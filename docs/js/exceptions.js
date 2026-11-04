import { api, master, fmtT, fmtHM, esc } from './api.js';

let TAB = 'exc';
const KIND = { queue_at_fab: '廠內排隊', late: '塞車／延誤', damage: '貨損', shortage_qty: '數量不符', reject: '客戶拒收', address: '地址／碼頭錯誤', vehicle_breakdown: '車輛故障', other: '其他' };
const SEV = { low: ['低', ''], mid: ['中', 'y'], high: ['高', 'r'] };
const EST = { open: ['待處理', 'r'], handling: ['處理中', 'y'], closed: ['已結案', 'g'] };
const REASON = {
  true_capacity: ['真的沒車', '車隊數量不足以應付當下需求'],
  stuck_in_fab: ['車卡在廠內', '車輛在晶圓廠排隊，回不來接下一趟'],
  burst_orders: ['同時大量下單', '短時間內湧入多張單'],
  no_consolidation: ['沒有併單', '同廠同時段的單分開叫車'],
  driver_absent: ['司機缺勤', '有車沒人開'],
  other: ['其他', ''],
};
const SST = { open: ['待處理', 'r'], covered_cross_site: ['跨倉補上', 'g'], covered_extra: ['加派外車', 'y'], unresolved: ['未解決', 'r'] };
const badge = ([t, c]) => `<span class="badge ${c}">${t}</span>`;

export async function render(ui) {
  const M = await master();
  ui.head('異常／缺車', '把現場問題變成可追蹤、可統計的數據');
  const a = ui.actions('<button class="btn warn" id="newS">＋ 通報缺車</button>');
  a.querySelector('#newS').onclick = () => shortageForm(ui, M, load);
  const v = ui.view(`<div class="kpis" id="kp"></div>
    <div class="tabs"><button data-t="exc">配送異常</button><button data-t="short">缺車通報</button><button data-t="ana">缺車分析</button></div><div id="pane"></div>`);
  v.querySelector('.tabs').onclick = e => { const t = e.target.dataset.t; if (t) { TAB = t; load(); } };

  async function load() {
    v.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === TAB));
    const [ex, sr] = await Promise.all([
      api.get('exceptions', 'select=*,orders(order_no,site_id,location_id,customer_id),trips(trip_no,drivers(name,phone),vehicles(plate))&order=created_at.desc&limit=200'),
      api.get('vehicle_shortage_reports', 'select=*,vehicles:covered_by_vehicle(plate)&order=created_at.desc&limit=500'),
    ]);
    const openEx = ex.filter(x => x.status !== 'closed'), weekSr = sr.filter(x => Date.now() - new Date(x.created_at) < 7 * 864e5);
    const covered = weekSr.filter(x => x.status.startsWith('covered')).length;
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>未結案異常</span><b style="color:var(--r)">${openEx.length}</b></div>
      <div class="kpi"><span>高嚴重度</span><b>${openEx.filter(x => x.severity === 'high').length}</b></div>
      <div class="kpi"><span>近 7 天缺車通報</span><b>${weekSr.length}</b></div>
      <div class="kpi"><span>缺車補上率</span><b style="color:var(--g)">${weekSr.length ? Math.round(covered / weekSr.length * 100) : 0}%</b></div>
      <div class="kpi"><span>非真缺車占比</span><b style="color:var(--teal)">${weekSr.length ? Math.round(weekSr.filter(x => x.reason_tag !== 'true_capacity').length / weekSr.length * 100) : 0}%</b></div>`;
    const pane = v.querySelector('#pane');
    if (TAB === 'exc') excPane(pane, ex); else if (TAB === 'short') shortPane(pane, sr); else anaPane(pane, sr);
  }

  function excPane(pane, ex) {
    if (!ex.length) { pane.innerHTML = '<div class="card empty">目前沒有異常 👍<br><span style="font-size:12px">司機在 App 按「回報異常」就會出現在這裡</span></div>'; return; }
    pane.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>時間</th><th>類型</th><th>嚴重度</th><th>訂單</th><th>送達點</th><th>司機</th><th>說明</th><th>狀態</th></tr></thead><tbody>
      ${ex.map(x => `<tr class="click" data-id="${x.id}"><td class="mono">${fmtT(x.created_at)}</td><td>${KIND[x.kind] || x.kind}</td><td>${badge(SEV[x.severity] || ['?', ''])}</td>
      <td class="mono">${x.orders?.order_no || ''}</td><td>${esc(M.loc[x.orders?.location_id]?.name || '')}</td><td>${esc(x.trips?.drivers?.name || x.reported_by || '')}</td>
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(x.description || '')}</td><td>${badge(EST[x.status])}</td></tr>`).join('')}</tbody></table></div>`;
    pane.onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) excDetail(ex.find(x => x.id === tr.dataset.id)); };
  }

  function excDetail(x) {
    const d = ui.drawer(`異常・${KIND[x.kind] || x.kind}`, `${badge(SEV[x.severity])} ${badge(EST[x.status])}`, `
      <div class="grid" style="grid-template-columns:1fr 1fr;font-size:13px">
        <div><span class="mut">訂單</span><br><a href="#oms?id=${x.order_id}" class="mono">${x.orders?.order_no || '—'}</a></div>
        <div><span class="mut">車單</span><br><span class="mono">${x.trips?.trip_no || '—'}</span></div>
        <div><span class="mut">司機</span><br>${esc(x.trips?.drivers?.name || '—')} ${x.trips?.drivers?.phone ? `<span class="mono">${x.trips.drivers.phone}</span>` : ''}</div>
        <div><span class="mut">車輛</span><br>${x.trips?.vehicles?.plate || '—'}</div>
        <div><span class="mut">送達點</span><br>${esc(M.loc[x.orders?.location_id]?.name || '—')}</div>
        <div><span class="mut">通報時間</span><br>${fmtT(x.created_at)}</div>
      </div>
      <div class="sec">現場說明</div><div>${esc(x.description || '—')}</div>
      ${x.photo_url ? `<div class="sec">照片</div><div class="mut">📷 ${esc(x.photo_url.replace('demo://', ''))}（Demo 未上傳）</div>` : ''}
      ${x.resolution ? `<div class="sec">處理結果</div><div>${esc(x.resolution)}</div>` : ''}
      ${x.status !== 'closed' ? `<div class="sec">處理方式</div><textarea id="res" rows="3" style="width:100%" placeholder="例：已聯絡客戶改收貨時間／已安排補貨">${esc(x.resolution || '')}</textarea>
        ${x.severity === 'high' ? '<p class="mut" style="font-size:12px;margin-top:6px">⚠ 高嚴重度異常結案需主管核准，會送到「專案管理平台 → 等你核准」</p>' : ''}` : ''}`,
      x.status === 'closed' ? '' : `${x.status === 'open' ? '<button class="btn" id="hd">標記處理中</button>' : ''}<button class="btn pri" id="cl">${x.severity === 'high' ? '送審結案' : '結案'}</button>`);
    d.querySelector('#hd')?.addEventListener('click', async () => { await ui.guard(() => api.update('exceptions', `id=eq.${x.id}`, { status: 'handling', resolution: d.querySelector('#res').value || null }), '已標記處理中'); ui.closeDrawer(); load(); });
    d.querySelector('#cl')?.addEventListener('click', async () => {
      const res = d.querySelector('#res').value.trim(); if (!res) return ui.toast('請先填寫處理方式', true);
      if (x.severity === 'high') {
        await ui.guard(async () => {
          await api.update('exceptions', `id=eq.${x.id}`, { status: 'handling', resolution: res });
          await api.insert('approvals', [{ kind: 'exception_close', ref_id: x.id, title: `結案：${KIND[x.kind]}・${x.orders?.order_no || ''}`, requested_by: '調度' }]);
        }, '已送主管核准');
      } else await ui.guard(() => api.update('exceptions', `id=eq.${x.id}`, { status: 'closed', resolution: res, closed_at: new Date().toISOString() }), '已結案');
      ui.closeDrawer(); load();
    });
  }

  function shortPane(pane, sr) {
    pane.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>通報時間</th><th>庫房</th><th>需求車種</th><th>需要時間</th><th>原因</th><th>通報人</th><th>處理結果</th><th></th></tr></thead><tbody>
      ${sr.map(x => `<tr><td class="mono">${fmtT(x.created_at)}</td><td>${x.site_id}</td><td>${x.type_code || ''}</td><td class="mono">${fmtT(x.needed_at)}</td><td>${REASON[x.reason_tag]?.[0] || '—'}</td><td>${esc(x.reported_by || '')}</td>
      <td>${badge(SST[x.status] || [x.status, ''])}${x.vehicles?.plate ? ` <span class="mut mono">${x.vehicles.plate}</span>` : ''}</td>
      <td>${x.status === 'open' ? `<button class="btn sm" data-s="${x.id}">處理</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">沒有缺車通報</td></tr>'}</tbody></table></div>`;
    pane.onclick = e => { const id = e.target.dataset?.s; if (id) resolveShort(sr.find(x => x.id === id)); };
  }

  function resolveShort(x) {
    const d = ui.drawer(`處理缺車・${x.site_id}`, badge(SST[x.status]), `
      <p style="margin-bottom:10px">${x.site_id} 需要 <b>${x.type_code || ''}</b>，時間 <b class="mono">${fmtT(x.needed_at)}</b></p>
      <label class="f">原因（現場判斷，可修正）<select id="rs">${Object.entries(REASON).map(([k, [t, h]]) => `<option value="${k}" ${k === x.reason_tag ? 'selected' : ''}>${t}${h ? '－' + h : ''}</option>`).join('')}</select></label>
      <div class="sec">怎麼補上？</div>
      <div class="grid">
        <a class="btn pri" href="#fleet?site=${x.site_id}" style="text-align:center;text-decoration:none">🚛 到「車輛資源」調一台跨倉支援</a>
        <button class="btn" id="ext">已加派外車</button>
        <button class="btn" id="un">未解決（記錄下來）</button>
      </div>`);
    const save = async st => { await ui.guard(() => api.update('vehicle_shortage_reports', `id=eq.${x.id}`, { status: st, reason_tag: d.querySelector('#rs').value, resolved_at: new Date().toISOString() }), '已更新'); ui.closeDrawer(); load(); };
    d.querySelector('#ext').onclick = () => save('covered_extra'); d.querySelector('#un').onclick = () => save('unresolved');
  }

  function anaPane(pane, sr) {
    if (!sr.length) { pane.innerHTML = '<div class="card empty">還沒有缺車資料</div>'; return; }
    const cnt = (arr, key) => arr.reduce((m, x) => { const k = key(x); m[k] = (m[k] || 0) + 1; return m; }, {});
    const bars = (obj, label, color, total) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
      `<div style="margin:8px 0"><div class="row" style="font-size:13px"><span>${label(k)}</span><span class="mut" style="margin-left:auto">${n} 次・${Math.round(n / total * 100)}%</span></div>
       <div style="height:10px;background:#eef0f4;border-radius:6px;margin-top:4px"><div style="height:100%;width:${n / total * 100}%;background:${typeof color === 'function' ? color(k) : color};border-radius:6px"></div></div></div>`).join('');
    const N = sr.length, byR = cnt(sr, x => x.reason_tag || 'other'), byS = cnt(sr, x => x.site_id), byH = cnt(sr, x => new Date(x.needed_at || x.created_at).getHours());
    const top = Object.entries(byR).sort((a, b) => b[1] - a[1])[0];
    const notTrue = sr.filter(x => x.reason_tag !== 'true_capacity').length;
    const fixable = (byR.stuck_in_fab || 0) + (byR.no_consolidation || 0) + (byR.burst_orders || 0);
    const hours = Array.from({ length: 24 }, (_, h) => byH[h] || 0), mx = Math.max(...hours, 1);
    pane.innerHTML = `
      <div class="card" style="margin-bottom:14px;background:#f0faf8;border-color:#bfe8e1">
        <b>📊 結論</b><p style="margin-top:6px;line-height:1.7">共 ${N} 筆缺車通報，<b>${Math.round(notTrue / N * 100)}% 不是真的缺車</b>。最大原因是「${REASON[top[0]]?.[0]}」（${Math.round(top[1] / N * 100)}%）。
        其中 <b>${fixable} 筆（${Math.round(fixable / N * 100)}%）可以靠流程改善</b>：併單規則、錯開下單時間、掌握廠內排隊狀況，不必直接加車。</p></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <div class="card"><b>原因分佈</b>${bars(byR, k => REASON[k]?.[0] || k, k => k === 'true_capacity' ? 'var(--r)' : 'var(--teal)', N)}</div>
        <div class="card"><b>各庫房通報次數</b>${bars(byS, k => M.site[k]?.name || k, 'var(--b)', N)}</div>
        <div class="card" style="grid-column:1/-1"><b>發生時段</b><div style="display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:12px">
          ${hours.map((n, h) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px"><div title="${h}:00 ${n} 次" style="width:100%;height:${n / mx * 100}px;background:${n ? 'var(--y)' : '#eef0f4'};border-radius:4px 4px 0 0;min-height:2px"></div><span class="mut" style="font-size:10px">${h}</span></div>`).join('')}</div></div>
      </div>`;
  }

  await load();
  return load;
}

function shortageForm(ui, M, reload) {
  const t = new Date(Date.now() + 60 * 60000); t.setMinutes(0, 0, 0);
  const d = ui.drawer('通報缺車', '', `
    <p class="mut" style="margin-bottom:12px">每一次叫不到車都記下來，月底就能看出真正的原因，而不是靠感覺。</p>
    <div class="grid">
      <label class="f">庫房<select id="s">${M.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="f">需要的車種<select id="ty">${M.vtypes.map(x => `<option>${x.code}</option>`).join('')}</select></label>
      <label class="f">需要的時間<input type="datetime-local" id="at" value="${new Date(t - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></label>
      <label class="f">你判斷的原因<select id="rs">${Object.entries(REASON).map(([k, [n, h]]) => `<option value="${k}">${n}${h ? '－' + h : ''}</option>`).join('')}</select></label>
      <label class="f">通報人<input id="by" value="庫房出貨員"></label>
    </div>`, '<button class="btn warn" id="ok">送出通報</button>');
  d.querySelector('#ok').onclick = async () => {
    await ui.guard(() => api.insert('vehicle_shortage_reports', [{ site_id: d.querySelector('#s').value, type_code: d.querySelector('#ty').value, needed_at: new Date(d.querySelector('#at').value).toISOString(), reason_tag: d.querySelector('#rs').value, reported_by: d.querySelector('#by').value, status: 'open' }]), '已通報，調度會收到');
    ui.closeDrawer(); reload();
  };
}
