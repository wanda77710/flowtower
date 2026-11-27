# 資料庫腳本
| 檔案 | 用途 |
|---|---|
| schema.sql | 資料表、檢視、RLS（預設只能讀） |
| seed.sql | 假資料 |
| reset_demo.sql | `reset_demo()`：以現在時間重產假資料；pg_cron 每天 06:00（台灣）執行 |
| advance_demo.sql | `advance_demo()`：每 1 分鐘把假資料訂單依時間推進（自動運轉）；只動 created_by 以 `OP-` 開頭的單 |
| reports.sql | 管理報表 v2：11 項管理指標 × 5 個角度（運輸商／司機／管理同仁／客戶／站點）× 趨勢。180 天歷史（rpt_ 資料表，唯讀）、教育訓練、跟車稽核、管理同仁↔運輸商對應、目標值表 `rpt_kpi_defs`；函式 `rpt_overview / rpt_kpi / rpt_kpi_detail / rpt_fleet / rpt_staff`；pg_cron 每天 06:05 重產 |
| security.sql | 權限強化：公開訪客可讀、可做 Demo 操作，但不能刪除/清空、主檔唯讀、文字與筆數上限；對外重置按鈕 `reset_demo_public()` 每 60 秒最多一次 |
| setup_all.sql | schema + seed 一次建立 |

## 執行順序（新建或更新都一樣，可重複執行）
1. `setup_all.sql`（只有第一次建立時需要）
2. `reset_demo.sql`
3. `advance_demo.sql`
4. `reports.sql`
5. `security.sql` ← **每次重跑 1–4 之後都要再跑一次**

庫房代碼為中性代碼：N1–N4（北區）、H1–H2（竹區）、C1（中區）、S1–S2（南區）。
