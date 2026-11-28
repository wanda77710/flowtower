// 派車規則維護：運輸商分配比例、推薦評分權重、即時管控門檻（改完按儲存即生效）
import { api, esc, fmtT } from './api.js';

const me = () => { try { return localStorage.getItem('ft_handler') || ''; } catch { return ''; } };

export async function render(ui) {
  ui.head('派車規則維護', '運輸商分配比例・推薦評分權重・即時管控門檻｜存檔後派車推薦與即時管控立即套用');
  const v = ui.view('<div class="loading">載入中…</div>');
  let carriers, alloc, weights, sets, month = {};
  try {
    [carriers, alloc, weights, sets] = await Promise.all([
      api.get('carriers', 'select=id,name&order=name'), api.get('carrier_allocation', 'select=*'),
      api.get('dispatch_weights', 'select=*&order=sort'), api.get('control_settings', 'select=*&order=sort')]);
  } catch (e) {
    v.innerHTML = `<div class="card empty">維護表還沒建立：請在 Supabase SQL Editor 執行 <b>supabase/control.sql</b>，再執行一次 <b>security.sql</b>。</div>`; return null;
  }
  // 這個月實際派車趟數（管理報表歷史 + 今天線上），用來對照目標比例
  try {
    month = await api.rpc('carrier_month_trips');
  } catch { /* 對照數字拿不到不影響維護 */ }
  const mt = Object.values(month).reduce((a, b) => a + b, 0);
  const A = Object.fromEntries(alloc.map(a => [a.carrier_name, a]));

  v.innerHTML = `
    <div class="card rsec"><div class="rh"><b>① 運輸商分配比例</b><span class="mut">每月目標派車比例（合計須 100%）與保障趟數；推薦時「分配公平」依此加減分</span></div>
      <div class="tw"><table class="t" id="ta"><thead><tr><th>運輸商</th><th class="r">目標比例 %</th><th class="r">每月保障趟數</th><th class="r">本月實際</th><th class="r">差距</th><th>備註</th><th>最後修改</th></tr></thead><tbody>
      ${carriers.map(c => { const a = A[c.name] || {}, act = mt ? (month[c.id] || 0) / mt * 100 : null;
        return `<tr data-id="${esc(c.name)}"><td><b>${esc(c.name)}</b></td>
          <td class="r"><input type="number" min="0" max="100" step="1" class="num" data-f="target_share" value="${a.target_share ?? 25}"></td>
          <td class="r"><input type="number" min="0" step="10" class="num" data-f="monthly_min_trips" value="${a.monthly_min_trips ?? 0}"></td>
          <td class="r">${act == null ? '—' : `${act.toFixed(1)}%<div class="mut" style="font-size:11px">${month[c.id] || 0} 趟</div>`}</td>
          <td class="r gap" data-act="${act ?? ''}"></td>
          <td><input data-f="note" value="${esc(a.note || '')}" maxlength="200" style="width:100%"></td>
          <td class="mut" style="font-size:12px">${a.updated_at ? `${esc(a.updated_by || '')} ${fmtT(a.updated_at)}` : ''}</td></tr>`; }).join('')}
      </tbody><tfoot><tr><td><b>合計</b></td><td class="r"><b id="asum"></b></td><td colspan="5"></td></tr></tfoot></table></div>
      <div class="row" style="margin-top:10px"><button class="btn pri" id="sa">儲存分配比例</button><span class="mut" style="font-size:12px" id="am"></span></div></div>

    <div class="card rsec"><div class="rh"><b>② 推薦評分權重</b><span class="mut">派車推薦依這些權重打分（合計須 100）</span></div>
      <div class="tw"><table class="t" id="tw"><thead><tr><th>項目</th><th class="r">權重</th><th>怎麼算</th><th>最後修改</th></tr></thead><tbody>
      ${weights.map(w => `<tr data-id="${w.factor}"><td><b>${esc(w.label)}</b></td><td class="r"><input type="number" min="0" max="100" step="1" class="num" data-f="weight" value="${+w.weight}"></td>
        <td class="mut" style="font-size:12px">${esc(w.note || '')}</td><td class="mut" style="font-size:12px">${w.updated_by ? `${esc(w.updated_by)} ${fmtT(w.updated_at)}` : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td><b>合計</b></td><td class="r"><b id="wsum"></b></td><td colspan="2"></td></tr></tfoot></table></div>
      <div class="row" style="margin-top:10px"><button class="btn pri" id="sw">儲存權重</button><span class="mut" style="font-size:12px" id="wm"></span></div></div>

    <div class="card rsec"><div class="rh"><b>③ 即時管控與併車門檻</b><span class="mut">即時管控中心的燈號、升級時間，以及併車推薦的條件</span></div>
      <div class="tw"><table class="t" id="ts"><thead><tr><th>設定</th><th class="r">數值</th><th>單位</th><th>說明</th></tr></thead><tbody>
      ${sets.map(x => `<tr data-id="${x.key}"><td>${esc(x.label)}</td><td class="r"><input type="number" min="0" step="1" class="num" data-f="value" value="${+x.value}"></td><td>${esc(x.unit || '')}</td><td class="mut" style="font-size:12px">${esc(x.note || '')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn pri" id="ss">儲存門檻</button><span class="mut" style="font-size:12px">派車黃燈要大於紅燈；出車紅燈要大於黃燈</span></div></div>`;

  const sum = (t, f) => [...v.querySelectorAll(`#${t} input[data-f="${f}"]`)].reduce((a, i) => a + (+i.value || 0), 0);
  const refresh = () => {
    const as = sum('ta', 'target_share'), ws = sum('tw', 'weight');
    v.querySelector('#asum').innerHTML = `<span style="color:${Math.abs(as - 100) < 0.01 ? 'var(--g)' : 'var(--r)'}">${as}%</span>`;
    v.querySelector('#wsum').innerHTML = `<span style="color:${Math.abs(ws - 100) < 0.01 ? 'var(--g)' : 'var(--r)'}">${ws}</span>`;
    v.querySelectorAll('#ta tr[data-id]').forEach(tr => { const g = tr.querySelector('.gap'), act = g.dataset.act;
      if (act === '') { g.textContent = '—'; return; }
      const d = +act - (+tr.querySelector('[data-f="target_share"]').value || 0);
      g.innerHTML = `<span class="badge ${Math.abs(d) < 3 ? 'g' : 'y'}">${d > 0 ? '超過' : '不足'} ${Math.abs(d).toFixed(1)}</span>`; });
  };
  v.oninput = refresh; refresh();

  const who = () => me() || '管理者';
  async function save(table, key, tableId, fields, check) {
    const err = check(); if (err) return ui.toast(err, true);
    const rows = [...v.querySelectorAll(`#${tableId} tr[data-id]`)];
    await ui.guard(async () => {
      for (const tr of rows) {
        const patch = { updated_by: who() };
        fields.forEach(f => { const i = tr.querySelector(`[data-f="${f}"]`); patch[f] = i.type === 'number' ? +i.value : i.value; });
        const r = await api.update(table, `${key}=eq.${encodeURIComponent(tr.dataset.id)}`, patch);
        if (!r?.length && table === 'carrier_allocation') throw new Error(`「${tr.dataset.id}」沒有分配比例資料，請重跑 control.sql`);
      }
    }, '已儲存，派車推薦與即時管控立即套用');
  }
  v.querySelector('#sa').onclick = () => save('carrier_allocation', 'carrier_name', 'ta', ['target_share', 'monthly_min_trips', 'note'],
    () => Math.abs(sum('ta', 'target_share') - 100) > 0.01 ? `目標比例合計要 100%（目前 ${sum('ta', 'target_share')}%）` : null);
  v.querySelector('#sw').onclick = () => save('dispatch_weights', 'factor', 'tw', ['weight'],
    () => Math.abs(sum('tw', 'weight') - 100) > 0.01 ? `權重合計要 100（目前 ${sum('tw', 'weight')}）` : null);
  v.querySelector('#ss').onclick = () => save('control_settings', 'key', 'ts', ['value'], () => {
    const g = k => +v.querySelector(`#ts tr[data-id="${k}"] input`)?.value;
    if (g('dispatch_yellow') <= g('dispatch_red')) return '派車黃燈的分鐘數要大於紅燈';
    if (g('depart_red') <= g('depart_yellow')) return '出車紅燈的分鐘數要大於黃燈';
    if (g('merge_max_stops') < 1) return '一趟至少 1 個送達點';
    return null;
  });
  return null;
}
