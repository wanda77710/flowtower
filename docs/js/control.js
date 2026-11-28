// 即時管控中心：準時派車／準時出車／準時配達 的即時燈號、通知、升級與處理紀錄
// 資料來源：control_alerts（資料庫每分鐘同步一次 sync_control_alerts；本頁打開時也會同步）
import { api, esc, fmtHM, fmtT } from './api.js';

const KIND = { dispatch: ['準時派車', '還沒派車'], depart: ['準時出車', '還沒出發'], arrive: ['準時配達', '會晚到／已晚到'] };
const ST = { open: ['待處理', 'r'], ack: ['處理中', 'y'], done: ['已處理', 'g'], resolved: ['已恢復', 'g'] };
let TAB = 'live', KF = '', last = [], settings = {};
const me = () => { try { return localStorage.getItem('ft_handler') || ''; } catch { return ''; } };
const setMe = v => { try { localStorage.setItem('ft_handler', v); } catch { /* 無痕模式等情況存不了，沒關係 */ } };
const ago = t => { const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000)); return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時 ${m % 60} 分`; };

export async function render(ui) {
  ui.head('即時管控中心', '準時派車・準時出車・準時配達｜每 15 秒更新・紅燈超時自動升級');
  ui.actions(`<label class="mut" style="font-size:12px">處理人 <input id="me" value="${esc(me())}" placeholder="你的名字" style="width:110px"></label>`)
    .querySelector('#me').onchange = e => setMe(e.target.value.trim());
  const v = ui.view(`<div class="kpis" id="ck"></div>
    <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div class="tabs" id="ctab" style="margin:0"><button data-t="live">未結案</button><button data-t="hist">已結案紀錄</button></div>
      <div class="seg" id="ckind"><button data-k="">全部</button>${Object.entries(KIND).map(([k, [t]]) => `<button data-k="${k}">${t}</button>`).join('')}</div>
      <span class="mut" id="csync" style="font-size:12px;margin-left:auto"></span></div>
    <div id="cbody"><div class="loading">同步中…</div></div>`);
  v.querySelector('#ctab').onclick = e => { const t = e.target.dataset.t; if (t) { TAB = t; draw(v, ui); } };
  v.querySelector('#ckind').onclick = e => { const k = e.target.dataset.k; if (k !== undefined) { KF = k; draw(v, ui); } };

  async function load() {
    let sync = null;
    try { sync = await api.rpc('sync_control_alerts'); }
    catch (e) {
      v.querySelector('#cbody').innerHTML = `<div class="card empty">即時管控還沒啟用：請在 Supabase SQL Editor 執行 <b>supabase/control.sql</b>，再執行一次 <b>security.sql</b>。<br><span class="mut" style="font-size:12px">${esc(e.message.slice(0, 120))}</span></div>`;
      return;
    }
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const [al, st] = await Promise.all([
      api.get('control_alerts', `select=*&or=(status.in.(open,ack),updated_at.gte.${since})&order=level.desc,level_since.asc&limit=500`),
      api.get('control_settings', 'select=key,value')]);
    last = al; settings = Object.fromEntries(st.map(x => [x.key, +x.value]));
    v.querySelector('#csync').textContent = `最後同步 ${fmtHM(sync.at)}${sync.new ? `・新增 ${sync.new}` : ''}${sync.escalated ? `・升級 ${sync.escalated}` : ''}${sync.resolved ? `・自動結案 ${sync.resolved}` : ''}`;
    draw(v, ui);
  }
  await load();
  return load;
}

function draw(v, ui) {
  v.querySelectorAll('#ctab button').forEach(b => b.classList.toggle('on', b.dataset.t === TAB));
  v.querySelectorAll('#ckind button').forEach(b => b.classList.toggle('on', b.dataset.k === KF));
  const live = last.filter(a => ['open', 'ack'].includes(a.status));
  const cnt = (k, l) => live.filter(a => (!k || a.kind === k) && (!l || a.level === l)).length;
  v.querySelector('#ck').innerHTML = `
    <div class="kpi kr"><span>🔴 紅燈</span><b>${cnt('', 'r')}</b><small>待處理 ${live.filter(a => a.level === 'r' && a.status === 'open').length}</small></div>
    <div class="kpi ky"><span>🟡 黃燈</span><b>${cnt('', 'y')}</b></div>
    <div class="kpi ${live.some(a => a.escalated_at) ? 'kr' : ''}"><span>已升級主管</span><b>${live.filter(a => a.escalated_at).length}</b><small>紅燈 ${settings.escalate_min ?? 15} 分鐘沒人處理</small></div>
    ${Object.entries(KIND).map(([k, [t]]) => `<div class="kpi"><span>${t}</span><b>${cnt(k)}</b><small>紅 ${cnt(k, 'r')}・黃 ${cnt(k, 'y')}</small></div>`).join('')}`;
  const rows = (TAB === 'live' ? live : last.filter(a => ['done', 'resolved'].includes(a.status))).filter(a => !KF || a.kind === KF);
  const body = v.querySelector('#cbody');
  if (!rows.length) {
    body.innerHTML = `<div class="card empty">${TAB === 'live' ? '目前沒有亮燈 👍' : '最近 24 小時沒有結案紀錄'}<br><span class="mut" style="font-size:12px">${rule()}</span></div>`;
    return;
  }
  body.innerHTML = `<div class="tw"><table class="t ctl"><thead><tr><th>燈號</th><th>項目</th><th>單號</th><th>站點</th><th>運輸商</th><th>狀況</th><th>負責人</th><th>亮燈多久</th><th>已通知</th><th>狀態</th><th></th></tr></thead><tbody>
    ${rows.map(a => `<tr class="${a.escalated_at && a.status === 'open' ? 'esc' : ''}">
      <td><span class="badge ${a.level}"><span class="dot ${a.level}"></span>${a.level === 'r' ? '紅' : '黃'}</span></td>
      <td>${KIND[a.kind]?.[0] || a.kind}</td><td class="mono">${esc(a.ref_no)}</td><td>${esc(a.site_id)}</td><td>${esc(a.carrier || '—')}</td>
      <td style="max-width:320px">${esc(a.detail)}${a.customer ? `<div class="mut" style="font-size:12px">${esc(a.customer)}</div>` : ''}</td>
      <td>${esc(a.owner)}</td>
      <td class="mono">${TAB === 'live' ? ago(a.level_since) : `${fmtHM(a.first_seen)} → ${fmtHM(a.resolved_at || a.ack_at)}`}</td>
      <td><span class="ntf" data-tip='${esc(JSON.stringify(a.notified || []))}'>${(a.notified || []).length} 則${a.escalated_at ? ' <span class="badge r">升級主管</span>' : ''}</span></td>
      <td><span class="badge ${ST[a.status][1]}">${ST[a.status][0]}</span>${a.ack_by ? `<div class="mut" style="font-size:11px">${esc(a.ack_by)} ${fmtHM(a.ack_at)}${a.ack_note ? `・${esc(a.ack_note)}` : ''}</div>` : ''}</td>
      <td style="white-space:nowrap">${TAB === 'live' ? `${a.status === 'open' ? `<button class="btn sm" data-ack="${a.id}" data-s="ack">處理中</button>` : ''}<button class="btn sm" data-ack="${a.id}" data-s="done">已處理</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="mut" style="font-size:12px;margin-top:8px">${rule()}｜通知對象：黃燈 → 負責管理同仁（派車類 → 站點調度）；紅燈 → 再加運輸商窗口；紅燈 ${settings.escalate_min ?? 15} 分鐘沒人按「處理中」→ 升級主管。狀況解除（已派車／已出發／已送達）會自動結案。<br>目前只做網站內通知與紀錄，還沒接 LINE／Teams。</p>`;
  body.querySelectorAll('[data-ack]').forEach(b => b.onclick = () => {
    const a = last.find(x => x.id === +b.dataset.ack), done = b.dataset.s === 'done';
    const d = ui.drawer(done ? '標記已處理' : '標記處理中', `<span class="badge ${a.level}">${a.level === 'r' ? '紅燈' : '黃燈'}</span>`, `
      <div style="font-size:13px"><b>${KIND[a.kind]?.[0]}・${esc(a.ref_no)}</b><div class="mut">${esc(a.detail)}</div></div>
      <label class="f" style="margin-top:12px">處理人<input id="aw" value="${esc(me())}" placeholder="你的名字"></label>
      <label class="f">處理說明${done ? '' : '（可留空）'}<textarea id="an" rows="3" placeholder="${done ? '例：已改派 TD-1703，預計 14:10 送達' : '例：已聯絡司機確認位置'}"></textarea></label>
      <div class="mut" style="font-size:12px">${done ? '標記已處理後這筆會結案；如果之後惡化成紅燈，系統會重新打開。' : '標記處理中後，紅燈就不會再升級主管。'}</div>`,
      `<button class="btn pri" id="aok">${done ? '已處理' : '處理中'}</button>`);
    d.querySelector('#aok').onclick = async e => {
      const who = d.querySelector('#aw').value.trim(), note = d.querySelector('#an').value.trim() || null;
      if (!who) return ui.toast('請填處理人', true);
      setMe(who); document.getElementById('me').value = who; e.target.disabled = true;
      try { await api.rpc('ack_control_alert', { p_id: a.id, p_status: b.dataset.s, p_by: who, p_note: note });
        Object.assign(a, { status: b.dataset.s, ack_by: who, ack_at: new Date().toISOString(), ack_note: note, updated_at: new Date().toISOString(), resolved_at: done ? new Date().toISOString() : a.resolved_at });
        ui.closeDrawer(); ui.toast(done ? '已標記處理完成' : '已標記處理中'); draw(v, ui);
      } catch (err) { ui.toast('操作失敗：' + err.message.slice(0, 100), true); e.target.disabled = false; }
    };
  });
  const tip = document.getElementById('ctip') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'ctip', className: 'rtip' });
  body.querySelectorAll('.ntf').forEach(el => {
    el.onmousemove = e => { const n = JSON.parse(el.dataset.tip);
      tip.innerHTML = n.length ? n.map(x => `<div>${fmtHM(x.at)}・${esc(x.to)}・${esc(x.why)}</div>`).join('') : '尚無通知';
      tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; };
    el.onmouseleave = () => tip.style.display = 'none';
  });
}
const rule = () => `規則：派車 → 出車前 ${settings.dispatch_yellow ?? 30} 分還沒派車黃燈、前 ${settings.dispatch_red ?? 5} 分紅燈；出車 → 過預計出車黃燈、+${settings.depart_red ?? 15} 分紅燈；配達 → 推算晚到超過 ${settings.arrive_tolerance ?? 10} 分黃燈、超過指定送達紅燈`;
