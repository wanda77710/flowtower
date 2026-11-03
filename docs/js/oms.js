import { api, master, flagOf, STATUS, fmtT, fmtHM, esc } from './api.js';

const toLocalInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const badgeStatus = s => `<span class="badge ${s === 'delivered' ? 'g' : s === 'exception' ? 'r' : s === 'in_transit' ? 'b' : s === 'created' ? '' : 't'}">${STATUS[s] || s}</span>`;

export async function render(ui) {
  const M = await master();
  ui.head('OMS 訂單', '建單、釋出到倉庫、追蹤每張單的檢查點');
  ui.actions('<button class="btn pri" id="newO">＋ 建立訂單</button>').querySelector('#newO').onclick = () => createForm(ui, M, load);
  const v = ui.view(`
    <div class="kpis" id="kp"></div>
    <div class="row" style="margin-bottom:12px">
      <select id="fSite"><option value="">全部庫房</option>${M.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="fSt"><option value="open">未完成</option><option value="">全部狀態</option>${Object.entries(STATUS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select>
      <select id="fFlag"><option value="">全部燈號</option><option value="r">🔴 紅燈</option><option value="y">🟡 黃燈</option><option value="g">🟢 正常</option></select>
      <input id="fQ" placeholder="搜尋單號／客戶／送達點" style="min-width:220px">
      <span class="mut" id="cnt"></span>
    </div>
    <div class="tw"><table class="t"><thead><tr><th>燈號</th><th>訂單號</th><th>客戶</th><th>出貨庫房</th><th>送達點</th><th>車種</th><th>要求出車</th><th>指定送達</th><th>狀態</th></tr></thead><tbody id="tb"><tr><td colspan="9" class="loading">載入中…</td></tr></tbody></table></div>`);
  let rows = [];
  async function load() {
    rows = await api.get('orders', 'select=*,order_lines(sku,qty,picked_qty)&order=req_depart_at.asc&limit=500');
    draw();
  }
  function draw() {
    const fs = v.querySelector('#fSite').value, st = v.querySelector('#fSt').value, ff = v.querySelector('#fFlag').value, q = v.querySelector('#fQ').value.trim().toLowerCase();
    const list = rows.map(o => ({ o, f: flagOf(o) })).filter(({ o, f }) =>
      (!fs || o.site_id === fs) && (!st || (st === 'open' ? !['delivered', 'cancelled'].includes(o.status) : o.status === st)) && (!ff || f[0] === ff) &&
      (!q || [o.order_no, M.cust[o.customer_id]?.name, M.loc[o.location_id]?.name].join(' ').toLowerCase().includes(q)));
    const open = rows.filter(o => !['delivered', 'cancelled'].includes(o.status));
    const red = open.filter(o => flagOf(o)[0] === 'r').length, yel = open.filter(o => flagOf(o)[0] === 'y').length;
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>訂單總數</span><b>${rows.length}</b></div>
      <div class="kpi"><span>未完成</span><b>${open.length}</b></div>
      <div class="kpi"><span>🔴 紅燈</span><b style="color:var(--r)">${red}</b></div>
      <div class="kpi"><span>🟡 黃燈</span><b style="color:var(--y)">${yel}</b></div>
      <div class="kpi"><span>已送達</span><b style="color:var(--g)">${rows.filter(o => o.status === 'delivered').length}</b></div>`;
    v.querySelector('#cnt').textContent = `${list.length} 筆`;
    v.querySelector('#tb').innerHTML = list.map(({ o, f }) => `<tr class="click" data-id="${o.id}">
      <td><span class="badge ${f[0]}"><span class="dot ${f[0]}"></span>${f[1]}</span></td>
      <td class="mono">${o.order_no}</td><td>${esc(M.cust[o.customer_id]?.name)}</td><td>${o.site_id}</td>
      <td>${esc(M.loc[o.location_id]?.name)}</td><td>${o.type_code}</td>
      <td class="mono">${fmtT(o.req_depart_at)}</td><td class="mono">${fmtT(o.req_arrive_at)}</td><td>${badgeStatus(o.status)}</td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">沒有符合的訂單</td></tr>';
  }
  v.querySelectorAll('select,input').forEach(el => el.oninput = draw);
  v.querySelector('#tb').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) detail(ui, M, tr.dataset.id, load); };
  await load();
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  if (want) detail(ui, M, want, load);
  return load;
}

async function detail(ui, M, id, reload) {
  const [[o], picks, events, changes] = await Promise.all([
    api.get('orders', `select=*,order_lines(sku,qty,picked_qty)&id=eq.${id}`),
    api.get('pick_tasks', `select=*&order_id=eq.${id}`),
    api.get('tracking_events', `select=*&order_id=eq.${id}&order=event_at`),
    api.get('order_changes', `select=*&order_id=eq.${id}&order=changed_at`),
  ]);
  const f = flagOf(o), pk = picks[0] || {};
  const ev = Object.fromEntries(events.map(e => [e.event, e]));
  const steps = [
    ['建單', o.created_at, true],
    ['釋出到倉庫', null, o.status !== 'created'],
    ['開始撿貨', pk.started_at, !!pk.started_at],
    ['撿貨完成・扣帳', pk.done_at, !!pk.done_at],
    ['交車給司機', ev.handover?.event_at, !!ev.handover],
    ['出發', ev.depart?.event_at, !!ev.depart],
    ['抵達哨口', ev.arrive_gate?.event_at, !!ev.arrive_gate],
    ['抵達碼頭', ev.arrive_dock?.event_at, !!ev.arrive_dock, ev.arrive_dock?.is_backfill],
    ['完成交貨', ev.delivered?.event_at, !!ev.delivered, ev.delivered?.is_backfill],
  ];
  const nowIdx = steps.findIndex(s => !s[2]);
  const P = Object.fromEntries(M.products.map(p => [p.sku, p]));
  const body = `
    <div class="grid" style="grid-template-columns:1fr 1fr;font-size:13px">
      <div><span class="mut">客戶</span><br>${esc(M.cust[o.customer_id]?.name)}</div>
      <div><span class="mut">送達點</span><br>${esc(M.loc[o.location_id]?.name)}</div>
      <div><span class="mut">出貨庫房</span><br>${esc(M.site[o.site_id]?.name)}</div>
      <div><span class="mut">車種</span><br>${o.type_code}</div>
      <div><span class="mut">要求出車 (T0)</span><br><b class="mono">${fmtT(o.req_depart_at)}</b></div>
      <div><span class="mut">指定送達 (ETA)</span><br><b class="mono">${fmtT(o.req_arrive_at)}</b></div>
    </div>
    ${o.remark ? `<div class="sec">備註</div><div>${esc(o.remark)}</div>` : ''}
    <div class="sec">貨品明細</div>
    <table class="t"><tr><th>品項</th><th>數量</th><th>已撿</th></tr>${o.order_lines.map(l => `<tr><td>${esc(P[l.sku]?.name || l.sku)} <span class="mut mono">${l.sku}</span></td><td>${l.qty}</td><td>${l.picked_qty}</td></tr>`).join('')}</table>
    <div class="sec">流程進度</div>
    <div class="tl">${steps.map((s, i) => `<div class="${s[2] ? 'done' : i === nowIdx ? 'now' : ''}">${s[0]} <span class="mut mono">${s[1] ? fmtHM(s[1]) : ''}</span>${s[3] ? ' <span class="badge">出廠補登</span>' : ''}</div>`).join('')}</div>
    <div class="sec">變更紀錄</div>
    ${changes.length ? `<table class="t">${changes.map(c => `<tr><td class="mono">${fmtT(c.changed_at)}</td><td>${esc(c.field)}：${esc(c.old_value)} → <b>${esc(c.new_value)}</b><br><span class="mut">${esc(c.reason || '')}・${esc(c.changed_by || '')}</span></td></tr>`).join('')}</table>` : '<div class="mut">無</div>'}`;
  const canRelease = o.status === 'created', canEdit = !['delivered', 'cancelled'].includes(o.status), canCancel = ['created', 'released'].includes(o.status);
  const d = ui.drawer(o.order_no, `<span class="badge ${f[0]}"><span class="dot ${f[0]}"></span>${f[1]}</span> ${badgeStatus(o.status)}`, body,
    `${canCancel ? '<button class="btn" id="cx">取消訂單</button>' : ''}${canEdit ? '<button class="btn" id="ed">客戶變更</button>' : ''}${canRelease ? '<button class="btn pri" id="rl">釋出到倉庫</button>' : ''}`);
  d.querySelector('#rl')?.addEventListener('click', async () => {
    await ui.guard(async () => {
      await api.update('orders', `id=eq.${id}`, { status: 'released' });
      if (!picks.length) await api.insert('pick_tasks', [{ order_id: id, site_id: o.site_id, status: 'open' }]);
    }, '已釋出，倉庫可開始撿貨');
    ui.closeDrawer(); reload();
  });
  d.querySelector('#cx')?.addEventListener('click', async () => {
    await ui.guard(() => api.update('orders', `id=eq.${id}`, { status: 'cancelled' }), '訂單已取消'); ui.closeDrawer(); reload();
  });
  d.querySelector('#ed')?.addEventListener('click', () => editForm(ui, M, o, reload));
}

function editForm(ui, M, o, reload) {
  const locs = M.locations.filter(l => l.customer_id === o.customer_id);
  const d = ui.drawer('客戶變更・' + o.order_no, '', `
    <p class="mut" style="margin-bottom:12px">變更會留下紀錄，帳單與報表都以這裡為準，不再只寫在紙本車單上。</p>
    <div class="grid">
      <label class="f">送達點<select id="eL">${locs.map(l => `<option value="${l.id}" ${l.id === o.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label class="f">要求出車<input type="datetime-local" id="eD" value="${toLocalInput(o.req_depart_at)}"></label>
      <label class="f">指定送達<input type="datetime-local" id="eA" value="${toLocalInput(o.req_arrive_at)}"></label>
      <label class="f">車種<select id="eV">${M.vtypes.map(t => `<option ${t.code === o.type_code ? 'selected' : ''}>${t.code}</option>`).join('')}</select></label>
      <label class="f">變更原因<input id="eR" placeholder="例：客戶來電改送達時間"></label>
    </div>`, '<button class="btn pri" id="sv">儲存變更</button>');
  d.querySelector('#sv').onclick = async () => {
    const nv = { location_id: d.querySelector('#eL').value, req_depart_at: new Date(d.querySelector('#eD').value).toISOString(), req_arrive_at: new Date(d.querySelector('#eA').value).toISOString(), type_code: d.querySelector('#eV').value };
    const label = { location_id: '送達點', req_depart_at: '要求出車', req_arrive_at: '指定送達', type_code: '車種' };
    const show = (k, val) => k === 'location_id' ? M.loc[val]?.name : k.startsWith('req') ? fmtT(val) : val;
    const ch = Object.keys(nv).filter(k => k.startsWith('req') ? new Date(nv[k]).getTime() !== new Date(o[k]).getTime() : nv[k] !== o[k]);
    if (!ch.length) return ui.toast('沒有變更');
    await ui.guard(async () => {
      await api.update('orders', `id=eq.${o.id}`, nv);
      await api.insert('order_changes', ch.map(k => ({ order_id: o.id, field: label[k], old_value: show(k, o[k]), new_value: show(k, nv[k]), reason: d.querySelector('#eR').value || '客戶變更', changed_by: 'OP' })));
    }, `已更新 ${ch.length} 個欄位`);
    ui.closeDrawer(); reload();
  };
}

function createForm(ui, M, reload) {
  const now = new Date(Date.now() + 90 * 60000); now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  const d = ui.drawer('建立訂單', '', `
    <div class="grid">
      <label class="f">客戶<select id="cC">${M.customers.map(c => `<option value="${c.id}">${esc(c.name)}${c.is_fab ? '（晶圓廠）' : ''}</option>`).join('')}</select></label>
      <label class="f">送達點<select id="cL"></select></label>
      <label class="f">出貨庫房<select id="cS">${M.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <div class="row"><label class="f" style="flex:1">要求出車 (T0)<input type="datetime-local" id="cD" value="${toLocalInput(now)}"></label>
      <label class="f" style="flex:1">車種<select id="cV">${M.vtypes.map(t => `<option>${t.code}</option>`).join('')}</select></label></div>
      <label class="f">指定送達 (ETA)<input type="datetime-local" id="cA"><span class="mut" id="cHint" style="font-size:11px"></span></label>
      <label class="f">備註<input id="cR" placeholder="選填"></label>
    </div>
    <div class="sec">貨品</div>
    <table class="t lines" id="cLines"></table>
    <button class="btn sm" id="addL" style="margin-top:8px">＋ 加一列</button>`, '<button class="btn pri" id="cOk">建立並釋出到倉庫</button><button class="btn" id="cDraft">只建單</button>');
  const $ = s => d.querySelector(s);
  const fillLoc = () => { $('#cL').innerHTML = M.locations.filter(l => l.customer_id === $('#cC').value).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join(''); eta(); };
  const eta = () => { const l = M.loc[$('#cL').value]; const std = l?.std_travel_min?.[$('#cS').value]; const mins = std || 60;
    const a = new Date(new Date($('#cD').value).getTime() + mins * 60000); $('#cA').value = toLocalInput(a);
    $('#cHint').textContent = std ? `依標準行車時間 ${std} 分鐘自動帶入` : '沒有這條路線的標準行車時間，先以 60 分鐘帶入'; };
  const addLine = () => { const tr = document.createElement('tr'); tr.innerHTML = `<td><select>${M.products.map(p => `<option value="${p.sku}">${esc(p.name)}</option>`).join('')}</select></td><td><input type="number" min="1" value="${1 + Math.floor(Math.random() * 10)}"></td><td><button class="btn sm">✕</button></td>`; tr.querySelector('button').onclick = () => tr.remove(); $('#cLines').appendChild(tr); };
  $('#cC').onchange = fillLoc; $('#cS').onchange = eta; $('#cL').onchange = eta; $('#cD').onchange = eta; $('#addL').onclick = addLine;
  fillLoc(); addLine();
  const save = async release => {
    const lines = [...$('#cLines').querySelectorAll('tr')].map(tr => ({ sku: tr.querySelector('select').value, qty: +tr.querySelector('input').value })).filter(l => l.qty > 0);
    if (!lines.length) return ui.toast('至少要一項貨品', true);
    const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const no = 'TW' + ymd + String(Math.floor(Math.random() * 9000) + 1000);
    await ui.guard(async () => {
      const [o] = await api.insert('orders', [{ order_no: no, customer_id: $('#cC').value, site_id: $('#cS').value, location_id: $('#cL').value, type_code: $('#cV').value,
        req_depart_at: new Date($('#cD').value).toISOString(), req_arrive_at: new Date($('#cA').value).toISOString(), status: release ? 'released' : 'created', remark: $('#cR').value || null, created_by: 'OP' }]);
      await api.insert('order_lines', lines.map(l => ({ ...l, order_id: o.id })));
      if (release) await api.insert('pick_tasks', [{ order_id: o.id, site_id: o.site_id, status: 'open' }]);
    }, `訂單 ${no} 已建立${release ? '並送到倉庫' : ''}`);
    ui.closeDrawer(); reload();
  };
  $('#cOk').onclick = () => save(true); $('#cDraft').onclick = () => save(false);
}
