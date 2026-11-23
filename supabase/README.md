# 資料庫腳本
| 檔案 | 用途 |
|---|---|
| schema.sql | 資料表、檢視、RLS（預設只能讀） |
| seed.sql | 假資料 |
| reset_demo.sql | `reset_demo()`：以現在時間重產假資料；pg_cron 每天 06:00（台灣）執行 |
| advance_demo.sql | `advance_demo()`：每 1 分鐘把假資料訂單依時間推進（自動運轉）；只動 created_by 以 `OP-` 開頭的單 |
| security.sql | 權限強化：公開訪客可讀、可做 Demo 操作，但不能刪除/清空、主檔唯讀、文字與筆數上限；對外重置按鈕 `reset_demo_public()` 每 60 秒最多一次 |
| setup_all.sql | schema + seed 一次建立 |

## 執行順序（新建或更新都一樣，可重複執行）
1. `setup_all.sql`（只有第一次建立時需要）
2. `reset_demo.sql`
3. `advance_demo.sql`
4. `security.sql` ← **每次重跑 1–3 之後都要再跑一次**

庫房代碼為中性代碼：N1–N4（北區）、H1–H2（竹區）、C1（中區）、S1–S2（南區）。
