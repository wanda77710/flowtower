import { master, api } from './api.js';

const $ = id => document.getElementById(id);
export const ui = {
  head(title, sub = '') { $('title').textContent = title; $('sub').textContent = sub; $('actions').innerHTML = ''; },
  actions(html) { $('actions').innerHTML = html; return $('actions'); },
  view(html) { $('view').innerHTML = html; return $('view'); },
  toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('toast').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 2600); },
  drawer(title, badge, body, foot = '') {
    $('dT').textContent = title; $('dB').innerHTML = badge || ''; $('dBody').innerHTML = body; $('dFoot').innerHTML = foot;
    $('drawer').classList.add('open'); $('mask').classList.add('on'); return $('drawer');
  },
  closeDrawer() { $('drawer').classList.remove('open'); $('mask').classList.remove('on'); },
  async guard(fn, okMsg) { try { const r = await fn(); if (okMsg) ui.toast(okMsg); return r; } catch (e) { console.error(e); ui.toast('操作失敗：' + e.message.slice(0, 120), true); throw e; } },
};
$('dX').onclick = ui.closeDrawer; $('mask').onclick = ui.closeDrawer;
$('resetBtn').onclick = async () => {
  if (!confirmBox()) return;
  $('resetBtn').disabled = true; $('resetBtn').textContent = '重置中…';
  try { await api.rpc('reset_demo'); await master(true); ui.toast('已用目前時間重新產生 Demo 資料'); route(); }
  catch (e) { ui.toast('重置失敗：' + e.message.slice(0, 100), true); }
  $('resetBtn').disabled = false; $('resetBtn').textContent = '↻ 重置 Demo 資料';
};
let armed = 0;
function confirmBox() { if (Date.now() - armed < 4000) return true; armed = Date.now(); ui.toast('再按一次確認重置（所有人的操作都會清掉）'); return false; }
$('menuBtn').onclick = () => $('nav').classList.toggle('open');

const routes = {
  oms: () => import('./oms.js'),
  wms: () => import('./wms.js'),
  tms: () => import('./tms.js'),
  driver: () => import('./driver.js'),
};
const SOON = { tower: '像素控制塔', tms: 'TMS 調度', driver: '司機 App', exceptions: '異常／缺車', fleet: '車輛資源', projects: '專案管理平台' };

let timer = null;
async function route() {
  const r = (location.hash.slice(1) || 'oms').split('?')[0];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r));
  $('nav').classList.remove('open'); ui.closeDrawer();
  if (timer) { clearInterval(timer); timer = null; }
  if (!routes[r]) { ui.head(SOON[r] || '頁面', '開發中'); ui.view(`<div class="card empty">「${SOON[r] || r}」正在建置中，Demo 週內上線。</div>`); return; }
  ui.view('<div class="loading">載入中…</div>');
  try {
    await master();
    const mod = await routes[r]();
    const refresh = await mod.render(ui);
    if (refresh) timer = setInterval(() => { if (!$('drawer').classList.contains('open')) refresh(); }, 15000);
  } catch (e) { console.error(e); ui.view(`<div class="card empty">載入失敗：${e.message}</div>`); }
}
addEventListener('hashchange', route);
route();
