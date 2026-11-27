// 管理報表：運輸商績效 · 供應商同仁作業追蹤 · 營收分析 · 車輛週轉率
// 資料來源：資料庫 rpt_* 函式（supabase/reports.sql），統計到昨天為止
import { api, master, esc } from './api.js';

const SERIES = ['#257de0', '#f47230', '#00b894', '#f2a600'];   // 運輸商固定配色（依名稱排序，不隨篩選改變）
const ONE = '#16a394';                                          // 單一系列用主色
const EXC = { late: '延誤', damage: '貨損', shortage_qty: '短少', reject: '拒收', address: '地址錯誤', queue_at_fab: '廠區排隊', vehicle_breakdown: '車輛故障', other: '其他' };
const REASON = { true_capacity: '真的車不夠', stuck_in_fab: '車卡在廠區', burst_orders: '訂單暴量', no_consolidation: '沒併車', driver_absent: '司機缺勤', other: '其他' };
const SHST = { covered_cross_site: '跨倉支援', covered_extra: '叫外車', unresolved: '未解決', open: '處理中' };
const TABS = [['carriers', '運輸商績效'], ['people', '供應商同仁作業追蹤'], ['revenue', '營收分析'], ['fleet', '車輛週轉率']];

const st = { tab: 'carriers', days: 30, site: '', carrier: '', sub: 'drivers', dim: 'customer' };
let M, carriers = [], colorOf = {}, last = null, ui;

const n0 = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const n1 = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 1 });
const pct = v => v == null ? '—' : n1(v) + '%';
const money = v => v == null ? '—' : 'NT$ ' + n0(v);
const wan = v => v == null ? '—' : (Math.abs(v) >= 10000 ? n1(v / 10000) + ' 萬' : n0(v));
const md = d => { const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
const tw = t => new Date(t).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const siteName = id => M.site[id]?.name || id;
const tone = (v, good, warn, hiBad) => { if (v == null) return ''; const b = hiBad ? v >= warn : v < warn, g = hiBad ? v <= good : v >= good; return g ? 'g' : b ? 'r' : 'y'; };
const badge = (txt, t) => `<span class="badge ${t}">${txt}</span>`;

export async function render(u) {
  ui = u; M = await master();
  carriers = await api.get('carriers', 'select=id,name&order=name');
  carriers.forEach((c, i) => colorOf[c.id] = colorOf[c.name] = SERIES[i % SERIES.length]);
  const h = new URLSearchParams(location.hash.split('?')[1] || '');
  if (h.get('tab')) st.tab = h.get('tab');
  ui.head('管理報表', '運輸商績效、同仁作業、營收與車輛週轉 · 統計到昨天為止');
  ui.actions('<button class="btn" id="csv">⇩ 匯出 CSV</button>').querySelector('#csv').onclick = exportCsv;
  ui.view(`
    <div class="tabs" id="rtabs">${TABS.map(([k, t]) => `<button data-t="${k}">${t}</button>`).join('')}</div>
    <div class="rfilters">
      <div class="seg" id="rdays">${[7, 30, 90].map(d => `<button data-d="${d}">近 ${d} 天</button>`).join('')}</div>
      <select id="rsite"><option value="">全部庫房</option>${M.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="rcar"><option value="">全部運輸商</option>${carriers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <span class="mut" id="rnote"></span>
    </div>
    <div id="rbody"><div class="loading">載入中…</div></div>
    <div id="rtip" class="rtip"></div>`);
  document.querySelectorAll('#rtabs button').forEach(b => b.onclick = () => { st.tab = b.dataset.t; load(); });
  document.querySelectorAll('#rdays button').forEach(b => b.onclick = () => { st.days = +b.dataset.d; load(); });
  const $s = document.getElementById('rsite'), $c = document.getElementById('rcar');
  $s.onchange = () => { st.site = $s.value; load(); };
  $c.onchange = () => { st.carrier = $c.value; load(); };
  await load();
  return null;
}

async function load() {
  document.querySelectorAll('#rtabs button').forEach(b => b.classList.toggle('on', b.dataset.t === st.tab));
  document.querySelectorAll('#rdays button').forEach(b => b.classList.toggle('on', +b.dataset.d === st.days));
  document.getElementById('rsite').value = st.site; document.getElementById('rcar').value = st.carrier;
  const body = document.getElementById('rbody');
  body.innerHTML = '<div class="loading">計算中…</div>';
  const args = { p_days: st.days, p_site: st.site || null, p_carrier: st.carrier || null };
  try {
    const d = await api.rpc('rpt_' + st.tab, args);
    last = { tab: st.tab, d };
    body.innerHTML = ({ carriers: vCarriers, people: vPeople, revenue: vRevenue, fleet: vFleet })[st.tab](d);
    wire(body);
  } catch (e) {
    console.error(e);
    body.innerHTML = /rpt_|function|404|PGRST/.test(e.message)
      ? `<div class="card empty">報表資料庫還沒建立：請在 Supabase SQL Editor 執行 <b>supabase/reports.sql</b>，再執行一次 <b>security.sql</b>。</div>`
      : `<div class="card empty">載入失敗：${esc(e.message)}</div>`;
  }
}

// ---------------- 1. 運輸商績效 ----------------
function vCarriers(d) {
  const rows = d.rows;
  if (!rows.length) return empty();
  const all = rows.reduce((a, r) => (a.t += r.trips, a.a += r.ontime_arrive * r.trips, a.dep += r.ontime_depart * r.trips, a.e += r.exc_per100 * r.trips, a), { t: 0, a: 0, dep: 0, e: 0 });
  const wks = [...new Set(d.trend.map(x => x.wk))].sort();
  const series = carriers.filter(c => rows.some(r => r.id === c.id)).map(c => ({
    name: c.name, color: colorOf[c.id],
    values: wks.map(w => d.trend.find(x => x.wk === w && x.carrier_id === c.id)?.ontime_arrive ?? null) }));
  return `
    <div class="kpis">
      ${kpi('車趟數', n0(all.t))}${kpi('準時出車率', pct(all.dep / all.t), '出車 ≤ 要求時間 +15 分')}
      ${kpi('準時送達率', pct(all.a / all.t), '送達 ≤ ETA')}${kpi('異常率', n1(all.e / all.t) + ' 件', '每 100 趟')}
    </div>
    <div class="card rsec"><div class="rh"><b>運輸商排名</b><span class="mut">點運輸商名稱看明細</span></div>
      <div class="tw"><table class="t"><thead><tr><th>#</th><th>運輸商</th><th class="r">趟數</th><th class="r">準時出車</th><th class="r">準時送達</th>
        <th class="r">異常/百趟</th><th class="r">異常結案(時)</th><th class="r">回報完整</th><th class="r">補登比例</th><th class="r">平均晚出車(分)</th><th class="r">營收</th><th class="r">毛利率</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td>
        <td><a href="#" data-car="${r.id}" class="clink"><i class="sw" style="background:${colorOf[r.id]}"></i>${esc(r.name)}</a></td>
        <td class="r">${n0(r.trips)}</td>
        <td class="r">${bar(r.ontime_depart, tone(r.ontime_depart, 90, 80))}</td>
        <td class="r">${bar(r.ontime_arrive, tone(r.ontime_arrive, 80, 70))}</td>
        <td class="r">${badge(n1(r.exc_per100), tone(r.exc_per100, 4, 7, true))}</td>
        <td class="r">${n1(r.exc_close_h)}</td>
        <td class="r">${bar(r.report_complete, tone(r.report_complete, 95, 85))}</td>
        <td class="r">${pct(r.backfill_pct)}</td><td class="r">${n1(r.avg_depart_delay)}</td>
        <td class="r">${wan(r.revenue)}</td><td class="r">${pct(r.margin_pct)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>每週準時送達率</b><span class="mut">%</span></div>${wks.length > 1 ? line(wks.map(md), series, { unit: '%', min: 40, max: 100, half: true }) : '<div class="empty">期間太短，請選近 30 或 90 天</div>'}</div>
      <div class="card rsec"><div class="rh"><b>異常類型</b><span class="mut">件數</span></div>${hbars(d.exc_kinds.map(x => ({ label: EXC[x.kind] || x.kind, v: x.n })), { fmt: n0 })}</div>
    </div>
    ${st.carrier ? detailTable(d.detail) : ''}`;
}
function detailTable(rows) {
  const c = carriers.find(x => x.id === st.carrier);
  return `<div class="card rsec"><div class="rh"><b>${esc(c?.name || '')}：晚出車／晚送達／異常明細</b><span class="mut">最近 ${rows.length} 筆</span></div>
    <div class="tw"><table class="t"><thead><tr><th>日期</th><th>車牌</th><th>司機</th><th>庫房</th><th>送達點</th><th class="r">晚出車(分)</th><th class="r">晚送達(分)</th><th>異常</th><th class="r">打卡</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${md(r.trip_date)}</td><td>${esc(r.plate)}</td><td>${esc(r.driver)}</td><td>${esc(r.site_id)}</td><td>${esc(r.location)}</td>
      <td class="r">${r.depart_delay > 15 ? badge(r.depart_delay, 'r') : r.depart_delay}</td>
      <td class="r">${r.arrive_delay > 0 ? badge(r.arrive_delay, 'r') : '準時'}</td>
      <td>${r.exception_kind ? badge(EXC[r.exception_kind] || r.exception_kind, r.exception_severity === 'high' ? 'r' : 'y') : ''}</td>
      <td class="r">${r.events_recorded}/${r.events_expected}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// ---------------- 2. 供應商同仁作業追蹤 ----------------
function vPeople(d) {
  const sub = `<div class="seg sub" id="rsub"><button data-s="drivers">車行同仁（司機）</button><button data-s="staff">內部運輸管理同仁</button></div>`;
  if (st.sub === 'staff') {
    const S = d.staff, tot = S.reduce((a, s) => (a.t += s.total, a.o += s.open, a.od += s.overdue_open, a.dn += s.done, a.sla += (s.sla_pct || 0) * s.done, a.h += (s.avg_hours || 0) * s.done, a), { t: 0, o: 0, od: 0, dn: 0, sla: 0, h: 0 });
    return sub + `
      <div class="kpis">${kpi('待辦總數', n0(tot.t))}${kpi('未結案', n0(tot.o))}${kpi('已逾期未結', n0(tot.od), '', tot.od ? 'r' : 'g')}
        ${kpi('時限內完成率', pct(tot.sla / tot.dn))}${kpi('平均處理時間', n1(tot.h / tot.dn) + ' 小時')}</div>
      <div class="card rsec"><div class="rh"><b>同仁處理狀況</b><span class="mut">逾期多、時限內完成率低的排前面</span></div>
        <div class="tw"><table class="t"><thead><tr><th>同仁</th><th class="r">待辦</th><th class="r">已完成</th><th class="r">未結案</th><th class="r">逾期未結</th><th class="r">時限內完成率</th><th class="r">平均處理(時)</th></tr></thead>
        <tbody>${S.map(s => `<tr><td>${esc(s.staff)}</td><td class="r">${s.total}</td><td class="r">${s.done}</td><td class="r">${s.open}</td>
          <td class="r">${s.overdue_open ? badge(s.overdue_open, 'r') : 0}</td><td class="r">${bar(s.sla_pct, tone(s.sla_pct, 80, 60))}</td><td class="r">${n1(s.avg_hours)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="rgrid">
        <div class="card rsec"><div class="rh"><b>各類待辦的時限內完成率</b><span class="mut">%</span></div>${hbars(d.staff_kinds.map(k => ({ label: `${k.kind}（${k.total}）`, v: k.sla_pct })), { fmt: pct, max: 100 })}</div>
        <div class="card rsec"><div class="rh"><b>各類待辦平均處理時間</b><span class="mut">小時</span></div>${hbars(d.staff_kinds.map(k => ({ label: k.kind, v: k.avg_hours })), { fmt: n1 })}</div>
      </div>
      <div class="card rsec"><div class="rh"><b>未結案待辦</b><span class="mut">依到期時間排序</span></div>
        ${d.open_tasks.length ? `<div class="tw"><table class="t"><thead><tr><th>同仁</th><th>類型</th><th>內容</th><th>庫房</th><th>建立</th><th>到期</th><th>狀態</th></tr></thead>
        <tbody>${d.open_tasks.map(o => `<tr><td>${esc(o.staff)}</td><td>${esc(o.kind)}</td><td>${esc(o.title)}</td><td>${esc(o.site_id)}</td><td>${tw(o.created_at)}</td><td>${tw(o.due_at)}</td>
          <td>${o.overdue_h > 0 ? badge('逾期 ' + n1(o.overdue_h) + ' 時', 'r') : badge('處理中', 'y')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">沒有未結案待辦</div>'}</div>`;
  }
  const D = d.drivers; if (!D.length) return sub + empty();
  const t = D.reduce((a, r) => (a.t += r.trips, a.c += r.complete_pct * r.trips, a.rt += r.realtime_pct * r.trips, a.m += r.missing_events, a), { t: 0, c: 0, rt: 0, m: 0 });
  return sub + `
    <div class="kpis">${kpi('司機人數', n0(D.length))}${kpi('車趟數', n0(t.t))}${kpi('4 節點打卡完整率', pct(t.c / t.t))}
      ${kpi('即時回報率', pct(t.rt / t.t), '10 分鐘內記錄')}${kpi('漏打卡節點', n0(t.m), '', t.m ? 'y' : 'g')}</div>
    <div class="card rsec"><div class="rh"><b>司機作業追蹤</b><span class="mut">打卡完整率低的排前面 · 節點：交車／出發／抵達碼頭／簽收</span></div>
      <div class="tw"><table class="t"><thead><tr><th>司機</th><th>運輸商</th><th>車牌</th><th>庫房</th><th class="r">趟數</th><th class="r">打卡完整</th><th class="r">即時回報</th><th class="r">漏打節點</th><th class="r">補登比例</th><th class="r">平均回報延遲(分)</th><th class="r">異常</th><th class="r">準時送達</th></tr></thead>
      <tbody>${D.map(r => `<tr><td>${esc(r.name)}</td><td><i class="sw" style="background:${colorOf[r.carrier]}"></i>${esc(r.carrier)}</td><td>${esc(r.plate)}</td><td>${esc(r.site_id)}</td>
        <td class="r">${r.trips}</td><td class="r">${bar(r.complete_pct, tone(r.complete_pct, 95, 85))}</td><td class="r">${bar(r.realtime_pct, tone(r.realtime_pct, 85, 70))}</td>
        <td class="r">${r.missing_events}</td><td class="r">${pct(r.backfill_pct)}</td><td class="r">${badge(n1(r.avg_delay_min), tone(r.avg_delay_min, 10, 20, true))}</td>
        <td class="r">${r.exceptions}</td><td class="r">${pct(r.ontime_arrive)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card rsec"><div class="rh"><b>最近 3 天待補登車趟</b><span class="mut">請車行同仁補打卡</span></div>
      ${d.missing.length ? `<div class="tw"><table class="t"><thead><tr><th>日期</th><th>司機</th><th>運輸商</th><th>車牌</th><th>庫房</th><th>送達點</th><th class="r">已打卡</th></tr></thead>
      <tbody>${d.missing.map(m => `<tr><td>${md(m.trip_date)}</td><td>${esc(m.driver)}</td><td>${esc(m.carrier)}</td><td>${esc(m.plate)}</td><td>${esc(m.site_id)}</td><td>${esc(m.location)}${m.is_fab ? ' ' + badge('晶圓廠', 't') : ''}</td>
        <td class="r">${badge(m.events_recorded + '/' + m.events_expected, 'y')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">最近 3 天沒有漏打卡</div>'}</div>`;
}

// ---------------- 3. 營收分析 ----------------
function vRevenue(d) {
  const T = d.total; if (!T || !T.trips) return empty();
  const P = d.prev || {}, ch = (a, b) => b ? (a - b) / b * 100 : null;
  const rc = ch(T.revenue, P.revenue), gc = ch(T.gp, P.gp);
  const weekly = st.days > 31;
  if (weekly) d = { ...d, series: d.series.filter(s => s.days >= 7) };   // 頭尾不完整的週不畫
  const labels = d.series.map(s => md(s.p) + (weekly ? ' 週' : ''));
  const per = s => weekly ? 1 / s.days : 1;        // 週資料換成「日平均」，頭尾不完整的週才不會失真
  const series = [
    { name: weekly ? '營收（日平均）' : '營收', color: SERIES[0], values: d.series.map(s => Math.round(s.revenue * per(s))) },
    { name: weekly ? '毛利（日平均）' : '毛利', color: SERIES[2], values: d.series.map(s => Math.round((s.revenue - s.cost) * per(s))) }];
  const dims = { customer: '客戶', site: '庫房', carrier: '運輸商', type: '車種' };
  const items = d.dims.filter(x => x.dim === st.dim);
  return `
    <div class="kpis">
      ${kpi('營收', wan(T.revenue), rc == null ? '' : `比前期 ${rc >= 0 ? '▲' : '▼'} ${n1(Math.abs(rc))}%`)}
      ${kpi('毛利', wan(T.gp), gc == null ? '' : `比前期 ${gc >= 0 ? '▲' : '▼'} ${n1(Math.abs(gc))}%`)}
      ${kpi('毛利率', pct(T.margin_pct))}${kpi('每趟平均營收', money(T.rev_per_trip))}
      ${kpi('異常造成的毛利損失', wan(T.exc_loss), '異常趟次多出來的成本', 'y')}
    </div>
    <div class="card rsec"><div class="rh"><b>${weekly ? '每週營收與毛利（日平均）' : '每日營收與毛利'}</b><span class="mut">NT$${weekly ? ' · 只列完整的週' : ''}</span></div>
      ${line(labels, series, { unit: '', fmt: wan, min: 0 })}</div>
    <div class="card rsec"><div class="rh"><b>營收拆解</b>
      <div class="seg sm" id="rdim">${Object.entries(dims).map(([k, t]) => `<button data-dim="${k}" class="${k === st.dim ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="rgrid"><div>${hbars(items.map(x => ({ label: x.label, v: x.revenue })), { fmt: wan })}</div>
      <div class="tw"><table class="t"><thead><tr><th>${dims[st.dim]}</th><th class="r">趟數</th><th class="r">營收</th><th class="r">毛利</th><th class="r">毛利率</th><th class="r">營收占比</th></tr></thead>
      <tbody>${items.map(x => `<tr><td>${st.dim === 'carrier' ? `<i class="sw" style="background:${colorOf[x.label]}"></i>` : ''}${esc(st.dim === 'site' ? x.label : x.label)}</td><td class="r">${n0(x.trips)}</td><td class="r">${n0(x.revenue)}</td>
        <td class="r">${n0(x.gp)}</td><td class="r">${pct(x.gp / x.revenue * 100)}</td><td class="r">${pct(x.revenue / T.revenue * 100)}</td></tr>`).join('')}</tbody></table></div></div></div>
    <p class="mut rfoot">營收／成本以 Demo 費率（庫房 × 送達點 × 車種）計算，運輸商成本率各不相同。</p>`;
}

// ---------------- 4. 車輛週轉率 ----------------
function vFleet(d) {
  const S = d.summary; if (!S.vehicles) return empty();
  const idleShare = S.shortage_reports ? S.shortage_with_idle / S.shortage_reports * 100 : 0;
  const daily = d.daily, labels = daily.map(x => md(x.d));
  const grp = k => d.groups.filter(g => g.dim === k);
  return `
    <div class="kpis">${kpi('車輛數', n0(S.vehicles))}${kpi('每車每日趟數', n1(S.trips_per_day), '有出勤的日子')}
      ${kpi('平均使用率', pct(S.util_pct), '在途時數 ÷ 班表時數')}${kpi('跨倉支援趟數', n0(S.cross_trips))}
      ${kpi('缺車通報', n0(S.shortage_reports))}</div>
    ${S.shortage_reports ? `<div class="card rsec rcall"><b>缺車 × 閒置對照：</b>這段期間 ${S.shortage_reports} 次缺車通報中，有 <b>${S.shortage_with_idle} 次（${n1(idleShare)}%）</b>
      同一個庫房、同一時間其實有可替代（同級或更大）的車閒著 — 這些是調度問題，不是真的缺車。</div>` : ''}
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>每車每日趟數</b><span class="mut">趟</span></div>${line(labels, [{ name: '每車每日趟數', color: ONE, values: daily.map(x => +x.tpv) }], { fmt: n1, min: 0, half: true })}</div>
      <div class="card rsec"><div class="rh"><b>使用率：依庫房</b><span class="mut">%</span></div>${hbars(grp('site').map(g => ({ label: siteName(g.label), v: g.util_pct })), { fmt: pct, max: 100 })}</div>
    </div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>依車種</b></div>${groupTable(grp('type'), '車種')}</div>
      <div class="card rsec"><div class="rh"><b>依運輸商</b></div>${groupTable(grp('carrier'), '運輸商', true)}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>車輛明細</b><span class="mut">使用率低的排前面（可調出支援）</span></div>
      <div class="tw"><table class="t"><thead><tr><th>車牌</th><th>車種</th><th>庫房</th><th>運輸商</th><th class="r">出勤天數</th><th class="r">未出勤天數</th><th class="r">趟數</th><th class="r">每日趟數</th><th class="r">在途時數</th><th class="r">使用率</th><th class="r">跨倉支援</th></tr></thead>
      <tbody>${d.vehicles.map(v => `<tr><td>${esc(v.plate)}</td><td>${esc(v.type_code)}</td><td>${esc(v.site_id)}</td><td><i class="sw" style="background:${colorOf[v.carrier]}"></i>${esc(v.carrier)}</td>
        <td class="r">${v.work_days}</td><td class="r">${v.idle_days}</td><td class="r">${v.trips}</td><td class="r">${n1(v.trips_per_day)}</td><td class="r">${n1(v.busy_h)}</td>
        <td class="r">${bar(v.util_pct, tone(v.util_pct, 70, 55))}</td><td class="r">${v.cross_trips}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="rgrid">
      <div class="card rsec"><div class="rh"><b>缺車通報：依庫房</b></div>
        ${d.shortage_sites.length ? `<div class="tw"><table class="t"><thead><tr><th>庫房</th><th class="r">通報</th><th class="r">同庫房有可替代車閒置</th><th class="r">同區他倉有車閒置</th><th class="r">未解決</th></tr></thead>
        <tbody>${d.shortage_sites.map(s => `<tr><td>${esc(siteName(s.site_id))}</td><td class="r">${s.reports}</td><td class="r">${s.with_idle_same_site ? badge(s.with_idle_same_site, 'y') : 0}</td>
          <td class="r">${s.with_idle_region}</td><td class="r">${s.unresolved ? badge(s.unresolved, 'r') : 0}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">期間內沒有缺車通報</div>'}</div>
      <div class="card rsec"><div class="rh"><b>缺車原因</b><span class="mut">件數</span></div>${hbars(d.shortage_reasons.map(r => ({ label: REASON[r.reason_tag] || r.reason_tag, v: r.n })), { fmt: n0 })}</div>
    </div>
    <div class="card rsec"><div class="rh"><b>缺車通報明細</b><span class="mut">最近 ${d.shortage_detail.length} 筆</span></div>
      ${d.shortage_detail.length ? `<div class="tw"><table class="t"><thead><tr><th>時間</th><th>庫房</th><th>需求車種</th><th>原因</th><th>處理</th><th class="r">同庫房閒置</th><th class="r">其中可替代</th><th class="r">同區他倉閒置</th></tr></thead>
      <tbody>${d.shortage_detail.map(s => `<tr><td>${tw(s.reported_at)}</td><td>${esc(s.site_id)}</td><td>${esc(s.type_code)}</td><td>${REASON[s.reason_tag] || s.reason_tag}</td>
        <td>${badge(SHST[s.status] || s.status, s.status === 'unresolved' ? 'r' : 't')}</td><td class="r">${s.idle_same_site}</td>
        <td class="r">${s.idle_same_type ? badge(s.idle_same_type, 'y') : 0}</td><td class="r">${s.idle_region}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">無</div>'}</div>`;
}
const groupTable = (rows, head, sw) => `<div class="tw"><table class="t"><thead><tr><th>${head}</th><th class="r">車輛</th><th class="r">每車每日趟數</th><th class="r">使用率</th></tr></thead>
  <tbody>${rows.map(g => `<tr><td>${sw ? `<i class="sw" style="background:${colorOf[g.label]}"></i>` : ''}${esc(g.label)}</td><td class="r">${g.vehicles}</td><td class="r">${n1(g.trips_per_day)}</td><td class="r">${bar(g.util_pct, tone(g.util_pct, 70, 55))}</td></tr>`).join('')}</tbody></table></div>`;

// ---------------- 小元件 ----------------
const empty = () => '<div class="card empty">這個篩選條件下沒有資料</div>';
const kpi = (label, value, hint = '', t = '') => `<div class="kpi ${t ? 'k' + t : ''}"><span>${label}</span><b>${value}</b>${hint ? `<small>${hint}</small>` : ''}</div>`;
const bar = (v, t) => v == null ? '—' : `<span class="pbar ${t}"><span class="trk"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><em>${pct(v)}</em></span>`;

function hbars(items, { fmt = n0, max } = {}) {
  if (!items.length) return '<div class="empty">無資料</div>';
  const mx = max || Math.max(...items.map(i => +i.v || 0)) || 1;
  return `<div class="hbars">${items.map(i => `<div class="hb" data-tip="${esc(i.label)}：${esc(fmt(i.v))}"><span class="l">${esc(i.label)}</span>
    <span class="tr"><i style="width:${Math.max(0, (+i.v || 0) / mx * 100)}%;background:${ONE}"></i></span><span class="v">${fmt(i.v)}</span></div>`).join('')}</div>`;
}

// 折線圖（SVG）：單一 Y 軸，十字線 + 提示框；≥2 條線時有圖例並在線尾直接標名稱
let chartId = 0; const charts = {};
function line(labels, series, { fmt, unit = '', min, max, half } = {}) {
  const id = 'c' + (++chartId); const f = fmt || (v => n1(v) + unit);
  const bw = document.getElementById('rbody')?.clientWidth || 900, two = half && bw > 760;
  const W = Math.max(300, Math.round((two ? (bw - 14) / 2 : bw) - 34)), H = 220, L = 52, R = series.length > 1 ? 84 : 16, T = 12, B = 28;
  const vals = series.flatMap(s => s.values).filter(v => v != null);
  let lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  if (min != null) lo = Math.min(lo, Math.min(...vals)); if (max == null) hi = hi * 1.08 || 1;
  if (hi === lo) hi = lo + 1;
  const x = i => L + (labels.length < 2 ? 0 : i * (W - L - R) / (labels.length - 1)), y = v => T + (hi - v) * (H - T - B) / (hi - lo);
  const ticks = [0, 1, 2, 3, 4].map(k => lo + (hi - lo) * k / 4);
  const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - L - R) / 70)));
  charts[id] = { labels, series, f, x, W, L, R };
  const path = s => s.values.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p).join('');
  const lastIdx = s => s.values.map((v, i) => v == null ? -1 : i).filter(i => i >= 0).pop();
  // 線尾標籤避免重疊
  const ends = series.map(s => ({ s, yy: y(s.values[lastIdx(s)]) })).sort((a, b) => a.yy - b.yy);
  ends.forEach((e, i) => { if (i && e.yy - ends[i - 1].yy < 13) e.yy = ends[i - 1].yy + 13; });
  return `<div class="lc" data-chart="${id}">
    ${series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join('、'))}">
      ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${esc(f(t))}</text>`).join('')}
      ${labels.map((l, i) => i % every === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(l)}</text>` : '').join('')}
      ${series.map(s => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`).join('')}
      ${series.length > 1 ? ends.map(e => `<text x="${x(lastIdx(e.s)) + 6}" y="${e.yy + 4}" class="ax ink">${esc(e.s.name)}</text>`).join('') : ''}
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/>
      ${series.map((s, k) => `<circle class="dot" data-k="${k}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2" style="display:none"/>`).join('')}
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
    </svg></div>`;
}

function wire(body) {
  const tip = document.getElementById('rtip');
  const show = (e, html) => { tip.innerHTML = html; tip.style.display = 'block'; const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; };
  const hide = () => tip.style.display = 'none';
  body.querySelectorAll('.hb').forEach(el => { el.onmousemove = e => show(e, el.dataset.tip); el.onmouseleave = hide; });
  body.querySelectorAll('.lc').forEach(el => {
    const c = charts[el.dataset.chart], svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
    const move = e => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * c.W;
      const n = c.labels.length, i = Math.max(0, Math.min(n - 1, Math.round((px - c.L) / ((c.W - c.L - c.R) / Math.max(n - 1, 1)))));
      xh.setAttribute('x1', c.x(i)); xh.setAttribute('x2', c.x(i)); xh.style.display = '';
      svg.querySelectorAll('.dot').forEach(d => { const s = c.series[d.dataset.k], v = s.values[i];
        if (v == null) { d.style.display = 'none'; return; }
        d.style.display = '';
        d.setAttribute('cx', c.x(i)); d.setAttribute('cy', yOf(svg, c, i, s)); });
      show(e, `<b>${esc(c.labels[i])}</b>${c.series.map(s => `<div><i style="background:${s.color}"></i>${esc(s.name)}：${s.values[i] == null ? '—' : esc(c.f(s.values[i]))}</div>`).join('')}`);
    };
    svg.querySelector('.hit').onmousemove = move;
    svg.querySelector('.hit').onmouseleave = () => { hide(); xh.style.display = 'none'; svg.querySelectorAll('.dot').forEach(d => d.style.display = 'none'); };
  });
  body.querySelectorAll('.clink').forEach(a => a.onclick = e => { e.preventDefault(); st.carrier = a.dataset.car; load(); });
  body.querySelectorAll('#rsub button').forEach(b => { b.classList.toggle('on', b.dataset.s === st.sub); b.onclick = () => { st.sub = b.dataset.s; body.innerHTML = vPeople(last.d); wire(body); }; });
  body.querySelectorAll('#rdim button').forEach(b => b.onclick = () => { st.dim = b.dataset.dim; body.innerHTML = vRevenue(last.d); wire(body); });
  const days = st.days, note = document.getElementById('rnote');
  const to = new Date(Date.now() - 864e5), from = new Date(Date.now() - days * 864e5);
  note.textContent = `${md(from)} – ${md(to)}`;
}
// 依路徑上的點取 y：從 path 的 d 屬性讀回（避免重算比例尺）
function yOf(svg, c, i, s) {
  const p = svg.querySelectorAll('path')[c.series.indexOf(s)];
  const pts = p.getAttribute('d').split(/[ML]/).filter(Boolean).map(q => q.split(',').map(Number));
  const xi = c.x(i); const hit = pts.find(q => Math.abs(q[0] - xi) < 0.6);
  return hit ? hit[1] : -10;
}

// ---------------- 匯出 CSV（目前分頁的主要表格） ----------------
function exportCsv() {
  if (!last) return;
  const { tab, d } = last; let rows, name;
  if (tab === 'carriers') { rows = st.carrier && d.detail.length ? d.detail : d.rows; name = st.carrier ? '運輸商明細' : '運輸商績效'; }
  else if (tab === 'people') { rows = st.sub === 'staff' ? [...d.staff, ...d.open_tasks] : d.drivers; name = st.sub === 'staff' ? '內部同仁作業' : '司機作業追蹤'; }
  else if (tab === 'revenue') { rows = d.dims; name = '營收拆解'; }
  else { rows = d.vehicles; name = '車輛週轉'; }
  if (!rows?.length) return ui.toast('沒有資料可匯出', true);
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => k !== 'id');
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = '﻿' + [cols.join(','), ...rows.map(r => cols.map(k => q(r[k])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `FlowTower_${name}_近${st.days}天.csv`; a.click(); URL.revokeObjectURL(a.href);
}
