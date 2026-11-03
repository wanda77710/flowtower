-- =====================================================================
-- FlowTower 物流塔台 — Demo 資料庫結構 (PostgreSQL / Supabase)
-- 模組：OMS 下單 · WMS 倉庫 · TMS 調度 · 司機貨態 · 異常/缺車 · 車輛資源 · 專案管理平台
-- 全部為 Demo 假資料用；正式上線前需改寫 RLS 權限（見檔尾）
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------- 主檔 Master data ----------
create table sites (               -- 庫房 / 倉庫（控制點）
  id          text primary key,     -- 'FTZ','TY2','HC',...
  name        text not null,
  region      text,
  lat numeric, lng numeric,
  color       text                  -- 控制塔顯示色
);

create table customers (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  is_fab      boolean default false -- 晶圓廠：廠內不可用手機 → 允許補登
);

create table locations (           -- 收貨點（客戶廠區/碼頭）
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  name        text not null,
  address     text,
  gate_name   text,                 -- 哨口
  dock_name   text,                 -- 碼頭
  lat numeric, lng numeric,
  std_travel_min jsonb default '{}'::jsonb  -- {"FTZ":45,"HC":30} 標準行車時間
);

create table products (
  sku         text primary key,
  name        text not null,
  unit        text default 'CTN',
  weight_kg   numeric
);

create table inventory (            -- WMS 庫存（扣帳對象）
  site_id     text references sites(id),
  sku         text references products(sku),
  bin         text,                 -- 儲位
  qty_on_hand integer not null default 0,
  qty_reserved integer not null default 0,
  primary key (site_id, sku, bin)
);

create table carriers (             -- 供應商（車行）
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  contact     text
);

create table vehicle_types (
  code        text primary key,     -- '3.5T','7T','17T','TRAILER'
  capacity_kg numeric,
  rank        int                   -- 大車可替代小車：rank 高者可接 rank 低者
);

create table vehicles (
  id          uuid primary key default gen_random_uuid(),
  plate       text unique,
  type_code   text references vehicle_types(code),
  carrier_id  uuid references carriers(id),
  home_site   text references sites(id),   -- 固定庫房
  shift_start time, shift_end time,
  status      text default 'idle' check (status in ('idle','assigned','on_trip','returning','off','maintenance'))
);

create table drivers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  carrier_id  uuid references carriers(id),
  line_user_id text,                -- 之後接 LINE LIFF
  vehicle_id  uuid references vehicles(id)
);

create table rate_cards (           -- 費率（之後做帳單自動化）
  id          uuid primary key default gen_random_uuid(),
  from_site   text references sites(id),
  location_id uuid references locations(id),
  type_code   text references vehicle_types(code),
  revenue     numeric, cost numeric
);

-- ---------- OMS 訂單 ----------
create table orders (
  id          uuid primary key default gen_random_uuid(),
  order_no    text unique not null,          -- TW + 流水號
  customer_id uuid references customers(id),
  site_id     text references sites(id),     -- 出貨庫房
  location_id uuid references locations(id), -- 送達點
  type_code   text references vehicle_types(code), -- 需求車種
  req_depart_at  timestamptz,                -- 要求出車 (T0)
  req_arrive_at  timestamptz,                -- 指定送達 (ETA)
  status      text not null default 'created' check (status in
              ('created','released','picking','picked','loaded','in_transit','delivered','exception','cancelled')),
  priority    int default 0,
  remark      text,
  created_by  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table order_lines (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id) on delete cascade,
  sku         text references products(sku),
  qty         integer not null,
  picked_qty  integer default 0
);

create table order_changes (         -- 客戶變更（取代寫在紙本車單上的備註）
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id) on delete cascade,
  field       text, old_value text, new_value text,
  reason      text, changed_by text,
  changed_at  timestamptz default now()
);

-- ---------- WMS 撿貨 / 扣帳 / 交車 ----------
create table pick_tasks (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id) on delete cascade,
  site_id     text references sites(id),
  picker      text,
  status      text default 'open' check (status in ('open','picking','done','short')),
  started_at  timestamptz, done_at timestamptz
);

create table inventory_tx (          -- 扣帳紀錄（庫存異動）
  id          uuid primary key default gen_random_uuid(),
  site_id     text, sku text, bin text,
  qty         integer not null,      -- 負數=出庫扣帳
  ref_order   uuid references orders(id),
  tx_type     text check (tx_type in ('reserve','issue','adjust','return')),
  created_at  timestamptz default now()
);

-- ---------- TMS 派車 / 車趟 ----------
create table trips (                  -- 一趟車（可合併多張訂單、多個送達點）
  id          uuid primary key default gen_random_uuid(),
  trip_no     text unique not null,   -- 車單號（可印條碼）
  site_id     text references sites(id),
  vehicle_id  uuid references vehicles(id),
  driver_id   uuid references drivers(id),
  planned_depart_at timestamptz,
  status      text default 'planned' check (status in
              ('planned','dispatched','handover','departed','arrived','completed','exception','cancelled')),
  created_at  timestamptz default now()
);

create table trip_orders (
  trip_id     uuid references trips(id) on delete cascade,
  order_id    uuid references orders(id) on delete cascade,
  stop_seq    int default 1,           -- 送達順序（續點）
  primary key (trip_id, order_id)
);

-- ---------- 司機貨態（點擊即回報） ----------
create table tracking_events (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references trips(id) on delete cascade,
  order_id    uuid references orders(id),
  event       text not null check (event in
              ('handover','depart','arrive_gate','arrive_dock','delivered','exception','backfill')),
  lat numeric, lng numeric,
  is_backfill boolean default false,   -- 晶圓廠出廠後補登
  photo_url   text,
  note        text,
  event_at    timestamptz default now(),
  recorded_at timestamptz default now()
);

-- ---------- 異常 / 缺車 ----------
create table exceptions (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id),
  trip_id     uuid references trips(id),
  kind        text check (kind in ('late','damage','shortage_qty','reject','address','queue_at_fab','vehicle_breakdown','other')),
  severity    text default 'mid' check (severity in ('low','mid','high')),
  description text, photo_url text,
  reported_by text,
  status      text default 'open' check (status in ('open','handling','closed')),
  resolution  text,
  created_at  timestamptz default now(), closed_at timestamptz
);

create table vehicle_shortage_reports (   -- 缺車通報（把「感覺」變成數據）
  id          uuid primary key default gen_random_uuid(),
  site_id     text references sites(id),
  type_code   text references vehicle_types(code),
  needed_at   timestamptz,
  order_ids   uuid[],
  reason_tag  text check (reason_tag in ('true_capacity','stuck_in_fab','burst_orders','no_consolidation','driver_absent','other')),
  reported_by text,
  status      text default 'open' check (status in ('open','covered_cross_site','covered_extra','unresolved')),
  covered_by_vehicle uuid references vehicles(id),
  created_at  timestamptz default now(), resolved_at timestamptz
);

create table vehicle_moves (          -- 車輛資源調整（跨倉支援）
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid references vehicles(id),
  from_site   text references sites(id), to_site text references sites(id),
  start_at    timestamptz, end_at timestamptz,
  reason      text, approved_by text,
  created_at  timestamptz default now()
);

-- ---------- 專案管理平台（運輸團隊專案規劃與管控） ----------
create table projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner       text, dept text,
  goal        text, expected_deliverable text,
  start_date  date, due_date date,
  status      text default 'active' check (status in ('draft','active','at_risk','done','bau')),
  created_at  timestamptz default now()
);

create table tasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references projects(id) on delete cascade,
  title       text not null,
  assignee    text, reviewer text,         -- 組員→組長→部門主管→GM
  due_date    date,
  status      text default 'todo' check (status in ('todo','doing','review','done','overdue')),
  deliverable text,
  source      text,                        -- 例：'會議 2026-11-03'
  created_at  timestamptz default now(), done_at timestamptz
);

create table approvals (               -- 等你核准（人類把關）
  id          uuid primary key default gen_random_uuid(),
  kind        text,                       -- 'vehicle_move','exception_close','task_review','agent_action'
  ref_id      uuid,
  title       text, requested_by text,
  status      text default 'pending' check (status in ('pending','approved','rejected')),
  decided_by  text, decided_at timestamptz,
  created_at  timestamptz default now()
);

-- ---------- 檢視：控制塔用 ----------
create view v_order_checkpoints as
select o.id, o.order_no, o.site_id, o.status, o.req_depart_at, o.req_arrive_at,
  case
    when o.status in ('delivered','cancelled') then 'g'
    when o.status in ('created','released','picking') and now() > o.req_depart_at - interval '5 min' then 'r'   -- T−5 未備妥
    when o.status in ('created','released','picking') and now() > o.req_depart_at - interval '15 min' then 'y'  -- T−15 未備妥
    when o.status in ('picked','loaded') and now() > o.req_depart_at then 'r'                                      -- T0 未交車
    when o.status = 'in_transit' and now() > o.req_arrive_at + interval '30 min' then 'r'                          -- ETA+30 未送達
    when o.status = 'in_transit' and now() > o.req_arrive_at then 'y'
    when o.status = 'exception' then 'r'
    else 'g' end as flag
from orders o;

create view v_site_summary as
select s.id site_id, s.name,
  count(*) filter (where c.status not in ('delivered','cancelled')) pending,
  count(*) filter (where c.flag='r' and c.status not in ('delivered','cancelled')) red,
  count(*) filter (where c.flag='y' and c.status not in ('delivered','cancelled')) yellow
from sites s left join v_order_checkpoints c on c.site_id = s.id
group by s.id, s.name;

-- ---------- 自動更新 updated_at ----------
create or replace function touch_updated() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;
create trigger trg_orders_touch before update on orders for each row execute function touch_updated();

-- ---------- Realtime（控制塔即時動畫） ----------
alter publication supabase_realtime add table orders, trips, tracking_events, exceptions, vehicle_shortage_reports, approvals;

-- ---------- RLS：Demo 模式（任何人可讀寫假資料） ----------
-- ⚠ 正式上線前必須改成依登入者角色（客戶/倉庫/調度/司機/管理者）限制
do $$ declare t text; begin
  foreach t in array array['sites','customers','locations','products','inventory','carriers','vehicle_types','vehicles','drivers',
    'rate_cards','orders','order_lines','order_changes','pick_tasks','inventory_tx','trips','trip_orders','tracking_events',
    'exceptions','vehicle_shortage_reports','vehicle_moves','projects','tasks','approvals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy demo_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;
-- FlowTower Demo 假資料（全部虛構）
-- 可重複執行：先清空再灌
truncate approvals, tasks, projects, vehicle_moves, vehicle_shortage_reports, exceptions, tracking_events,
  trip_orders, trips, inventory_tx, pick_tasks, order_changes, order_lines, orders, rate_cards,
  drivers, vehicles, vehicle_types, carriers, inventory, products, locations, customers, sites cascade;

insert into sites(id,name,region,lat,lng,color) values
 ('FTZ','FTZ 自貿區倉','北區',25.08,121.23,'#4aa3ff'),('TY2','TY2 桃園二倉','北區',24.99,121.30,'#ff8a3d'),
 ('HC','HC 新竹倉','竹區',24.80,120.99,'#f2c230'),('XS','XS 倉','竹區',24.78,121.01,'#a77bff'),
 ('LK','LK 倉','北區',25.06,121.37,'#3fc77a'),('TC','TC 台中倉','中區',24.20,120.62,'#ff5d8f'),
 ('TN','TN 台南倉','南區',23.10,120.29,'#22c3c3'),('QT','QT 倉','北區',25.02,121.20,'#8fc43a'),
 ('QZ','QZ 倉','南區',22.70,120.33,'#ff6f5d');

insert into customers(code,name,is_fab) values
 ('C01','星辰半導體',true),('C02','曜光晶圓',true),('C03','禾豐封測',true),
 ('C04','聯程設備',false),('C05','藍海材料',false),('C06','晨曦光電',false);

insert into locations(customer_id,name,address,gate_name,dock_name,lat,lng,std_travel_min)
select c.id, v.name, v.addr, v.gate, v.dock, v.lat, v.lng, v.std::jsonb from (values
 ('C01','星辰 竹科一廠','新竹科學園區','北哨','D3',24.78,121.00,'{"HC":15,"XS":12,"FTZ":70,"TY2":55}'),
 ('C01','星辰 南科十八廠','台南科學園區','東哨','B1',23.11,120.27,'{"TN":15,"QZ":45,"TC":110}'),
 ('C02','曜光 中科廠','台中科學園區','2號哨','A5',24.21,120.61,'{"TC":20,"HC":75}'),
 ('C02','曜光 竹南廠','苗栗竹南','南哨','C2',24.69,120.88,'{"HC":30,"XS":28,"TC":60}'),
 ('C03','禾豐 龍潭廠','桃園龍潭','正門','D1',24.86,121.21,'{"TY2":25,"QT":30,"HC":40}'),
 ('C03','禾豐 高雄廠','高雄楠梓','西哨','B4',22.73,120.32,'{"QZ":15,"TN":45}'),
 ('C04','聯程 林口廠','新北林口','大門','1',25.07,121.36,'{"LK":10,"FTZ":30,"TY2":35}'),
 ('C05','藍海 觀音廠','桃園觀音','大門','2',25.03,121.08,'{"QT":20,"TY2":30,"FTZ":35}'),
 ('C06','晨曦 台中港','台中港','港區','5',24.27,120.51,'{"TC":35}'),
 ('C05','藍海 台北港','新北八里','港區','7',25.15,121.38,'{"FTZ":40,"LK":30}')
) v(cc,name,addr,gate,dock,lat,lng,std) join customers c on c.code=v.cc;

insert into products(sku,name,unit,weight_kg)
select 'SKU-'||lpad(g::text,3,'0'), (array['晶圓盒','光罩盒','化學品桶','設備零件','測試治具','包材','氣體鋼瓶','電子模組'])[1+(g%8)]||' '||g, 'CTN', 5+(g%7)*8
from generate_series(1,24) g;

insert into inventory(site_id,sku,bin,qty_on_hand)
select s.id, p.sku, 'A-'||lpad((row_number() over (partition by s.id))::text,2,'0'), 50+floor(random()*400)::int
from sites s cross join products p where random()<0.6;

insert into carriers(name,contact) values ('順達通運','02-0000-0001'),('鴻運物流','03-0000-0002'),('大成貨運','04-0000-0003'),('快捷車行','06-0000-0004');
insert into vehicle_types values ('3.5T',3500,1),('7T',7000,2),('17T',17000,3),('TRAILER',30000,4);

-- 每個庫房 4 台固定車
insert into vehicles(plate,type_code,carrier_id,home_site,shift_start,shift_end,status)
select chr(65+(n%26))||chr(65+((n*7)%26))||'-'||lpad((1000+n*37)::text,4,'0'),
  (array['3.5T','7T','7T','17T'])[1+(n%4)], (select id from carriers order by name offset (n%4) limit 1),
  s.id, case when n%2=0 then '07:00'::time else '13:00'::time end, case when n%2=0 then '16:00'::time else '22:00'::time end, 'idle'
from (select id, row_number() over () r from sites) s, generate_series(1,4) k, lateral (select (s.r*4+k)::int n) x;

insert into drivers(name,phone,carrier_id,vehicle_id)
select (array['陳','林','黃','張','李','王','吳','劉','蔡','楊','許','鄭'])[1+(rn%12)]||(array['大明','志豪','建宏','俊傑','家豪','冠宇','宗翰','信宏','承恩'])[1+(rn%9)],
  '09'||lpad((10000000+rn*7919)::text,8,'0'), v.carrier_id, v.id
from (select v.*, row_number() over () rn from vehicles v) v;

-- 訂單：每庫房 8~12 張，時間以現在為準分佈在 −2h ~ +4h
insert into orders(order_no,customer_id,site_id,location_id,type_code,req_depart_at,req_arrive_at,status,created_by,created_at)
select 'TW'||to_char(now(),'YYMMDD')||lpad(row_number() over ()::text,4,'0'),
  l.customer_id, s.id, l.id, (array['3.5T','7T','7T','17T'])[1+floor(random()*4)::int],
  dep, dep + make_interval(mins => coalesce((l.std_travel_min->>s.id)::int, 60)),
  case when dep < now()-interval '90 min' then (array['delivered','delivered','in_transit'])[1+floor(random()*3)::int]
       when dep < now()-interval '20 min' then (array['in_transit','in_transit','loaded','delivered'])[1+floor(random()*4)::int]
       when dep < now()+interval '30 min' then (array['picked','picking','loaded','released'])[1+floor(random()*4)::int]
       else (array['created','released','released'])[1+floor(random()*3)::int] end,
  'OP-'||s.id, now()-interval '1 day'
from sites s
cross join lateral generate_series(1, 8+floor(random()*5)::int+length(s.id)*0) k
cross join lateral (select date_trunc('minute', now() + make_interval(mins => -120 + floor(random()*360)::int + k*0)) dep) d
cross join lateral (select * from locations where (std_travel_min ? s.id or random()<0.15) and k>0 order by random() limit 1) l;

insert into order_lines(order_id,sku,qty,picked_qty)
select order_id, sku, q, case when st in ('picked','loaded','in_transit','delivered') then q else 0 end
from (select o.id order_id, o.status st, p.sku, (1+floor(random()*20))::int q
      from orders o cross join lateral (select sku from products where o.id is not null order by random() limit 1+floor(random()*3)::int) p) x;

insert into pick_tasks(order_id,site_id,picker,status,started_at,done_at)
select id, site_id, '撿貨員'||(1+floor(random()*3)::int),
  case when status in ('created','released') then 'open' when status='picking' then 'picking' else 'done' end,
  case when status not in ('created','released') then req_depart_at-interval '50 min' end,
  case when status not in ('created','released','picking') then req_depart_at-interval '20 min' end
from orders;

-- 已出車的訂單：一張單一趟車
insert into trips(trip_no,site_id,vehicle_id,driver_id,planned_depart_at,status)
select 'T'||substr(o.order_no,3), o.site_id, v.id, d.id, o.req_depart_at,
  case o.status when 'delivered' then 'completed' when 'in_transit' then 'departed' else 'handover' end
from orders o
cross join lateral (select * from vehicles where home_site=o.site_id order by random() limit 1) v
join drivers d on d.vehicle_id=v.id
where o.status in ('loaded','in_transit','delivered');
insert into trip_orders(trip_id,order_id) select t.id, o.id from trips t join orders o on t.trip_no='T'||substr(o.order_no,3);

insert into tracking_events(trip_id,order_id,event,event_at,is_backfill)
select t.id, o.id, e.ev, o.req_depart_at + make_interval(mins => e.off), e.ev in ('arrive_dock','delivered') and c.is_fab
from trips t join trip_orders tor on tor.trip_id=t.id join orders o on o.id=tor.order_id join customers c on c.id=o.customer_id
cross join lateral (values ('handover',-8,1),('depart',0,2),('arrive_gate',35,3),('arrive_dock',50,4),('delivered',70,5)) e(ev,off,lvl)
where (o.status='loaded' and e.lvl<=1) or (o.status='in_transit' and e.lvl<=2+floor(random()*2)::int) or o.status='delivered';

update vehicles set status='on_trip' where id in (select vehicle_id from trips where status='departed');

insert into exceptions(order_id,kind,severity,description,reported_by,status)
select id,(array['queue_at_fab','late','damage','reject'])[1+floor(random()*4)::int],'mid','廠內排隊超過 40 分鐘','司機回報','open'
from orders where status='in_transit' order by random() limit 3;

insert into vehicle_shortage_reports(site_id,type_code,needed_at,reason_tag,reported_by,status,created_at)
select (array['HC','TY2','TC','FTZ','HC','TN'])[1+(g%6)], (array['7T','17T','7T','3.5T'])[1+(g%4)], now()-make_interval(hours=>g*5),
  (array['stuck_in_fab','burst_orders','no_consolidation','true_capacity','stuck_in_fab','driver_absent'])[1+(g%6)], '庫房出貨員',
  (array['covered_cross_site','covered_extra','unresolved','covered_cross_site'])[1+(g%4)], now()-make_interval(hours=>g*5)
from generate_series(1,18) g;

insert into projects(name,owner,dept,goal,expected_deliverable,start_date,due_date,status) values
 ('缺車根因改善','運輸數據組','運輸部','缺車通報下降 30%','缺車統計看板＋併單規則',current_date-20,current_date+40,'active'),
 ('司機點擊回報上線','運輸數據組','運輸部','9 庫房司機回報率 80%','LINE 回報介面＋教育訓練',current_date-10,current_date+30,'at_risk'),
 ('帳單自動化','運輸數據組','運輸部','帳單人工時數減半','費率資料庫＋帳單比對工具',current_date-30,current_date+60,'active');
insert into tasks(project_id,title,assignee,reviewer,due_date,status,deliverable,source)
select p.id, t.title, t.who, '組長', current_date+t.d, t.st, t.dl, '週會'
from projects p join (values
 ('缺車根因改善','整理近 3 個月缺車通報','組員A',-3,'done','原因分類統計表'),
 ('缺車根因改善','訪談 HC、TY2 出貨員','組員B',2,'doing','訪談紀錄'),
 ('缺車根因改善','設計同廠同時段併單規則','組員A',10,'todo','規則文件'),
 ('司機點擊回報上線','LIFF 介面測試','組員C',-1,'overdue','測試報告'),
 ('司機點擊回報上線','供應商說明會','組員B',5,'todo','簡報＋簽到'),
 ('司機點擊回報上線','晶圓廠補登流程','組員C',8,'doing','SOP'),
 ('帳單自動化','費率卡數位化','組員A',-10,'done','費率資料庫'),
 ('帳單自動化','車單變更欄位定義','組員B',4,'review','欄位規格'),
 ('帳單自動化','對帳差異報表','組員C',15,'todo','差異報表')
) t(pn,title,who,d,st,dl) on t.pn=p.name;
insert into approvals(kind,title,requested_by) values
 ('vehicle_move','HC 支援 TY2 一台 17T（14:00–18:00）','調度'),
 ('task_review','車單變更欄位定義 → 送審','組員B'),
 ('exception_close','結案：星辰竹科廠排隊延誤','調度');
