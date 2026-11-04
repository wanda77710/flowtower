import { api, fmtT, esc } from './api.js';

let TAB = 'proj';
const PST = { draft: ['草稿', ''], active: ['進行中', 't'], at_risk: ['有風險', 'r'], done: ['已完成', 'g'], bau: ['轉常態', 'b'] };
const TST = { todo: '待辦', doing: '進行中', review: '待審核', done: '完成', overdue: '逾期' };
const COLS = ['todo', 'doing', 'review', 'done'];
const AK = { vehicle_move: '車輛調度', exception_close: '異常結案', task_review: '任務審核', agent_action: 'AI 助理動作' };
const today = () => new Date().toISOString().slice(0, 10);
const isOver = t => t.status !== 'done' && t.due_date && t.due_date < today();
const badge = ([t, c]) => `<span class="badge ${c}">${t}</span>`;

export async function render(ui) {
  ui.head('專案管理平台', '會議行動項目 → 任務 → 審核，主管不用再追進度');
  const a = ui.actions('<button class="btn" id="mt">📝 從會議紀錄產生任務</button><button class="btn pri" id="np">＋ 新專案</button>');
  const v = ui.view(`<div class="kpis" id="kp"></div>
    <div class="tabs"><button data-t="proj">專案</button><button data-t="board">任務看板</button><button data-t="appr">等你核准 <span id="apn" class="badge r" style="margin-left:4px"></span></button></div><div id="pane"></div>`);
  v.querySelector('.tabs').onclick = e => { const t = e.target.closest('button')?.dataset.t; if (t) { TAB = t; load(); } };
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('tab') === 'appr') TAB = 'appr';
  let D = {};
  a.querySelector('#np').onclick = () => newProject();
  a.querySelector('#mt').onclick = () => meetingNotes();

  async function load() {
    v.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === TAB));
    const [projects, tasks, approvals] = await Promise.all([
      api.get('projects', 'select=*&order=due_date'),
      api.get('tasks', 'select=*&order=due_date'),
      api.get('approvals', 'select=*&order=created_at.desc&limit=100'),
    ]);
    D = { projects, tasks, approvals, pending: approvals.filter(x => x.status === 'pending') };
    const open = tasks.filter(t => t.status !== 'done');
    v.querySelector('#apn').textContent = D.pending.length || '';
    v.querySelector('#kp').innerHTML = `
      <div class="kpi"><span>進行中專案</span><b>${projects.filter(p => ['active', 'at_risk'].includes(p.status)).length}</b></div>
      <div class="kpi"><span>未完成任務</span><b>${open.length}</b></div>
      <div class="kpi"><span>🔴 逾期任務</span><b style="color:var(--r)">${tasks.filter(isOver).length}</b></div>
      <div class="kpi"><span>本週到期</span><b style="color:var(--y)">${open.filter(t => t.due_date && t.due_date >= today() && (new Date(t.due_date) - new Date(today())) / 864e5 <= 7).length}</b></div>
      <div class="kpi"><span>⏳ 等你核准</span><b style="color:var(--y)">${D.pending.length}</b></div>`;
    const pane = v.querySelector('#pane');
    ({ proj: projPane, board: boardPane, appr: apprPane })[TAB](pane);
  }

  function projPane(pane) {
    pane.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${D.projects.map(p => {
      const ts = D.tasks.filter(t => t.project_id === p.id), done = ts.filter(t => t.status === 'done').length, over = ts.filter(isOver).length;
      const pct = ts.length ? Math.round(done / ts.length * 100) : 0, days = p.due_date ? Math.round((new Date(p.due_date) - new Date(today())) / 864e5) : null;
      return `<div class="card pickcard" data-p="${p.id}" style="cursor:pointer">
        <div class="row"><b style="font-size:15px">${esc(p.name)}</b><span style="margin-left:auto">${badge(over && p.status === 'active' ? PST.at_risk : PST[p.status] || [p.status, ''])}</span></div>
        <div class="mut" style="font-size:12px">${esc(p.owner || '')}・目標：${esc(p.goal || '')}</div>
        <div style="height:8px;background:#eef0f4;border-radius:6px;margin-top:6px"><div style="height:100%;width:${pct}%;background:var(--teal);border-radius:6px"></div></div>
        <div class="row" style="font-size:12px"><span>${done}/${ts.length} 任務・${pct}%</span>${over ? `<span class="badge r">逾期 ${over}</span>` : ''}<span class="mut" style="margin-left:auto">${days === null ? '' : days < 0 ? `已過期 ${-days} 天` : `剩 ${days} 天`}</span></div>
        <div class="mut" style="font-size:12px">交付物：${esc(p.expected_deliverable || '—')}</div></div>`; }).join('')}</div>`;
    pane.onclick = e => { const c = e.target.closest('[data-p]'); if (c) projDetail(D.projects.find(p => p.id === c.dataset.p)); };
  }

  function projDetail(p) {
    const ts = D.tasks.filter(t => t.project_id === p.id);
    const d = ui.drawer(p.name, badge(PST[p.status] || [p.status, '']), `
      <div class="grid" style="grid-template-columns:1fr 1fr;font-size:13px"><div><span class="mut">負責</span><br>${esc(p.owner || '')}</div><div><span class="mut">期限</span><br>${p.start_date || ''} ～ ${p.due_date || ''}</div>
      <div style="grid-column:1/-1"><span class="mut">目標</span><br>${esc(p.goal || '')}</div><div style="grid-column:1/-1"><span class="mut">預期交付物（結案依據）</span><br>${esc(p.expected_deliverable || '')}</div></div>
      <div class="sec">任務</div>
      <table class="t">${ts.map(t => `<tr><td>${esc(t.title)}<br><span class="mut" style="font-size:12px">${esc(t.assignee || '')}・交付：${esc(t.deliverable || '—')}</span></td><td class="mono">${t.due_date || ''}</td><td>${badge(isOver(t) ? ['逾期', 'r'] : [TST[t.status], t.status === 'done' ? 'g' : t.status === 'review' ? 'y' : ''])}</td></tr>`).join('') || '<tr><td class="mut">尚無任務</td></tr>'}</table>
      <div class="sec">新增任務</div>
      <div class="grid" style="grid-template-columns:2fr 1fr 1fr"><input id="tt" placeholder="任務名稱"><input id="ta" placeholder="負責人"><input id="td" type="date"></div>
      <input id="tdl" placeholder="交付物（完成時要交出什麼）" style="width:100%;margin-top:8px">`,
      `<select id="ps">${Object.entries(PST).map(([k, [t]]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${t}</option>`).join('')}</select><button class="btn" id="sv">更新狀態</button><button class="btn pri" id="add">新增任務</button>`);
    d.querySelector('#add').onclick = async () => { const title = d.querySelector('#tt').value.trim(); if (!title) return ui.toast('請輸入任務名稱', true);
      await ui.guard(() => api.insert('tasks', [{ project_id: p.id, title, assignee: d.querySelector('#ta').value || null, reviewer: '組長', due_date: d.querySelector('#td').value || null, deliverable: d.querySelector('#tdl').value || null, status: 'todo', source: '手動新增' }]), '已新增任務'); await load(); projDetail(D.projects.find(x => x.id === p.id)); };
    d.querySelector('#sv').onclick = async () => { await ui.guard(() => api.update('projects', `id=eq.${p.id}`, { status: d.querySelector('#ps').value }), '專案狀態已更新'); ui.closeDrawer(); load(); };
  }

  function boardPane(pane) {
    const col = s => D.tasks.filter(t => (s === 'todo' ? ['todo', 'overdue'].includes(t.status) : t.status === s));
    const pn = Object.fromEntries(D.projects.map(p => [p.id, p.name]));
    pane.innerHTML = `<p class="mut" style="margin-bottom:10px;font-size:12px">點任務往下一步推進；送審的任務會進「等你核准」，由上一層主管核准後才算完成（組員→組長→部門主管→GM）。</p>
      <div class="grid" style="grid-template-columns:repeat(4,minmax(200px,1fr));overflow:auto">${COLS.map(s => `<div style="background:#eceef2;border-radius:12px;padding:10px;min-height:300px">
      <b style="font-size:13px">${TST[s]} <span class="mut">${col(s).length}</span></b>
      ${col(s).map(t => `<div class="pickcard" data-t="${t.id}" style="margin-top:8px;${isOver(t) ? 'border-color:var(--r)' : ''}"><div style="font-size:13px">${esc(t.title)}</div>
        <div class="mut" style="font-size:11px">${esc(pn[t.project_id] || '')}</div>
        <div class="row" style="font-size:11px"><span>${esc(t.assignee || '')}</span><span class="mono ${isOver(t) ? '' : 'mut'}" style="margin-left:auto;${isOver(t) ? 'color:var(--r)' : ''}">${t.due_date ? t.due_date.slice(5) : ''}${isOver(t) ? ' 逾期' : ''}</span></div></div>`).join('')}</div>`).join('')}</div>`;
    pane.onclick = e => { const c = e.target.closest('[data-t]'); if (c) taskMove(D.tasks.find(t => t.id === c.dataset.t)); };
  }

  function taskMove(t) {
    const next = { todo: 'doing', overdue: 'doing', doing: 'review' }[t.status];
    const d = ui.drawer(t.title, badge(isOver(t) ? ['逾期', 'r'] : [TST[t.status], '']), `
      <div style="font-size:13px;line-height:1.8"><span class="mut">負責人</span> ${esc(t.assignee || '—')}<br><span class="mut">審核人</span> ${esc(t.reviewer || '—')}<br><span class="mut">期限</span> ${t.due_date || '—'}<br><span class="mut">交付物</span> ${esc(t.deliverable || '—')}<br><span class="mut">來源</span> ${esc(t.source || '—')}</div>`,
      next ? `<button class="btn pri" id="mv">${next === 'doing' ? '開始進行' : '完成，送審'}</button>` : t.status === 'review' ? '<span class="mut">等待審核中</span>' : '');
    d.querySelector('#mv')?.addEventListener('click', async () => {
      await ui.guard(async () => {
        await api.update('tasks', `id=eq.${t.id}`, { status: next });
        if (next === 'review') await api.insert('approvals', [{ kind: 'task_review', ref_id: t.id, title: `${t.title} → 送審`, requested_by: t.assignee || '組員' }]);
      }, next === 'review' ? `已送 ${t.reviewer || '主管'} 審核` : '已開始'); ui.closeDrawer(); load();
    });
  }

  function apprPane(pane) {
    const done = D.approvals.filter(x => x.status !== 'pending').slice(0, 10);
    pane.innerHTML = (D.pending.length ? D.pending.map(x => `<div class="card row" style="margin-bottom:8px"><span class="badge t">${AK[x.kind] || x.kind}</span><div style="flex:1"><b>${esc(x.title)}</b><div class="mut" style="font-size:12px">${esc(x.requested_by || '')}・${fmtT(x.created_at)}</div></div>
      <button class="btn" data-r="${x.id}">退回</button><button class="btn pri" data-a="${x.id}">核准</button></div>`).join('') : '<div class="card empty">都處理完了 ✓</div>') +
      (done.length ? `<div class="sec">最近處理</div><table class="t">${done.map(x => `<tr><td>${AK[x.kind] || x.kind}</td><td>${esc(x.title)}</td><td>${badge(x.status === 'approved' ? ['已核准', 'g'] : ['已退回', 'r'])}</td><td class="mono mut">${fmtT(x.decided_at)}</td></tr>`).join('')}</table>` : '');
    pane.onclick = async e => {
      const id = e.target.dataset?.a || e.target.dataset?.r; if (!id) return; const ok = !!e.target.dataset.a, x = D.pending.find(y => y.id === id);
      await ui.guard(async () => {
        await api.update('approvals', `id=eq.${id}`, { status: ok ? 'approved' : 'rejected', decided_by: '主管', decided_at: new Date().toISOString() });
        if (x.kind === 'task_review' && x.ref_id) await api.update('tasks', `id=eq.${x.ref_id}`, ok ? { status: 'done', done_at: new Date().toISOString() } : { status: 'doing' });
        if (x.kind === 'exception_close' && x.ref_id) await api.update('exceptions', `id=eq.${x.ref_id}`, ok ? { status: 'closed', closed_at: new Date().toISOString() } : { status: 'handling' });
      }, ok ? '已核准' : '已退回'); load();
    };
  }

  function newProject() {
    const d = ui.drawer('新專案', '', `<div class="grid">
      <label class="f">專案名稱<input id="n"></label><label class="f">負責單位／人<input id="o" value="運輸數據組"></label>
      <label class="f">目標（可衡量）<input id="g" placeholder="例：缺車通報下降 30%"></label>
      <label class="f">預期交付物（結案時對照）<input id="dl" placeholder="例：看板＋SOP"></label>
      <div class="row"><label class="f" style="flex:1">開始<input type="date" id="s" value="${today()}"></label><label class="f" style="flex:1">期限<input type="date" id="e"></label></div></div>`,
      '<button class="btn pri" id="ok">建立</button>');
    d.querySelector('#ok').onclick = async () => { const name = d.querySelector('#n').value.trim(); if (!name) return ui.toast('請輸入專案名稱', true);
      await ui.guard(() => api.insert('projects', [{ name, owner: d.querySelector('#o').value, dept: '運輸部', goal: d.querySelector('#g').value, expected_deliverable: d.querySelector('#dl').value, start_date: d.querySelector('#s').value || null, due_date: d.querySelector('#e').value || null, status: 'active' }]), '專案已建立'); ui.closeDrawer(); load(); };
  }

  function meetingNotes() {
    const d = ui.drawer('從會議紀錄產生任務', '', `
      <p class="mut" style="font-size:12px;margin-bottom:8px">一行一個行動項目，格式：<b>任務／負責人／期限(MM/DD)</b>（用全形「／」或「|」分隔）。正式版可接 AI 直接讀整份會議紀錄。</p>
      <label class="f">放進哪個專案<select id="p">${D.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <textarea id="tx" rows="8" style="width:100%;margin-top:10px">整理 HC 倉 10 月缺車明細／組員A／11/12
與供應商確認晶圓廠排隊時間／組員B／11/15
試行同廠併單規則一週／組員C／11/20</textarea><div id="pv" style="margin-top:10px"></div>`, '<button class="btn pri" id="ok">建立任務</button>');
    const parse = () => d.querySelector('#tx').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [title, who, due] = (/[／|｜]/.test(l) ? l.split(/[／|｜]/) : l.split(/\s+\/\s+/)).map(s => s?.trim());
      let date = null; if (due) { const m = due.match(/(\d{1,2})[\/\-.](\d{1,2})/); if (m) { const y = new Date().getFullYear(); date = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; } }
      return { title, assignee: who || null, due_date: date }; }).filter(x => x.title);
    const pv = () => { d.querySelector('#pv').innerHTML = `<table class="t">${parse().map(x => `<tr><td>${esc(x.title)}</td><td>${esc(x.assignee || '—')}</td><td class="mono">${x.due_date || '—'}</td></tr>`).join('')}</table>`; };
    d.querySelector('#tx').oninput = pv; pv();
    d.querySelector('#ok').onclick = async () => { const items = parse(); if (!items.length) return;
      await ui.guard(() => api.insert('tasks', items.map(x => ({ ...x, project_id: d.querySelector('#p').value, reviewer: '組長', status: 'todo', source: '會議 ' + today() }))), `已建立 ${items.length} 個任務`); ui.closeDrawer(); TAB = 'board'; load(); };
  }

  await load();
  return load;
}
