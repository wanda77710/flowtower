// 管理報表 v2：指標總覽 · 指標分析（11 項指標 × 5 個角度 × 趨勢）· 營運量能 · 營收成本 · 管理同仁待辦
// 資料來源：資料庫 rpt_* 函式（supabase/reports.sql），統計到昨天為止
import { api, master, esc } from './api.js';

const SERIES = ['#257de0', '#f47230', '#00b894', '#f2a600'];   // 比較線固定 4 色（依選取順序，最多 4 條）
const ONE = '#16a394', ALLC = '#8a93a6';                       // 單一系列 / 「全部」平均線
const DIMS = [['carrier', '運輸商'], ['driver', '司機'], ['staff', '管理同仁'], ['customer', '客戶'], ['site', '站點']];
const TABS = [['overview', '指標總覽'], ['analysis', '指標分析'], ['volume', '營運量能'], ['money', '營收成本'], ['staff', '管理同仁待辦']];
const EXC = { late: '延誤', damage: '貨損', shortage_qty: '短少', reject: '拒收', address: '地址錯誤', queue_at_fab: '廠區排隊', vehicle_breakdown: '車輛故障', other: '其他' };
const REASON = { true_capacity: '真的車不夠', stuck_in_fab: '車卡在廠區', burst_orders: '訂單暴量', no_consolidation: '沒併車', driver_absent: '司機缺勤', other: '其他' };
const MIN_N = 20;   // 司機樣本少於這個趟數不列入排名
const SUMK = ['trips', 'orders', 'revenue', 'cost', 'gp'];
// 加總型指標：頭尾不完整的週／月會偏低，不畫
// 比率型指標：資料天數太少的頭尾期間也不畫（避免 1～2 天的樣本跳動）
const fullP = (k, s, g) => s.days == null || s.days >= (SUMK.includes(k) ? (g === 'month' ? 28 : 7) : (g === 'month' ? 10 : 3));

const st = { tab: 'overview', days: 90, grain: 'week', site: '', carrier: '', staff: '', kpi: 'arrive', dim: 'carrier', pick: null, focus: null, mdim: 'carrier' };
let M, carriers = [], owners = [], defs = [], ui, last = null;

// ---------- 格式 ----------
const n0 = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const n1 = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 1 });
const n2 = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const pct = v => v == null ? '—' : n1(v) + '%';
const wan = v => v == null ? '—' : (Math.abs(v) >= 10000 ? n1(v / 10000) + ' 萬' : n0(v));
const md = d => { const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
const ym = d => { const x = new Date(d); return `${x.getMonth() + 1}月`; };
const tw = t => t ? new Date(t).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const plab = (p, g) => g === 'month' ? ym(p) : md(p);
const badge = (txt, t) => `<span class="badge ${t || ''}">${txt}</span>`;
function fmtK(def, v) {
  if (v == null) return '—';
  switch (def?.unit) { case '%': return pct(v); case '元': return wan(v); case '件/百趟': return n2(v); case '天': return n1(v) + ' 天'; default: return n0(v); }
}
const unitTxt = def => ({ '%': '%', '元': 'NT$', '件/百趟': '件／每 100 趟', '天': '天' })[def?.unit] || def?.unit || '';
// 燈號：達標綠、差一點黃、明顯落後紅
function rag(def, v) {
  if (v == null || def?.target == null) return '';
  const t = +def.target;
  if (def.better === 'hi') return v >= t ? 'g' : v >= t * 0.95 ? 'y' : 'r';
  return v <= t ? 'g' : v <= t * 1.3 + 0.2 ? 'y' : 'r';
}
const RAGTXT = { g: '達標', y: '接近', r: '未達標' };
function delta(def, v, p) {
  if (v == null || p == null || +p === 0) return '';
  const isPct = def?.unit === '%', d = isPct ? v - p : (v - p) / Math.abs(p) * 100;
  if (Math.abs(d) < 0.05) return `<span class="dl">持平</span>`;
  const good = def?.better === 'lo' ? d < 0 : d > 0;
  return `<span class="dl ${good ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${n1(Math.abs(d))}${isPct ? ' 個百分點' : '%'}</span>`;
}

export async function render(u) {
  ui = u; M = await master();
  const h = new URLSearchParams(location.hash.split('?')[1] || '');
  if (h.get('tab')) st.tab = h.get('tab');
  ui.head('管理報表', '11 項管理指標 × 運輸商／司機／管理同仁／客戶／站點 · 統計到昨天為止');
  ui.actions('<button class="btn" id="csv">⇩ 匯出 CSV</button>').querySelector('#csv').onclick = exportCsv;
  ui.view('<div id="rbody"><div class="loading">載入中…</div></div><div id="rtip" class="rtip"></div>');
  try {
    [carriers, owners, defs] = await Promise.all([api.get('carriers', 'select=id,name&order=name'), api.rpc('rpt_owners'), api.get('rpt_kpi_defs', 'select=*&order=sort')]);
  } catch (e) { notReady(e); return null; }
  ui.view(`
    <div class="tabs" id="rtabs">${TABS.map(([k, t]) => `<button data-t="${k}">${t}</button>`).join('')}</div>
    <div class="rfilters">
      <div class="seg" id="rdays">${[30, 90, 180].map(d => `<button data-d="${d}">近 ${d} 天</button>`).join('')}</div>
      <div class="seg" id="rgrain"><button data-g="week">週</button><button data-g="month">月</button></div>
      <select id="rsite"><option value="">全部站點</option>${M.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="rstaff"><option value="">全部管理同仁</option>${owners.map(o => `<option value="${esc(o.staff)}">${esc(o.staff)}（${o.carriers.map(c => esc(c.name)).join('、')}）</option>`).join('')}</select>
      <select id="rcar"><option value="">全部運輸商</option>${carriers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <span class="mut" id="rnote"></span>
    </div>
    <div id="rbody"><div class="loading">載入中…</div></div>
    <div id="rtip" class="rtip"></div>`);
  document.querySelectorAll('#rtabs button').forEach(b => b.onclick = () => { st.tab = b.dataset.t; load(); });
  document.querySelectorAll('#rdays button').forEach(b => b.onclick = () => { st.days = +b.dataset.d; if (st.days === 180) st.grain = 'month'; load(); });
  document.querySelectorAll('#rgrain button').forEach(b => b.onclick = () => { st.grain = b.dataset.g; load(); });
  const $ = id => document.getElementById(id);
  $('rsite').onchange = () => { st.site = $('rsite').value; load(); };
  $('rstaff').onchange = () => { st.staff = $('rstaff').value; load(); };
  $('rcar').onchange = () => { st.carrier = $('rcar').value; load(); };
  await load();
  return null;
}
function notReady(e) {
  console.error(e);
  const msg = /rpt_|function|404|PGRST|relation/.test(e.message)
    ? `報表資料庫還沒建立（或還是舊版）：請在 Supabase SQL Editor 執行最新的 <b>supabase/reports.sql</b>，再執行一次 <b>security.sql</b>。`
    : `載入失敗：${esc(e.message)}`;
  const b = document.getElementById('rbody'); if (b) b.innerHTML = `<div class="card empty">${msg}</div>`;
}
const F = () => ({ p_days: st.days, p_site: st.site || null, p_carrier: st.carrier || null, p_staff: st.staff || null });
const defOf = k => defs.find(d => d.kpi === k);

async function load() {
  const $ = id => document.getElementById(id);
  document.querySelectorAll('#rtabs button').forEach(b => b.classList.toggle('on', b.dataset.t === st.tab));
  document.querySelectorAll('#rdays button').forEach(b => b.classList.toggle('on', +b.dataset.d === st.days));
  document.querySelectorAll('#rgrain button').forEach(b => b.classList.toggle('on', b.dataset.g === st.grain));
  $('rgrain').style.display = ['overview', 'analysis', 'money'].includes(st.tab) ? '' : 'none';
  $('rsite').value = st.site; $('rcar').value = st.carrier; $('rstaff').value = st.staff;
  const to = new Date(Date.now() - 864e5), from = new Date(Date.now() - st.days * 864e5);
  $('rnote').textContent = `${md(from)} – ${md(to)}`;
  const body = $('rbody'); body.innerHTML = '<div class="loading">計算中…</div>';
  try {
    let html;
    if (st.tab === 'overview') { const d = await api.rpc('rpt_overview', { ...F(), p_grain: st.grain }); last = { tab: 'overview', d }; html = vOverview(d); }
    else if (st.tab === 'analysis') {
      const [d, all] = await Promise.all([
        api.rpc('rpt_kpi', { p_kpi: st.kpi, p_dim: st.dim, p_grain: st.grain, ...F() }),
        api.rpc('rpt_kpi', { p_kpi: st.kpi, p_dim: 'all', p_grain: st.grain, ...F() })]);
      last = { tab: 'analysis', d, all }; html = vAnalysis(d, all);
    }
    else if (st.tab === 'volume') {
      const [d, vt] = await Promise.all([api.rpc('rpt_fleet', F()), api.rpc('rpt_kpi', { p_kpi: 'trips', p_dim: st.mdim, p_grain: 'week', ...F() })]);
      last = { tab: 'volume', d }; html = vVolume(d, vt);
    }
    else if (st.tab === 'money') {
      const r = await Promise.all([...['revenue', 'cost', 'gp', 'margin'].map(k => api.rpc('rpt_kpi', { p_kpi: k, p_dim: st.mdim, p_grain: st.grain, ...F() })),
        ...['revenue', 'gp', 'margin'].map(k => api.rpc('rpt_kpi', { p_kpi: k, p_dim: 'all', p_grain: st.grain, ...F() }))]);
      last = { tab: 'money', d: r }; html = vMoney(r);
    }
    else { const d = await api.rpc('rpt_staff', F()); last = { tab: 'staff', d }; html = vStaff(d); }
    body.innerHTML = html; wire(body);
    if (st.tab === 'analysis' && st.focus) loadDetail();
  } catch (e) { notReady(e); }
}

// ================= ① 指標總覽 =================
function vOverview(d) {
  const ks = d.kpis.filter(k => k.grp === 'kpi'), vol = d.kpis.filter(k => k.grp !== 'kpi');
  const r = ks.map(k => rag(k, k.value));
  const ok = r.filter(x => x === 'g').length, bad = r.filter(x => x === 'r').length;
  return `
    <div class="rsum">${badge(`${ok} 項達標`, 'g')} ${badge(`${ks.length - ok - bad} 項接近`, 'y')} ${badge(`${bad} 項未達標`, 'r')}
      <span class="mut">點任一張卡片，看運輸商／司機／管理同仁／客戶／站點的排名與趨勢</span></div>
    <div class="kgrid">${ks.map(k => kcard(k, d.grain)).join('')}</div>
    <div class="sec2">營運量能與營收</div>
    <div class="kgrid sm">${vol.map(k => kcard(k, d.grain)).join('')}</div>`;
}
function kcard(k, g) {
  const r = rag(k, k.value);
  return `<button class="kc ${r}" data-kpi="${k.kpi}">
    <div class="kt"><span>${esc(k.label)}</span>${r ? `<i class="lamp ${r}" title="${RAGTXT[r]}"></i>` : ''}</div>
    <div class="kv">${fmtK(k, k.value)}</div>
    <div class="km">${k.target != null ? `<span class="mut">目標 ${k.better === 'hi' ? '≥' : '≤'} ${fmtK(k, k.target)}</span>` : ''}${delta(k, k.value, k.prev)}</div>
    ${spark(k.series.filter(s => fullP(k.kpi, s, g)), k, k.kpi === 'audit' ? 'month' : g)}
  </button>`;
}
function spark(series, def, g) {
  const pts = series.filter(s => s.value != null); if (pts.length < 2) return '<div class="spk"></div>';
  const W = 220, H = 42, vals = pts.map(p => +p.value);
  if (def.target != null) vals.push(+def.target);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = i => 4 + i * (W - 8) / (pts.length - 1), y = v => 4 + (hi - v) * (H - 8) / (hi - lo);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(+p.value).toFixed(1)}`).join('');
  const step = (W - 8) / (pts.length - 1);
  return `<svg class="spk" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${def.target != null ? `<line x1="4" x2="${W - 4}" y1="${y(+def.target)}" y2="${y(+def.target)}" class="tgt"/>` : ''}
    <path d="${path}" fill="none" stroke="${ONE}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<rect x="${x(i) - step / 2}" y="0" width="${step}" height="${H}" fill="transparent" data-tip="${esc(plab(p.p, g))}：${esc(fmtK(def, p.value))}"/>`).join('')}
  </svg>`;
}

// ================= ② 指標分析 =================
function vAnalysis(d, all) {
  const def = d.def, rated = d.rated !== false, g = d.grain;
  const rows = d.rows.map(r => ({ ...r, small: st.dim === 'driver' && r.n < MIN_N && !['training', 'audit'].includes(d.kpi) }));
  const worse = (a, b) => def.better === 'lo' ? (b.value ?? -1e9) - (a.value ?? -1e9) : (a.value ?? 1e9) - (b.value ?? 1e9);
  rows.sort((a, b) => (a.small - b.small) || worse(a, b));
  const periods = [...new Set(all.series.filter(s => fullP(d.kpi, s, g)).map(s => s.p))].sort();
  // 預設比較最差的 3 個；勾選可換
  if (!st.pick || st.pick.kpi !== d.kpi || st.pick.dim !== st.dim) st.pick = { kpi: d.kpi, dim: st.dim, keys: rows.filter(r => !r.small).slice(0, 3).map(r => r.key) };
  const keys = st.pick.keys.filter(k => rows.some(r => r.key === k)).slice(0, 4);
  const lab = k => rows.find(r => r.key === k)?.label || k;
  const series = keys.map((k, i) => ({ name: lab(k), color: SERIES[i], values: periods.map(p => d.series.find(s => s.p === p && s.key === k)?.value ?? null) }));
  const allSer = { name: '全部', color: ALLC, dash: true, values: periods.map(p => all.series.find(s => s.p === p)?.value ?? null) };
  const tv = all.total?.value, tr = rated ? rag(def, tv) : '';
  const dimName = DIMS.find(x => x[0] === st.dim)[1];
  const kOpts = defs.filter(k => k.grp === 'kpi' || k.grp === 'volume' || k.kpi === 'margin');
  const showStaff = st.dim === 'carrier';
  return `
    <div class="rpick">
      <label>指標 <select id="rkpi">${kOpts.map(k => `<option value="${k.kpi}" ${k.kpi === d.kpi ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></label>
      <span class="mut">看的角度</span>
      <div class="seg" id="rdim">${DIMS.map(([k, t]) => `<button data-dim="${k}" class="${k === st.dim ? 'on' : ''}">${t}</button>`).join('')}</div>
    </div>
    <div class="kpis">
      <div class="kpi ${tr ? 'k' + tr : ''}"><span>${esc(def.label)}（全部）</span><b>${fmtK(def, tv)}</b><small>${def.target != null && rated ? `目標 ${def.better === 'hi' ? '≥' : '≤'} ${fmtK(def, def.target)}　` : ''}${delta(def, tv, all.prev?.value)}</small></div>
      ${kpiNote(d, all)}
    </div>
    <div class="card rsec"><div class="rh"><b>${esc(def.label)}趨勢：依${dimName}</b><span class="mut">${unitTxt(def)} · ${g === 'month' ? '每月' : '每週'} · 灰色虛線＝全部${def.target != null && rated ? ' · 紅色虛線＝目標' : ''} · 在下表勾選要比較的對象（最多 4 個）</span></div>
      ${periods.length > 1 ? line(periods.map(p => plab(p, g)), [...series, allSer], { fmt: v => fmtK(def, v), target: rated ? def.target : null }) : '<div class="empty">期間太短，請改選較長期間或「週」</div>'}</div>
    <div class="card rsec"><div class="rh"><b>${dimName}排名</b><span class="mut">由差到好 · 點名稱看${d.kpi === 'audit' ? '稽核紀錄' : '沒達標的明細'}${st.dim === 'driver' ? ` · 少於 ${MIN_N} 趟的司機排最後、不列入排名` : ''}</span></div>
      <div class="tw"><table class="t" id="rank"><thead><tr><th class="cb">比較</th><th>#</th><th>${dimName}</th>${showStaff ? '<th>管理同仁</th>' : ''}
        <th class="r">${esc(def.label)}</th><th>狀態</th><th class="r">前期</th><th class="r">變化</th><th class="r">${colN(d.kpi)}</th>${extraHead(d.kpi)}</tr></thead>
      <tbody>${rows.map((r, i) => {
        const rr = rated ? rag(def, r.value) : '', on = keys.indexOf(r.key);
        return `<tr class="${st.focus === r.key ? 'sel' : ''} ${r.small ? 'dim' : ''}">
          <td class="cb"><label class="chk"><input type="checkbox" data-k="${esc(r.key)}" ${on >= 0 ? 'checked' : ''}><i style="${on >= 0 ? `background:${SERIES[on]};border-color:${SERIES[on]}` : ''}"></i></label></td>
          <td>${r.small ? '' : i + 1}</td>
          <td><a href="#" class="clink" data-focus="${esc(r.key)}">${esc(r.label)}</a>${r.small ? ' ' + badge('樣本少', '') : ''}</td>
          ${showStaff ? `<td class="mut">${esc(owners.find(o => o.carriers.some(c => c.id === r.key))?.staff || '')}</td>` : ''}
          <td class="r">${def.unit === '%' && rated ? bar(r.value, rr) : `<b>${fmtK(def, r.value)}</b>`}</td>
          <td>${rr ? badge(RAGTXT[rr], rr) : ''}</td>
          <td class="r mut">${fmtK(def, r.prev)}</td><td class="r">${delta(def, r.value, r.prev)}</td>
          <td class="r">${cellN(d.kpi, r)}</td>${extraCells(d.kpi, r)}</tr>`; }).join('')}</tbody></table></div></div>
    <div id="rdetail"></div>`;
}
const colN = k => k === 'training' ? '有效／出車司機' : k === 'audit' ? '稽核次數' : k === 'paper_rate' ? '應繳回趟數' : '趟數';
const cellN = (k, r) => k === 'training' ? `${n0(r.num)} / ${n0(r.den)}` : k === 'audit' ? (r.den != null ? `${n0(r.num)} / 目標 ${n1(r.den)}` : n0(r.n)) : k === 'paper_rate' ? n0(r.den) : n0(r.n);
const extraHead = k => k === 'audit' ? '<th class="r">稽核缺失</th><th class="r">已改善</th>' : ['exception', 'complaint'].includes(k) ? '<th class="r">件數</th>' : '';
const extraCells = (k, r) => k === 'audit' ? `<td class="r">${n0(r.findings)}</td><td class="r">${r.findings ? `${n0(r.closed)}（${pct(r.closed / r.findings * 100)}）` : '—'}</td>`
  : ['exception', 'complaint'].includes(k) ? `<td class="r">${n0(r.num)}</td>` : '';
function kpiNote(d, all) {
  const T = all.total || {};
  if (d.kpi === 'audit') return `<div class="kpi"><span>稽核次數</span><b>${n0(T.n)}</b><small>每家運輸商每月目標 2 次</small></div>
    <div class="kpi"><span>稽核缺失</span><b>${n0(T.findings)}</b><small>已改善 ${n0(T.closed)} 件（${T.findings ? pct(T.closed / T.findings * 100) : '—'}）</small></div>
    ${d.rated === false ? '<div class="kpi"><span>說明</span><small class="note">司機／客戶／站點沒有稽核目標，這裡顯示的是稽核次數</small></div>' : ''}`;
  if (d.kpi === 'training') return `<div class="kpi"><span>期間內出車司機</span><b>${n0(T.n)} 人</b><small>3 門必修：安全駕駛、晶圓廠進廠規範、貨態回報操作（效期 1 年），以期末判定</small></div>`;
  if (d.kpi === 'paper_days') return `<div class="kpi"><span>說明</span><small class="note">只算配達已滿 7 天的趟次；尚未繳回的車單以「配達到今天」的天數計入，避免拖最久的單被漏掉</small></div>`;
  return `<div class="kpi"><span>樣本</span><b>${n0(T.n)} 趟</b><small>${DEF_TXT[d.kpi] || ''}</small></div>`;
}
const DEF_TXT = { dispatch: '派好車與司機 ≤ 預計出車 − 5 分鐘', depart: '實際出車 ≤ 預計出車 + 15 分鐘', arrive: '實際送達 ≤ 指定送達時間', exception: '每 100 趟的異常件數',
  complaint: '每 100 趟的客訴件數', milestone: '交車／出發／抵達／簽收 4 節點都有回傳', paper_rate: '配達後 7 天內繳回；只算配達已滿 7 天的趟次', margin: '毛利 ÷ 營收' };

async function loadDetail() {
  const box = document.getElementById('rdetail'); if (!box) return;
  box.innerHTML = '<div class="card rsec"><div class="loading">讀取明細…</div></div>';
  let d;
  try { d = await api.rpc('rpt_kpi_detail', { p_kpi: st.kpi, p_dim: st.dim, p_key: st.focus, ...F() }); } catch (e) { box.innerHTML = `<div class="card empty">明細載入失敗：${esc(e.message)}</div>`; return; }
  last.detail = d.rows;
  const name = last.d.rows.find(r => r.key === st.focus)?.label || '';
  const def = defOf(st.kpi);
  let tb;
  if (d.type === 'training') tb = `<thead><tr><th>司機</th><th>運輸商</th><th>管理同仁</th><th>站點</th><th>缺少／過期的必修課</th><th>最近一次過期日</th></tr></thead>
    <tbody>${d.rows.map(r => `<tr><td>${esc(r.driver)}</td><td>${esc(r.carrier)}</td><td>${esc(r.staff)}</td><td>${esc(r.site_id)}</td><td>${badge(esc(r.missing), 'r')}</td><td>${r.last_expired || '從未受訓'}</td></tr>`).join('')}</tbody>`;
  else if (d.type === 'audit') tb = `<thead><tr><th>稽核日</th><th>管理同仁</th><th>運輸商</th><th>司機</th><th>站點</th><th>客戶</th><th>結果</th><th class="r">缺失</th><th class="r">已改善</th><th>改善完成</th></tr></thead>
    <tbody>${d.rows.map(r => `<tr><td>${md(r.audit_date)}</td><td>${esc(r.staff)}</td><td>${esc(r.carrier)}</td><td>${esc(r.driver)}</td><td>${esc(r.site_id)}</td><td>${esc(r.customer)}</td>
      <td>${r.findings ? badge(esc(r.note), 'y') : esc(r.note)}</td><td class="r">${r.findings}</td><td class="r">${r.findings_closed}${r.findings > r.findings_closed ? ' ' + badge('待改善', 'r') : ''}</td><td>${r.closed_at ? md(r.closed_at) : ''}</td></tr>`).join('')}</tbody>`;
  else if (['trips', 'orders', 'margin'].includes(st.kpi)) tb = null;
  else tb = `<thead><tr><th>日期</th><th>運輸商</th><th>司機</th><th>管理同仁</th><th>客戶</th><th>站點</th><th>${detailCol(st.kpi)}</th></tr></thead>
    <tbody>${d.rows.map(r => `<tr><td>${md(r.trip_date)}</td><td>${esc(r.carrier)}</td><td>${esc(r.driver)}</td><td>${esc(r.staff)}</td><td>${esc(r.customer)}</td><td>${esc(r.site_id)}</td><td>${detailCell(st.kpi, r)}</td></tr>`).join('')}</tbody>`;
  box.innerHTML = `<div class="card rsec"><div class="rh"><b>${esc(name)}：${esc(def.label)}${st.kpi === 'audit' ? '紀錄' : '未達標明細'}</b><span class="mut">${tb ? d.rows.length + ' 筆' + (d.rows.length >= 300 ? '（只列最近 300 筆）' : '') : ''}</span>
    <button class="btn sm" id="rdx" style="margin-left:auto">關閉</button></div>
    ${!tb ? '<div class="empty">這個指標沒有「未達標」明細</div>' : d.rows.length ? `<div class="tw"><table class="t">${tb}</table></div>` : '<div class="empty">沒有未達標紀錄</div>'}</div>`;
  document.getElementById('rdx').onclick = () => { st.focus = null; box.innerHTML = ''; document.querySelectorAll('#rank tr.sel').forEach(t => t.classList.remove('sel')); };
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
const detailCol = k => ({ dispatch: '預計出車 → 派好車', depart: '預計出車 → 實際出車', arrive: '指定送達 → 實際送達', exception: '異常', complaint: '客訴', milestone: '節點回傳', paper_rate: '配達 → 車單繳回', paper_days: '配達 → 車單繳回' })[k] || '';
const mins = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
function detailCell(k, r) {
  if (k === 'dispatch') { const m = mins(r.dispatched_at, r.planned_depart); return `${tw(r.planned_depart)} · ${m >= 0 ? badge(`只提前 ${m} 分派車`, 'y') : badge(`出車後 ${-m} 分才派車`, 'r')}`; }
  if (k === 'depart') return `${tw(r.planned_depart)} → ${tw(r.actual_depart)} ${badge('晚 ' + mins(r.planned_depart, r.actual_depart) + ' 分', 'r')}`;
  if (k === 'arrive') return `${tw(r.req_arrive)} → ${tw(r.actual_arrive)} ${badge('晚 ' + mins(r.req_arrive, r.actual_arrive) + ' 分', 'r')}`;
  if (k === 'exception') return badge(EXC[r.exception_kind] || r.exception_kind, r.exception_severity === 'high' ? 'r' : 'y');
  if (k === 'complaint') return badge(esc(r.complaint), 'r') + (r.exception_kind ? ' ' + badge('同趟異常：' + (EXC[r.exception_kind] || ''), 'y') : '');
  if (k === 'milestone') return `${badge(r.events_recorded + ' / ' + r.events_expected, 'y')} 漏 ${r.events_expected - r.events_recorded} 個節點`;
  return `${md(r.actual_arrive)} → ${r.waybill_returned_at ? md(r.waybill_returned_at) + ' ' + badge(n1(r.paper_days) + ' 天', 'y') : badge('未繳回 ' + n0(r.paper_days) + ' 天', 'r')}`;
}

// ================= ③ 營運量能 =================
function vVolume(d, vt) {
  const S = d.summary; if (!S.vehicles) return empty();
  const W = d.weekly.filter(w => w.days >= 7);                    // 只畫完整的週
  const labels = W.map(w => md(w.p) + ' 週');
  const idleShare = S.shortage_reports ? S.shortage_with_idle / S.shortage_reports * 100 : 0;
  const dimName = DIMS.find(x => x[0] === st.mdim)[1];
  const totalTrips = vt.rows.reduce((a, r) => a + (+r.value || 0), 0);
  const rows = [...vt.rows].sort((a, b) => b.value - a.value);
  const periods = [...new Set(vt.series.map(s => s.p))].sort().filter(p => W.some(w => w.p === p));
  const top = rows.slice(0, 4).map((r, i) => ({ name: r.label, color: SERIES[i], values: periods.map(p => vt.series.find(s => s.p === p && s.key === r.key)?.value ?? null) }));
  return `
    <div class="kpis">${kpi('車趟數', n0(S.trips))}${kpi('訂單數', n0(S.orders))}${kpi('車輛', n0(S.vehicles))}
      ${kpi('每車每日趟數', n1(S.trips_per_day), '有出勤的日子')}${kpi('平均使用率', pct(S.util_pct), '在途時數 ÷ 班表時數')}${kpi('跨倉支援', n0(S.cross_trips) + ' 趟')}</div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>每週車趟數與訂單數</b><span class="mut">件 · 只列完整的週</span></div>
        ${line(labels, [{ name: '車趟', color: SERIES[0], values: W.map(w => +w.trips) }, { name: '訂單', color: SERIES[1], values: W.map(w => +w.orders) }], { fmt: n0, min: 0, half: true })}</div>
      <div class="card rsec"><div class="rh"><b>每週車輛使用率</b><span class="mut">%</span></div>
        ${line(labels, [{ name: '使用率', color: ONE, values: W.map(w => +w.util) }], { fmt: pct, min: 0, max: 100, half: true })}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>量能分布：依${dimName}</b><span class="mut">車趟數</span>
      <div class="seg sm" id="rmdim">${DIMS.map(([k, t]) => `<button data-mdim="${k}" class="${k === st.mdim ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="rgrid"><div>${rows.length > 1 && periods.length > 1 ? line(periods.map(p => md(p) + ' 週'), top, { fmt: n0, min: 0, half: true }) + '<p class="mut rfoot">每週車趟數 · 前 4 名</p>' : ''}</div>
      <div class="tw"><table class="t"><thead><tr><th>${dimName}</th><th class="r">車趟</th><th class="r">占比</th><th class="r">前期</th><th class="r">變化</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="r">${n0(r.value)}</td><td class="r">${bar(r.value / totalTrips * 100, '')}</td><td class="r mut">${n0(r.prev)}</td><td class="r">${delta({ better: 'hi' }, r.value, r.prev)}</td></tr>`).join('')}</tbody></table></div></div></div>
    ${S.shortage_reports ? `<div class="card rsec rcall"><b>缺車 × 閒置對照：</b>這段期間 ${S.shortage_reports} 次缺車通報中，有 <b>${S.shortage_with_idle} 次（${n1(idleShare)}%）</b>
      同一個站點、同一時間其實有可替代（同級或更大）的車閒著 — 這些是調度問題，不是真的缺車。</div>` : ''}
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>使用率：依管理同仁</b></div>${groupTable(d.groups.filter(g => g.dim === 'staff'), '管理同仁')}</div>
      <div class="card rsec"><div class="rh"><b>使用率：依運輸商</b></div>${groupTable(d.groups.filter(g => g.dim === 'carrier'), '運輸商')}</div>
      <div class="card rsec"><div class="rh"><b>使用率：依站點</b></div>${groupTable(d.groups.filter(g => g.dim === 'site').map(g => ({ ...g, label: M.site[g.label]?.name || g.label })), '站點')}</div>
      <div class="card rsec"><div class="rh"><b>使用率：依車種</b></div>${groupTable(d.groups.filter(g => g.dim === 'type'), '車種')}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>車輛明細</b><span class="mut">使用率低的排前面（可調出支援）</span></div>
      <div class="tw"><table class="t"><thead><tr><th>車牌</th><th>車種</th><th>站點</th><th>運輸商</th><th>管理同仁</th><th class="r">出勤天數</th><th class="r">趟數</th><th class="r">每日趟數</th><th class="r">使用率</th><th class="r">跨倉支援</th></tr></thead>
      <tbody>${d.vehicles.map(v => `<tr><td>${esc(v.plate)}</td><td>${esc(v.type_code)}</td><td>${esc(v.site_id)}</td><td>${esc(v.carrier)}</td><td class="mut">${esc(v.staff)}</td>
        <td class="r">${v.work_days}</td><td class="r">${v.trips}</td><td class="r">${n1(v.trips_per_day)}</td><td class="r">${bar(v.util_pct, utilT(v.util_pct))}</td><td class="r">${v.cross_trips}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>缺車通報：依站點</b></div>
        ${d.shortage_sites.length ? `<div class="tw"><table class="t"><thead><tr><th>站點</th><th class="r">通報</th><th class="r">同站有可替代車閒置</th><th class="r">同區他站有車閒置</th><th class="r">未解決</th></tr></thead>
        <tbody>${d.shortage_sites.map(s => `<tr><td>${esc(M.site[s.site_id]?.name || s.site_id)}</td><td class="r">${s.reports}</td><td class="r">${s.with_idle_same_site ? badge(s.with_idle_same_site, 'y') : 0}</td>
          <td class="r">${s.with_idle_region}</td><td class="r">${s.unresolved ? badge(s.unresolved, 'r') : 0}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">期間內沒有缺車通報</div>'}</div>
      <div class="card rsec"><div class="rh"><b>缺車原因</b><span class="mut">件數</span></div>${hbars(d.shortage_reasons.map(r => ({ label: REASON[r.reason_tag] || r.reason_tag, v: r.n })), { fmt: n0 })}</div>
    </div>`;
}
const utilT = v => v == null ? '' : v >= 70 ? 'g' : v < 55 ? 'r' : 'y';
const groupTable = (rows, head) => `<div class="tw"><table class="t"><thead><tr><th>${head}</th><th class="r">車輛</th><th class="r">每車每日趟數</th><th class="r">使用率</th></tr></thead>
  <tbody>${rows.map(g => `<tr><td>${esc(g.label)}</td><td class="r">${g.vehicles}</td><td class="r">${n1(g.trips_per_day)}</td><td class="r">${bar(g.util_pct, utilT(g.util_pct))}</td></tr>`).join('')}</tbody></table></div>`;

// ================= ④ 營收成本 =================
function vMoney([rev, cost, gp, mg, aRev, aGp, aMg]) {
  if (!rev.rows.length) return empty();
  const g = aRev.grain, dimName = DIMS.find(x => x[0] === st.mdim)[1];
  const by = (d, k) => d.rows.find(r => r.key === k);
  const rows = rev.rows.map(r => ({ key: r.key, label: r.label, n: r.n, revenue: +r.value, cost: +(by(cost, r.key)?.value || 0), gp: +(by(gp, r.key)?.value || 0),
    margin: by(mg, r.key)?.value, prev: r.prev })).sort((a, b) => b.revenue - a.revenue);
  const T = { revenue: +aRev.total.value, gp: +aGp.total.value, margin: aMg.total.value };
  const periods = [...new Set(aRev.series.filter(s => fullP('revenue', s, g)).map(s => s.p))].sort();
  const mDef = defOf('margin');
  const mPeriods = [...new Set(mg.series.map(s => s.p))].sort();
  const mTop = rows.slice(0, 4).map((r, i) => ({ name: r.label, color: SERIES[i], values: mPeriods.map(p => mg.series.find(s => s.p === p && s.key === r.key)?.value ?? null) }));
  return `
    <div class="kpis">${kpi('營收', wan(T.revenue), delta({ better: 'hi' }, T.revenue, aRev.prev.value))}${kpi('成本', wan(T.revenue - T.gp))}
      ${kpi('毛利', wan(T.gp), delta({ better: 'hi' }, T.gp, aGp.prev.value))}${kpi('毛利率', pct(T.margin), `目標 ≥ ${pct(mDef?.target)}`, rag(mDef, T.margin))}
      ${kpi('每趟平均營收', 'NT$ ' + n0(T.revenue / aRev.total.n))}</div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>${g === 'month' ? '每月' : '每週'}營收與毛利</b><span class="mut">NT$ · 只列完整的${g === 'month' ? '月' : '週'}</span></div>
        ${line(periods.map(p => plab(p, g)), [{ name: '營收', color: SERIES[0], values: periods.map(p => aRev.series.find(s => s.p === p)?.value ?? null) },
          { name: '毛利', color: SERIES[2], values: periods.map(p => aGp.series.find(s => s.p === p)?.value ?? null) }], { fmt: wan, min: 0, half: true })}</div>
      <div class="card rsec"><div class="rh"><b>毛利率趨勢：依${dimName}</b><span class="mut">% · 營收前 4 名 · 灰色虛線＝全部 · 紅色虛線＝目標</span></div>
        ${line(mPeriods.map(p => plab(p, g)), [...mTop, { name: '全部', color: ALLC, dash: true, values: mPeriods.map(p => aMg.series.find(s => s.p === p)?.value ?? null) }], { fmt: pct, target: mDef?.target, half: true })}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>營收成本分布：依${dimName}</b>
      <div class="seg sm" id="rmdim">${DIMS.map(([k, t]) => `<button data-mdim="${k}" class="${k === st.mdim ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="rgrid"><div>${hbars(rows.slice(0, 12).map(r => ({ label: r.label, v: r.revenue })), { fmt: wan })}${rows.length > 12 ? `<p class="mut rfoot">只列營收前 12 名，完整清單見右表</p>` : ''}</div>
      <div class="tw"><table class="t"><thead><tr><th>${dimName}</th><th class="r">趟數</th><th class="r">營收</th><th class="r">成本</th><th class="r">毛利</th><th class="r">毛利率</th><th class="r">營收占比</th><th class="r">營收變化</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="r">${n0(r.n)}</td><td class="r">${n0(r.revenue)}</td><td class="r">${n0(r.cost)}</td><td class="r">${n0(r.gp)}</td>
        <td class="r">${badge(pct(r.margin), rag(mDef, r.margin))}</td><td class="r">${pct(r.revenue / T.revenue * 100)}</td><td class="r">${delta({ better: 'hi' }, r.revenue, r.prev)}</td></tr>`).join('')}</tbody></table></div></div></div>
    <p class="mut rfoot">營收／成本以 Demo 費率（站點 × 送達點 × 車種）計算，運輸商成本率各不相同。</p>`;
}

// ================= ⑤ 管理同仁待辦 =================
function vStaff(d) {
  const S = d.staff; if (!S.length) return empty();
  const tot = S.reduce((a, s) => (a.t += s.total, a.o += s.open, a.od += s.overdue_open, a.dn += s.done, a.sla += (s.sla_pct || 0) * s.done, a.h += (s.avg_hours || 0) * s.done, a), { t: 0, o: 0, od: 0, dn: 0, sla: 0, h: 0 });
  return `
    <div class="kpis">${kpi('待辦總數', n0(tot.t))}${kpi('未結案', n0(tot.o))}${kpi('已逾期未結', n0(tot.od), '', tot.od ? 'r' : 'g')}
      ${kpi('時限內完成率', pct(tot.sla / tot.dn))}${kpi('平均處理時間', n1(tot.h / tot.dn) + ' 小時')}</div>
    <div class="card rsec"><div class="rh"><b>管理同仁處理狀況</b><span class="mut">逾期多、時限內完成率低的排前面</span></div>
      <div class="tw"><table class="t"><thead><tr><th>同仁</th><th>負責運輸商</th><th class="r">待辦</th><th class="r">已完成</th><th class="r">未結案</th><th class="r">逾期未結</th><th class="r">時限內完成率</th><th class="r">平均處理(時)</th></tr></thead>
      <tbody>${S.map(s => `<tr><td>${esc(s.staff)}</td><td class="mut">${esc(s.carriers || '')}</td><td class="r">${s.total}</td><td class="r">${s.done}</td><td class="r">${s.open}</td>
        <td class="r">${s.overdue_open ? badge(s.overdue_open, 'r') : 0}</td><td class="r">${bar(s.sla_pct, s.sla_pct >= 80 ? 'g' : s.sla_pct < 60 ? 'r' : 'y')}</td><td class="r">${n1(s.avg_hours)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>各類待辦的時限內完成率</b><span class="mut">%</span></div>${hbars(d.kinds.map(k => ({ label: `${k.kind}（${k.total}）`, v: k.sla_pct })), { fmt: pct, max: 100 })}</div>
      <div class="card rsec"><div class="rh"><b>各類待辦平均處理時間</b><span class="mut">小時</span></div>${hbars(d.kinds.map(k => ({ label: k.kind, v: k.avg_hours })), { fmt: n1 })}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>未結案待辦</b><span class="mut">依到期時間排序</span></div>
      ${d.open_tasks.length ? `<div class="tw"><table class="t"><thead><tr><th>同仁</th><th>類型</th><th>內容</th><th>站點</th><th>建立</th><th>到期</th><th>狀態</th></tr></thead>
      <tbody>${d.open_tasks.map(o => `<tr><td>${esc(o.staff)}</td><td>${esc(o.kind)}</td><td>${esc(o.title)}</td><td>${esc(o.site_id)}</td><td>${tw(o.created_at)}</td><td>${tw(o.due_at)}</td>
        <td>${o.overdue_h > 0 ? badge('逾期 ' + n1(o.overdue_h) + ' 時', 'r') : badge('處理中', 'y')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">沒有未結案待辦</div>'}</div>`;
}

// ================= 小元件 =================
const empty = () => '<div class="card empty">這個篩選條件下沒有資料</div>';
const kpi = (label, value, hint = '', t = '') => `<div class="kpi ${t ? 'k' + t : ''}"><span>${label}</span><b>${value}</b>${hint ? `<small>${hint}</small>` : ''}</div>`;
const bar = (v, t) => v == null ? '—' : `<span class="pbar ${t}"><span class="trk"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><em>${pct(v)}</em></span>`;
function hbars(items, { fmt = n0, max } = {}) {
  if (!items.length) return '<div class="empty">無資料</div>';
  const mx = max || Math.max(...items.map(i => +i.v || 0)) || 1;
  return `<div class="hbars">${items.map(i => `<div class="hb" data-tip="${esc(i.label)}：${esc(fmt(i.v))}"><span class="l">${esc(i.label)}</span>
    <span class="tr"><i style="width:${Math.max(0, (+i.v || 0) / mx * 100)}%;background:${ONE}"></i></span><span class="v">${fmt(i.v)}</span></div>`).join('')}</div>`;
}

// 折線圖（SVG，依實際寬度繪製）：單一 Y 軸；十字線＋提示框；≥2 條線有圖例＋線尾直接標名稱；可加目標虛線
let chartId = 0; const charts = {};
function line(labels, series, { fmt, min, max, half, target } = {}) {
  const id = 'c' + (++chartId); const f = fmt || n1;
  const bw = document.getElementById('rbody')?.clientWidth || 900, two = half && bw > 760;
  const multi = series.length > 1;
  const W = Math.max(300, Math.round((two ? (bw - 14) / 2 : bw) - 34)), H = 230, L = 58, R = multi ? 92 : 16, T = 12, B = 28;
  const vals = series.flatMap(s => s.values).filter(v => v != null).map(Number);
  if (target != null) vals.push(+target);
  if (!vals.length) return '<div class="empty">無資料</div>';
  let lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  const span = (hi - lo) || 1;
  if (min == null) lo -= span * 0.1; if (max == null) hi += span * 0.1;
  if (min == null && lo < 0 && Math.min(...vals) >= 0) lo = 0;   // 不出現負的刻度
  const x = i => L + (labels.length < 2 ? 0 : i * (W - L - R) / (labels.length - 1)), y = v => T + (hi - v) * (H - T - B) / (hi - lo);
  const ticks = [0, 1, 2, 3, 4].map(k => lo + (hi - lo) * k / 4);
  const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - L - R) / 64)));
  charts[id] = { labels, series, f, x, y, W, L, R };
  const path = s => { let out = '', pen = false; s.values.forEach((v, i) => { if (v == null) { pen = false; return; } out += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(+v).toFixed(1); pen = true; }); return out; };
  const lastIdx = s => { for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return i; return null; };
  const ends = series.filter(s => lastIdx(s) != null).map(s => ({ s, yy: y(+s.values[lastIdx(s)]) })).sort((a, b) => a.yy - b.yy);
  ends.forEach((e, i) => { if (i && e.yy - ends[i - 1].yy < 13) e.yy = ends[i - 1].yy + 13; });
  return `<div class="lc" data-chart="${id}">
    ${multi ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}${target != null ? '<span><i class="tgti"></i>目標</span>' : ''}</div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join('、'))}">
      ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${esc(f(t))}</text>`).join('')}
      ${labels.map((l, i) => i % every === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(l)}</text>` : '').join('')}
      ${target != null ? `<line x1="${L}" x2="${W - R}" y1="${y(+target)}" y2="${y(+target)}" class="tgt"/>` : ''}
      ${series.map(s => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
      ${multi ? ends.map(e => `<text x="${x(lastIdx(e.s)) + 6}" y="${e.yy + 4}" class="ax ink">${esc(e.s.name.length > 6 ? e.s.name.slice(0, 6) + '…' : e.s.name)}</text>`).join('') : ''}
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/>
      ${series.map((s, k) => `<circle class="dot" data-k="${k}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2" style="display:none"/>`).join('')}
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
    </svg></div>`;
}

function wire(body) {
  const tip = document.getElementById('rtip');
  const show = (e, html) => { tip.innerHTML = html; tip.style.display = 'block'; const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 8) + 'px'; tip.style.top = Math.min(e.clientY + 14, innerHeight - r.height - 8) + 'px'; };
  const hide = () => tip.style.display = 'none';
  body.querySelectorAll('[data-tip]').forEach(el => { el.onmousemove = e => show(e, el.dataset.tip); el.onmouseleave = hide; });
  body.querySelectorAll('.lc').forEach(el => {
    const c = charts[el.dataset.chart], svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
    const move = e => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * c.W, n = c.labels.length;
      const i = Math.max(0, Math.min(n - 1, Math.round((px - c.L) / ((c.W - c.L - c.R) / Math.max(n - 1, 1)))));
      xh.setAttribute('x1', c.x(i)); xh.setAttribute('x2', c.x(i)); xh.style.display = '';
      svg.querySelectorAll('.dot').forEach(d => { const v = c.series[d.dataset.k].values[i];
        if (v == null) { d.style.display = 'none'; return; } d.style.display = ''; d.setAttribute('cx', c.x(i)); d.setAttribute('cy', c.y(+v)); });
      show(e, `<b>${esc(c.labels[i])}</b>${c.series.map(s => `<div><i style="background:${s.color}"></i>${esc(s.name)}：${s.values[i] == null ? '—' : esc(c.f(s.values[i]))}</div>`).join('')}`);
    };
    const hit = svg.querySelector('.hit'); hit.onmousemove = move;
    hit.onmouseleave = () => { hide(); xh.style.display = 'none'; svg.querySelectorAll('.dot').forEach(d => d.style.display = 'none'); };
  });
  body.querySelectorAll('.kc').forEach(b => b.onclick = () => { hide(); st.focus = null;
    if (['revenue', 'cost', 'gp'].includes(b.dataset.kpi)) st.tab = 'money'; else { st.kpi = b.dataset.kpi; st.tab = 'analysis'; } load(); });
  const k = body.querySelector('#rkpi'); if (k) k.onchange = () => { st.kpi = k.value; st.focus = null; load(); };
  body.querySelectorAll('#rdim button').forEach(b => b.onclick = () => { st.dim = b.dataset.dim; st.focus = null; load(); });
  body.querySelectorAll('#rmdim button').forEach(b => b.onclick = () => { st.mdim = b.dataset.mdim; load(); });
  body.querySelectorAll('#rank input[type=checkbox]').forEach(cb => cb.onchange = () => {
    const kk = cb.dataset.k;
    if (cb.checked) { if (st.pick.keys.length >= 4) { cb.checked = false; return ui.toast('最多同時比較 4 個，請先取消一個'); } st.pick.keys.push(kk); }
    else st.pick.keys = st.pick.keys.filter(x => x !== kk);
    const y0 = scrollY; body.innerHTML = vAnalysis(last.d, last.all); wire(body); scrollTo(0, y0);
    if (st.focus) loadDetail();
  });
  body.querySelectorAll('.clink[data-focus]').forEach(a => a.onclick = e => { e.preventDefault(); st.focus = a.dataset.focus;
    body.querySelectorAll('#rank tr').forEach(t => t.classList.toggle('sel', t.contains(a))); loadDetail(); });
}

// ---------------- 匯出 CSV（目前畫面的主要表格） ----------------
function exportCsv() {
  if (!last) return;
  const { tab, d } = last; let rows, name;
  const dn = DIMS.find(x => x[0] === st.dim)?.[1];
  if (tab === 'overview') { rows = d.kpis.map(k => ({ 指標: k.label, 單位: k.unit, 數值: k.value, 前期: k.prev, 目標: k.target, 狀態: RAGTXT[rag(k, k.value)] || '' })); name = '指標總覽'; }
  else if (tab === 'analysis') {
    const L = defOf(st.kpi).label;
    if (st.focus && last.detail?.length) { rows = last.detail; name = `${L}_明細`; }
    else { rows = d.rows.map(r => ({ [dn]: r.label, [L]: r.value, 前期: r.prev, 樣本: r.n, 分子: r.num, 分母: r.den })); name = `${L}_依${dn}`; }
  }
  else if (tab === 'volume') { rows = d.vehicles; name = '車輛週轉'; }
  else if (tab === 'money') { const [rev, cost, gp, mg] = d; rows = rev.rows.map(r => ({ 名稱: r.label, 趟數: r.n, 營收: r.value, 成本: cost.rows.find(x => x.key === r.key)?.value, 毛利: gp.rows.find(x => x.key === r.key)?.value, 毛利率: mg.rows.find(x => x.key === r.key)?.value })); name = '營收成本'; }
  else { rows = [...d.staff, ...d.open_tasks]; name = '管理同仁待辦'; }
  if (!rows?.length) return ui.toast('沒有資料可匯出', true);
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => k !== 'id' && k !== 'key');
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = '﻿' + [cols.join(','), ...rows.map(r => cols.map(k => q(r[k])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `FlowTower_${name}_近${st.days}天.csv`; a.click(); URL.revokeObjectURL(a.href);
}
