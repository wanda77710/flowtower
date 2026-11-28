// 總覽首頁：主視覺 + 各模組入口（插圖由 Higgsfield 生成）
const MODS = [
  ['tower', 'logo.webp', '像素控制塔', '整個平台的即時狀況一眼看完'],
  ['oms', 'oms.webp', 'OMS 訂單', '建單、釋出到倉庫、追蹤檢查點'],
  ['wms', 'wms.webp', 'WMS 倉庫', '收貨、揀貨、備貨與交車'],
  ['tms', 'tms.webp', 'TMS 調度', '排車、派車、路線與車趟'],
  ['driver', 'driver.webp', '司機 App', '司機出發、抵達、簽收回報'],
  ['exceptions', 'exceptions.webp', '異常／缺車', '延誤、缺車與異常處理'],
  ['fleet', 'fleet.webp', '車輛資源', '車隊、供應商與跨倉調車'],
  ['projects', 'projects.webp', '專案管理平台', '任務看板、核准與追蹤'],
  ['control', 'control.svg', '即時管控中心', '派車、出車、配達即時燈號與升級'],
  ['reports', 'reports.svg', '管理報表', '11 項管理指標與趨勢'],
  ['rules', 'rules.svg', '派車規則維護', '分配比例、推薦權重、管控門檻'],
];

export async function render(ui) {
  ui.head('總覽首頁', '從接單到送達，一座塔台看全部');
  ui.view(`
    <section class="hero"><video class="bgv" src="img/hero.mp4" poster="img/hero.webp" autoplay muted loop playsinline preload="metadata" aria-hidden="true"></video><div class="in">
      <h2>FlowTower 物流塔台</h2>
      <p>OMS、WMS、TMS、司機、異常與車隊，在同一個平台即時串起來。</p>
      <a class="btn" href="#tower">進入控制塔</a><a class="btn ghost" href="#oms">從訂單開始</a>
    </div></section>
    <div class="mods">${MODS.map(([r, img, t, d]) => `
      <a class="mod" href="#${r}"><img src="img/${img}" alt="${t}" loading="lazy" width="320" height="320"><div><b>${t}</b><span>${d}</span></div></a>`).join('')}
    </div>`);
  return null;
}
