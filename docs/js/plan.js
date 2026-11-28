// 併車推薦 v2：同庫房、出車時間相近；不同送達點只要順路也能併
// 檢查：繞路上限、每一站趕得上 ETA、總重量 ≤ 車輛載重、最多幾個送達點；並排好送達順序、算出省多少
// 門檻來自資料庫 control_settings（「派車規則維護」頁可改）

const DEF = { merge_window: 60, merge_detour: 30, merge_max_stops: 3, unload_min: 20 };

export function km(a, b) {
  if (a?.lat == null || b?.lat == null) return null;
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// 庫房 → 送達點：優先用標準車程，沒有就用直線距離估（同資料庫 ft_travel_min）
export function travelMin(M, siteId, locId) {
  const l = M.loc[locId], s = M.site[siteId];
  const std = l?.std_travel_min?.[siteId];
  if (std != null) return +std;
  const d = km(s, l); return d == null ? 60 : Math.ceil(d * 1.3 / (d > 30 ? 60 : 35) * 60) + 10;
}
// 送達點 → 送達點
function legMin(M, a, b) {
  if (a === b) return 0;
  const d = km(M.loc[a], M.loc[b]); if (d == null) return 60;
  return Math.ceil(d * 1.3 / (d > 30 ? 60 : 35) * 60) + 5;
}
// 運費成本（同資料庫 ft_trip_cost）
export function tripCost(M, rates, siteId, locId, type) {
  const r = rates?.find(x => x.from_site === siteId && x.location_id === locId && x.type_code === type);
  if (r) return +r.cost;
  const rank = M.vtypes.find(t => t.code === type)?.rank || 1;
  return Math.round((900 + travelMin(M, siteId, locId) * 26) * (0.7 + rank * 0.35) * 0.8 / 10) * 10;
}

// 評估一組訂單能不能併成一趟；能的話回傳路線與檢查結果
export function evaluate(M, S, group, rates) {
  const site = group[0].site_id, m = 60000;
  const dep = Math.min(...group.map(o => +new Date(o.req_depart_at)));
  const locs = [...new Set(group.map(o => o.location_id))];
  if (locs.length > S.merge_max_stops) return null;
  // 送達順序：最近鄰（先送最近的；同距離時 ETA 早的先）
  const route = []; let cur = null; const left = [...locs];
  while (left.length) {
    left.sort((a, b) => (cur ? legMin(M, cur, a) : travelMin(M, site, a)) - (cur ? legMin(M, cur, b) : travelMin(M, site, b))
      || Math.min(...group.filter(o => o.location_id === a).map(o => +new Date(o.req_arrive_at))) - Math.min(...group.filter(o => o.location_id === b).map(o => +new Date(o.req_arrive_at))));
    const nx = left.shift(); route.push(nx); cur = nx;
  }
  // 推算每一站抵達時間
  let t = dep, drive = 0; const stops = [];
  route.forEach((loc, i) => {
    const plan = Math.min(...group.filter(o => o.location_id === loc).map(o => (new Date(o.req_arrive_at) - new Date(o.req_depart_at)) / m).filter(x => x > 0));
    const leg = i === 0 ? (Number.isFinite(plan) ? Math.ceil(plan) : travelMin(M, site, loc)) : legMin(M, route[i - 1], loc);
    drive += leg; t += leg * m;
    const os = group.filter(o => o.location_id === loc);
    stops.push({ loc, orders: os, eta: t, ok: os.every(o => t <= +new Date(o.req_arrive_at)), late: Math.max(...os.map(o => Math.ceil((t - new Date(o.req_arrive_at)) / m))) });
    t += S.unload_min * m;
  });
  const direct = Math.max(...route.map(l => travelMin(M, site, l)));
  const detour = drive - direct;
  if (route.length > 1 && detour > S.merge_detour) return null;
  if (!stops.every(s => s.ok)) return null;
  // 車種：需求車種以上、載重夠的最小車
  const weight = group.reduce((a, o) => a + (+o.weight_kg || 0), 0);
  const need = Math.max(...group.map(o => M.vtypes.find(t => t.code === o.type_code)?.rank || 1));
  const vt = M.vtypes.filter(t => t.rank >= need && (+t.capacity_kg || 0) >= weight).sort((a, b) => a.rank - b.rank)[0];
  if (!vt) return null;
  const far = route.reduce((a, l) => travelMin(M, site, l) > travelMin(M, site, a) ? l : a, route[0]);
  const costSep = group.reduce((a, o) => a + tripCost(M, rates, site, o.location_id, o.type_code), 0);
  const costMerged = tripCost(M, rates, site, far, vt.code) + 300 * (route.length - 1);
  const prep = group.filter(o => +new Date(o.req_depart_at) > dep).map(o => ({ o, min: Math.round((new Date(o.req_depart_at) - dep) / m) }));
  return { site, dep, stops, orders: stops.flatMap(s => s.orders), type: vt.code, cap: +vt.capacity_kg, weight, detour, drive,
    saved_trips: group.length - 1, cost_sep: costSep, cost_merged: costMerged, saved_cost: costSep - costMerged, prep };
}

// 貪婪法：依出車時間排序，從最早的單開始，每次加入「加了之後最不繞路」的單，直到加不進去
export function planMerges(M, settings, open, rates) {
  const S = { ...DEF, ...settings };
  const list = [...open].filter(o => o.req_depart_at).sort((a, b) => new Date(a.req_depart_at) - new Date(b.req_depart_at));
  const used = new Set(), out = [];
  for (const seed of list) {
    if (used.has(seed.id)) continue;
    let group = [seed], best = evaluate(M, S, group, rates);
    if (!best) continue;
    for (;;) {
      const cands = list.filter(o => !used.has(o.id) && !group.includes(o) && o.site_id === seed.site_id
        && Math.abs(new Date(o.req_depart_at) - new Date(seed.req_depart_at)) <= S.merge_window * 60000);
      let pick = null;
      for (const c of cands) {
        const ev = evaluate(M, S, [...group, c], rates);
        if (ev && ev.saved_cost > 0 && (!pick || ev.drive < pick.ev.drive || (ev.drive === pick.ev.drive && ev.saved_cost > pick.ev.saved_cost))) pick = { c, ev };
      }
      if (!pick) break;
      group.push(pick.c); best = pick.ev;
    }
    if (group.length > 1) { group.forEach(o => used.add(o.id)); out.push(best); }
  }
  return out.sort((a, b) => b.saved_cost - a.saved_cost);
}
