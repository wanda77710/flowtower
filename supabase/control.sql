-- =====================================================================
-- FlowTower 派車推薦 · 即時管控 · 派車規則維護
-- 執行順序：… → advance_demo.sql → reports.sql → 本檔 → security.sql（可重複執行）
--
-- 內容：
--   1. 訂單重量、派車時間欄位
--   2. 維護表：運輸商分配比例 carrier_allocation、推薦評分權重 dispatch_weights、管控門檻 control_settings
--   3. 派車推薦 recommend_vehicles(訂單)：先過濾（空車、車型／載重、班表跑得完），再依權重打分，附理由
--   4. 即時管控 v_live_control：準時派車／準時出車／準時配達（和管理報表同一套定義）
--   5. 通知與升級紀錄 control_alerts + sync_control_alerts()（每分鐘）+ ack_control_alert()
--   6. 燈號統一：v_order_checkpoints 改用和報表相同的出車／配達定義
-- =====================================================================

-- ---------- 1. 欄位 ----------
alter table orders add column if not exists weight_kg numeric;           -- 貨物重量（併車、載重檢查用）
alter table trips  add column if not exists dispatched_at timestamptz default now();   -- 派好車與司機的時間
alter table trips  add column if not exists rec_rank int;                -- 採用的是推薦第幾名（null = 沒用推薦）
alter table trips  add column if not exists rec_score numeric;
update trips set dispatched_at = created_at where dispatched_at is null;

-- Demo：沒填重量的訂單，依需求車種給一個合理重量（約該車種載重的 15%～50%）
create or replace function ft_order_weight() returns trigger language plpgsql as $fn$
begin
  if new.weight_kg is null then
    select round(capacity_kg * (0.15 + random() * 0.35) / 10) * 10 into new.weight_kg from vehicle_types where code = new.type_code;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_order_weight on orders;
create trigger trg_order_weight before insert on orders for each row execute function ft_order_weight();
update orders o set weight_kg = round(vt.capacity_kg * (0.15 + random() * 0.35) / 10) * 10
from vehicle_types vt where vt.code = o.type_code and o.weight_kg is null;

-- 管理報表的「運輸商 ↔ 管理同仁」對應表（reports.sql 會填資料；沒跑過也不會壞）
create table if not exists rpt_carrier_owner (carrier_id uuid primary key, staff text not null);

-- ---------- 2. 維護表 ----------
-- 以「運輸商名稱」為鍵：Demo 每天重置會重建運輸商（ID 會變），用名稱才不會把你維護的比例洗掉
create table if not exists carrier_allocation (     -- 運輸商分配比例（每月）
  carrier_name text primary key,
  target_share numeric not null default 25 check (target_share between 0 and 100),   -- 目標派車比例 %
  monthly_min_trips int default 0 check (monthly_min_trips >= 0),                    -- 每月保障趟數
  note text, updated_by text, updated_at timestamptz default now());
insert into carrier_allocation(carrier_name, target_share, monthly_min_trips, note)
select name, case name when '順達通運' then 30 when '鴻運物流' then 30 when '大成貨運' then 20 else 20 end,
           case name when '順達通運' then 900 when '鴻運物流' then 900 when '大成貨運' then 600 else 600 end, 'Demo 模擬比例'
from carriers on conflict (carrier_name) do nothing;

create table if not exists dispatch_weights (       -- 推薦評分權重（合計 100）
  factor text primary key, label text, weight numeric not null check (weight between 0 and 100), sort int, note text,
  updated_by text, updated_at timestamptz default now());
insert into dispatch_weights(factor, label, weight, sort, note) values
  ('ontime',     '運輸商準時率', 30, 1, '近 30 天準時出車率、準時配達率的平均；80% 以下 0 分、100% 滿分'),
  ('quality',    '運輸商品質',   15, 2, '近 30 天每 100 趟異常＋客訴件數；0 件滿分、10 件以上 0 分'),
  ('cost',       '成本',         20, 3, '這一趟的運費成本（含跨倉調車），候選車中最便宜滿分、最貴 0 分'),
  ('own_site',   '本倉車',       15, 4, '本倉車滿分；跨倉支援依調車時間扣分'),
  ('type_fit',   '車型剛好',     10, 5, '車型剛好滿分、大一級一半、大兩級以上 0 分（避免大車小用）'),
  ('allocation', '分配公平',     10, 6, '這個月派車比例低於目標比例就加分、超過就扣分')
on conflict (factor) do update set label = excluded.label, sort = excluded.sort, note = excluded.note;

create table if not exists control_settings (       -- 即時管控門檻
  key text primary key, label text, value numeric not null check (value >= 0), unit text, sort int, note text,
  updated_by text, updated_at timestamptz default now());
insert into control_settings(key, label, value, unit, sort, note) values
  ('dispatch_yellow',  '派車黃燈：出車前幾分鐘還沒派車', 30, '分鐘', 1, ''),
  ('dispatch_red',     '派車紅燈：出車前幾分鐘還沒派車', 5,  '分鐘', 2, '= 準時派車的定義'),
  ('depart_yellow',    '出車黃燈：預計出車後幾分鐘還沒出發', 0, '分鐘', 3, ''),
  ('depart_red',       '出車紅燈：預計出車後幾分鐘還沒出發', 15, '分鐘', 4, '= 準時出車的定義'),
  ('arrive_tolerance', '配達黃燈：推算會晚到超過幾分鐘',  10, '分鐘', 5, '推算送達 = 實際出發 + 計畫車程（出發晚幾分鐘就推算晚幾分鐘）；短暫延誤通常追得回來，所以留緩衝'),
  ('escalate_min',     '紅燈幾分鐘沒人處理就升級主管',   15, '分鐘', 6, ''),
  ('merge_window',     '併車：出車時間相差幾分鐘內',     60, '分鐘', 7, ''),
  ('merge_detour',     '併車：最多繞路幾分鐘',           30, '分鐘', 8, ''),
  ('merge_max_stops',  '併車：一趟最多幾個送達點',       3,  '點',   9, ''),
  ('unload_min',       '每個送達點卸貨時間',             20, '分鐘', 10, '併車推算 ETA 用')
on conflict (key) do update set label = excluded.label, unit = excluded.unit, sort = excluded.sort, note = excluded.note;

do $$ declare t text; begin
  foreach t in array array['carrier_allocation','dispatch_weights','control_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists m_read on %I', t);
    execute format('drop policy if exists m_update on %I', t);
    execute format('create policy m_read on %I for select to anon, authenticated using (true)', t);
    execute format('create policy m_update on %I for update to anon, authenticated using (true) with check (true)', t);
    execute format('grant select, update on %I to anon, authenticated', t);
    execute format('revoke insert, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;
create or replace function ft_touch_maint() returns trigger language plpgsql as $fn$
begin new.updated_at := now(); return new; end $fn$;
drop trigger if exists trg_touch on carrier_allocation; create trigger trg_touch before update on carrier_allocation for each row execute function ft_touch_maint();
drop trigger if exists trg_touch on dispatch_weights;   create trigger trg_touch before update on dispatch_weights   for each row execute function ft_touch_maint();
drop trigger if exists trg_touch on control_settings;   create trigger trg_touch before update on control_settings   for each row execute function ft_touch_maint();

create or replace function ft_setting(p_key text) returns numeric language sql stable as $$
  select value from control_settings where key = p_key $$;

-- ---------- 3. 共用：距離、車程、成本 ----------
create or replace function ft_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) returns numeric
language sql immutable as $$
  select case when lat1 is null or lat2 is null then null else
    round((6371 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::numeric, 1) end $$;

-- 庫房 → 送達點 標準車程（分鐘）：優先用 std_travel_min，沒有就用直線距離估
create or replace function ft_travel_min(p_site text, p_loc uuid) returns int language sql stable as $$
  select coalesce((l.std_travel_min->>p_site)::int,     -- 沒有標準車程：直線距離 ×1.3，30 公里以上用 60 km/h、以內 35 km/h
                  ceil(ft_km(s.lat, s.lng, l.lat, l.lng) * 1.3 / case when ft_km(s.lat, s.lng, l.lat, l.lng) > 30 then 60 else 35 end * 60)::int + 10, 60)
  from locations l, sites s where l.id = p_loc and s.id = p_site $$;

-- 一趟運費成本：費率表優先，沒有就用 Demo 公式
create or replace function ft_trip_cost(p_site text, p_loc uuid, p_type text) returns numeric language sql stable as $$
  select coalesce(
    (select cost from rate_cards where from_site = p_site and location_id = p_loc and type_code = p_type limit 1),
    round((900 + ft_travel_min(p_site, p_loc) * 26) * (0.7 + (select rank from vehicle_types where code = p_type) * 0.35) * 0.8 / 10) * 10) $$;

-- ---------- 4. 派車推薦 ----------
create or replace function recommend_vehicles(p_order_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  o record; res jsonb; tz text := 'Asia/Taipei';
  wsum numeric; has_rpt boolean := to_regclass('public.rpt_fact') is not null;
begin
  select min(site_id) site_id, count(distinct site_id) nsite, max(vt.rank) need_rank, sum(coalesce(weight_kg, 0)) weight,
         min(req_depart_at) dep, count(*) n, count(distinct location_id) stops,
         -- 單程車程：優先用訂單自己的計畫車程（ETA − 預計出車），沒有才用標準車程
         max(coalesce(nullif(ceil(extract(epoch from req_arrive_at - req_depart_at) / 60), 0)::int, ft_travel_min(site_id, location_id))) far_min,
         (array_agg(location_id order by coalesce(nullif(ceil(extract(epoch from req_arrive_at - req_depart_at) / 60), 0)::int, ft_travel_min(site_id, location_id)) desc))[1] far_loc
    into o
  from orders od join vehicle_types vt on vt.code = od.type_code where od.id = any(p_order_ids);
  if o.n is null or o.n = 0 then raise exception '找不到訂單'; end if;
  if o.nsite > 1 then raise exception '一趟車只能從同一個庫房出發'; end if;
  select sum(weight) into wsum from dispatch_weights;

  with wt as (select factor, weight / nullif(wsum, 0) * 100 w from dispatch_weights),
  perf as (   -- 運輸商近 30 天表現（管理報表的歷史資料）
    select carrier_id,
      round(100.0 * (avg(depart_ok) + avg(arrive_ok)) / 2, 1) ontime,
      round(100.0 * (sum(exc) + sum(cmp)) / count(*), 2) issues100
    from rpt_fact where has_rpt and trip_date >= (now() at time zone tz)::date - 30 group by carrier_id),
  mon as (    -- 這個月各運輸商的派車趟數（歷史 + 今天線上）
    select carrier_id, count(*) n from (
      select carrier_id from rpt_trips where has_rpt and trip_date >= date_trunc('month', now() at time zone tz)::date
      union all
      select v.carrier_id from trips t join vehicles v on v.id = t.vehicle_id
      where t.created_at >= date_trunc('day', now() at time zone tz) at time zone tz) x group by carrier_id),
  share as (select c.id carrier_id, a.target_share, coalesce(100.0 * m.n / nullif(sum(m.n) over (), 0), 0) actual_share
            from carriers c left join carrier_allocation a on a.carrier_name = c.name left join mon m on m.carrier_id = c.id),
  cand as (
    select v.id vehicle_id, v.plate, v.type_code, v.home_site, v.shift_start, v.shift_end, vt.rank, vt.capacity_kg,
      c.id carrier_id, c.name carrier, d.id driver_id, d.name driver,
      v.home_site = o.site_id own,
      case when v.home_site = o.site_id then 0
           else coalesce(ceil(ft_km(hs.lat, hs.lng, ss.lat, ss.lng) * 1.3 / case when ft_km(hs.lat, hs.lng, ss.lat, ss.lng) > 30 then 60 else 35 end * 60)::int + 10, 60) end repos_min,
      o.far_min * 2 + ft_setting('unload_min') * o.stops trip_min
    from vehicles v join vehicle_types vt on vt.code = v.type_code join carriers c on c.id = v.carrier_id
    join lateral (select id, name from drivers where vehicle_id = v.id limit 1) d on true
    join sites hs on hs.id = v.home_site join sites ss on ss.id = o.site_id
    where v.status = 'idle'),
  chk as (
    select cand.*,
      ((greatest(o.dep, now()) at time zone tz)::time >= shift_start - interval '30 min') start_ok,
      ((greatest(o.dep, now()) at time zone tz) + make_interval(mins => trip_min::int))::time <= shift_end + interval '30 min'
        and ((greatest(o.dep, now()) at time zone tz) + make_interval(mins => trip_min::int))::date = (greatest(o.dep, now()) at time zone tz)::date shift_ok,
      rank >= o.need_rank type_ok, capacity_kg >= o.weight weight_ok,
      (repos_min = 0 or now() + make_interval(mins => repos_min) <= greatest(o.dep, now()) + interval '15 min') reach_ok,   -- 調車要趕得上（已逾時的單只看調車 15 分鐘內）
      ft_trip_cost(o.site_id, o.far_loc, type_code) + 300 * (o.stops - 1) + repos_min * 15 cost
    from cand),
  ok as (select * from chk where start_ok and shift_ok and type_ok and weight_ok and reach_ok),
  sc as (
    select ok.*, p.ontime, p.issues100, sh.target_share, round(sh.actual_share, 1) actual_share,
      round((select w from wt where factor = 'ontime') * greatest(0, least(1, (coalesce(p.ontime, 90) - 80) / 20.0)), 1) s_ontime,
      round((select w from wt where factor = 'quality') * greatest(0, least(1, 1 - coalesce(p.issues100, 3) / 10.0)), 1) s_quality,
      round((select w from wt where factor = 'cost') * case when max(cost) over () = min(cost) over () then 1
            else (max(cost) over () - cost) / (max(cost) over () - min(cost) over ()) end, 1) s_cost,
      round((select w from wt where factor = 'own_site') * case when own then 1 else greatest(0, 0.5 - repos_min / 120.0) end, 1) s_own,
      round((select w from wt where factor = 'type_fit') * case rank - o.need_rank when 0 then 1 when 1 then 0.5 else 0 end, 1) s_type,
      round((select w from wt where factor = 'allocation') * greatest(0, least(1, 0.5 + (coalesce(sh.target_share, 25) - sh.actual_share) / 20.0)), 1) s_alloc
    from ok left join perf p using (carrier_id) left join share sh using (carrier_id)),
  fin as (select sc.*, s_ontime + s_quality + s_cost + s_own + s_type + s_alloc score from sc)
  select jsonb_build_object(
    'site_id', o.site_id, 'orders', o.n, 'stops', o.stops, 'weight_kg', o.weight, 'dep', o.dep,
    'need_type', (select code from vehicle_types where rank = o.need_rank), 'trip_min', o.far_min * 2 + ft_setting('unload_min') * o.stops,
    'weights', (select jsonb_object_agg(factor, round(w, 1)) from wt),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'vehicle_id', vehicle_id, 'plate', plate, 'type_code', type_code, 'home_site', home_site, 'own', own, 'repos_min', repos_min,
        'carrier_id', carrier_id, 'carrier', carrier, 'driver_id', driver_id, 'driver', driver,
        'shift', to_char(shift_start, 'HH24:MI') || '–' || to_char(shift_end, 'HH24:MI'),
        'cost', cost, 'ontime', ontime, 'issues100', issues100, 'target_share', target_share, 'actual_share', actual_share,
        'score', round(score, 1),
        'parts', jsonb_build_object('ontime', s_ontime, 'quality', s_quality, 'cost', s_cost, 'own_site', s_own, 'type_fit', s_type, 'allocation', s_alloc),
        'reasons', array_remove(array[
            case when ontime >= 95 then carrier || '近 30 天準時率 ' || ontime || '%' end,
            case when issues100 is not null and issues100 <= 3 then '異常／客訴少（每百趟 ' || issues100 || ' 件）' end,
            case when s_cost >= (select w from wt where factor = 'cost') * 0.8 then '成本較低（約 ' || cost || ' 元）' end,
            case when own then '本倉車，不用調車' end,
            case when rank = o.need_rank then '車型剛好' end,
            case when target_share - actual_share >= 3 then '本月派車比例 ' || actual_share || '%，低於目標 ' || target_share || '%' end], null),
        'cautions', array_remove(array[
            case when not own then '跨倉支援：從 ' || home_site || ' 調車約 ' || repos_min || ' 分鐘' end,
            case when rank - o.need_rank >= 1 then '車型大 ' || (rank - o.need_rank) || ' 級' end,
            case when ontime < 90 then carrier || '近 30 天準時率只有 ' || ontime || '%' end,
            case when issues100 > 6 then '異常／客訴偏多（每百趟 ' || issues100 || ' 件）' end,
            case when actual_share - target_share >= 3 then '本月派車比例 ' || actual_share || '%，已超過目標 ' || target_share || '%' end], null)
      ) order by score desc, cost) from fin), '[]'),
    'excluded', coalesce((select jsonb_agg(jsonb_build_object('plate', plate, 'type_code', type_code, 'carrier', carrier, 'home_site', home_site,
        'reason', concat_ws('、',
          case when not type_ok then '車型太小' end, case when type_ok and not weight_ok then '載重不足' end,
          case when not start_ok then '班表還沒開始' end, case when not shift_ok then '班表跑不完（約需 ' || trip_min || ' 分）' end,
          case when not reach_ok then '調車趕不上出車時間' end)) order by own desc, plate)
      from chk where not (start_ok and shift_ok and type_ok and weight_ok and reach_ok)), '[]'),
    'busy', (select count(*) from vehicles where status <> 'idle'))
  into res;
  return res;
end $fn$;

-- 本月各運輸商實際派車趟數（維護頁對照用）
create or replace function carrier_month_trips() returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare tz text := 'Asia/Taipei'; res jsonb;
begin
  if to_regclass('public.rpt_trips') is not null then
    execute $q$ select coalesce(jsonb_object_agg(carrier_id, n), '{}') from (
      select carrier_id, count(*) n from (
        select carrier_id from rpt_trips where trip_date >= date_trunc('month', now() at time zone 'Asia/Taipei')::date
        union all
        select v.carrier_id from trips t join vehicles v on v.id = t.vehicle_id where t.created_at >= date_trunc('day', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei') x
      group by carrier_id) y $q$ into res;
  else
    select coalesce(jsonb_object_agg(carrier_id, n), '{}') into res from (
      select v.carrier_id, count(*) n from trips t join vehicles v on v.id = t.vehicle_id
      where t.created_at >= date_trunc('month', now() at time zone tz) at time zone tz group by v.carrier_id) y;
  end if;
  return res;
end $fn$;

-- ---------- 5. 即時管控（和管理報表同一套定義） ----------
create or replace view v_live_control with (security_invoker = true) as
with st as (select
    ft_setting('dispatch_yellow') dy, ft_setting('dispatch_red') dr, ft_setting('depart_yellow') py,
    ft_setting('depart_red') pr, ft_setting('arrive_tolerance') at),
own as (select carrier_id, staff from rpt_carrier_owner),
-- 準時派車：還沒派車的訂單
d as (
  select 'dispatch'::text kind, o.id ref_id, o.order_no ref_no, o.site_id, null::uuid carrier_id, o.customer_id,
    o.req_depart_at due,
    case when now() > o.req_depart_at - make_interval(mins => st.dr::int) then 'r' else 'y' end lvl,
    case when now() > o.req_depart_at - make_interval(mins => st.dr::int) then o.req_depart_at - make_interval(mins => st.dr::int)
         else o.req_depart_at - make_interval(mins => st.dy::int) end lvl_since,
    '預計出車 ' || to_char(o.req_depart_at at time zone 'Asia/Taipei', 'HH24:MI') || '，還沒派車' detail,
    '站點調度・' || o.site_id owner
  from orders o, st
  where o.status in ('created','released','picking','picked','loaded')
    and not exists (select 1 from trip_orders x where x.order_id = o.id)
    and now() > o.req_depart_at - make_interval(mins => st.dy::int)),
-- 準時出車：已派車但還沒出發的車趟
p as (
  select 'depart', t.id, t.trip_no, t.site_id, v.carrier_id,
    (select o.customer_id from trip_orders x join orders o on o.id = x.order_id where x.trip_id = t.id order by x.stop_seq limit 1),
    t.planned_depart_at,
    case when now() > t.planned_depart_at + make_interval(mins => st.pr::int) then 'r' else 'y' end,
    case when now() > t.planned_depart_at + make_interval(mins => st.pr::int) then t.planned_depart_at + make_interval(mins => st.pr::int)
         else t.planned_depart_at + make_interval(mins => st.py::int) end,
    v.plate || '・預計出車 ' || to_char(t.planned_depart_at at time zone 'Asia/Taipei', 'HH24:MI') || '，還沒出發',
    coalesce(own.staff, '運管（未指派）')
  from trips t join vehicles v on v.id = t.vehicle_id left join own on own.carrier_id = v.carrier_id, st
  where t.status in ('planned','dispatched','handover')
    and now() > t.planned_depart_at + make_interval(mins => st.py::int)),
-- 準時配達：配送中的訂單（推算送達 = 實際出發 + 計畫車程；出發晚幾分鐘，送達就晚幾分鐘）
a0 as (
  select o.id, o.order_no, o.site_id, v.carrier_id, o.customer_id, o.req_arrive_at, v.plate, x.stop_seq,
    (select min(e.event_at) from tracking_events e where e.trip_id = x.trip_id and e.event = 'depart') dep_at,
    o.req_arrive_at - o.req_depart_at travel          -- 這張單自己的計畫車程（ETA − 預計出車）
  from orders o join trip_orders x on x.order_id = o.id join trips t on t.id = x.trip_id join vehicles v on v.id = t.vehicle_id
  where o.status = 'in_transit'),
a as (
  select 'arrive', a0.id, a0.order_no, a0.site_id, a0.carrier_id, a0.customer_id, a0.req_arrive_at,
    case when now() > a0.req_arrive_at then 'r' else 'y' end,
    case when now() > a0.req_arrive_at then a0.req_arrive_at else a0.dep_at end,
    case when now() > a0.req_arrive_at then a0.plate || '・已超過指定送達 ' || to_char(a0.req_arrive_at at time zone 'Asia/Taipei', 'HH24:MI') || '，還沒送達'
         else a0.plate || '・推算 ' || to_char((a0.dep_at + a0.travel) at time zone 'Asia/Taipei', 'HH24:MI')
              || ' 送達，比指定 ' || to_char(a0.req_arrive_at at time zone 'Asia/Taipei', 'HH24:MI') || ' 晚 '
              || ceil(extract(epoch from a0.dep_at + a0.travel - a0.req_arrive_at) / 60) || ' 分' end,
    coalesce(own.staff, '運管（未指派）')
  from a0 left join own on own.carrier_id = a0.carrier_id, st
  where now() > a0.req_arrive_at
     or (a0.dep_at is not null and a0.dep_at + a0.travel > a0.req_arrive_at + make_interval(mins => st.at::int)))
select kind || ':' || ref_id alert_key, x.*, c.name carrier, c.contact carrier_contact, cu.name customer
from (select * from d union all select * from p union all select * from a) x(kind, ref_id, ref_no, site_id, carrier_id, customer_id, due, level, level_since, detail, owner)
left join carriers c on c.id = x.carrier_id left join customers cu on cu.id = x.customer_id;
grant select on v_live_control to anon, authenticated;

-- 通知與升級紀錄
create table if not exists control_alerts (
  id bigserial primary key,
  alert_key text unique not null,
  kind text, level text, ref_id uuid, ref_no text, site_id text, carrier_id uuid, carrier text, customer text,
  owner text, due timestamptz, detail text,
  first_seen timestamptz default now(), level_since timestamptz,
  notified jsonb default '[]',                  -- [{to, level, at, why}]
  escalated_at timestamptz,
  status text default 'open' check (status in ('open','ack','done','resolved')),   -- 待處理／處理中／已處理（手動）／已恢復（自動）
  ack_by text, ack_at timestamptz, ack_note text, resolved_at timestamptz, updated_at timestamptz default now());
create index if not exists control_alerts_status on control_alerts(status);
alter table control_alerts enable row level security;
drop policy if exists m_read on control_alerts;
create policy m_read on control_alerts for select to anon, authenticated using (true);
grant select on control_alerts to anon, authenticated;
revoke insert, update, delete, truncate on control_alerts from anon, authenticated;

create or replace function sync_control_alerts() returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare n_new int; n_up int; n_esc int; n_res int; boss text := '主管（運輸課）';
begin
  create temp table _live on commit drop as select * from v_live_control;

  -- 新的燈號：黃燈通知負責人；紅燈再加運輸商窗口
  insert into control_alerts(alert_key, kind, level, ref_id, ref_no, site_id, carrier_id, carrier, customer, owner, due, detail, level_since, notified)
  select l.alert_key, l.kind, l.level, l.ref_id, l.ref_no, l.site_id, l.carrier_id, l.carrier, l.customer, l.owner, l.due, l.detail, l.level_since,
    jsonb_build_array(jsonb_build_object('to', l.owner, 'level', l.level, 'at', now(), 'why', case l.level when 'r' then '紅燈' else '黃燈' end))
      || case when l.level = 'r' and l.carrier is not null
              then jsonb_build_array(jsonb_build_object('to', l.carrier || ' 窗口（' || coalesce(l.carrier_contact, '') || '）', 'level', 'r', 'at', now(), 'why', '紅燈')) else '[]' end
  from _live l
  on conflict (alert_key) do nothing;
  get diagnostics n_new = row_count;

  -- 黃轉紅：再通知一次（含運輸商窗口）；已處理的單若惡化成紅燈，重新打開
  update control_alerts c set level = 'r', level_since = l.level_since, detail = l.detail, updated_at = now(),
    status = case when c.status = 'done' then 'open' else c.status end,
    notified = c.notified || jsonb_build_array(jsonb_build_object('to', l.owner, 'level', 'r', 'at', now(), 'why', '轉紅燈'))
      || case when l.carrier is not null then jsonb_build_array(jsonb_build_object('to', l.carrier || ' 窗口（' || coalesce(l.carrier_contact, '') || '）', 'level', 'r', 'at', now(), 'why', '轉紅燈')) else '[]' end
  from _live l where l.alert_key = c.alert_key and c.level = 'y' and l.level = 'r' and c.status in ('open','ack','done');
  get diagnostics n_up = row_count;
  update control_alerts c set detail = l.detail, updated_at = now()
  from _live l where l.alert_key = c.alert_key and c.status in ('open','ack') and c.detail is distinct from l.detail;

  -- 紅燈超過 N 分鐘沒人按「處理中」→ 升級主管
  update control_alerts set escalated_at = now(), updated_at = now(),
    notified = notified || jsonb_build_array(jsonb_build_object('to', boss, 'level', 'r', 'at', now(), 'why', '紅燈 ' || ft_setting('escalate_min') || ' 分鐘沒人處理'))
  where status = 'open' and level = 'r' and escalated_at is null
    and level_since + make_interval(mins => ft_setting('escalate_min')::int) < now();
  get diagnostics n_esc = row_count;

  -- 狀況解除（已派車／已出發／已送達）→ 自動結案
  update control_alerts c set status = 'resolved', resolved_at = now(), updated_at = now()
  where c.status in ('open','ack','done') and not exists (select 1 from _live l where l.alert_key = c.alert_key);
  get diagnostics n_res = row_count;

  delete from control_alerts where status in ('resolved','done') and coalesce(resolved_at, ack_at, updated_at) < now() - interval '3 days';
  return jsonb_build_object('new', n_new, 'to_red', n_up, 'escalated', n_esc, 'resolved', n_res, 'at', now());
end $fn$;

create or replace function ack_control_alert(p_id bigint, p_status text, p_by text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare r control_alerts;
begin
  if p_status not in ('ack','done') then raise exception 'status 只能是 ack（處理中）或 done（已處理）'; end if;
  update control_alerts set status = p_status, ack_by = left(coalesce(nullif(trim(p_by), ''), '值班人員'), 40),
    ack_note = left(p_note, 300), ack_at = now(), updated_at = now(),
    resolved_at = case when p_status = 'done' then now() else resolved_at end
  where id = p_id and status in ('open','ack') returning * into r;
  if r.id is null then raise exception '這筆警示已結案或不存在'; end if;
  return to_jsonb(r);
end $fn$;

revoke execute on function sync_control_alerts() from public;
grant execute on function sync_control_alerts(), ack_control_alert(bigint, text, text, text), recommend_vehicles(uuid[]), carrier_month_trips(),
  ft_setting(text), ft_km(numeric, numeric, numeric, numeric), ft_travel_min(text, uuid), ft_trip_cost(text, uuid, text) to anon, authenticated;

-- ---------- 6. 燈號統一（控制塔、OMS 用；和管理報表同一套定義） ----------
create or replace view v_order_checkpoints as
select o.id, o.order_no, o.site_id, o.status, o.req_depart_at, o.req_arrive_at,
  case
    when o.status in ('delivered','cancelled') then 'g'
    when o.status in ('created','released','picking') and now() > o.req_depart_at - interval '5 min' then 'r'    -- T−5 未備妥
    when o.status in ('created','released','picking') and now() > o.req_depart_at - interval '15 min' then 'y'   -- T−15 未備妥
    when o.status in ('picked','loaded') and now() > o.req_depart_at + interval '15 min' then 'r'                -- T+15 未出車（= 不準時出車）
    when o.status in ('picked','loaded') and now() > o.req_depart_at then 'y'                                    -- 過 T0 未出車
    when o.status = 'in_transit' and now() > o.req_arrive_at then 'r'                                            -- 超過 ETA（= 不準時配達）
    when o.status = 'in_transit' and now() > o.req_arrive_at - interval '10 min' then 'y'                        -- 快到 ETA 還沒送達
    when o.status = 'exception' then 'r'
    else 'g' end as flag
from orders o;

-- ---------- 7. 每分鐘同步一次警示 ----------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('ft-control-sync') where exists (select 1 from cron.job where jobname = 'ft-control-sync');
    perform cron.schedule('ft-control-sync', '* * * * *', 'select public.sync_control_alerts()');
  end if;
end $$;
select sync_control_alerts();
