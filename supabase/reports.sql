-- =====================================================================
-- FlowTower 管理報表 v2
--   11 項管理指標 × 5 個角度（運輸商／司機／運輸商管理同仁／客戶／站點）× 趨勢
-- 執行順序：reset_demo.sql → advance_demo.sql → 本檔 → security.sql（可重複執行）
--
-- 為什麼要另外的歷史資料表？
--   Demo 作業資料每天 06:00 重置，只有「今天」幾個小時；作業表又有 2 萬筆上限。
--   所以歷史資料放在獨立的 rpt_ 資料表（唯讀），每天 06:05 以「昨天往前 180 天」重產。
--
-- 指標定義（目標值在 rpt_kpi_defs，可直接改）：
--   準時派車        派好車與司機的時間 ≤ 預計出車 − 5 分鐘
--   準時出車        實際出車 ≤ 預計出車 + 15 分鐘
--   準時配達        實際送達 ≤ 指定送達(ETA)
--   異常／客訴      每 100 趟件數
--   Milestone 回傳  交車／出發／抵達／簽收 4 個節點都有回傳的趟次比例
--   紙本車單繳回率  配達後 7 天內繳回；只算配達已滿 7 天的趟次（未到期的不判定）
--   紙本車單繳回天數 配達 → 繳回；尚未繳回的以「到今天」的天數計入；同樣只算配達已滿 7 天的趟次
--   教育訓練涵蓋率  期間內有出車的司機中，3 門必修課都在有效期（1 年）內的比例（以期末判定）
--   跟車稽核執行率  實際稽核次數 ÷ 目標（每家運輸商每月 2 次）；同仁的目標 = 負責運輸商數 × 2
--   「運輸商管理同仁」= 我們部門負責管理運輸商的同仁（對應表 rpt_carrier_owner）
-- =====================================================================

-- ---------- 0. 移除 v1 的函式（參數不同，避免 API 呼叫時混淆） ----------
drop function if exists rpt_carriers(int, text, uuid);
drop function if exists rpt_people(int, text, uuid);
drop function if exists rpt_revenue(int, text, uuid);
drop function if exists rpt_fleet(int, text, uuid);
drop function if exists rpt_base(int, text, uuid);
drop view if exists rpt_fact;

-- ---------- 1. 資料表 ----------
create table if not exists rpt_trips (
  id bigserial primary key,
  trip_date date not null,
  site_id text, carrier_id uuid, vehicle_id uuid, driver_id uuid, customer_id uuid, location_id uuid, type_code text,
  planned_depart timestamptz, actual_depart timestamptz, req_arrive timestamptz, actual_arrive timestamptz, return_at timestamptz,
  is_fab boolean,
  events_expected int, events_recorded int, events_realtime int, backfill_cnt int, report_delay_min numeric,
  exception_kind text, exception_severity text, exception_close_h numeric,
  revenue numeric, cost numeric,
  cross_site boolean default false
);
alter table rpt_trips add column if not exists dispatched_at timestamptz;       -- 派好車與司機的時間
alter table rpt_trips add column if not exists complaint text;                  -- 客訴類型（null = 無）
alter table rpt_trips add column if not exists waybill_returned_at timestamptz; -- 紙本車單繳回
alter table rpt_trips add column if not exists order_count int default 1;
create index if not exists rpt_trips_date on rpt_trips(trip_date);

create table if not exists rpt_carrier_owner (      -- 運輸商 ↔ 負責的管理同仁
  carrier_id uuid primary key, staff text not null);

create table if not exists rpt_driver_training (    -- 司機教育訓練紀錄
  id bigserial primary key, driver_id uuid, course text, trained_at date, expires_at date);
create index if not exists rpt_training_driver on rpt_driver_training(driver_id);

create table if not exists rpt_ride_audits (        -- 跟車稽核
  id bigserial primary key, audit_date date, staff text, carrier_id uuid, driver_id uuid, site_id text, customer_id uuid,
  findings int, findings_closed int, closed_at date, note text);
create index if not exists rpt_audits_date on rpt_ride_audits(audit_date);

create table if not exists rpt_staff_tasks (
  id bigserial primary key, staff text not null, kind text not null, carrier_id uuid, site_id text, title text,
  created_at timestamptz, due_at timestamptz, done_at timestamptz);

create table if not exists rpt_shortage (
  id bigserial primary key, reported_at timestamptz, site_id text, type_code text, reason_tag text, status text,
  idle_same_site int, idle_same_type int, idle_region int);

create table if not exists rpt_kpi_defs (            -- 指標目錄與目標值（改目標改這裡）
  kpi text primary key, label text, unit text, better text, target numeric, sort int, grp text);
insert into rpt_kpi_defs(kpi, label, unit, better, target, sort, grp) values
  ('dispatch',   '準時派車率',          '%',      'hi', 95,   1, 'kpi'),
  ('depart',     '準時出車率',          '%',      'hi', 95,   2, 'kpi'),
  ('arrive',     '準時配達率',          '%',      'hi', 95,   3, 'kpi'),
  ('exception',  '異常件數',            '件/百趟', 'lo', 3,    4, 'kpi'),
  ('complaint',  '客訴件數',            '件/百趟', 'lo', 0.5,  5, 'kpi'),
  ('milestone',  'Milestone 回傳率',    '%',      'hi', 98,   6, 'kpi'),
  ('paper_rate', '紙本車單 7 天繳回率', '%',      'hi', 95,   7, 'kpi'),
  ('paper_days', '紙本車單繳回天數',    '天',     'lo', 3,    8, 'kpi'),
  ('training',   '司機教育訓練涵蓋率',  '%',      'hi', 100,  9, 'kpi'),
  ('audit',      '跟車稽核執行率',      '%',      'hi', 100, 10, 'kpi'),
  ('trips',      '車趟數',              '趟',     'hi', null, 11, 'volume'),
  ('orders',     '訂單數',              '張',     'hi', null, 12, 'volume'),
  ('revenue',    '營收',                '元',     'hi', null, 13, 'money'),
  ('cost',       '成本',                '元',     'lo', null, 14, 'money'),
  ('gp',         '毛利',                '元',     'hi', null, 15, 'money'),
  ('margin',     '毛利率',              '%',      'hi', 18,   16, 'money')
on conflict (kpi) do update set label = excluded.label, unit = excluded.unit, better = excluded.better, sort = excluded.sort, grp = excluded.grp;
-- 重跑本檔不會覆蓋你改過的目標值

do $$ declare t text; begin
  foreach t in array array['rpt_trips','rpt_carrier_owner','rpt_driver_training','rpt_ride_audits','rpt_staff_tasks','rpt_shortage','rpt_kpi_defs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists rpt_read on %I', t);
    execute format('create policy rpt_read on %I for select to anon, authenticated using (true)', t);
    execute format('grant select on %I to anon, authenticated', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- 2. 產生歷史資料 ----------
create or replace function gen_report_history(p_days int default 180) returns text
language plpgsql security definer set search_path = public as $fn$
declare
  today date := (now() at time zone 'Asia/Taipei')::date;
  d0 date := today - p_days;
  d date; m date; v record; loc record; c record; dr record; tr record;
  n int; i int; k int; t_start timestamptz; shift_end timestamptz;
  travel int; delay int; dur int; arr timestamptz; ret timestamptz; disp timestamptz; wb timestamptz;
  rev numeric; exc text; sev text; cmp text; rec int; rt int; bf int; tot int := 0;
  nxt date; fd int;
  courses text[] := array['安全駕駛','晶圓廠進廠規範','貨態回報操作'];
  kinds text[] := array['異常追蹤','客訴處理','紙本車單追繳','司機訓練安排','稽核缺失改善追蹤','帳單核對'];
  sla int[] := array[24, 48, 72, 120, 168, 72];
  cr timestamptz;
begin
  perform setseed(0.42);
  truncate rpt_trips, rpt_staff_tasks, rpt_shortage, rpt_driver_training, rpt_ride_audits, rpt_carrier_owner restart identity;

  -- 運輸商特性（每家強弱項不同，報表才看得出差異）
  create temp table _prof on commit drop as
  select id carrier_id, name,
    case name when '順達通運' then '{"late":0.04,"disp":0.01,"miss":0.01,"exc":0.02,"cmp":0.003,"cost":0.78,"delay":4,"plate":0.03,"plost":0.005,"renew":0.08,"untrained":0.0}'
              when '鴻運物流' then '{"late":0.08,"disp":0.03,"miss":0.03,"exc":0.03,"cmp":0.006,"cost":0.80,"delay":7,"plate":0.08,"plost":0.01,"renew":0.25,"untrained":0.03}'
              when '大成貨運' then '{"late":0.16,"disp":0.06,"miss":0.04,"exc":0.05,"cmp":0.012,"cost":0.76,"delay":9,"plate":0.06,"plost":0.01,"renew":0.22,"untrained":0.03}'
              else                '{"late":0.06,"disp":0.02,"miss":0.12,"exc":0.035,"cmp":0.008,"cost":0.83,"delay":18,"plate":0.22,"plost":0.03,"renew":0.3,"untrained":0.05}' end::jsonb p
  from carriers;

  -- 運輸商 ↔ 負責同仁
  insert into rpt_carrier_owner(carrier_id, staff)
  select carrier_id, case name when '順達通運' then '運管-林雅婷' when '快捷車行' then '運管-林雅婷'
                               when '鴻運物流' then '運管-陳冠廷' else '運管-黃詩涵' end from _prof;
  create temp table _staff on commit drop as
  select * from (values ('運管-林雅婷', 0.95, 0.7), ('運管-陳冠廷', 0.8, 1.0), ('運管-黃詩涵', 0.55, 1.5)) x(staff, diligence, speed);

  -- Demo 費率
  delete from rate_cards;
  insert into rate_cards(from_site, location_id, type_code, revenue, cost)
  select s.key, l.id, vt.code,
    round((900 + s.value::int * 26) * (0.7 + vt.rank * 0.35) / 10) * 10,
    round((900 + s.value::int * 26) * (0.7 + vt.rank * 0.35) * 0.8 / 10) * 10
  from locations l cross join lateral jsonb_each_text(l.std_travel_min) s cross join vehicle_types vt;

  -- 車趟
  for d in select generate_series(d0, today - 1, interval '1 day')::date loop
    for v in select ve.*, dv.id driver_id, p.p from vehicles ve
             left join drivers dv on dv.vehicle_id = ve.id join _prof p on p.carrier_id = ve.carrier_id loop
      if random() < (case when extract(dow from d) = 0 then 0.75 else 0.06 end) then continue; end if;
      t_start := (d + v.shift_start + make_interval(mins => floor(random()*40)::int)) at time zone 'Asia/Taipei';
      shift_end := (d + v.shift_end) at time zone 'Asia/Taipei';
      n := 0;
      loop
        select l.*, (l.std_travel_min->>v.home_site)::int tm, cu.is_fab, cu.id cid into loc
        from locations l join customers cu on cu.id = l.customer_id
        where l.std_travel_min ? v.home_site order by random() limit 1;
        exit when loc is null;
        travel := loc.tm;
        delay := case when random() < (v.p->>'late')::numeric then 16 + floor(random()*40)::int else floor(random()*12)::int - 5 end;
        dur := round(travel * (0.85 + random()*0.25)) + case when loc.is_fab then floor(random()*20)::int else 0 end;
        arr := t_start + make_interval(mins => delay + dur);
        ret := arr + make_interval(mins => 25 + floor(random()*20)::int + round(travel*0.9)::int);
        exit when ret > shift_end + interval '45 min' or n >= 5;
        disp := case when random() < (v.p->>'disp')::numeric
                     then t_start + make_interval(mins => floor(random()*20)::int - 4)          -- 晚派車
                     else t_start - make_interval(mins => 30 + floor(random()*300)::int) end;
        rec := 4 - case when random() < (v.p->>'miss')::numeric then 1 + floor(random()*2)::int else 0 end;
        bf  := case when loc.is_fab and random() < 0.55 then 1 else 0 end;
        rt  := greatest(rec - bf - case when random() < (v.p->>'miss')::numeric * 2 then 1 else 0 end, 0);
        exc := null; sev := null; cmp := null;
        if random() < (v.p->>'exc')::numeric + (case when delay > 15 then 0.05 else 0 end) then
          exc := (array['late','late','queue_at_fab','damage','shortage_qty','reject','address','vehicle_breakdown'])[1+floor(random()*8)::int];
          sev := (array['low','mid','mid','high'])[1+floor(random()*4)::int];
        end if;
        if random() < (v.p->>'cmp')::numeric + (case when exc is not null then 0.06 else 0 end) then
          cmp := (array['延遲送達','服務態度','貨損','未事先通知','文件錯誤'])[1+floor(random()*5)::int];
        end if;
        wb := case when random() < (v.p->>'plost')::numeric then null
                   when random() < (v.p->>'plate')::numeric then arr + make_interval(days => 8 + floor(random()*14)::int)
                   else arr + make_interval(days => 1 + floor(random()*5)::int, hours => floor(random()*8)::int) end;
        if wb > now() then wb := null; end if;
        rev := round((900 + travel*26) * (0.7 + (select rank from vehicle_types where code = v.type_code)*0.35) / 10) * 10;
        insert into rpt_trips(trip_date, site_id, carrier_id, vehicle_id, driver_id, customer_id, location_id, type_code,
          planned_depart, actual_depart, req_arrive, actual_arrive, return_at, is_fab,
          events_expected, events_recorded, events_realtime, backfill_cnt, report_delay_min,
          exception_kind, exception_severity, exception_close_h, revenue, cost, cross_site,
          dispatched_at, complaint, waybill_returned_at, order_count)
        values (d, case when random() < 0.04 then (select id from sites where id <> v.home_site order by random() limit 1) else v.home_site end,
          v.carrier_id, v.id, v.driver_id, loc.cid, loc.id, v.type_code,
          t_start, t_start + make_interval(mins => delay), t_start + make_interval(mins => round(travel * 1.15)::int + 20), arr, ret, loc.is_fab,
          4, rec, rt, bf, round(((v.p->>'delay')::numeric * (0.5 + random())::numeric) + bf * 35, 1),
          exc, sev, case when exc is not null then round((2 + random() * case sev when 'high' then 40 else 18 end)::numeric, 1) end,
          rev, round(rev * ((v.p->>'cost')::numeric + random()*0.04) + case when exc is not null then rev*0.15 else 0 end),
          false, disp, cmp, wb, 1 + floor(random()*random()*3)::int);
        n := n + 1; tot := tot + 1;
        t_start := ret + make_interval(mins => 15 + floor(random()*50)::int);
      end loop;
    end loop;
  end loop;
  update rpt_trips t set cross_site = true from vehicles ve where ve.id = t.vehicle_id and t.site_id <> ve.home_site;

  -- 教育訓練：每位司機 3 門必修，每年複訓；有的運輸商常常逾期才複訓
  for dr in select dv.id, p.p from drivers dv join _prof p on p.carrier_id = dv.carrier_id loop
    for k in 1 .. 3 loop
      continue when random() < (dr.p->>'untrained')::numeric;              -- 從沒上過這門課
      nxt := today - (200 + floor(random()*360)::int);
      while nxt < today loop
        insert into rpt_driver_training(driver_id, course, trained_at, expires_at) values (dr.id, courses[k], nxt, nxt + 365);
        nxt := nxt + 365 + case when random() < (dr.p->>'renew')::numeric then 15 + floor(random()*100)::int else -floor(random()*30)::int end;
      end loop;
    end loop;
  end loop;

  -- 跟車稽核：每家運輸商每月目標 2 次，由負責同仁執行（執行力各不相同）
  for m in select generate_series(date_trunc('month', d0)::date, today - 1, interval '1 month')::date loop
    for c in select o.carrier_id, o.staff, st.diligence from rpt_carrier_owner o join _staff st using (staff) loop
      for i in 1 .. 3 loop
        continue when (i <= 2 and random() > c.diligence) or (i = 3 and random() > 0.12);
        select * into tr from rpt_trips
         where carrier_id = c.carrier_id and trip_date >= greatest(m, d0) and trip_date < least((m + interval '1 month')::date, today)
         order by random() limit 1;
        continue when tr is null;
        fd := floor(random()*random()*4)::int;
        insert into rpt_ride_audits(audit_date, staff, carrier_id, driver_id, site_id, customer_id, findings, findings_closed, closed_at, note)
        values (tr.trip_date, c.staff, c.carrier_id, tr.driver_id, tr.site_id, tr.customer_id, fd,
          case when fd = 0 then 0 when tr.trip_date + 14 < today then fd - case when random() < 0.2 then 1 else 0 end else floor(random()*(fd+1))::int end,
          case when fd > 0 and tr.trip_date + 14 < today then tr.trip_date + 2 + floor(random()*12)::int end,
          (array['跟車全程無缺失','未依規定繫安全帶','進廠前未確認證件','貨物綑綁不確實','未即時回報貨態','超速','車廂清潔不佳'])[case when fd = 0 then 1 else 2 + floor(random()*6)::int end]);
      end loop;
    end loop;
  end loop;

  -- 缺車通報 × 同時段閒置車
  insert into rpt_shortage(reported_at, site_id, type_code, reason_tag, status)
  select ((d0 + (floor(random()*p_days))::int) + make_interval(hours => (array[7,8,8,9,9,10,13,14,14,15,16])[1+floor(random()*11)::int], mins => floor(random()*60)::int))
           at time zone 'Asia/Taipei',
    s.id, (array['3.5T','7T','7T','17T'])[1+floor(random()*4)::int],
    (array['true_capacity','stuck_in_fab','stuck_in_fab','burst_orders','no_consolidation','driver_absent'])[1+floor(random()*6)::int],
    (array['covered_cross_site','covered_extra','unresolved','covered_cross_site','covered_extra'])[1+floor(random()*5)::int]
  from sites s cross join generate_series(1, case when s.id in ('N1','H1','S1') then p_days / 6 else p_days / 15 end);
  update rpt_shortage r set idle_same_site = coalesce(x.same_site,0), idle_same_type = coalesce(x.same_type,0), idle_region = coalesce(x.region,0)
  from (
    select r2.id,
      count(ve.id) filter (where ve.home_site = r2.site_id) same_site,
      count(ve.id) filter (where ve.home_site = r2.site_id and vt.rank >= rt.rank) same_type,
      count(ve.id) filter (where ve.home_site <> r2.site_id and s1.region = s2.region) region
    from rpt_shortage r2
    join sites s2 on s2.id = r2.site_id join vehicle_types rt on rt.code = r2.type_code
    left join vehicles ve on (r2.reported_at at time zone 'Asia/Taipei')::time between ve.shift_start and ve.shift_end
      and exists (select 1 from rpt_trips t where t.vehicle_id = ve.id and t.trip_date = (r2.reported_at at time zone 'Asia/Taipei')::date)
      and not exists (select 1 from rpt_trips t where t.vehicle_id = ve.id and r2.reported_at between t.actual_depart and t.return_at)
    left join vehicle_types vt on vt.code = ve.type_code
    left join sites s1 on s1.id = ve.home_site
    group by r2.id) x
  where x.id = r.id;

  -- 管理同仁待辦（依負責運輸商分派）
  for d in select generate_series(d0, today, interval '1 day')::date loop
    for i in 1 .. 4 + floor(random()*4)::int loop
      k := 1 + floor(random()*6)::int;
      select o.carrier_id, o.staff, p.name, st.speed into c from rpt_carrier_owner o join _prof p using (carrier_id) join _staff st using (staff) order by random() limit 1;
      cr := (d + make_interval(hours => 8 + floor(random()*9)::int, mins => floor(random()*60)::int)) at time zone 'Asia/Taipei';
      insert into rpt_staff_tasks(staff, kind, carrier_id, site_id, title, created_at, due_at, done_at)
      values (c.staff, kinds[k], c.carrier_id, (select id from sites order by random() limit 1), kinds[k] || '：' || c.name,
        cr, cr + make_interval(hours => sla[k]),
        case when cr + make_interval(hours => round(sla[k] * c.speed * (0.3 + random()*1.1))::int) < now()
             then cr + make_interval(hours => round(sla[k] * c.speed * (0.3 + random()*1.1))::int) end);
    end loop;
  end loop;

  return 'ok ' || tot || ' trips';
end $fn$;
revoke execute on function gen_report_history(int) from public, anon, authenticated;

-- ---------- 3. 車趟事實檢視：每趟車的各指標分子／分母 + 5 個角度 ----------
create view rpt_fact with (security_invoker = true) as
select t.*,
  c.name carrier, dv.name driver, coalesce(o.staff, '（未指派）') staff, cu.name customer, s.name site,
  (t.dispatched_at <= t.planned_depart - interval '5 min')::int dispatch_ok,
  (t.actual_depart <= t.planned_depart + interval '15 min')::int depart_ok,
  (t.actual_arrive <= t.req_arrive)::int arrive_ok,
  (t.exception_kind is not null)::int exc,
  (t.complaint is not null)::int cmp,
  (t.events_recorded >= t.events_expected)::int milestone_ok,
  (t.actual_arrive <= now() - interval '7 days')::int paper_due,                 -- 配達滿 7 天才判定
  (t.waybill_returned_at is not null and t.waybill_returned_at <= t.actual_arrive + interval '7 days')::int paper_ok,
  round((extract(epoch from coalesce(t.waybill_returned_at, now()) - t.actual_arrive) / 86400)::numeric, 2) paper_days
from rpt_trips t
left join carriers c on c.id = t.carrier_id
left join drivers dv on dv.id = t.driver_id
left join rpt_carrier_owner o on o.carrier_id = t.carrier_id
left join customers cu on cu.id = t.customer_id
left join sites s on s.id = t.site_id;
grant select on rpt_fact to anon, authenticated;

-- ---------- 4. 通用指標函式 ----------
-- p_kpi：rpt_kpi_defs.kpi；p_dim：all / carrier / driver / staff / customer / site
-- p_grain：week / month；p_days：最近幾天（到昨天）；篩選：庫房、運輸商、管理同仁
create or replace function rpt_kpi(p_kpi text, p_dim text default 'all', p_days int default 90, p_grain text default 'week',
  p_site text default null, p_carrier uuid default null, p_staff text default null)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare
  d_to date := (now() at time zone 'Asia/Taipei')::date - 1;
  nd int := least(greatest(coalesce(p_days, 90), 7), 180);
  d_from date := d_to - nd + 1;
  g text := case when p_grain = 'month' then 'month' else 'week' end;
  kx text; lx text; num text; den text; mult numeric := 100; agg text := 'ratio';
  w text; res jsonb; tgt numeric;
begin
  if p_dim not in ('all','carrier','driver','staff','customer','site') then raise exception 'bad dim'; end if;
  kx := case p_dim when 'all' then '''all''' when 'carrier' then 'carrier_id::text' when 'driver' then 'driver_id::text'
              when 'staff' then 'staff' when 'customer' then 'customer_id::text' else 'site_id' end;
  lx := case p_dim when 'all' then '''全部''' when 'carrier' then 'carrier' when 'driver' then 'driver'
              when 'staff' then 'staff' when 'customer' then 'customer' else 'site' end;
  w := format('(%L::text is null or site_id = %L) and (%L::uuid is null or carrier_id = %L) and (%L::text is null or staff = %L)',
              p_site, p_site, p_carrier, p_carrier, p_staff, p_staff);

  if p_kpi in ('dispatch','depart','arrive','milestone','exception','complaint','paper_rate','paper_days','trips','orders','revenue','cost','gp','margin') then
    num := case p_kpi when 'dispatch' then 'dispatch_ok' when 'depart' then 'depart_ok' when 'arrive' then 'arrive_ok'
             when 'milestone' then 'milestone_ok' when 'exception' then 'exc' when 'complaint' then 'cmp'
             when 'paper_rate' then 'paper_ok * paper_due' when 'paper_days' then 'paper_days * paper_due' when 'trips' then '1'
             when 'orders' then 'order_count' when 'revenue' then 'revenue' when 'cost' then 'cost'
             else 'revenue - cost' end;
    den := case p_kpi when 'paper_rate' then 'paper_due' when 'paper_days' then 'paper_due' when 'margin' then 'revenue' else '1' end;
    if p_kpi in ('trips','orders','revenue','cost','gp') then agg := 'sum'; end if;
    if p_kpi = 'paper_days' then mult := 1; end if;
    execute format($q$
      with b as (select %1$s k, %2$s l, date_trunc(%3$L, trip_date)::date p, trip_date, (%4$s)::numeric nu, (%5$s)::numeric de
                 from rpt_fact where %6$s and trip_date between %7$L::date - %8$s and %9$L),
      cur as (select * from b where trip_date >= %7$L),
      val as (select k, max(l) l, count(*) n, sum(nu) nu, sum(de) de from cur group by k),
      prv as (select k, sum(nu) nu, sum(de) de from b where trip_date < %7$L group by k),
      ser as (select p, k, count(*) n, count(distinct trip_date) days, sum(nu) nu, sum(de) de from cur group by p, k)
      select jsonb_build_object(
        'total', (select jsonb_build_object('n', count(*), 'value', case when %10$L = 'sum' then sum(nu) else round(%11$s * sum(nu) / nullif(sum(de),0), 2) end) from cur),
        'prev',  (select jsonb_build_object('value', case when %10$L = 'sum' then sum(nu) else round(%11$s * sum(nu) / nullif(sum(de),0), 2) end) from b where trip_date < %7$L),
        'rows',  coalesce((select jsonb_agg(jsonb_build_object('key', v.k, 'label', v.l, 'n', v.n,
                    'value', case when %10$L = 'sum' then v.nu else round(%11$s * v.nu / nullif(v.de,0), 2) end,
                    'prev',  case when %10$L = 'sum' then pv.nu else round(%11$s * pv.nu / nullif(pv.de,0), 2) end,
                    'num', v.nu, 'den', v.de)) from val v left join prv pv using (k)), '[]'),
        'series', coalesce((select jsonb_agg(jsonb_build_object('p', p, 'key', k, 'n', n, 'days', days,
                    'value', case when %10$L = 'sum' then nu else round(%11$s * nu / nullif(de,0), 2) end) order by p) from ser), '[]'))
    $q$, kx, lx, g, num, den, w, d_from, nd, d_to, agg, mult) into res;

  elsif p_kpi = 'training' then
    -- 期間內有出車的司機，期末 3 門必修是否都有效
    execute format($q$
      with a as (select distinct %1$s k, %2$s l, date_trunc(%3$L, trip_date)::date p, driver_id from rpt_fact
                 where %4$s and trip_date between %5$L and %6$L),
      ap as (select a.*, least((p + ('1 ' || %3$L)::interval - interval '1 day')::date, %6$L::date) pe from a),
      cov as (select ap.*, (select count(distinct course) from rpt_driver_training t
                            where t.driver_id = ap.driver_id and t.trained_at <= ap.pe and t.expires_at > ap.pe) = 3 ok from ap),
      tot as (select distinct %1$s k, %2$s l, driver_id from rpt_fact where %4$s and trip_date between %5$L and %6$L),
      tc as (select tot.*, (select count(distinct course) from rpt_driver_training t
                            where t.driver_id = tot.driver_id and t.trained_at <= %6$L and t.expires_at > %6$L) = 3 ok from tot),
      prv as (select distinct %1$s k, driver_id from rpt_fact where %4$s and trip_date between %5$L::date - %7$s and %5$L::date - 1),
      pc as (select prv.*, (select count(distinct course) from rpt_driver_training t
                            where t.driver_id = prv.driver_id and t.trained_at <= %5$L::date - 1 and t.expires_at > %5$L::date - 1) = 3 ok from prv)
      select jsonb_build_object(
        'total', (select jsonb_build_object('n', count(distinct driver_id), 'value', round(100.0 * count(distinct driver_id) filter (where ok) / nullif(count(distinct driver_id),0), 2)) from tc),
        'prev',  (select jsonb_build_object('value', round(100.0 * count(distinct driver_id) filter (where ok) / nullif(count(distinct driver_id),0), 2)) from pc),
        'rows',  coalesce((select jsonb_agg(r) from (select tc.k key, max(tc.l) label, count(*) n, round(100.0 * count(*) filter (where ok) / count(*), 2) value,
                    (select round(100.0 * count(*) filter (where pc.ok) / nullif(count(*),0), 2) from pc where pc.k = tc.k) prev,
                    count(*) filter (where ok) num, count(*) den from tc group by tc.k) r), '[]'),
        'series', coalesce((select jsonb_agg(s order by s.p) from (select p, k key, count(*) n, round(100.0 * count(*) filter (where ok) / count(*), 2) value from cov group by p, k) s), '[]'))
    $q$, kx, lx, g, w, d_from, d_to, nd) into res;

  elsif p_kpi = 'audit' then
    -- 運輸商／同仁／全部：執行率（次數 ÷ 目標）；司機／客戶／站點：次數（沒有目標）
    -- 目標是「每月」，所以趨勢固定以月計，且不畫不滿 10 天的月份
    g := 'month';
    execute format($q$
      with a as (select au.*, c.name carrier, dv.name driver, cu.name customer, s.name site
                 from rpt_ride_audits au left join carriers c on c.id = au.carrier_id left join drivers dv on dv.id = au.driver_id
                 left join customers cu on cu.id = au.customer_id left join sites s on s.id = au.site_id
                 where %1$s and audit_date between %2$L::date - %3$s and %4$L),
      own as (select o.staff, o.carrier_id, c.name carrier from rpt_carrier_owner o join carriers c on c.id = o.carrier_id
              where (%5$L::uuid is null or o.carrier_id = %5$L) and (%6$L::text is null or o.staff = %6$L)),
      keys as (select distinct %7$s k, %8$s l from own where %12$L),
      cur as (select %9$s k, %10$s l, date_trunc(%11$L, audit_date)::date p, findings, findings_closed from a where audit_date >= %2$L),
      prv as (select %9$s k, count(*) n from a where audit_date < %2$L group by 1),
      per as (select p::date p, (least((p + ('1 ' || %11$L)::interval - interval '1 day')::date, %4$L::date) - greatest(p::date, %2$L::date) + 1) days
              from generate_series(date_trunc(%11$L, %2$L::date), %4$L::date, ('1 ' || %11$L)::interval) p),
      perf as (select * from per where days >= 10),
      ncar as (select %7$s k, count(*) nc from own group by 1),
      allk as (select k from keys union select k from cur)
      select jsonb_build_object(
        'rated', %12$L,
        'total', (select jsonb_build_object('n', count(*), 'findings', sum(findings), 'closed', sum(findings_closed),
                   'value', case when %12$L then round(100.0 * count(*) / nullif((select sum(nc) from ncar) * %13$s * %3$s / 30.44, 0), 2) else count(*) end) from cur),
        'prev', jsonb_build_object('value', case when %12$L then round(100.0 * (select coalesce(sum(n),0) from prv) / nullif((select sum(nc) from ncar) * %13$s * %3$s / 30.44, 0), 2)
                                                else (select coalesce(sum(n),0) from prv) end),
        'rows', coalesce((select jsonb_agg(r) from (
                  select x.k key, coalesce((select max(l) from cur where cur.k = x.k), (select max(l) from keys where keys.k = x.k)) label,
                    (select count(*) from cur where cur.k = x.k) n,
                    (select sum(findings) from cur where cur.k = x.k) findings, (select sum(findings_closed) from cur where cur.k = x.k) closed,
                    case when %12$L then round(100.0 * (select count(*) from cur where cur.k = x.k) / nullif(ncar.nc * %13$s * %3$s / 30.44, 0), 2)
                         else (select count(*) from cur where cur.k = x.k) end value,
                    case when %12$L then round(100.0 * coalesce(prv.n,0) / nullif(ncar.nc * %13$s * %3$s / 30.44, 0), 2) else coalesce(prv.n,0) end prev,
                    (select count(*) from cur where cur.k = x.k) num, round(ncar.nc * %13$s * %3$s / 30.44, 1) den
                  from allk x left join ncar on ncar.k = x.k left join prv on prv.k = x.k) r), '[]'),
        'series', coalesce((select jsonb_agg(s order by s.p) from (
                  select per.p, x.k key, count(cur.k) n,
                    case when %12$L then round(100.0 * count(cur.k) / nullif(max(ncar.nc) * %13$s * max(per.days) / 30.44, 0), 2) else count(cur.k) end value
                  from perf per cross join allk x
                  left join cur on cur.p = per.p and cur.k = x.k left join ncar on ncar.k = x.k
                  group by per.p, x.k) s), '[]'))
    $q$,
      format('(%L::text is null or au.site_id = %L) and (%L::uuid is null or au.carrier_id = %L) and (%L::text is null or au.staff = %L)', p_site, p_site, p_carrier, p_carrier, p_staff, p_staff),
      d_from, nd, d_to, p_carrier, p_staff,
      case p_dim when 'carrier' then 'carrier_id::text' when 'staff' then 'staff' else '''all''' end,
      case p_dim when 'carrier' then 'carrier' when 'staff' then 'staff' else '''全部''' end,
      kx, lx, g, p_dim in ('all','carrier','staff'), 2) into res;
  else
    raise exception 'unknown kpi %', p_kpi;
  end if;

  select target into tgt from rpt_kpi_defs where kpi = p_kpi;
  return res || jsonb_build_object('kpi', p_kpi, 'dim', p_dim, 'grain', g, 'from', d_from, 'to', d_to, 'target', tgt,
    'def', (select to_jsonb(k) from rpt_kpi_defs k where kpi = p_kpi));
end $fn$;

-- 總覽：所有指標的全部值 + 前期 + 趨勢
create or replace function rpt_overview(p_days int default 90, p_grain text default 'week',
  p_site text default null, p_carrier uuid default null, p_staff text default null)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare k record; out jsonb := '[]'; r jsonb;
begin
  for k in select * from rpt_kpi_defs order by sort loop
    r := rpt_kpi(k.kpi, 'all', p_days, p_grain, p_site, p_carrier, p_staff);
    out := out || jsonb_build_array(jsonb_build_object('kpi', k.kpi, 'label', k.label, 'unit', k.unit, 'better', k.better, 'target', k.target, 'grp', k.grp,
      'value', r->'total'->'value', 'n', r->'total'->'n', 'prev', r->'prev'->'value', 'rated', coalesce(r->'rated', 'true'),
      'series', (select coalesce(jsonb_agg(jsonb_build_object('p', e->>'p', 'value', e->'value', 'n', e->'n', 'days', e->'days') order by e->>'p'), '[]') from jsonb_array_elements(r->'series') e)));
  end loop;
  return jsonb_build_object('kpis', out, 'from', r->'from', 'to', r->'to', 'grain', r->'grain');
end $fn$;

-- 明細：某指標在某個角度、某個對象下「沒達標」的紀錄
create or replace function rpt_kpi_detail(p_kpi text, p_dim text default 'all', p_key text default null, p_days int default 90,
  p_site text default null, p_carrier uuid default null, p_staff text default null)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare
  d_to date := (now() at time zone 'Asia/Taipei')::date - 1;
  d_from date := d_to - least(greatest(coalesce(p_days, 90), 7), 180) + 1;
  kx text; cond text; res jsonb;
begin
  if p_dim not in ('all','carrier','driver','staff','customer','site') then raise exception 'bad dim'; end if;
  kx := case p_dim when 'all' then '''all''' when 'carrier' then 'carrier_id::text' when 'driver' then 'driver_id::text'
              when 'staff' then 'staff' when 'customer' then 'customer_id::text' else 'site_id' end;
  if p_kpi = 'training' then
    select coalesce(jsonb_agg(x order by x.missing), '[]') into res from (
      select f.driver, max(f.carrier) carrier, max(f.staff) staff, max(f.site_id) site_id,
        (select string_agg(cs, '、') from unnest(array['安全駕駛','晶圓廠進廠規範','貨態回報操作']) cs
          where not exists (select 1 from rpt_driver_training t where t.driver_id = f.driver_id and t.course = cs and t.trained_at <= d_to and t.expires_at > d_to)) missing,
        (select max(expires_at) from rpt_driver_training t where t.driver_id = f.driver_id and t.expires_at <= d_to) last_expired
      from rpt_fact f
      where f.trip_date between d_from and d_to
        and (p_key is null or p_dim = 'all' or (case p_dim when 'carrier' then f.carrier_id::text when 'driver' then f.driver_id::text when 'staff' then f.staff when 'customer' then f.customer_id::text else f.site_id end) = p_key)
        and (p_site is null or f.site_id = p_site) and (p_carrier is null or f.carrier_id = p_carrier) and (p_staff is null or f.staff = p_staff)
      group by f.driver_id, f.driver) x where x.missing is not null;
    return jsonb_build_object('type', 'training', 'rows', res);
  elsif p_kpi = 'audit' then
    select coalesce(jsonb_agg(x order by x.audit_date desc), '[]') into res from (
      select au.audit_date, au.staff, c.name carrier, dv.name driver, au.site_id, cu.name customer, au.findings, au.findings_closed, au.closed_at, au.note
      from rpt_ride_audits au left join carriers c on c.id = au.carrier_id left join drivers dv on dv.id = au.driver_id left join customers cu on cu.id = au.customer_id
      where au.audit_date between d_from and d_to
        and (p_key is null or p_dim = 'all' or (case p_dim when 'carrier' then au.carrier_id::text when 'driver' then au.driver_id::text when 'staff' then au.staff when 'customer' then au.customer_id::text else au.site_id end) = p_key)
        and (p_site is null or au.site_id = p_site) and (p_carrier is null or au.carrier_id = p_carrier) and (p_staff is null or au.staff = p_staff)
      limit 300) x;
    return jsonb_build_object('type', 'audit', 'rows', res);
  end if;
  cond := case p_kpi when 'dispatch' then 'dispatch_ok = 0' when 'depart' then 'depart_ok = 0' when 'arrive' then 'arrive_ok = 0'
                     when 'milestone' then 'milestone_ok = 0' when 'exception' then 'exc = 1' when 'complaint' then 'cmp = 1'
                     when 'paper_rate' then 'paper_due = 1 and paper_ok = 0' when 'paper_days' then 'paper_due = 1 and (waybill_returned_at is null or paper_days > 7)'
                     else 'false' end;
  execute format($q$
    select coalesce(jsonb_agg(x order by x.trip_date desc, x.planned_depart desc), '[]') from (
      select trip_date, planned_depart, dispatched_at, actual_depart, req_arrive, actual_arrive, waybill_returned_at, paper_days,
        carrier, driver, staff, customer, site_id, exception_kind, exception_severity, complaint, events_recorded, events_expected
      from rpt_fact where %s and trip_date between %L and %L and (%L::text is null or %L = 'all' or %s = %L)
        and (%L::text is null or site_id = %L) and (%L::uuid is null or carrier_id = %L) and (%L::text is null or staff = %L)
      order by trip_date desc limit 300) x
  $q$, cond, d_from, d_to, p_key, p_dim, kx, p_key, p_site, p_site, p_carrier, p_carrier, p_staff, p_staff) into res;
  return jsonb_build_object('type', 'trip', 'rows', res);
end $fn$;

-- 營運量能：每週量能、車輛週轉、使用率、缺車 × 閒置
create or replace function rpt_fleet(p_days int default 90, p_site text default null, p_carrier uuid default null, p_staff text default null)
returns jsonb language sql stable set search_path = public as $$
with rng as (select (now() at time zone 'Asia/Taipei')::date - 1 d_to, least(greatest(coalesce(p_days,90),7),180) n),
b as (select f.* from rpt_fact f, rng where f.trip_date > rng.d_to - rng.n and f.trip_date <= rng.d_to
        and (p_site is null or f.site_id = p_site) and (p_carrier is null or f.carrier_id = p_carrier) and (p_staff is null or f.staff = p_staff)),
veh as (
  select ve.id, ve.plate, ve.type_code, ve.home_site site_id, c.name carrier, coalesce(o.staff,'') staff,
    extract(epoch from (ve.shift_end - ve.shift_start))/3600 shift_h,
    count(b.id) trips, count(distinct b.trip_date) work_days,
    coalesce(sum(extract(epoch from b.return_at - b.actual_depart))/3600, 0) busy_h,
    count(b.id) filter (where b.cross_site) cross_trips
  from vehicles ve join carriers c on c.id = ve.carrier_id left join rpt_carrier_owner o on o.carrier_id = ve.carrier_id
  left join b on b.vehicle_id = ve.id
  where (p_site is null or ve.home_site = p_site) and (p_carrier is null or ve.carrier_id = p_carrier) and (p_staff is null or o.staff = p_staff)
  group by ve.id, ve.plate, ve.type_code, ve.home_site, c.name, o.staff, ve.shift_start, ve.shift_end),
v2 as (select veh.*, round(trips::numeric / nullif(work_days,0), 2) trips_per_day,
         round(100 * busy_h / nullif(shift_h * work_days, 0), 1) util_pct, (select n from rng) - work_days idle_days from veh),
grp as (
  select 'site' dim, site_id label, count(*) vehicles, round(sum(trips)::numeric / nullif(sum(work_days),0), 2) trips_per_day,
    round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) util_pct from v2 group by site_id
  union all select 'type', type_code, count(*), round(sum(trips)::numeric / nullif(sum(work_days),0), 2), round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2 group by type_code
  union all select 'carrier', carrier, count(*), round(sum(trips)::numeric / nullif(sum(work_days),0), 2), round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2 group by carrier
  union all select 'staff', staff, count(*), round(sum(trips)::numeric / nullif(sum(work_days),0), 2), round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2 group by staff),
vd as (select date_trunc('week', b.trip_date)::date p, b.vehicle_id, b.trip_date, count(*) trips, sum(b.order_count) orders,
         sum(extract(epoch from b.return_at - b.actual_depart))/3600 busy,
         max(extract(epoch from (ve.shift_end - ve.shift_start))/3600) shift_h
       from b join vehicles ve on ve.id = b.vehicle_id group by 1, 2, 3),
wk as (select p, sum(trips) trips, sum(orders) orders, count(*) vehicle_days, round(sum(trips)::numeric / count(*), 2) tpv,
         round(100 * sum(busy) / nullif(sum(shift_h),0), 1) util, count(distinct trip_date) days from vd group by p),
sh as (select r.* from rpt_shortage r, rng
       where r.reported_at >= (rng.d_to - rng.n + 1) at time zone 'Asia/Taipei' and r.reported_at < (rng.d_to + 1) at time zone 'Asia/Taipei'
         and (p_site is null or r.site_id = p_site)),
shs as (select site_id, count(*) reports, count(*) filter (where idle_same_type > 0) with_idle_same_site,
          count(*) filter (where idle_same_type = 0 and idle_region > 0) with_idle_region, count(*) filter (where status = 'unresolved') unresolved
        from sh group by site_id),
shr as (select reason_tag, count(*) n, count(*) filter (where idle_same_type > 0) with_idle from sh group by reason_tag),
shd as (select reported_at, site_id, type_code, reason_tag, status, idle_same_site, idle_same_type, idle_region from sh order by reported_at desc limit 200)
select jsonb_build_object(
  'summary', jsonb_build_object('vehicles', (select count(*) from v2),
     'trips', (select count(*) from b), 'orders', (select sum(order_count) from b),
     'trips_per_day', (select round(sum(trips)::numeric / nullif(sum(work_days),0), 2) from v2),
     'util_pct', (select round(100 * sum(busy_h) / nullif(sum(shift_h * work_days),0), 1) from v2),
     'cross_trips', (select sum(cross_trips) from v2),
     'shortage_reports', (select count(*) from sh), 'shortage_with_idle', (select count(*) from sh where idle_same_type > 0)),
  'weekly', coalesce((select jsonb_agg(wk order by p) from wk), '[]'),
  'vehicles', coalesce((select jsonb_agg(v2 order by util_pct nulls first) from v2), '[]'),
  'groups', coalesce((select jsonb_agg(grp order by dim, label) from grp), '[]'),
  'shortage_sites', coalesce((select jsonb_agg(shs order by reports desc) from shs), '[]'),
  'shortage_reasons', coalesce((select jsonb_agg(shr order by n desc) from shr), '[]'),
  'shortage_detail', coalesce((select jsonb_agg(shd) from shd), '[]'))
$$;

-- 管理同仁待辦
create or replace function rpt_staff(p_days int default 90, p_site text default null, p_carrier uuid default null, p_staff text default null)
returns jsonb language sql stable set search_path = public as $$
with st as (
  select t.*, c.name carrier from rpt_staff_tasks t left join carriers c on c.id = t.carrier_id
  where t.created_at >= ((now() at time zone 'Asia/Taipei')::date - least(greatest(coalesce(p_days,90),7),180)) at time zone 'Asia/Taipei'
    and (p_site is null or t.site_id = p_site) and (p_carrier is null or t.carrier_id = p_carrier) and (p_staff is null or t.staff = p_staff)),
own as (select staff, string_agg(c.name, '、' order by c.name) carriers from rpt_carrier_owner o join carriers c on c.id = o.carrier_id group by staff),
stf as (
  select st.staff, max(own.carriers) carriers, count(*) total, count(*) filter (where done_at is not null) done, count(*) filter (where done_at is null) open,
    count(*) filter (where done_at is null and due_at < now()) overdue_open,
    round(100.0 * count(*) filter (where done_at is not null and done_at <= due_at) / nullif(count(*) filter (where done_at is not null), 0), 1) sla_pct,
    round(avg(extract(epoch from done_at - created_at)/3600) filter (where done_at is not null), 1) avg_hours
  from st left join own using (staff) group by st.staff),
stk as (
  select kind, count(*) total, round(avg(extract(epoch from done_at - created_at)/3600) filter (where done_at is not null), 1) avg_hours,
    round(100.0 * count(*) filter (where done_at is not null and done_at <= due_at) / nullif(count(*) filter (where done_at is not null), 0), 1) sla_pct
  from st group by kind),
opn as (select staff, kind, title, site_id, carrier, created_at, due_at, round(extract(epoch from now() - due_at)/3600, 1) overdue_h
        from st where done_at is null order by due_at limit 200)
select jsonb_build_object(
  'staff', coalesce((select jsonb_agg(stf order by overdue_open desc, sla_pct) from stf), '[]'),
  'kinds', coalesce((select jsonb_agg(stk order by total desc) from stk), '[]'),
  'open_tasks', coalesce((select jsonb_agg(opn) from opn), '[]'))
$$;

-- 選單用：管理同仁與負責運輸商
create or replace function rpt_owners() returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('staff', staff, 'carriers', carriers) order by staff), '[]') from (
    select o.staff, jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name) carriers
    from rpt_carrier_owner o join carriers c on c.id = o.carrier_id group by o.staff) x
$$;

grant execute on function rpt_kpi(text, text, int, text, text, uuid, text), rpt_overview(int, text, text, uuid, text),
  rpt_kpi_detail(text, text, text, int, text, uuid, text), rpt_fleet(int, text, uuid, text), rpt_staff(int, text, uuid, text), rpt_owners()
  to anon, authenticated;

-- ---------- 5. 立即產生，並每天 06:05（台灣）重產 ----------
select gen_report_history(180);

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('ft-report-history') where exists (select 1 from cron.job where jobname = 'ft-report-history');
    perform cron.schedule('ft-report-history', '5 22 * * *', 'select public.gen_report_history(180)');
  end if;
end $$;

-- 檢查
select (select count(*) from rpt_trips) trips, (select count(*) from rpt_driver_training) trainings,
       (select count(*) from rpt_ride_audits) audits, (select count(*) from rpt_staff_tasks) staff_tasks;
