-- =====================================================================
-- Demo 自動運轉：每 2 分鐘把「假資料訂單」依時間往下一步推進
-- 只動 created_by 以 'OP-' 開頭的系統假單；客戶／使用者手動建立的單不動
-- 約 12% 的單會刻意延誤，讓燈號、警示、異常自然出現
-- =====================================================================
create or replace function advance_demo() returns text
language plpgsql security definer set search_path = public as $fn$
declare r record; v_id uuid; d_id uuid; n int := 0; s record;
begin
  -- 1) 建單 → 釋出（出車前 150 分鐘）
  update orders set status='released' where created_by like 'OP-%' and status='created' and now() > req_depart_at - interval '150 min';

  -- 2) 釋出 → 撿貨中（出車前 70 分鐘；延誤單晚 25 分鐘）
  with u as (update orders o set status='picking' where created_by like 'OP-%' and status='released'
      and now() > req_depart_at - make_interval(mins => 70 - case when abs(hashtext(order_no))%100<12 then 25 else 0 end) returning id)
  update pick_tasks p set status='picking', started_at=now(), picker='撿貨員'||(1+abs(hashtext(p.id::text))%3) from u where p.order_id=u.id;

  -- 3) 撿貨中 → 已撿貨（出車前 30 分鐘）
  with u as (update orders o set status='picked' where created_by like 'OP-%' and status='picking'
      and now() > req_depart_at - make_interval(mins => 30 - case when abs(hashtext(order_no))%100<12 then 25 else 0 end) returning id)
  update pick_tasks p set status='done', done_at=now() from u where p.order_id=u.id;
  update order_lines l set picked_qty=qty from orders o where l.order_id=o.id and o.created_by like 'OP-%' and o.status in ('picked','loaded','in_transit','delivered') and l.picked_qty=0;

  -- 4) 派車（出車前 25 分鐘，沒車就送缺車通報）
  for r in select o.* from orders o where o.created_by like 'OP-%' and o.status='picked'
      and now() > o.req_depart_at - interval '25 min' and not exists (select 1 from trip_orders t where t.order_id=o.id) loop
    select id into v_id from vehicles where home_site=r.site_id and status='idle' order by random() limit 1;
    if v_id is null then
      insert into vehicle_shortage_reports(site_id,type_code,needed_at,order_ids,reason_tag,reported_by,status)
        values (r.site_id, r.type_code, r.req_depart_at, array[r.id], (array['stuck_in_fab','burst_orders','no_consolidation'])[1+abs(hashtext(r.order_no))%3], '系統', 'open');
      select id into v_id from vehicles where home_site=r.site_id order by random() limit 1;
    end if;
    select id into d_id from drivers where vehicle_id=v_id limit 1;
    insert into trips(trip_no,site_id,vehicle_id,driver_id,planned_depart_at,status)
      values ('TA'||upper(substr(md5(r.id::text),1,8)), r.site_id, v_id, d_id, r.req_depart_at, 'dispatched') returning id into v_id;
    insert into trip_orders(trip_id,order_id,stop_seq) values (v_id, r.id, 1);
    update vehicles set status='assigned' where id=(select vehicle_id from trips where id=v_id) and status='idle';
    n := n + 1;
  end loop;

  -- 5) 已撿貨 → 已交車（出車前 10 分鐘）
  with u as (update orders o set status='loaded' where created_by like 'OP-%' and status='picked'
      and exists (select 1 from trip_orders t where t.order_id=o.id)
      and now() > req_depart_at - make_interval(mins => 10 - case when abs(hashtext(order_no))%100<12 then 25 else 0 end) returning id),
    e as (insert into tracking_events(trip_id,order_id,event,note) select t.trip_id,u.id,'handover','倉庫掃碼交車' from u join trip_orders t on t.order_id=u.id returning trip_id)
  update trips set status='handover' where id in (select trip_id from e) and status in ('planned','dispatched');

  -- 6) 已交車 → 配送中（出車時間 + 0~8 分鐘；延誤單 +25）
  with u as (update orders o set status='in_transit' where created_by like 'OP-%' and status='loaded'
      and now() > req_depart_at + make_interval(mins => abs(hashtext(order_no))%9 + case when abs(hashtext(order_no))%100<12 then 25 else 0 end) returning id),
    e as (insert into tracking_events(trip_id,order_id,event) select t.trip_id,u.id,'depart' from u join trip_orders t on t.order_id=u.id returning trip_id),
    tr as (update trips set status='departed' where id in (select trip_id from e) returning vehicle_id)
  update vehicles set status='on_trip' where id in (select vehicle_id from tr);

  -- 7) 抵達哨口（行程 75%）
  insert into tracking_events(trip_id,order_id,event)
  select t.trip_id, o.id, 'arrive_gate' from orders o join trip_orders t on t.order_id=o.id
  where o.created_by like 'OP-%' and o.status='in_transit'
    and now() > o.req_depart_at + (o.req_arrive_at - o.req_depart_at) * 0.75 + make_interval(mins => case when abs(hashtext(o.order_no))%100<12 then 25 else 0 end)
    and not exists (select 1 from tracking_events x where x.order_id=o.id and x.event='arrive_gate');

  -- 8) 部分單在廠內排隊 → 司機回報異常
  with u as (insert into exceptions(order_id,trip_id,kind,severity,description,reported_by,status)
    select o.id, t.trip_id, 'queue_at_fab', 'mid', '廠內排隊：前面還有 '||(3+abs(hashtext(o.order_no))%5)||' 台車', '司機', 'open'
    from orders o join trip_orders t on t.order_id=o.id join customers c on c.id=o.customer_id
    where o.created_by like 'OP-%' and o.status='in_transit' and c.is_fab and abs(hashtext(o.order_no))%100 between 12 and 17
      and exists (select 1 from tracking_events x where x.order_id=o.id and x.event='arrive_gate')
      and not exists (select 1 from exceptions x where x.order_id=o.id) returning order_id, trip_id, description)
  insert into tracking_events(trip_id,order_id,event,note) select trip_id, order_id, 'exception', description from u;

  -- 9) 配送中 → 已送達（ETA −8～+0 分；延誤單 +40）
  with u as (update orders o set status='delivered' where created_by like 'OP-%' and status='in_transit'
      and now() > req_arrive_at + make_interval(mins => abs(hashtext(order_no))%9 - 8 + case when abs(hashtext(order_no))%100<18 then 40 else 0 end)
      returning id, customer_id),
    e as (insert into tracking_events(trip_id,order_id,event,is_backfill)
      select t.trip_id, u.id, ev, c.is_fab from u join trip_orders t on t.order_id=u.id join customers c on c.id=u.customer_id
      cross join (values ('arrive_dock'),('delivered')) v(ev) returning trip_id)
  select count(*) into n from e;
  -- 車趟全部送達 → 完成（另起一句，才看得到上一步更新後的訂單狀態）
  update trips tt set status='completed' where status in ('dispatched','handover','departed','arrived')
    and exists (select 1 from trip_orders x where x.trip_id=tt.id)
    and not exists (select 1 from trip_orders x join orders o on o.id=x.order_id where x.trip_id=tt.id and o.status not in ('delivered','cancelled'));
  update vehicles v set status='idle' where status in ('assigned','on_trip')
    and not exists (select 1 from trips t where t.vehicle_id=v.id and t.status in ('dispatched','handover','departed','arrived'));

  -- 排隊類異常：交貨後自動結案
  update exceptions x set status='closed', resolution='已完成交貨，排隊結束', closed_at=now()
  from orders o where o.id=x.order_id and o.status='delivered' and x.kind='queue_at_fab' and x.status<>'closed' and x.reported_by='司機' and o.created_by like 'OP-%';

  -- 10) 補新訂單：每個庫房保持 3 張以上「90 分鐘後」的單
  for s in select si.id site_id, count(o.id) c from sites si left join orders o on o.site_id=si.id and o.created_by like 'OP-%' and o.req_depart_at > now() + interval '90 min' group by si.id loop
    if s.c < 3 then
      insert into orders(order_no,customer_id,site_id,location_id,type_code,req_depart_at,req_arrive_at,status,created_by)
      select 'TW'||to_char(now() at time zone 'Asia/Taipei','YYMMDD')||lpad((floor(random()*9000)+1000)::text,4,'0')||chr(65+floor(random()*26)::int),
        l.customer_id, s.site_id, l.id, (array['3.5T','7T','7T','17T'])[1+floor(random()*4)::int], dep,
        dep + make_interval(mins => coalesce((l.std_travel_min->>s.site_id)::int, 60)), 'created', 'OP-'||s.site_id
      from generate_series(1, 3 - s.c) g
      cross join lateral (select date_trunc('minute', now() + make_interval(mins => 100 + floor(random()*200)::int + (g*0)::int)) dep) d
      cross join lateral (select * from locations where (std_travel_min ? s.site_id) and g>0 order by random() limit 1) l;
    end if;
  end loop;
  insert into order_lines(order_id,sku,qty)
  select o.id, p.sku, (1+floor(random()*20))::int from orders o
  cross join lateral (select sku from products where o.id is not null order by random() limit 1+floor(random()*3)::int) p
  where not exists (select 1 from order_lines l where l.order_id=o.id);
  insert into pick_tasks(order_id,site_id,status)
  select o.id, o.site_id, 'open' from orders o where not exists (select 1 from pick_tasks p where p.order_id=o.id);

  return 'advanced ' || now();
end $fn$;
grant execute on function advance_demo() to anon, authenticated;

select cron.unschedule('ft-advance-demo') where exists (select 1 from cron.job where jobname='ft-advance-demo');
select cron.schedule('ft-advance-demo', '*/2 * * * *', $$select public.advance_demo()$$);
select public.advance_demo();
