import { api, master, flagOf, STATUS, fmtT, fmtHM, esc, inList } from './api.js';

let SITE = (() => { try { return localStorage.getItem('ft_site') || 'HC'; } catch { return 'HC'; } })();
let TAB = 'pick', SEL = null;

export async function render(ui) {
  const M = await master();
  ui.head('WMS 倉庫', '撿貨 → 扣帳 → 交車給司機');
  const a = ui.actions(`<select id="site">${M.sites.map(s => `<option value="${s.id}" ${s.id === SITE ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`);
  a.querySelector('#site').onchange = e => { SITE = e.target.value; SEL = null; try { localStorage.setItem('ft_site', SITE); } catch { } load(); };
  const v = ui.view(`<div class="kpis" id="kp"></div>
    <div class="tabs"><button data-t="pick">撿貨作業</button><button data-t="hand">待交車</button><button data-t="inv">庫存</button></div><div id="pane"></div>`);
  v.querySelector('.tabs').onclick = e => { const t = e.target.dataset.t; if (t) { TAB = t; load(); } };
  const P = Object.fromEntries(M.products.map(p => [p.sku, p]));

  async function load() {
    v.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === TAB));
    const [tasks, ready, inv] = await Promise.all([
      api.get('pick_tasks', `select=*,orders!inner(*,order_lines(*))&site_id=eq.${SITE}&status=in.(open,picking)&orders.status=in.(released,picking)`),
      api.get('orders', `select=*&site_id=eq.${SITE}&status=in.(picked,loaded)&order=req_depart_at`),
      api.get('inventory', `select=*&site_id=eq.${SITE}&order=sku`),
    ]);
    tasks.sort((x, y) => new Date(x.orders.req_depart_at) - new Date(y.orders.req_depart_at));
    const red = tasks.filter(t => flagOf(t.orders)[0] === 'r').length;
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>待撿貨</span><b>${tasks.filter(t => t.status === 'open').length}</b></div>
      <div class="kpi"><span>撿貨中</span><b>${tasks.filter(t => t.status === 'picking').length}</b></div>
      <div class="kpi"><span>🔴 快趕不上出車</span><b style="color:var(--r)">${red}</b></div>
      <div class="kpi"><span>待交車</span><b>${ready.filter(o => o.status === 'picked').length}</b></div>
      <div class="kpi"><span>庫存品項</span><b>${inv.length}</b></div>`;
    const pane = v.querySelector('#pane');
    if (TAB === 'pick') pickPane(pane, tasks, inv);
    else if (TAB === 'hand') await handPane(pane, ready);
    else await invPane(pane, inv);
  }

  // ---------- 撿貨 ----------
  function pickPane(pane, tasks, inv) {
    if (!tasks.length) { pane.innerHTML = '<div class="card empty">這個庫房目前沒有待撿貨的訂單 👍<br><span style="font-size:12px">到 OMS 建一張單並釋出，就會出現在這裡</span></div>'; return; }
    if (!tasks.find(t => t.id === SEL)) SEL = tasks[0].id;
    pane.innerHTML = `<div class="split"><div class="list" id="tl"></div><div class="card" id="tk"></div></div>`;
    pane.querySelector('#tl').innerHTML = tasks.map(t => { const o = t.orders, f = flagOf(o);
      return `<div class="pickcard ${t.id === SEL ? 'sel' : ''}" data-id="${t.id}">
        <div class="row"><b class="mono">${o.order_no}</b><span class="badge ${f[0]}"><span class="dot ${f[0]}"></span>${f[1]}</span>${t.status === 'picking' ? '<span class="badge b">撿貨中</span>' : ''}</div>
        <div class="mut" style="font-size:12px">${esc(M.cust[o.customer_id]?.name)} → ${esc(M.loc[o.location_id]?.name)}</div>
        <div style="font-size:12px">出車 <b class="mono">${fmtHM(o.req_depart_at)}</b>・${o.order_lines.length} 項・${o.type_code}</div></div>`; }).join('');
    pane.querySelector('#tl').onclick = e => { const c = e.target.closest('[data-id]'); if (c) { SEL = c.dataset.id; pickPane(pane, tasks, inv); } };
    const t = tasks.find(x => x.id === SEL), o = t.orders;
    const stock = sku => inv.filter(i => i.sku === sku && i.qty_on_hand > 0).sort((a, b) => b.qty_on_hand - a.qty_on_hand);
    pane.querySelector('#tk').innerHTML = `
      <div class="row"><h3 class="mono">${o.order_no}</h3><span class="mut">${esc(M.cust[o.customer_id]?.name)}・要求出車 ${fmtT(o.req_depart_at)}</span></div>
      <div class="sec">撿貨清單</div>
      <table class="t lines"><tr><th>品項</th><th>儲位（庫存）</th><th>需求</th><th>實撿</th></tr>
      ${o.order_lines.map(l => { const s = stock(l.sku), tot = s.reduce((a, b) => a + b.qty_on_hand, 0);
        return `<tr data-l="${l.id}" data-sku="${l.sku}"><td>${esc(P[l.sku]?.name || l.sku)}<br><span class="mut mono">${l.sku}</span></td>
        <td>${s.length ? s.slice(0, 2).map(b => `<span class="mono">${b.bin}</span> <span class="mut">(${b.qty_on_hand})</span>`).join('<br>') : '<span class="badge r">無庫存</span>'}${tot < l.qty && s.length ? '<br><span class="badge y">庫存不足</span>' : ''}</td>
        <td>${l.qty}</td><td><input type="number" min="0" value="${Math.min(l.qty, tot)}" ${t.status !== 'picking' ? 'disabled' : ''}></td></tr>`; }).join('')}</table>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        ${t.status === 'open' ? '<button class="btn pri" id="st">開始撿貨</button>' : '<button class="btn pri" id="dn">撿貨完成並扣帳</button>'}
      </div>`;
    pane.querySelector('#st')?.addEventListener('click', async () => {
      await ui.guard(async () => {
        await api.update('pick_tasks', `id=eq.${t.id}`, { status: 'picking', started_at: new Date().toISOString(), picker: '撿貨員1' });
        await api.update('orders', `id=eq.${o.id}`, { status: 'picking' });
      }, '開始撿貨'); load();
    });
    pane.querySelector('#dn')?.addEventListener('click', async e => {
      e.target.disabled = true;
      const picks = [...pane.querySelectorAll('tr[data-l]')].map(tr => ({ id: tr.dataset.l, sku: tr.dataset.sku, qty: +tr.querySelector('input').value || 0, need: o.order_lines.find(l => l.id === tr.dataset.l).qty }));
      let short = false;
      await ui.guard(async () => {
        for (const p of picks) {
          if (p.qty < p.need) short = true;
          let left = p.qty;
          for (const b of stock(p.sku)) {           // 依儲位扣帳
            if (left <= 0) break;
            const take = Math.min(left, b.qty_on_hand); left -= take;
            await api.update('inventory', `site_id=eq.${SITE}&sku=eq.${encodeURIComponent(p.sku)}&bin=eq.${encodeURIComponent(b.bin)}`, { qty_on_hand: b.qty_on_hand - take });
            await api.insert('inventory_tx', [{ site_id: SITE, sku: p.sku, bin: b.bin, qty: -take, ref_order: o.id, tx_type: 'issue' }]);
          }
          await api.update('order_lines', `id=eq.${p.id}`, { picked_qty: p.qty });
        }
        await api.update('pick_tasks', `id=eq.${t.id}`, { status: short ? 'short' : 'done', done_at: new Date().toISOString() });
        await api.update('orders', `id=eq.${o.id}`, { status: 'picked' });
      });
      ui.toast(short ? `已扣帳，但有品項短撿，已標記「短撿」` : `撿貨完成・已扣帳，等待交車`, short);
      SEL = null; load();
    });
  }

  // ---------- 交車 ----------
  async function handPane(pane, ready) {
    if (!ready.length) { pane.innerHTML = '<div class="card empty">沒有待交車的訂單</div>'; return; }
    const links = await api.get('trip_orders', `select=order_id,trips(id,trip_no,status,vehicles(plate,type_code),drivers(name,phone))&order_id=in.${inList(ready.map(o => o.id))}`);
    const trip = Object.fromEntries(links.map(l => [l.order_id, l.trips]));
    pane.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>燈號</th><th>訂單號</th><th>送達點</th><th>要求出車</th><th>車單／車輛／司機</th><th>狀態</th><th></th></tr></thead><tbody>
      ${ready.map(o => { const f = flagOf(o), tr = trip[o.id];
        return `<tr><td><span class="badge ${f[0]}"><span class="dot ${f[0]}"></span>${f[1]}</span></td><td class="mono">${o.order_no}</td><td>${esc(M.loc[o.location_id]?.name)}</td><td class="mono">${fmtT(o.req_depart_at)}</td>
        <td>${tr ? `<span class="mono">${tr.trip_no}</span><br><span class="mut">${tr.vehicles?.plate || ''} ${tr.vehicles?.type_code || ''}・${esc(tr.drivers?.name || '')}</span>` : '<span class="badge y">等待 TMS 派車</span>'}</td>
        <td>${o.status === 'loaded' ? '<span class="badge t">已交車</span>' : '<span class="badge">已撿貨</span>'}</td>
        <td>${o.status === 'picked' ? `<button class="btn sm pri" data-h="${o.id}" ${tr ? '' : 'disabled title="需先在 TMS 派車"'}>掃碼交車</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="mut" style="margin-top:10px;font-size:12px">交車＝倉庫把貨交給司機的時間點，會記錄在車單上，司機 App 同步看到。</p>`;
    pane.onclick = async e => { const id = e.target.dataset?.h; if (!id) return; const tr = trip[id];
      await ui.guard(async () => {
        await api.insert('tracking_events', [{ trip_id: tr.id, order_id: id, event: 'handover', note: '倉庫掃碼交車' }]);
        await api.update('orders', `id=eq.${id}`, { status: 'loaded' });
        if (tr.status === 'planned' || tr.status === 'dispatched') await api.update('trips', `id=eq.${tr.id}`, { status: 'handover' });
      }, `已交車給 ${tr.drivers?.name || '司機'}`); load(); };
  }

  // ---------- 庫存 ----------
  async function invPane(pane, inv) {
    const tx = await api.get('inventory_tx', `select=*&site_id=eq.${SITE}&order=created_at.desc&limit=15`);
    pane.innerHTML = `<div class="split" style="grid-template-columns:1fr 1fr">
      <div class="tw"><table class="t"><thead><tr><th>品項</th><th>儲位</th><th>在庫</th></tr></thead><tbody>
      ${inv.map(i => `<tr><td>${esc(P[i.sku]?.name || i.sku)} <span class="mut mono">${i.sku}</span></td><td class="mono">${i.bin}</td><td>${i.qty_on_hand < 60 ? `<span class="badge y">${i.qty_on_hand} 偏低</span>` : i.qty_on_hand}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h3 style="font-size:15px">最近扣帳紀錄</h3>${tx.length ? `<table class="t" style="margin-top:8px">${tx.map(x => `<tr><td class="mono">${fmtT(x.created_at)}</td><td>${esc(P[x.sku]?.name || x.sku)}<br><span class="mut mono">${x.bin}</span></td><td style="color:${x.qty < 0 ? 'var(--r)' : 'var(--g)'}">${x.qty > 0 ? '+' : ''}${x.qty}</td></tr>`).join('')}</table>` : '<div class="empty">還沒有扣帳紀錄，完成一次撿貨就會出現</div>'}</div></div>`;
  }

  await load();
  return load;
}
