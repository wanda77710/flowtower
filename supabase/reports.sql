-- =====================================================================
-- FlowTower 管理報表（運輸商績效 · 供應商同仁作業追蹤 · 營收分析 · 車輛週轉率）
-- 執行順序：reset_demo.sql → advance_demo.sql → 本檔 → security.sql
-- 可重複執行。
--
-- 為什麼要另外的歷史資料表？
--   Demo 作業資料每天 06:00 重置，只有「今天」幾個小時，看不出 30／90 天趨勢；
--   作業表又有 2 萬筆上限。所以歷史資料放在獨立的 rpt_ 資料表（唯讀），
--   每天 06:05 以「昨天往前 90 天」重新產生，日期永遠跟著今天走。
--
-- KPI 定義（要換公司定義改這裡）：
--   準時出車：實際出車 ≤ 要求出車 + 15 分鐘
--   準時送達：實際送達 ≤ 指定送達(ETA)
--   回報完整：交車／出發／抵達碼頭／簽收 4 個節點都有打卡
--   即時回報：節點發生後 10 分鐘內記錄（晶圓廠出廠後補登另計）
--   使用率：在途時數 ÷ 班表時數
-- =====================================================================

-- ---------- 1. 歷史資料表 ----------
create table if not exists rpt_trips (           -- 每一趟車一筆
  id               bigserial primary key,
  trip_date        date not null,                -- 台灣日期
  site_id          text, carrier_id uuid, vehicle_id uuid, driver_id uuid,
  customer_id      uuid, location_id uuid, type_code text,
  planned_depart   timestamptz, actual_depart timestamptz,
  req_arrive       timestamptz, actual_arrive timestamptz, return_at timestamptz,
  is_fab           boolean,
  events_expected  int, events_recorded int, events_realtime int, backfill_cnt int,
  report_delay_min numeric,                      -- 節點發生 → 系統記錄 平均延遲
  exception_kind   text, exception_severity text, exception_close_h numeric,
  revenue          numeric, cost numeric,
  cross_site       boolean default false         -- 跨倉支援
);
create index if not exists rpt_trips_date on rpt_trips(trip_date);

create table if not exists rpt_staff_tasks (     -- 內部運輸管理同仁的待辦
  id         bigserial primary key,
  staff      text not null,
  kind       text not null,                      -- 異常追蹤／缺車調度／司機補登追蹤／帳單核對／運輸商績效檢討
  carrier_id uuid, site_id text,
  title      text,
  created_at timestamptz, due_at timestamptz, done_at timestamptz
);
create index if not exists rpt_staff_created on rpt_staff_tasks(created_at);

create table if not exists rpt_shortage (        -- 缺車通報 × 同時段閒置車輛
  id          bigserial primary key,
  reported_at timestamptz, site_id text, type_code text, reason_tag text, status text,
  idle_same_site  int,                           -- 同庫房、班表內、沒在跑的車
  idle_same_type  int,                           -- 其中車種可替代（同級或更大）
  idle_region     int                            -- 同區其他庫房閒置車
);
create index if not exists rpt_shortage_at on rpt_shortage(reported_at);

alter table rpt_trips enable row level security;
alter table rpt_staff_tasks enable row level security;
alter table rpt_shortage enable row level security;
drop policy if exists rpt_read on rpt_trips;       create policy rpt_read on rpt_trips       for select to anon, authenticated using (true);
drop policy if exists rpt_read on rpt_staff_tasks; create policy rpt_read on rpt_staff_tasks for select to anon, authenticated using (true);
drop policy if exists rpt_read on rpt_shortage;    create policy rpt_read on rpt_shortage    for select to anon, authenticated using (true);
grant select on rpt_trips, rpt_staff_tasks, rpt_shortage to anon, authenticated;
revoke insert, update, delete, truncate on rpt_trips, rpt_staff_tasks, rpt_shortage from anon, authenticated;

-- ---------- 2. 產生歷史資料 ----------
create or replace function gen_report_history(p_days int default 90) returns text
language plpgsql security definer set search_path = public as $fn$
declare
  d0 date := (now() at time zone 'Asia/Taipei')::date - p_days;
  d date; v record; loc record; c record;
  n int; i int; t_start timestamptz; shift_end timestamptz;
  travel int; delay int; dur int; arr timestamptz; ret timestamptz;
  prof jsonb; rev numeric; exc text; sev text; rec int; rt int; bf int;
  staff text[] := array['運管-林雅婷','運管-陳冠廷','運管-黃詩涵','運管-張家銘','運管-李佩珊','運管-吳承翰'];
  speed numeric[] := array[0.6, 1.0, 1.4, 0.8, 1.8, 1.1];   -- 處理速度（越小越快）
  kinds text[] := array['異常追蹤','缺車調度','司機補登追蹤','帳單核對','運輸商績效檢討'];
  sla int[] := array[24, 4, 24, 72, 120];                     -- 各類待辦時限（小時）
  k int; s int; cr timestamptz; tot int := 0;
begin
  perform setseed(0.42);                     -- 每天產生的分佈一致，只是日期往前推
  truncate rpt_trips, rpt_staff_tasks, rpt_shortage restart identity;

  -- 運輸商特性：準時、回報、異常、成本率都不一樣，報表才看得出差異
  create temp table _prof on commit drop as
  select id carrier_id, name,
    case name when '順達通運' then '{"late":0.10,"miss":0.03,"exc":0.025,"cost":0.78,"delay":4}'
              when '鴻運物流' then '{"late":0.18,"miss":0.06,"exc":0.04,"cost":0.80,"delay":7}'
              when '大成貨運' then '{"late":0.32,"miss":0.08,"exc":0.07,"cost":0.76,"delay":9}'
              else                '{"late":0.15,"miss":0.20,"exc":0.05,"cost":0.83,"delay":18}' end::jsonb p
  from carriers;

  -- Demo 費率：庫房 × 送達點 × 車種（reset_demo 會清掉，這裡補回）
  delete from rate_cards;
  insert into rate_cards(from_site, location_id, type_code, revenue, cost)
  select s.key, l.id, vt.code,
    round((900 + s.value::int * 26) * (0.7 + vt.rank * 0.35) / 10) * 10,
    round((900 + s.value::int * 26) * (0.7 + vt.rank * 0.35) * 0.8 / 10) * 10
  from locations l cross join lateral jsonb_each_text(l.std_travel_min) s cross join vehicle_types vt;

  for d in select generate_series(d0, d0 + p_days - 1, interval '1 day')::date loop
    for v in select ve.*, dr.id driver_id, p.p from vehicles ve
             left join drivers dr on dr.vehicle_id = ve.id join _prof p on p.carrier_id = ve.carrier_id loop
      if random() < (case when extract(dow from d) = 0 then 0.75 else 0.06 end) then continue; end if;  -- 休假
      t_start := (d + v.shift_start + make_interval(mins => floor(random()*40)::int)) at time zone 'Asia/Taipei';
      shift_end := (d + v.shift_end) at time zone 'Asia/Taipei';
      n := 0;
      loop
        select l.*, (l.std_travel_min->>v.home_site)::int tm, cu.is_fab, cu.id cid into loc
        from locations l join customers cu on cu.id = l.customer_id
        where l.std_travel_min ? v.home_site order by random() limit 1;
        exit when loc is null;
        travel := loc.tm;
        delay := case when random() < (v.p->>'late')::numeric then 16 + floor(random()*45)::int else floor(random()*12)::int - 4 end;
        dur := round(travel * (0.85 + random()*0.3)) + case when loc.is_fab then floor(random()*30)::int else 0 end;
        arr := t_start + make_interval(mins => delay + dur);
        ret := arr + make_interval(mins => 25 + floor(random()*20)::int + round(travel*0.9)::int);
        exit when ret > shift_end + interval '45 min' or n >= 5;
        rec := 4 - case when random() < (v.p->>'miss')::numeric then 1 + floor(random()*2)::int else 0 end;
        bf  := case when loc.is_fab and random() < 0.55 then 1 else 0 end;
        rt  := greatest(rec - bf - case when random() < (v.p->>'miss')::numeric * 2 then 1 else 0 end, 0);
        exc := null; sev := null;
        if random() < (v.p->>'exc')::numeric + (case when delay > 15 then 0.05 else 0 end) then
          exc := (array['late','late','queue_at_fab','damage','shortage_qty','reject','address','vehicle_breakdown'])[1+floor(random()*8)::int];
          sev := (array['low','mid','mid','high'])[1+floor(random()*4)::int];
        end if;
        rev := round((900 + travel*26) * (0.7 + (select rank from vehicle_types where code = v.type_code)*0.35) / 10) * 10;
        insert into rpt_trips(trip_date, site_id, carrier_id, vehicle_id, driver_id, customer_id, location_id, type_code,
          planned_depart, actual_depart, req_arrive, actual_arrive, return_at, is_fab,
          events_expected, events_recorded, events_realtime, backfill_cnt, report_delay_min,
          exception_kind, exception_severity, exception_close_h, revenue, cost, cross_site)
        values (d, case when random() < 0.04 then (select id from sites where id <> v.home_site order by random() limit 1) else v.home_site end,
          v.carrier_id, v.id, v.driver_id, loc.cid, loc.id, v.type_code,
          t_start, t_start + make_interval(mins => delay), t_start + make_interval(mins => round(travel * 1.15)::int + 20), arr, ret, loc.is_fab,
          4, rec, rt, bf, round(((v.p->>'delay')::numeric * (0.5 + random())::numeric) + bf * 35, 1),
          exc, sev, case when exc is not null then round((2 + random() * case sev when 'high' then 40 else 18 end)::numeric, 1) end,
          rev, round(rev * ((v.p->>'cost')::numeric + random()*0.04) + case when exc is not null then rev*0.15 else 0 end),
          false);
        n := n + 1; tot := tot + 1;
        t_start := ret + make_interval(mins => 15 + floor(random()*50)::int);
      end loop;
    end loop;
  end loop;
  update rpt_trips set cross_site = true where site_id <> (select home_site from vehicles where id = vehicle_id);

  -- 缺車通報：分佈在尖峰時段，再算出「同一時間其實有幾台車閒著」
  insert into rpt_shortage(reported_at, site_id, type_code, reason_tag, status)
  select ((d0 + (floor(random()*p_days))::int) + make_interval(hours => (array[7,8,8,9,9,10,13,14,14,15,16])[1+floor(random()*11)::int], mins => floor(random()*60)::int))
           at time zone 'Asia/Taipei',
    s.id, (array['3.5T','7T','7T','17T'])[1+floor(random()*4)::int],
    (array['true_capacity','stuck_in_fab','stuck_in_fab','burst_orders','no_consolidation','driver_absent'])[1+floor(random()*6)::int],
    (array['covered_cross_site','covered_extra','unresolved','covered_cross_site','covered_extra'])[1+floor(random()*5)::int]
  from sites s cross join generate_series(1, case when s.id in ('N1','H1','S1') then 14 else 6 end);

  update rpt_shortage r set
    idle_same_site = x.same_site, idle_same_type = x.same_type, idle_region = x.region
  from (
    select r2.id,
      count(*) filter (where ve.home_site = r2.site_id) same_site,
      count(*) filter (where ve.home_site = r2.site_id and vt.rank >= rt.rank) same_type,
      count(*) filter (where ve.home_site <> r2.site_id and s1.region = s2.region) region
    from rpt_shortage r2
    join sites s2 on s2.id = r2.site_id
    join vehicle_types rt on rt.code = r2.type_code
    join vehicles ve on true
    join vehicle_types vt on vt.code = ve.type_code
    join sites s1 on s1.id = ve.home_site
    where (r2.reported_at at time zone 'Asia/Taipei')::time between ve.shift_start and ve.shift_end
      and exists (select 1 from rpt_trips t where t.vehicle_id = ve.id and t.trip_date = (r2.reported_at at time zone 'Asia/Taipei')::date)
      and not exists (select 1 from rpt_trips t where t.vehicle_id = ve.id and r2.reported_at between t.actual_depart and t.return_at)
    group by r2.id
  ) x where x.id = r.id;
  update rpt_shortage set idle_same_site = coalesce(idle_same_site,0), idle_same_type = coalesce(idle_same_type,0), idle_region = coalesce(idle_region,0);

  -- 內部運輸管理同仁待辦：每天約 6～9 件，各人處理速度不同；最近幾天會有未結案
  for d in select generate_series(d0, d0 + p_days, interval '1 day')::date loop
    for i in 1 .. 6 + floor(random()*4)::int loop
      s := 1 + floor(random()*6)::int; k := 1 + floor(random()*5)::int;
      cr := (d + make_interval(hours => 8 + floor(random()*9)::int, mins => floor(random()*60)::int)) at time zone 'Asia/Taipei';
      select * into c from _prof order by random() limit 1;
      insert into rpt_staff_tasks(staff, kind, carrier_id, site_id, title, created_at, due_at, done_at)
      values (staff[s], kinds[k], c.carrier_id, (select id from sites order by random() limit 1),
        kinds[k] || '：' || c.name, cr, cr + make_interval(hours => sla[k]),
        case when cr + make_interval(hours => round(sla[k] * speed[s] * (0.3 + random()*1.2))::int) < now()
             then cr + make_interval(hours => round(sla[k] * speed[s] * (0.3 + random()*1.2))::int) end);
    end loop;
  end loop;

  return 'ok ' || tot || ' trips';
end $fn$;
revoke execute on function gen_report_history(int) from public, anon, authenticated;

-- ---------- 3. 報表函式（瀏覽器呼叫，回傳 JSON） ----------
-- 共用篩選：最近 p_days 天（到昨天為止）、庫房、運輸商
create or replace function rpt_base(p_days int, p_site text, p_carrier uuid)
returns setof rpt_trips language sql stable as $$
  select * from rpt_trips
  where trip_date > (now() at time zone 'Asia/Taipei')::date - 1 - least(greatest(p_days,1),90)
    and (p_site is null or site_id = p_site)
    and (p_carrier is null or carrier_id = p_carrier)
$$;

-- 3-1 運輸商績效
create or replace function rpt_carriers(p_days int default 30, p_site text default null, p_carrier uuid default null)
returns jsonb language sql stable as $$
with b as (select * from rpt_base(p_days, p_site, p_carrier)),
per as (
  select c.id, c.name, count(*) trips,
    round(100.0 * count(*) filter (where actual_depart <= planned_depart + interval '15 min') / count(*), 1) ontime_depart,
    round(100.0 * count(*) filter (where actual_arrive <= req_arrive) / count(*), 1) ontime_arrive,
    round(100.0 * count(*) filter (where exception_kind is not null) / count(*), 2) exc_per100,
    round(avg(exception_close_h), 1) exc_close_h,
    round(100.0 * count(*) filter (where events_recorded = events_expected) / count(*), 1) report_complete,
    round(100.0 * sum(backfill_cnt) / nullif(sum(events_recorded), 0), 1) backfill_pct,
    round(avg(greatest(extract(epoch from actual_depart - planned_depart)/60, 0)) , 1) avg_depart_delay,
    sum(revenue) revenue, round(100 * (sum(revenue) - sum(cost)) / nullif(sum(revenue), 0), 1) margin_pct
  from b join carriers c on c.id = b.carrier_id group by c.id, c.name),
wk as (
  select date_trunc('week', trip_date)::date wk, carrier_id,
    round(100.0 * count(*) filter (where actual_arrive <= req_arrive) / count(*), 1) ontime_arrive,
    round(100.0 * count(*) filter (where actual_depart <= planned_depart + interval '15 min') / count(*), 1) ontime_depart
  from b group by 1, 2),
exk as (select exception_kind kind, count(*) n from b where exception_kind is not null group by 1),
det as (
  select b.trip_date, c.name carrier, ve.plate, dr.name driver, b.site_id, l.name location,
    round(extract(epoch from b.actual_depart - b.planned_depart)/60) depart_delay,
    round(extract(epoch from b.actual_arrive - b.req_arrive)/60) arrive_delay,
    b.exception_kind, b.exception_severity, b.events_recorded, b.events_expected
  from b join carriers c on c.id = b.carrier_id left join vehicles ve on ve.id = b.vehicle_id
  left join drivers dr on dr.id = b.driver_id left join locations l on l.id = b.location_id
  where p_carrier is not null and (b.actual_arrive > b.req_arrive or b.actual_depart > b.planned_depart + interval '15 min' or b.exception_kind is not null)
  order by b.actual_depart desc limit 300)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(per order by ontime_arrive desc) from per), '[]'),
  'trend', coalesce((select jsonb_agg(jsonb_build_object('wk', wk, 'carrier_id', carrier_id, 'ontime_arrive', ontime_arrive, 'ontime_depart', ontime_depart) order by wk) from wk), '[]'),
  'exc_kinds', coalesce((select jsonb_agg(exk order by n desc) from exk), '[]'),
  'detail', coalesce((select jsonb_agg(det) from det), '[]'))
$$;

-- 3-2 供應商同仁作業追蹤：司機（車行同仁）＋ 內部運輸管理同仁
create or replace function rpt_people(p_days int default 30, p_site text default null, p_carrier uuid default null)
returns jsonb language sql stable as $$
with b as (select * from rpt_base(p_days, p_site, p_carrier)),
drv as (
  select dr.id, dr.name, c.name carrier, ve.plate, ve.home_site site_id, count(*) trips,
    round(100.0 * count(*) filter (where events_recorded = events_expected) / count(*), 1) complete_pct,
    round(100.0 * sum(events_realtime) / nullif(sum(events_expected), 0), 1) realtime_pct,
    sum(events_expected - events_recorded) missing_events,
    round(100.0 * sum(backfill_cnt) / nullif(sum(events_recorded), 0), 1) backfill_pct,
    round(avg(report_delay_min), 1) avg_delay_min,
    count(*) filter (where exception_kind is not null) exceptions,
    round(100.0 * count(*) filter (where actual_arrive <= req_arrive) / count(*), 1) ontime_arrive
  from b join drivers dr on dr.id = b.driver_id join carriers c on c.id = b.carrier_id join vehicles ve on ve.id = b.vehicle_id
  group by dr.id, dr.name, c.name, ve.plate, ve.home_site),
st as (
  select * from rpt_staff_tasks
  where created_at >= ((now() at time zone 'Asia/Taipei')::date - least(greatest(p_days,1),90)) at time zone 'Asia/Taipei'
    and (p_site is null or site_id = p_site) and (p_carrier is null or carrier_id = p_carrier)),
stf as (
  select staff, count(*) total,
    count(*) filter (where done_at is not null) done,
    count(*) filter (where done_at is null) open,
    count(*) filter (where done_at is null and due_at < now()) overdue_open,
    round(100.0 * count(*) filter (where done_at is not null and done_at <= due_at) / nullif(count(*) filter (where done_at is not null), 0), 1) sla_pct,
    round(avg(extract(epoch from done_at - created_at)/3600) filter (where done_at is not null), 1) avg_hours
  from st group by staff),
stk as (
  select kind, count(*) total, round(avg(extract(epoch from done_at - created_at)/3600) filter (where done_at is not null), 1) avg_hours,
    round(100.0 * count(*) filter (where done_at is not null and done_at <= due_at) / nullif(count(*) filter (where done_at is not null), 0), 1) sla_pct
  from st group by kind),
opn as (
  select st.staff, st.kind, st.title, st.site_id, c.name carrier, st.created_at, st.due_at,
    round(extract(epoch from now() - st.due_at)/3600, 1) overdue_h
  from st left join carriers c on c.id = st.carrier_id where st.done_at is null order by st.due_at limit 200),
miss as (   -- 最近 3 天回報不完整的車趟（要追補登）
  select b.trip_date, dr.name driver, c.name carrier, ve.plate, b.site_id, l.name location,
    b.events_recorded, b.events_expected, b.is_fab
  from b join drivers dr on dr.id = b.driver_id join carriers c on c.id = b.carrier_id
  join vehicles ve on ve.id = b.vehicle_id left join locations l on l.id = b.location_id
  where b.events_recorded < b.events_expected and b.trip_date >= (now() at time zone 'Asia/Taipei')::date - 3
  order by b.trip_date desc, dr.name limit 200)
select jsonb_build_object(
  'drivers', coalesce((select jsonb_agg(drv order by complete_pct, trips desc) from drv), '[]'),
  'staff', coalesce((select jsonb_agg(stf order by overdue_open desc, sla_pct) from stf), '[]'),
  'staff_kinds', coalesce((select jsonb_agg(stk order by total desc) from stk), '[]'),
  'open_tasks', coalesce((select jsonb_agg(opn) from opn), '[]'),
  'missing', coalesce((select jsonb_agg(miss) from miss), '[]'))
$$;

-- 3-3 營收分析
create or replace function rpt_revenue(p_days int default 30, p_site text default null, p_carrier uuid default null)
returns jsonb language sql stable as $$
with b as (select * from rpt_base(p_days, p_site, p_carrier)),
tot as (select count(*) trips, sum(revenue) revenue, sum(cost) cost, sum(revenue) - sum(cost) gp,
          round(100 * (sum(revenue) - sum(cost)) / nullif(sum(revenue),0), 1) margin_pct,
          round(avg(revenue)) rev_per_trip,
          sum(revenue - cost) filter (where exception_kind is not null) exc_gp,
          round(sum(cost) filter (where exception_kind is not null) - sum(revenue) filter (where exception_kind is not null) * (1 - (sum(cost) filter (where exception_kind is null) / nullif(sum(revenue) filter (where exception_kind is null),0)))) exc_loss
        from b),
prev as (select sum(revenue) revenue, sum(revenue) - sum(cost) gp from rpt_trips
         where trip_date > (now() at time zone 'Asia/Taipei')::date - 1 - 2*least(greatest(p_days,1),90)
           and trip_date <= (now() at time zone 'Asia/Taipei')::date - 1 - least(greatest(p_days,1),90)
           and (p_site is null or site_id = p_site) and (p_carrier is null or carrier_id = p_carrier)),
per as (select case when p_days > 31 then date_trunc('week', trip_date)::date else trip_date end p,
          sum(revenue) revenue, sum(cost) cost, count(*) trips, count(distinct trip_date) days from b group by 1),
dm as (
  select 'customer' dim, cu.name label, count(*) trips, sum(revenue) revenue, sum(revenue)-sum(cost) gp from b join customers cu on cu.id = b.customer_id group by cu.name
  union all select 'site', s.name, count(*), sum(revenue), sum(revenue)-sum(cost) from b join sites s on s.id = b.site_id group by s.name
  union all select 'carrier', c.name, count(*), sum(revenue), sum(revenue)-sum(cost) from b join carriers c on c.id = b.carrier_id group by c.name
  union all select 'type', b.type_code, count(*), sum(revenue), sum(revenue)-sum(cost) from b group by b.type_code)
select jsonb_build_object(
  'total', (select to_jsonb(tot) from tot), 'prev', (select to_jsonb(prev) from prev),
  'series', coalesce((select jsonb_agg(per order by p) from per), '[]'),
  'dims', coalesce((select jsonb_agg(dm order by dm.dim, dm.revenue desc) from dm), '[]'))
$$;

-- 3-4 車輛週轉率
create or replace function rpt_fleet(p_days int default 30, p_site text default null, p_carrier uuid default null)
returns jsonb language sql stable as $$
with b as (select * from rpt_base(p_days, p_site, p_carrier)),
days as (select least(greatest(p_days,1),90) n),
veh as (
  select ve.id, ve.plate, ve.type_code, ve.home_site site_id, c.name carrier,
    extract(epoch from (ve.shift_end - ve.shift_start))/3600 shift_h,
    count(b.id) trips, count(distinct b.trip_date) work_days,
    coalesce(sum(extract(epoch from b.return_at - b.actual_depart))/3600, 0) busy_h,
    count(b.id) filter (where b.cross_site) cross_trips
  from vehicles ve join carriers c on c.id = ve.carrier_id
  left join b on b.vehicle_id = ve.id
  where (p_site is null or ve.home_site = p_site) and (p_carrier is null or ve.carrier_id = p_carrier)
  group by ve.id, ve.plate, ve.type_code, ve.home_site, c.name, ve.shift_start, ve.shift_end),
v2 as (select veh.*, round(trips::numeric / nullif(work_days,0), 2) trips_per_day,
         round(100 * busy_h / nullif(shift_h * work_days, 0), 1) util_pct,
         (select n from days) - work_days idle_days from veh),
grp as (
  select 'site' dim, site_id label, count(*) vehicles, round(sum(trips)::numeric / nullif(sum(work_days),0), 2) trips_per_day,
    round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) util_pct from v2 group by site_id
  union all select 'type', type_code, count(*), round(sum(trips)::numeric / nullif(sum(work_days),0), 2),
    round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2 group by type_code
  union all select 'carrier', carrier, count(*), round(sum(trips)::numeric / nullif(sum(work_days),0), 2),
    round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2 group by carrier),
daily as (select trip_date d, count(*) trips, count(distinct vehicle_id) vehicles,
            round(count(*)::numeric / nullif(count(distinct vehicle_id),0), 2) tpv from b group by trip_date),
sh as (select * from rpt_shortage
       where reported_at >= ((now() at time zone 'Asia/Taipei')::date - (select n from days)) at time zone 'Asia/Taipei'
         and reported_at < ((now() at time zone 'Asia/Taipei')::date) at time zone 'Asia/Taipei'
         and (p_site is null or site_id = p_site)),
shs as (select site_id, count(*) reports,
          count(*) filter (where idle_same_type > 0) with_idle_same_site,
          count(*) filter (where idle_same_type = 0 and idle_region > 0) with_idle_region,
          round(avg(idle_same_type), 1) avg_idle_same_type,
          count(*) filter (where status = 'unresolved') unresolved
        from sh group by site_id),
shr as (select reason_tag, count(*) n, count(*) filter (where idle_same_type > 0) with_idle from sh group by reason_tag),
shd as (select s.reported_at, s.site_id, s.type_code, s.reason_tag, s.status, s.idle_same_site, s.idle_same_type, s.idle_region
        from sh s order by s.reported_at desc limit 200)
select jsonb_build_object(
  'summary', jsonb_build_object(
     'vehicles', (select count(*) from v2),
     'trips_per_day', (select round(sum(trips)::numeric / nullif(sum(work_days),0), 2) from v2),
     'util_pct', (select round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2),
     'cross_trips', (select sum(cross_trips) from v2),
     'shortage_reports', (select count(*) from sh),
     'shortage_with_idle', (select count(*) from sh where idle_same_type > 0)),
  'vehicles', coalesce((select jsonb_agg(v2 order by util_pct nulls first) from v2), '[]'),
  'groups', coalesce((select jsonb_agg(grp order by dim, label) from grp), '[]'),
  'daily', coalesce((select jsonb_agg(daily order by d) from daily), '[]'),
  'shortage_sites', coalesce((select jsonb_agg(shs order by reports desc) from shs), '[]'),
  'shortage_reasons', coalesce((select jsonb_agg(shr order by n desc) from shr), '[]'),
  'shortage_detail', coalesce((select jsonb_agg(shd) from shd), '[]'))
$$;

grant execute on function rpt_carriers(int, text, uuid), rpt_people(int, text, uuid),
  rpt_revenue(int, text, uuid), rpt_fleet(int, text, uuid), rpt_base(int, text, uuid) to anon, authenticated;

-- ---------- 4. 立即產生一次，並每天 06:05（台灣）重產 ----------
select gen_report_history(90);

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('ft-report-history') where exists (select 1 from cron.job where jobname = 'ft-report-history');
    perform cron.schedule('ft-report-history', '5 22 * * *', 'select public.gen_report_history(90)');
  end if;
end $$;

-- 檢查：應該看到約 8,000～9,000 趟
select (select count(*) from rpt_trips) trips, (select count(*) from rpt_staff_tasks) staff_tasks, (select count(*) from rpt_shortage) shortages;
