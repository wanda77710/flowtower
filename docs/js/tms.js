import { api, master, flagOf, STATUS, fmtT, fmtHM, esc, inList } from './api.js';

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
    const [orders, trips, vehicles] = await Promise.all([
      api.get('orders', `select=*,trip_orders(trip_id)&status=in.(released,picking,picked)${sf}&order=req_depart_at`),
      api.get('trips', `select=*,vehicles(plate,type_code,home_site),drivers(name,phone),trip_orders(order_id,stop_seq,orders(order_no,location_id,status,req_arrive_at,customer_id))&planned_depart_at=gte.${since}${sf}&order=planned_depart_at.desc&limit=200`),
      api.get('vehicles', `select=*,drivers(id,name)&order=home_site,plate`),
    ]);
    D = { open: orders.filter(o => !o.trip_orders.length), trips, vehicles };
    const act = trips.filter(t => ['dispatched', 'handover', 'departed', 'arrived'].includes(t.status));
    const vs = SITE ? vehicles.filter(x => x.home_site === SITE) : vehicles;
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>待派車訂單</span><b>${D.open.length}</b></div>
      <div class="kpi"><span>🔴 待派車且紅燈</span><b style="color:var(--r)">${D.open.filter(o => flagOf(o)[0] === 'r').length}</b></div>
      <div class="kpi"><span>進行中車趟</span><b>${act.length}</b></div>
      <div class="kpi"><span>可用車輛</span><b style="color:var(--g)">${vs.filter(x => x.status === 'idle').length}<span class="mut" style="font-size:14px"> / ${vs.length}</span></b></div>
      <div class="kpi"><span>併單可省車次</span><b style="color:var(--teal)">${mergeGroups(D.open).reduce((s, g) => s + g.length - 1, 0)}</b></div>`;
    const pane = v.querySelector('#pane');
    ({ plan: planPane, merge: mergePane, trips: tripsPane, fleet: fleetPane })[TAB](pane);
  }

  // 同庫房、同送達點、出車時間 45 分鐘內 → 建議合併
  function mergeGroups(list) {
    const by = {};
    list.forEach(o => { (by[o.site_id + '|' + o.location_id] ||= []).push(o); });
    const out = [];
    Object.values(by).forEach(arr => { arr.sort((a, b) => new Date(a.req_depart_at) - new Date(b.req_depart_at));
      let g = [arr[0]]; for (let i = 1; i < arr.length; i++) { if (new Date(arr[i].req_depart_at) - new Date(g[0].req_depart_at) <= 45 * 60000) g.push(arr[i]); else { if (g.length > 1) out.push(g); g = [arr[i]]; } }
      if (g.length > 1) out.push(g); });
    return out;
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
    const gs = mergeGroups(D.open);
    if (!gs.length) { pane.innerHTML = '<div class="card empty">目前沒有可合併的訂單<br><span style="font-size:12px">規則：同庫房、同送達點、出車時間相差 45 分鐘內</span></div>'; return; }
    pane.innerHTML = `<p class="mut" style="margin-bottom:10px">同庫房、同送達點、出車時間相差 45 分鐘內的訂單，合併成一趟可直接減少叫車數——這是「缺車」的主要成因之一。</p>` +
      gs.map((g, i) => `<div class="card" style="margin-bottom:10px"><div class="row"><b>${g[0].site_id} → ${esc(M.loc[g[0].location_id]?.name)}</b><span class="badge t">可省 ${g.length - 1} 車次</span><span class="mut">${fmtHM(g[0].req_depart_at)}–${fmtHM(g[g.length - 1].req_depart_at)}</span><span style="flex:1"></span><button class="btn pri sm" data-g="${i}">合併派車</button></div>
      <table class="t" style="margin-top:8px">${g.map(o => orderRow(o, false)).join('')}</table></div>`).join('');
    pane.onclick = e => { const i = e.target.dataset.g; if (i !== undefined) dispatch(gs[+i]); };
  }

  function dispatch(list) {
    const site = list[0].site_id, need = Math.max(...list.map(o => rank[o.type_code] || 1));
    const dep = list.map(o => new Date(o.req_depart_at)).sort((a, b) => a - b)[0];
    const cands = D.vehicles.filter(x => x.status === 'idle' && x.drivers?.length).map(x => ({ x, own: x.home_site === site, ok: (rank[x.type_code] || 1) >= need }))
      .sort((a, b) => (b.own - a.own) || (b.ok - a.ok) || (rank[a.x.type_code] - rank[b.x.type_code]));
    const d = ui.drawer(`派車・${site}`, `<span class="badge">${list.length} 張訂單</span>`, `
      <div class="sec">送達順序（續點）</div>
      <table class="t">${list.map((o, i) => `<tr><td>${i + 1}</td><td class="mono">${o.order_no}</td><td>${esc(M.loc[o.location_id]?.name)}</td><td>${o.type_code}</td><td class="mono">${fmtHM(o.req_arrive_at)}</td></tr>`).join('')}</table>
      <div class="sec">選擇車輛（需求車種 ≥ ${M.vtypes.find(t => t.rank === need)?.code}）</div>
      ${cands.length ? `<div class="list" style="max-height:340px">${cands.map(({ x, own, ok }, i) => `<label class="pickcard ${i === 0 ? 'sel' : ''}" style="flex-direction:row;align-items:center;gap:10px">
        <input type="radio" name="veh" value="${x.id}" ${i === 0 ? 'checked' : ''}>
        <div style="flex:1"><b class="mono">${x.plate}</b> <span class="badge">${x.type_code}</span> ${own ? '<span class="badge g">本倉</span>' : `<span class="badge y">跨倉・${x.home_site}</span>`} ${ok ? '' : '<span class="badge r">車型偏小</span>'}
        <div class="mut" style="font-size:12px">司機 ${esc(x.drivers[0].name)}・班表 ${x.shift_start?.slice(0, 5)}–${x.shift_end?.slice(0, 5)}</div></div></label>`).join('')}</div>`
        : '<div class="card empty">目前沒有空車 → 可在「異常／缺車」送出缺車通報</div>'}
      <label class="f" style="margin-top:12px">預計出車<input type="datetime-local" id="pd" value="${new Date(dep - dep.getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></label>`,
      cands.length ? '<button class="btn pri" id="ok">確認派車</button>' : '<button class="btn warn" id="short">送出缺車通報</button>');
    d.querySelector('.list')?.addEventListener('change', e => { d.querySelectorAll('.pickcard').forEach(c => c.classList.toggle('sel', c.contains(e.target) && e.target.checked)); });
    d.querySelector('#short')?.addEventListener('click', async () => {
      await ui.guard(() => api.insert('vehicle_shortage_reports', [{ site_id: site, type_code: M.vtypes.find(t => t.rank === need)?.code, needed_at: dep.toISOString(), order_ids: list.map(o => o.id), reason_tag: 'true_capacity', reported_by: '調度', status: 'open' }]), '已送出缺車通報');
      ui.closeDrawer();
    });
    d.querySelector('#ok')?.addEventListener('click', async e => {
      e.target.disabled = true;
      const vid = d.querySelector('input[name=veh]:checked').value, veh = D.vehicles.find(x => x.id === vid);
      const tripNo = 'T' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
      await ui.guard(async () => {
        const [t] = await api.insert('trips', [{ trip_no: tripNo, site_id: site, vehicle_id: vid, driver_id: veh.drivers[0].id, planned_depart_at: new Date(d.querySelector('#pd').value).toISOString(), status: 'dispatched' }]);
        await api.insert('trip_orders', list.map((o, i) => ({ trip_id: t.id, order_id: o.id, stop_seq: i + 1 })));
        await api.update('vehicles', `id=eq.${vid}`, { status: 'assigned' });
        if (veh.home_site !== site) {
          await api.insert('vehicle_moves', [{ vehicle_id: vid, from_site: veh.home_site, to_site: site, start_at: new Date().toISOString(), reason: '跨倉支援派車', approved_by: '調度' }]);
          await api.update('vehicle_shortage_reports', `site_id=eq.${site}&status=eq.open`, { status: 'covered_cross_site', covered_by_vehicle: vid, resolved_at: new Date().toISOString() });
        }
      }, `車單 ${tripNo} 已派給 ${veh.plate}・${veh.drivers[0].name}`);
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
