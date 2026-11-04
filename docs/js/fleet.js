import { api, master, fmtT, fmtHM, esc } from './api.js';

const ST = { idle: ['可用', 'g'], assigned: ['已派車', 't'], on_trip: ['配送中', 'b'], returning: ['回程', ''], off: ['休息', ''], maintenance: ['保養', 'y'] };
const REGION_ORDER = ['北區', '竹區', '中區', '南區'];
let HOURS = 4;
const ROUND_MIN = 120; // 一趟來回（含裝卸）平均分鐘，正式版改用歷史資料計算

export async function render(ui) {
  const M = await master();
  ui.head('車輛資源', `看未來幾小時哪裡缺車、哪裡有空車，直接跨倉調度（以一趟來回 ${ROUND_MIN} 分鐘估算產能）`);
  const a = ui.actions(`<label class="row" style="gap:6px;font-size:13px">預估未來<select id="h">${[2, 4, 8].map(h => `<option ${h === HOURS ? 'selected' : ''}>${h}</option>`).join('')}</select>小時</label>`);
  a.querySelector('#h').onchange = e => { HOURS = +e.target.value; load(); };
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('site');
  const v = ui.view(`<div class="kpis" id="kp"></div><div id="sug"></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));margin-top:14px" id="sites"></div>
    <div class="card" style="margin-top:14px"><b>進行中的跨倉支援</b><div id="moves" style="margin-top:8px"></div></div>`);

  async function load() {
    const until = new Date(Date.now() + HOURS * 3600e3).toISOString();
    const [vehicles, orders, moves, shorts] = await Promise.all([
      api.get('vehicles', 'select=*,drivers(name)&order=home_site,plate'),
      api.get('orders', `select=id,site_id,location_id,req_depart_at,trip_orders(trip_id)&status=in.(created,released,picking,picked)&req_depart_at=lte.${until}`),
      api.get('vehicle_moves', 'select=*,vehicles(plate,type_code)&end_at=is.null&order=created_at.desc'),
      api.get('vehicle_shortage_reports', 'select=site_id&status=eq.open'),
    ]);
    // 需求趟數：未派車的單，同庫房同送達點 45 分鐘內視為一趟（已扣除併單）
    const need = {};
    const pend = orders.filter(o => !o.trip_orders.length).sort((x, y) => new Date(x.req_depart_at) - new Date(y.req_depart_at));
    const groups = {};
    pend.forEach(o => { const k = o.site_id + '|' + o.location_id; const g = groups[k] ||= []; const last = g[g.length - 1];
      if (last && new Date(o.req_depart_at) - new Date(last[0].req_depart_at) <= 45 * 60000) last.push(o); else g.push([o]); });
    Object.entries(groups).forEach(([k, gs]) => { const s = k.split('|')[0]; need[s] = (need[s] || 0) + gs.length; });
    const rawNeed = pend.reduce((m, o) => (m[o.site_id] = (m[o.site_id] || 0) + 1, m), {});
    const openShort = shorts.reduce((m, x) => (m[x.site_id] = (m[x.site_id] || 0) + 1, m), {});
    // 產能：空車可跑 floor(H/來回)，出勤中的車回來後還能跑 floor((H−1h)/來回)
    const per = Math.max(1, Math.floor(HOURS * 60 / ROUND_MIN)), perBusy = Math.max(0, Math.floor((HOURS * 60 - 60) / ROUND_MIN));
    const rows = M.sites.map(s => { const vs = vehicles.filter(x => x.home_site === s.id); const idle = vs.filter(x => x.status === 'idle').length;
      const busy = vs.filter(x => ['assigned', 'on_trip', 'returning'].includes(x.status)).length, cap = idle * per + busy * perBusy;
      return { s, vs, idle, cap, need: need[s.id] || 0, raw: rawNeed[s.id] || 0, gap: cap - (need[s.id] || 0), short: openShort[s.id] || 0 }; });
    // 調度建議：缺的庫房從同區／鄰近區有餘車的庫房借
    const sug = [], unmet = [];
    const surplus = rows.filter(r => r.gap > 0).map(r => ({ ...r, left: r.gap }));
    rows.filter(r => r.gap < 0).sort((x, y) => x.gap - y.gap).forEach(r => {
      let lack = -r.gap;
      const ri = REGION_ORDER.indexOf(r.s.region);
      surplus.sort((x, y) => Math.abs(REGION_ORDER.indexOf(x.s.region) - ri) - Math.abs(REGION_ORDER.indexOf(y.s.region) - ri)).forEach(sp => {
        while (lack > 0 && sp.left >= per) { const veh = vehicles.find(x => x.home_site === sp.s.id && x.status === 'idle' && !sug.some(g => g.veh.id === x.id)); if (!veh) break;
          sug.push({ from: sp.s, to: r.s, veh }); sp.left -= per; lack -= per; } });
      if (lack > 0) unmet.push({ s: r.s, lack });
    });
    const totalIdle = rows.reduce((a, r) => a + r.idle, 0), totalNeed = rows.reduce((a, r) => a + r.need, 0), totalRaw = rows.reduce((a, r) => a + r.raw, 0);
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>可用車輛</span><b style="color:var(--g)">${totalIdle}<span class="mut" style="font-size:14px"> / ${vehicles.length}</span></b></div>
      <div class="kpi"><span>未來 ${HOURS} 小時 需求／產能</span><b>${totalNeed}<span class="mut" style="font-size:14px"> / ${rows.reduce((a, r) => a + r.cap, 0)} 趟</span></b></div>
      <div class="kpi"><span>併單後少叫的車次</span><b style="color:var(--teal)">${totalRaw - totalNeed}</b></div>
      <div class="kpi"><span>會缺車的庫房</span><b style="color:var(--r)">${rows.filter(r => r.gap < 0).length}</b></div>
      <div class="kpi"><span>跨倉支援中</span><b>${moves.length}</b></div>`;
    v.querySelector('#sug').innerHTML = sug.length ? `<div class="card" style="border-color:#bfe8e1;background:#f0faf8"><b>💡 調度建議（${sug.length}）</b>
      ${sug.map((g, i) => `<div class="row" style="margin-top:8px;font-size:13px"><span>${esc(g.from.name)} → <b>${esc(g.to.name)}</b></span><span class="mono">${g.veh.plate}</span><span class="badge">${g.veh.type_code}</span><button class="btn sm pri" data-sug="${i}" style="margin-left:auto">執行調度</button></div>`).join('')}</div>`
      : unmet.length ? '' : `<div class="card" style="background:#f3faf5;border-color:#cdebd8">✅ 未來 ${HOURS} 小時各庫房產能足夠，不需要跨倉調度</div>`;
    if (unmet.length) v.querySelector('#sug').insertAdjacentHTML('beforeend', `<div class="card" style="margin-top:10px;background:#fff5f5;border-color:#f5c2c2"><b>🚨 跨倉也補不齊</b>
      <div style="margin-top:6px;font-size:13px">${unmet.map(u => `${esc(u.s.name)} 還差 <b>${u.lack}</b> 趟`).join('、')}。建議：先看「TMS → 併單建議」，仍不足再加派外車，並送出缺車通報留下紀錄。</div></div>`);
    v.querySelector('#sites').innerHTML = rows.map(r => `<div class="card" ${want === r.s.id ? 'style="box-shadow:0 0 0 3px var(--teal2);border-color:var(--teal)"' : ''}>
      <div class="row"><b>${esc(r.s.name)}</b><span class="mut" style="font-size:12px">${r.s.region}</span>${r.short ? `<span class="badge r" style="margin-left:auto">缺車通報 ${r.short}</span>` : ''}</div>
      <div class="row" style="margin:10px 0;font-size:13px"><div>可跑 <b style="font-size:20px;color:var(--g)">${r.cap}</b> 趟<div class="mut" style="font-size:11px">空車 ${r.idle}・出勤 ${r.vs.filter(x => ['assigned', 'on_trip', 'returning'].includes(x.status)).length}${r.vs.some(x => ['off', 'maintenance'].includes(x.status)) ? `・停用 ${r.vs.filter(x => ['off', 'maintenance'].includes(x.status)).length}` : ''}</div></div><div>需求 <b style="font-size:20px">${r.need}</b> 趟${r.raw > r.need ? `<span class="mut" style="font-size:11px">（原 ${r.raw}）</span>` : ''}</div>
      <div style="margin-left:auto">${r.gap < 0 ? `<span class="badge r">缺 ${-r.gap}</span>` : r.gap > 0 ? `<span class="badge g">餘 ${r.gap}</span>` : '<span class="badge">剛好</span>'}</div></div>
      ${r.vs.map(x => `<div class="row" style="font-size:12.5px;padding:4px 0;border-top:1px dashed var(--line)"><span class="mono">${x.plate}</span><span class="badge">${x.type_code}</span><span class="mut">${esc(x.drivers?.[0]?.name || '')}</span>
        <select data-v="${x.id}" style="margin-left:auto;padding:2px 6px;font-size:12px" ${['assigned', 'on_trip'].includes(x.status) ? 'disabled' : ''}>${Object.entries(ST).map(([k, [t]]) => `<option value="${k}" ${k === x.status ? 'selected' : ''} ${['assigned', 'on_trip'].includes(k) ? 'disabled' : ''}>${t}</option>`).join('')}</select></div>`).join('')}</div>`).join('');
    v.querySelector('#moves').innerHTML = moves.length ? `<table class="t">${moves.map(m => `<tr><td class="mono">${m.vehicles?.plate}</td><td>${m.vehicles?.type_code}</td><td>${m.from_site} → <b>${m.to_site}</b></td><td class="mut">${esc(m.reason || '')}</td><td class="mono">${fmtT(m.start_at)}</td><td><button class="btn sm" data-back="${m.id}">歸建</button></td></tr>`).join('')}</table>` : '<div class="mut">目前沒有</div>';

    v.onclick = async e => {
      const i = e.target.dataset?.sug, back = e.target.dataset?.back;
      if (i !== undefined) { const g = sug[+i]; e.target.disabled = true;
        await ui.guard(async () => {
          await api.insert('vehicle_moves', [{ vehicle_id: g.veh.id, from_site: g.from.id, to_site: g.to.id, start_at: new Date().toISOString(), reason: `支援 ${g.to.id} 未來 ${HOURS} 小時需求`, approved_by: '調度' }]);
          await api.update('vehicles', `id=eq.${g.veh.id}`, { home_site: g.to.id });
          await api.update('vehicle_shortage_reports', `site_id=eq.${g.to.id}&status=eq.open`, { status: 'covered_cross_site', covered_by_vehicle: g.veh.id, resolved_at: new Date().toISOString() });
        }, `${g.veh.plate} 已調到 ${g.to.name}`); load(); }
      if (back) { const m = moves.find(x => x.id === back);
        await ui.guard(async () => {
          await api.update('vehicle_moves', `id=eq.${m.id}`, { end_at: new Date().toISOString() });
          await api.update('vehicles', `id=eq.${m.vehicle_id}`, { home_site: m.from_site });
        }, `${m.vehicles?.plate} 已歸建 ${m.from_site}`); load(); }
    };
    v.onchange = async e => { const id = e.target.dataset?.v; if (!id) return;
      await ui.guard(() => api.update('vehicles', `id=eq.${id}`, { status: e.target.value }), '車輛狀態已更新'); load(); };
  }
  await load();
  return load;
}
