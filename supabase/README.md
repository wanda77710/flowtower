# 資料庫腳本
| 檔案 | 用途 |
|---|---|
| schema.sql | 資料表、檢視、RLS（Demo 模式） |
| seed.sql | 假資料 |
| reset_demo.sql | `reset_demo()`：以現在時間重產假資料；pg_cron 每天 06:00（台灣）執行 |
| advance_demo.sql | `advance_demo()`：每 1 分鐘把假資料訂單依時間推進（自動運轉）；只動 created_by 以 `OP-` 開頭的單 |
| setup_all.sql | schema + seed 一次建立 |
