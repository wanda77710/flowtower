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
