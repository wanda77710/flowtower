// 像素控制塔：嵌入 tower.html（同網域，直接讀同一個資料庫）
export async function render(ui) {
  ui.head('像素控制塔', '整個平台的即時狀況：庫房燈號、交車、出車、異常，每 8 秒同步');
  ui.actions('<a class="btn" href="tower.html" target="_blank">⛶ 全螢幕開啟</a>');
  ui.view('<iframe src="tower.html" title="像素控制塔" style="display:block;width:calc(100% + 48px);margin:-20px -24px -60px;height:calc(100vh - 73px);border:0;background:#0d1020"></iframe>');
  return null;
}
