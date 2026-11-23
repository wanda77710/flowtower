-- =====================================================================
-- FlowTower 資料庫權限強化（公開 Demo 用）
-- 執行順序：schema.sql / setup_all.sql → reset_demo.sql → advance_demo.sql → 本檔
-- 可重複執行。
--
-- 規則：
--   1. 所有人可讀（Demo 要給人看）
--   2. 主檔（庫房、客戶、地點、品項、車行、車型、司機、費率）唯讀
--   3. 作業資料只能新增／修改，任何人都不能刪除、不能清空資料表
--   4. 文字欄位最長 500 字、每張表最多 20,000 筆（防灌爆、防亂塞）
--   5. 只有「重置 Demo」對外開放，且全站每 60 秒最多一次；
--      advance_demo() 只給 pg_cron 用，外部不能呼叫
--   6. 每天 06:00 自動重置，被亂改的資料隔天會自動恢復
-- =====================================================================

-- ---------- 1. 清掉舊的「任何人可讀寫刪」規則 ----------
do $$ declare t text; begin
  foreach t in array array['sites','customers','locations','products','inventory','carriers','vehicle_types','vehicles','drivers',
    'rate_cards','orders','order_lines','order_changes','pick_tasks','inventory_tx','trips','trip_orders','tracking_events',
    'exceptions','vehicle_shortage_reports','vehicle_moves','projects','tasks','approvals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists demo_all on %I', t);
    execute format('drop policy if exists demo_read on %I', t);
    execute format('drop policy if exists demo_insert on %I', t);
    execute format('drop policy if exists demo_update on %I', t);
    execute format('create policy demo_read on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- ---------- 2. 可新增的作業資料 ----------
do $$ declare t text; begin
  foreach t in array array['orders','order_lines','order_changes','pick_tasks','inventory_tx','trips','trip_orders',
    'tracking_events','exceptions','vehicle_shortage_reports','vehicle_moves','projects','tasks','approvals'] loop
    execute format('create policy demo_insert on %I for insert to anon, authenticated with check (true)', t);
  end loop;
end $$;

-- ---------- 3. 可修改的資料（車輛、庫存只能改狀態/數量，不能新增） ----------
do $$ declare t text; begin
  foreach t in array array['orders','order_lines','pick_tasks','trips','exceptions','vehicle_shortage_reports',
    'vehicle_moves','projects','tasks','approvals','vehicles','inventory'] loop
    execute format('create policy demo_update on %I for update to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- 4. 雙重保險：直接收回刪除、清空權限 ----------
revoke delete, truncate, references, trigger on all tables in schema public from anon, authenticated;

-- ---------- 5. 防亂塞：文字長度、資料筆數上限 ----------
create or replace function ft_guard_write() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare kv record; n bigint;
begin
  for kv in select key, value from jsonb_each(to_jsonb(new)) loop
    if jsonb_typeof(kv.value) = 'string' and char_length(kv.value #>> '{}') > 500 then
      raise exception '欄位 % 太長（最多 500 字）', kv.key;
    end if;
  end loop;
  if tg_op = 'INSERT' then
    execute format('select count(*) from %I', tg_table_name) into n;
    if n >= 20000 then raise exception '% 資料已達 Demo 上限，請等每日自動重置', tg_table_name; end if;
  end if;
  return new;
end $fn$;

do $$ declare t text; begin
  foreach t in array array['orders','order_lines','order_changes','pick_tasks','inventory_tx','trips','trip_orders',
    'tracking_events','exceptions','vehicle_shortage_reports','vehicle_moves','projects','tasks','approvals','vehicles','inventory'] loop
    execute format('drop trigger if exists trg_ft_guard on %I', t);
    execute format('create trigger trg_ft_guard before insert or update on %I for each row execute function ft_guard_write()', t);
  end loop;
end $$;

-- ---------- 6. 函式權限 ----------
-- 內部函式：外部（瀏覽器）不能直接呼叫，只給 pg_cron
revoke execute on function reset_demo()   from public, anon, authenticated;
revoke execute on function advance_demo() from public, anon, authenticated;

-- 對外的「重置 Demo」按鈕：全站每 60 秒最多執行一次
create table if not exists demo_meta (k text primary key, v timestamptz);
alter table demo_meta enable row level security;   -- 沒有任何 policy = 外部完全看不到

create or replace function reset_demo_public() returns text
language plpgsql security definer set search_path = public as $fn$
declare last timestamptz;
begin
  select v into last from demo_meta where k = 'last_public_reset' for update;
  if last is not null and last > now() - interval '60 seconds' then
    return 'skipped: 剛剛已重置過，請 1 分鐘後再試';
  end if;
  insert into demo_meta(k, v) values ('last_public_reset', now())
    on conflict (k) do update set v = excluded.v;
  return reset_demo();
end $fn$;
revoke execute on function reset_demo_public() from public;
grant execute on function reset_demo_public() to anon, authenticated;

-- 檢查結果：應該只看到 demo_read / demo_insert / demo_update
select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by tablename, policyname;
