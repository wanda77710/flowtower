import { api, master, STATUS, fmtHM, fmtT, esc } from './api.js';

// 司機 App：手機優先、只用點的。Demo 用「選擇司機」模擬登入（正式版改為 LINE 登入）
let DRIVER = (() => { try { return localStorage.getItem('ft_driver') || ''; } catch { return ''; } })();
let TRIP = '';
const KIND = { queue_at_fab: '廠內排隊', late: '塞車／延誤', damage: '貨損', shortage_qty: '數量不符', reject: '客戶拒收', address: '地址／碼頭錯誤', vehicle_breakdown: '車輛故障', other: '其他' };

const CSS = `
#phone{max-width:420px;margin:0 auto;background:#0f1420;border-radius:28px;padding:14px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
#scr{background:#f4f5f7;border-radius:18px;min-height:640px;overflow:hidden;display:flex;flex-direction:column}
.dhd{background:#16a394;color:#fff;padding:16px 16px 14px}
.dhd small{opacity:.8}
.dbody{padding:14px;display:flex;flex-direction:column;gap:12px;flex:1}
.tcard{background:#fff;border-radius:14px;padding:14px;border:1px solid #e3e6ec}
.stop{border-left:4px solid #cfd4dd;padding:8px 0 8px 12px;margin:8px 0}
.stop.cur{border-color:#16a394}.stop.done{border-color:#22a660;opacity:.6}
.big{width:100%;border:none;border-radius:14px;padding:18px;font:700 18px "Noto Sans TC";color:#fff;background:#16a394;cursor:pointer;margin-top:8px}
.big:active{transform:scale(.98)}.big:disabled{background:#b9c0cc}
.big.alt{background:#fff;color:#e5484d;border:2px solid #e5484d}
.big.blue{background:#3b82f6}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips button{border:1px solid #e3e6ec;background:#fff;border-radius:20px;padding:9px 14px;font:inherit;cursor:pointer}
.chips button.on{background:#e5484d;color:#fff;border-color:#e5484d}
@media (max-width:860px){#phone{border-radius:0;padding:0;box-shadow:none}#scr{border-radius:0;min-height:calc(100vh - 70px)}}`;

export async function render(ui) {
  const M = await master();
  if (!document.getElementById('drvcss')) { const s = document.createElement('style'); s.id = 'drvcss'; s.textContent = CSS; document.head.appendChild(s); }
  ui.head('司機 App', '手機版・只用點的回報貨態（Demo 以選擇司機模擬 LINE 登入）');
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('trip')) {
    TRIP = q.get('trip');
    const [t] = await api.get('trips', `select=driver_id&id=eq.${TRIP}`);
    if (t) DRIVER = t.driver_id;
  }
  const v = ui.view(`<div id="phone"><div id="scr"></div></div>`);
  const scr = v.querySelector('#scr');

  async function load() {
    if (!DRIVER) return pickDriver();
    const [[drv], trips] = await Promise.all([
      api.get('drivers', `select=*,vehicles(plate,type_code,home_site)&id=eq.${DRIVER}`),
      api.get('trips', `select=*,trip_orders(stop_seq,order_id,orders(order_no,location_id,customer_id,status,req_arrive_at))&driver_id=eq.${DRIVER}&status=in.(dispatched,handover,departed,arrived)&order=planned_depart_at`),
    ]);
    if (!drv) { DRIVER = ''; return pickDriver(); }
    if (!trips.find(t => t.id === TRIP)) TRIP = trips[0]?.id || '';
    const t = trips.find(x => x.id === TRIP);
    scr.innerHTML = `<div class="dhd"><div class="row"><b style="font-size:18px">👋 ${esc(drv.name)}</b><button class="btn sm" id="sw" style="margin-left:auto">切換司機</button></div><small>${drv.vehicles?.plate || ''}・${drv.vehicles?.type_code || ''}・今日 ${trips.length} 趟待完成</small></div><div class="dbody" id="db"></div>`;
    scr.querySelector('#sw').onclick = () => { DRIVER = ''; TRIP = ''; pickDriver(); };
    const db = scr.querySelector('#db');
    if (!t) { db.innerHTML = '<div class="tcard empty">目前沒有派給你的車趟 🚚<br><span style="font-size:12px">調度在 TMS 派車後會出現在這裡</span></div>'; return; }
    if (trips.length > 1) db.insertAdjacentHTML('beforeend', `<select id="tp">${trips.map(x => `<option value="${x.id}" ${x.id === TRIP ? 'selected' : ''}>${x.trip_no}・${fmtHM(x.planned_depart_at)}</option>`).join('')}</select>`);
    db.querySelector('#tp')?.addEventListener('change', e => { TRIP = e.target.value; load(); });
    const ev = await api.get('tracking_events', `select=*&trip_id=eq.${t.id}&order=event_at`);
    const stops = t.trip_orders.sort((a, b) => a.stop_seq - b.stop_seq);
    const has = (oid, e) => ev.some(x => x.order_id === oid && x.event === e);
    const handed = stops.every(s => has(s.order_id, 'handover')), departed = ev.some(x => x.event === 'depart');
    const cur = stops.find(s => !has(s.order_id, 'delivered'));
    const custOf = s => M.cust[s.orders.customer_id] || {};
    let next = null;
    if (!handed) next = null;
    else if (!departed) next = ['depart', '🚚 出發'];
    else if (cur && !has(cur.order_id, 'arrive_gate')) next = ['arrive_gate', '📍 抵達哨口'];
    else if (cur && !has(cur.order_id, 'arrive_dock')) next = ['arrive_dock', '🏭 抵達碼頭'];
    else if (cur) next = ['delivered', '✅ 完成交貨'];
    const sameN = cur ? stops.filter(s => s.orders.location_id === cur.orders.location_id && !has(s.order_id, 'delivered')).length : 0;
    const fab = cur && custOf(cur).is_fab && departed && has(cur.order_id, 'arrive_gate');
    db.insertAdjacentHTML('beforeend', `
      <div class="tcard"><div class="row"><b class="mono">${t.trip_no}</b><span class="mut" style="margin-left:auto">出車 ${fmtHM(t.planned_depart_at)}</span></div>
      ${stops.map(s => { const d = has(s.order_id, 'delivered'); return `<div class="stop ${d ? 'done' : s === cur ? 'cur' : ''}"><b>${s.stop_seq}. ${esc(M.loc[s.orders.location_id]?.name)}</b>${custOf(s).is_fab ? ' <span class="badge">晶圓廠</span>' : ''}
        <div class="mut" style="font-size:12px">${s.orders.order_no}・指定 ${fmtHM(s.orders.req_arrive_at)}・${d ? '已交貨' : has(s.order_id, 'arrive_dock') ? '已到碼頭' : has(s.order_id, 'arrive_gate') ? '已到哨口' : '未到'}</div></div>`; }).join('')}</div>
      ${!handed ? '<div class="tcard" style="text-align:center">⏳ 等待倉庫交車<br><span class="mut" style="font-size:12px">倉庫在 WMS 掃碼交車後就能出發</span></div>' : ''}
      ${fab ? `<div class="tcard" style="font-size:13px">📵 晶圓廠內不能用手機：出廠後再補登。<label class="f" style="margin-top:6px">實際時間（不改＝現在）<input type="time" id="bf" value="${new Date().toTimeString().slice(0, 5)}"></label></div>` : ''}
      ${next ? `<button class="big" id="nx">${next[1]}${cur && next[0] !== 'depart' ? `<div style="font:400 12px 'Noto Sans TC';opacity:.85">${esc(M.loc[cur.orders.location_id]?.name)}${sameN > 1 ? `・${sameN} 張單一起回報` : ''}</div>` : ''}</button>` : ''}
      ${departed && cur ? '<button class="big alt" id="ex">⚠️ 回報異常</button>' : ''}
      ${!cur ? '<div class="tcard" style="text-align:center">🎉 這趟全部完成！</div>' : ''}`);

    db.querySelector('#bf')?.addEventListener('input', e => { e.target.dataset.dirty = '1'; });
    db.querySelector('#nx')?.addEventListener('click', async e => {
      e.currentTarget.disabled = true;
      const pos = await gps();
      let at = new Date();
      const bf = db.querySelector('#bf');
      if (bf && bf.dataset.dirty && ['arrive_dock', 'delivered'].includes(next[0])) { const [h, m] = bf.value.split(':'); at.setHours(+h, +m, 0, 0); if (at > new Date()) at.setDate(at.getDate() - 1); }
      await ui.guard(async () => {
        // 同一送達點的多張單一次回報（同廠多單）
        const targets = next[0] === 'depart' ? stops : stops.filter(s => s.orders.location_id === cur.orders.location_id && !has(s.order_id, 'delivered') && !has(s.order_id, next[0]));
        await api.insert('tracking_events', targets.map(s => ({ trip_id: t.id, order_id: s.order_id, event: next[0], event_at: at.toISOString(), is_backfill: !!bf && ['arrive_dock', 'delivered'].includes(next[0]), lat: pos?.lat, lng: pos?.lng })));
        if (next[0] === 'depart') {
          await api.update('orders', `id=in.(${stops.map(s => s.order_id).join(',')})`, { status: 'in_transit' });
          await api.update('trips', `id=eq.${t.id}`, { status: 'departed' });
          await api.update('vehicles', `id=eq.${t.vehicle_id}`, { status: 'on_trip' });
        }
        if (next[0] === 'delivered') {
          await api.update('orders', `id=in.(${targets.map(s => s.order_id).join(',')})`, { status: 'delivered' });
          if (stops.filter(s => !targets.includes(s)).every(s => has(s.order_id, 'delivered'))) {
            await api.update('trips', `id=eq.${t.id}`, { status: 'completed' });
            await api.update('vehicles', `id=eq.${t.vehicle_id}`, { status: 'idle' });
          }
        }
      }, `已回報：${next[1].replace(/^\S+\s/, '')}`);
      load();
    });
    db.querySelector('#ex')?.addEventListener('click', () => exception(t, cur));
  }

  function exception(t, cur) {
    const db = scr.querySelector('#db');
    db.innerHTML = `<div class="tcard"><b>回報異常</b><div class="mut" style="font-size:12px;margin:4px 0 10px">${esc(M.loc[cur.orders.location_id]?.name)}・${cur.orders.order_no}</div>
      <div class="chips">${Object.entries(KIND).map(([k, t]) => `<button data-k="${k}">${t}</button>`).join('')}</div>
      <textarea id="nt" rows="3" placeholder="補充說明（選填）" style="width:100%;margin-top:10px"></textarea>
      <label class="f" style="margin-top:8px">照片<input type="file" accept="image/*" id="ph"></label>
      <div class="mut" style="font-size:11px">Demo 版照片只記錄檔名，正式版會上傳到雲端儲存</div></div>
      <button class="big alt" id="send" disabled>送出異常</button><button class="btn" id="back">返回</button>`;
    let kind = '';
    db.querySelector('.chips').onclick = e => { const k = e.target.dataset.k; if (!k) return; kind = k; db.querySelectorAll('.chips button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); db.querySelector('#send').disabled = false; };
    db.querySelector('#back').onclick = load;
    db.querySelector('#send').onclick = async () => {
      const note = db.querySelector('#nt').value, ph = db.querySelector('#ph').files[0]?.name;
      await ui.guard(async () => {
        await api.insert('exceptions', [{ order_id: cur.order_id, trip_id: t.id, kind, severity: ['damage', 'reject', 'vehicle_breakdown'].includes(kind) ? 'high' : 'mid', description: (KIND[kind] + (note ? '：' + note : '')), photo_url: ph ? 'demo://' + ph : null, reported_by: '司機', status: 'open' }]);
        await api.insert('tracking_events', [{ trip_id: t.id, order_id: cur.order_id, event: 'exception', note: KIND[kind] + (note ? '：' + note : '') }]);
      }, '已通報調度，請等候指示'); load();
    };
  }

  async function pickDriver() {
    const trips = await api.get('trips', 'select=driver_id,status,drivers(id,name,vehicles(plate))&status=in.(dispatched,handover,departed,arrived)');
    const ds = {}; trips.forEach(t => { if (t.drivers) { (ds[t.drivers.id] ||= { ...t.drivers, n: 0 }).n++; } });
    const list = Object.values(ds);
    scr.innerHTML = `<div class="dhd"><b style="font-size:18px">FlowTower 司機</b><br><small>正式版以 LINE 登入，Demo 請選一位有派車的司機</small></div>
      <div class="dbody">${list.length ? list.map(d => `<button class="tcard" style="text-align:left;cursor:pointer;font:inherit" data-d="${d.id}"><b>${esc(d.name)}</b> <span class="mut">${d.vehicles?.plate || ''}</span><span class="badge t" style="float:right">${d.n} 趟</span></button>`).join('') : '<div class="tcard empty">目前沒有派車中的司機，先到 TMS 派一趟車</div>'}</div>`;
    scr.onclick = e => { const b = e.target.closest('[data-d]'); if (b) { DRIVER = b.dataset.d; try { localStorage.setItem('ft_driver', DRIVER); } catch { } scr.onclick = null; load(); } };
  }

  function gps() { return new Promise(r => { if (!navigator.geolocation) return r(null); const to = setTimeout(() => r(null), 2500);
    navigator.geolocation.getCurrentPosition(p => { clearTimeout(to); r({ lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5) }); }, () => { clearTimeout(to); r(null); }, { timeout: 2500 }); }); }

  await load();
  return load;
}
