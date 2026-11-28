import { api, master, flagOf, STATUS, fmtT, fmtHM, esc, inList } from './api.js';
import { planMerges } from './plan.js';

let SITE = '', TAB = 'plan';
const TRIP_ST = { planned: '規劃中', dispatched: '已派車', handover: '已交車', departed: '配送中', arrived: '已抵達', completed: '已完成', exception: '異常', cancelled: '已取消' };
const tripBadge = s => `<span class="badge ${s === 'completed' ? 'g' : s === 'departed' || s === 'arrived' ? 'b' : s === 'exception' ? 'r' : 't'}">${TRIP_ST[s] || s}</span>`;
const EV = { handover: '交車', depart: '出發', arrive_gate: '抵達哨口', arrive_dock: '抵達碼頭', delivered: '完成交貨', exception: '異常', backfill: '補登' };

export async function render(ui) {
  const M = await master();
  const rank = Object.fromEntries(M.vtypes.map(t => [t.code, t.rank]));
  ui.head('TMS 調度', '派車、併單、車趟追蹤');
  const a = ui.actions(`<select id="site"><option value="">全部庫房</option>${M.sites.map(s => `<option value="${s.id}" ${s.id === SITE ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`);
  a.querySelector('#site').onchange = e => { SITE = e.target.value; load(); };
  const v = ui.view(`<div class="kpis" id="kp"></div>
    <div class="tabs"><button data-t="plan">待派車</button><button data-t="merge">併單建議</button><button data-t="trips">車趟</button><button data-t="fleet">車輛狀態</button></div><div id="pane"></div>`);
  v.querySelector('.tabs').onclick = e => { const t = e.target.dataset.t; if (t) { TAB = t; load(); } };

  let D = {};
  async function load() {
    v.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === TAB));
    const sf = SITE ? `&site_id=eq.${SITE}` : '';
    const since = new Date(Date.now() - 18 * 3600e3).toISOString();
    const [orders, trips, vehicles, settings, rates] = await Promise.all([
      api.get('orders', `select=*,trip_orders(trip_id)&status=in.(released,picking,picked)${sf}&order=req_depart_at`),
      api.get('trips', `select=*,vehicles(plate,type_code,home_site),drivers(name,phone),trip_orders(order_id,stop_seq,orders(order_no,location_id,status,req_arrive_at,customer_id))&planned_depart_at=gte.${since}${sf}&order=planned_depart_at.desc&limit=200`),
      api.get('vehicles', `select=*,drivers(id,name)&order=home_site,plate`),
      api.get('control_settings', 'select=key,value').catch(() => []),
      api.get('rate_cards', 'select=from_site,location_id,type_code,cost').catch(() => []),
    ]);
    D = { open: orders.filter(o => !o.trip_orders.length), trips, vehicles, rates,
      S: Object.fromEntries(settings.map(x => [x.key, +x.value])) };
    D.merges = planMerges(M, D.S, D.open, rates);
    const act = trips.filter(t => ['dispatched', 'handover', 'departed', 'arrived'].includes(t.status));
    const vs = SITE ? vehicles.filter(x => x.home_site === SITE) : vehicles;
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>待派車訂單</span><b>${D.open.length}</b></div>
      <div class="kpi"><span>🔴 待派車且紅燈</span><b style="color:var(--r)">${D.open.filter(o => flagOf(o)[0] === 'r').length}</b></div>
      <div class="kpi"><span>進行中車趟</span><b>${act.length}</b></div>
      <div class="kpi"><span>可用車輛</span><b style="color:var(--g)">${vs.filter(x => x.status === 'idle').length}<span class="mut" style="font-size:14px"> / ${vs.length}</span></b></div>
      <div class="kpi"><span>併車可省</span><b style="color:var(--teal)">${D.merges.reduce((s, g) => s + g.saved_trips, 0)} 趟</b><small class="mut">約 NT$ ${D.merges.reduce((s, g) => s + g.saved_cost, 0).toLocaleString()}</small></div>`;
    const pane = v.querySelector('#pane');
    ({ plan: planPane, merge: mergePane, trips: tripsPane, fleet: fleetPane })[TAB](pane);
  }

  function orderRow(o, chk) { const f = flagOf(o);
    return `<tr><td>${chk ? `<input type="checkbox" data-o="${o.id}">` : ''}</td><td><span class="badge ${f[0]}"><span class="dot ${f[0]}"></span>${f[1]}</span></td><td class="mono">${o.order_no}</td><td>${o.site_id}</td><td>${esc(M.cust[o.customer_id]?.name)}</td><td>${esc(M.loc[o.location_id]?.name)}</td><td>${o.type_code}</td><td class="mono">${fmtT(o.req_depart_at)}</td><td><span class="badge">${STATUS[o.status]}</span></td></tr>`; }

  function planPane(pane) {
    if (!D.open.length) { pane.innerHTML = '<div class="card empty">目前沒有待派車的訂單 👍</div>'; return; }
    pane.innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn pri" id="go" disabled>派車（已選 0 張）</button><span class="mut" style="font-size:12px">勾選同一庫房的訂單，可以一趟車送多個點（續點）</span></div>
      <div class="tw"><table class="t"><thead><tr><th></th><th>燈號</th><th>訂單號</th><th>庫房</th><th>客戶</th><th>送達點</th><th>車種</th><th>要求出車</th><th>倉庫進度</th></tr></thead><tbody>${D.open.map(o => orderRow(o, true)).join('')}</tbody></table></div>`;
    const sel = () => [...pane.querySelectorAll('input[data-o]:checked')].map(i => D.open.find(o => o.id === i.dataset.o));
    pane.onchange = () => { const s = sel(); const b = pane.querySelector('#go'); b.disabled = !s.length; b.textContent = `派車（已選 ${s.length} 張）`; };
    pane.querySelector('#go').onclick = () => { const s = sel(); if (new Set(s.map(o => o.site_id)).size > 1) return ui.toast('一趟車只能從同一個庫房出發', true); dispatch(s); };
  }

  function mergePane(pane) {
    const gs = D.merges, S = { merge_window: 60, merge_detour: 30, merge_max_stops: 3, unload_min: 20, ...D.S };
    const rule = `規則：同庫房、出車時間相差 ${S.merge_window} 分鐘內；不同送達點只要繞路 ≤ ${S.merge_detour} 分鐘也能併；每一站都要趕得上 ETA、總重量 ≤ 車輛載重、一趟最多 ${S.merge_max_stops} 個送達點（門檻可在「派車規則維護」調整）`;
    if (!gs.length) { pane.innerHTML = `<div class="card empty">目前沒有可合併的訂單<br><span style="font-size:12px">${rule}</span></div>`; return; }
    pane.innerHTML = `<p class="mut" style="margin-bottom:10px;font-size:13px">${rule}。依省下的成本排序。</p>` +
      gs.map((g, i) => `<div class="card mg" style="margin-bottom:12px">
        <div class="row" style="flex-wrap:wrap;gap:8px"><b>${g.site} → ${g.stops.map(s => esc(M.loc[s.loc]?.name)).join(' → ')}</b>
          <span class="badge t">省 ${g.saved_trips} 趟</span><span class="badge g">省 NT$ ${g.saved_cost.toLocaleString()}</span>
          <span class="badge">${g.type}・${g.weight.toLocaleString()} / ${g.cap.toLocaleString()} kg</span>
          ${g.stops.length > 1 ? `<span class="badge ${g.detour > S.merge_detour * 0.7 ? 'y' : ''}">繞路 ${g.detour} 分</span>` : '<span class="badge">同一送達點</span>'}
          <span style="flex:1"></span><button class="btn pri sm" data-g="${i}">合併派車</button></div>
        <div class="tw" style="margin-top:8px"><table class="t"><thead><tr><th>順序</th><th>送達點</th><th>訂單</th><th>重量</th><th>要求出車</th><th>指定送達</th><th>推算抵達</th><th></th></tr></thead><tbody>
        ${g.stops.map((s, k) => s.orders.map((o, j) => `<tr>${j === 0 ? `<td rowspan="${s.orders.length}"><b>${k + 1}</b></td><td rowspan="${s.orders.length}">${esc(M.loc[s.loc]?.name)}</td>` : ''}
          <td class="mono">${o.order_no}</td><td>${(+o.weight_kg || 0).toLocaleString()} kg</td><td class="mono">${fmtHM(o.req_depart_at)}</td><td class="mono">${fmtHM(o.req_arrive_at)}</td>
          ${j === 0 ? `<td rowspan="${s.orders.length}" class="mono">${fmtHM(s.eta)}</td><td rowspan="${s.orders.length}"><span class="badge g">趕得上</span></td>` : ''}</tr>`).join('')).join('')}
        </tbody></table></div>
        <div class="mut" style="font-size:12px;margin-top:6px">合併後 ${fmtHM(g.dep)} 一起出車；分開叫車約 NT$ ${g.cost_sep.toLocaleString()}，合併約 NT$ ${g.cost_merged.toLocaleString()}
          ${g.prep.length ? `<br>⚠ 倉庫要提前備貨：${g.prep.map(p => `${p.o.order_no} 提前 ${p.min} 分鐘`).join('、')}` : ''}</div></div>`).join('');
    pane.onclick = e => { const i = e.target.dataset.g; if (i !== undefined) dispatch(gs[+i].orders); };
  }

  const PART = { ontime: '準時率', quality: '品質', cost: '成本', own_site: '本倉', type_fit: '車型', allocation: '分配' };
  async function dispatch(list) {
    const site = list[0].site_id, need = Math.max(...list.map(o => rank[o.type_code] || 1));
    const dep = list.map(o => new Date(o.req_depart_at)).sort((a, b) => a - b)[0];
    const d = ui.drawer(`派車・${site}`, `<span class="badge">${list.length} 張訂單</span>`, '<div class="loading">計算推薦車輛…</div>');
    let R = null;
    try { R = await api.rpc('recommend_vehicles', { p_order_ids: list.map(o => o.id) }); } catch (e) { console.warn('recommend_vehicles 不可用，改用簡易排序', e); }
    const cands = R ? R.candidates : D.vehicles.filter(x => x.status === 'idle' && x.drivers?.length).map(x => ({ vehicle_id: x.id, plate: x.plate, type_code: x.type_code, home_site: x.home_site,
        own: x.home_site === site, driver_id: x.drivers[0].id, driver: x.drivers[0].name, shift: `${x.shift_start?.slice(0, 5)}–${x.shift_end?.slice(0, 5)}`, reasons: [], cautions: (rank[x.type_code] || 1) < need ? ['車型偏小'] : [] }))
      .sort((a, b) => (b.own - a.own) || (rank[a.type_code] - rank[b.type_code]));
    const card = (c, i) => `<label class="pickcard rec ${i === 0 ? 'sel' : ''}" style="flex-direction:row;align-items:flex-start;gap:10px">
        <input type="radio" name="veh" value="${c.vehicle_id}" data-rank="${i + 1}" data-score="${c.score ?? ''}" ${i === 0 ? 'checked' : ''} style="margin-top:4px">
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px;flex-wrap:wrap">${R && i < 3 ? `<span class="badge ${i === 0 ? 'g' : 't'}">推薦 ${i + 1}</span>` : ''}<b class="mono">${c.plate}</b><span class="badge">${c.type_code}</span>
            ${c.carrier ? `<span>${esc(c.carrier)}</span>` : ''}${c.own ? '<span class="badge g">本倉</span>' : `<span class="badge y">跨倉・${c.home_site}</span>`}
            ${c.score != null ? `<b class="recsc">${c.score}<small> 分</small></b>` : ''}</div>
          <div class="mut" style="font-size:12px">司機 ${esc(c.driver)}・班表 ${c.shift}${c.cost ? `・成本約 NT$ ${(+c.cost).toLocaleString()}` : ''}</div>
          ${c.parts ? `<div class="parts">${Object.entries(c.parts).map(([k, v]) => `<span title="${PART[k]}：${v} / ${R.weights[k]}"><i style="width:${R.weights[k] ? v / R.weights[k] * 100 : 0}%"></i><em>${PART[k]} ${v}</em></span>`).join('')}</div>` : ''}
          ${c.reasons?.length ? `<div class="why ok">${c.reasons.map(r => `✓ ${esc(r)}`).join('<br>')}</div>` : ''}
          ${c.cautions?.length ? `<div class="why warn">${c.cautions.map(r => `⚠ ${esc(r)}`).join('<br>')}</div>` : ''}
        </div></label>`;
    const top = cands.slice(0, R ? 3 : cands.length), rest = R ? cands.slice(3) : [];
    const wt = R ? list.reduce((a, o) => a + (+o.weight_kg || 0), 0) : null;
    d.querySelector('#dBody').innerHTML = `
      <div class="sec">送達順序（續點）</div>
      <table class="t">${list.map((o, i) => `<tr><td>${i + 1}</td><td class="mono">${o.order_no}</td><td>${esc(M.loc[o.location_id]?.name)}</td><td>${o.type_code}</td><td>${o.weight_kg ? (+o.weight_kg).toLocaleString() + ' kg' : ''}</td><td class="mono">${fmtHM(o.req_arrive_at)}</td></tr>`).join('')}</table>
      ${R ? `<div class="recsum">需求車種 ≥ <b>${R.need_type}</b>・總重 <b>${(+R.weight_kg).toLocaleString()} kg</b>・預估車程約 <b>${R.trip_min} 分</b>（來回＋卸貨）・
        評分權重：準時率 ${R.weights.ontime}、品質 ${R.weights.quality}、成本 ${R.weights.cost}、本倉 ${R.weights.own_site}、車型 ${R.weights.type_fit}、分配 ${R.weights.allocation}</div>`
        : `<div class="sec">選擇車輛（需求車種 ≥ ${M.vtypes.find(t => t.rank === need)?.code}）</div><div class="mut" style="font-size:12px;margin-bottom:6px">推薦功能尚未啟用（資料庫還沒執行 control.sql），先用簡易排序</div>`}
      ${cands.length ? `<div class="list" style="max-height:none">${top.map(card).join('')}</div>
        ${rest.length ? `<details style="margin-top:10px"><summary class="mut">其他可用車輛（${rest.length}）</summary><div class="list" style="max-height:none;margin-top:8px">${rest.map((c, i) => card(c, i + 3)).join('')}</div></details>` : ''}`
        : '<div class="card empty">沒有符合條件的空車 → 可以送出缺車通報</div>'}
      ${R?.excluded?.length ? `<details style="margin-top:10px"><summary class="mut">不符合條件的空車（${R.excluded.length}）</summary><table class="t" style="margin-top:6px">${R.excluded.map(x => `<tr><td class="mono">${x.plate}</td><td>${x.type_code}</td><td>${esc(x.carrier)}</td><td>${x.home_site}</td><td class="mut">${esc(x.reason)}</td></tr>`).join('')}</table></details>` : ''}
      <label class="f" style="margin-top:12px">預計出車<input type="datetime-local" id="pd" value="${new Date(dep - dep.getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></label>`;
    d.querySelector('#dFoot').innerHTML = cands.length ? '<button class="btn pri" id="ok">確認派車</button>' : '<button class="btn warn" id="short">送出缺車通報</button>';
    d.querySelector('#dBody').addEventListener('change', e => { if (e.target.name === 'veh') d.querySelectorAll('.pickcard').forEach(c => c.classList.toggle('sel', c.contains(e.target))); });
    d.querySelector('#short')?.addEventListener('click', async () => {
      await ui.guard(() => api.insert('vehicle_shortage_reports', [{ site_id: site, type_code: M.vtypes.find(t => t.rank === need)?.code, needed_at: dep.toISOString(), order_ids: list.map(o => o.id), reason_tag: 'true_capacity', reported_by: '調度', status: 'open' }]), '已送出缺車通報');
      ui.closeDrawer();
    });
    d.querySelector('#ok')?.addEventListener('click', async e => {
      e.target.disabled = true;
      const inp = d.querySelector('input[name=veh]:checked'), c = cands.find(x => x.vehicle_id === inp.value);
      const tripNo = 'T' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
      const recRank = R ? +inp.dataset.rank : null;
      await ui.guard(async () => {
        const row = { trip_no: tripNo, site_id: site, vehicle_id: c.vehicle_id, driver_id: c.driver_id, planned_depart_at: new Date(d.querySelector('#pd').value).toISOString(), status: 'dispatched' };
        if (R) Object.assign(row, { rec_rank: recRank, rec_score: c.score });
        const [t] = await api.insert('trips', [row]);
        await api.insert('trip_orders', list.map((o, i) => ({ trip_id: t.id, order_id: o.id, stop_seq: i + 1 })));
        await api.update('vehicles', `id=eq.${c.vehicle_id}`, { status: 'assigned' });
        if (c.home_site !== site) {
          await api.insert('vehicle_moves', [{ vehicle_id: c.vehicle_id, from_site: c.home_site, to_site: site, start_at: new Date().toISOString(), reason: '跨倉支援派車', approved_by: '調度' }]);
          await api.update('vehicle_shortage_reports', `site_id=eq.${site}&status=eq.open`, { status: 'covered_cross_site', covered_by_vehicle: c.vehicle_id, resolved_at: new Date().toISOString() });
        }
      }, `車單 ${tripNo} 已派給 ${c.plate}・${c.driver}${recRank ? `（推薦第 ${recRank} 名）` : ''}`);
      ui.closeDrawer(); load();
    });
  }

  function tripsPane(pane) {
    const ts = D.trips;
    if (!ts.length) { pane.innerHTML = '<div class="card empty">還沒有車趟</div>'; return; }
    pane.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>車單號</th><th>庫房</th><th>車輛</th><th>司機</th><th>訂單／點數</th><th>預計出車</th><th>狀態</th><th></th></tr></thead><tbody>
      ${ts.map(t => `<tr class="click" data-t="${t.id}"><td class="mono">${t.trip_no}</td><td>${t.site_id}</td><td class="mono">${t.vehicles?.plate || ''} <span class="mut">${t.vehicles?.type_code || ''}</span></td><td>${esc(t.drivers?.name || '')}</td>
      <td>${t.trip_orders.length} 張・${new Set(t.trip_orders.map(x => x.orders?.location_id)).size} 點</td><td class="mono">${fmtT(t.planned_depart_at)}</td><td>${tripBadge(t.status)}</td>
      <td><a class="btn sm" href="#driver?trip=${t.id}" onclick="event.stopPropagation()">📱 司機視角</a></td></tr>`).join('')}</tbody></table></div>`;
    pane.onclick = async e => { const tr = e.target.closest('tr[data-t]'); if (!tr) return; const t = ts.find(x => x.id === tr.dataset.t);
      const ev = await api.get('tracking_events', `select=*&trip_id=eq.${t.id}&order=event_at`);
      ui.drawer(`車單 ${t.trip_no}`, tripBadge(t.status), `
        <div class="grid" style="grid-template-columns:1fr 1fr;font-size:13px"><div><span class="mut">車輛</span><br>${t.vehicles?.plate} ${t.vehicles?.type_code}</div><div><span class="mut">司機</span><br>${esc(t.drivers?.name)}・${t.drivers?.phone}</div></div>
        <div class="sec">送達點</div><table class="t">${t.trip_orders.sort((a, b) => a.stop_seq - b.stop_seq).map(x => `<tr><td>${x.stop_seq}</td><td class="mono">${x.orders?.order_no}</td><td>${esc(M.loc[x.orders?.location_id]?.name)}</td><td><span class="badge">${STATUS[x.orders?.status]}</span></td></tr>`).join('')}</table>
        <div class="sec">司機回報</div>${ev.length ? `<div class="tl">${ev.map(e => `<div class="done">${EV[e.event] || e.event} <span class="mut mono">${fmtHM(e.event_at)}</span>${e.is_backfill ? ' <span class="badge">補登</span>' : ''}${e.note ? `<br><span class="mut">${esc(e.note)}</span>` : ''}</div>`).join('')}</div>` : '<div class="mut">尚無回報</div>'}`,
        `<a class="btn pri" href="#driver?trip=${t.id}">📱 開啟司機視角</a>`); };
  }

  function fleetPane(pane) {
    const vs = SITE ? D.vehicles.filter(x => x.home_site === SITE) : D.vehicles;
    const ST = { idle: ['可用', 'g'], assigned: ['已派車', 't'], on_trip: ['配送中', 'b'], returning: ['回程', ''], off: ['休息', ''], maintenance: ['保養', 'y'] };
    pane.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">${M.sites.filter(s => !SITE || s.id === SITE).map(s => { const list = vs.filter(x => x.home_site === s.id);
      return `<div class="card"><div class="row"><b>${esc(s.name)}</b><span class="mut" style="margin-left:auto">${list.filter(x => x.status === 'idle').length}/${list.length} 可用</span></div>
      ${list.map(x => `<div class="row" style="margin-top:8px;font-size:13px"><span class="mono">${x.plate}</span><span class="badge">${x.type_code}</span><span class="badge ${ST[x.status]?.[1] || ''}" style="margin-left:auto">${ST[x.status]?.[0] || x.status}</span></div>`).join('')}</div>`; }).join('')}</div>`;
  }

  await load();
  return load;
}
