// Mission Control v2 frontend. Vanilla JS, no build step.

const MODELS = [
  { v: '', label: 'Default' },
  { v: 'opus', label: 'Opus 4.8' },
  { v: 'sonnet', label: 'Sonnet 4.6' },
  { v: 'haiku', label: 'Haiku 4.5' },
];
const EFFORTS = [
  { v: '', label: 'Effort' },
  { v: 'low', label: 'Low' },
  { v: 'medium', label: 'Med' },
  { v: 'high', label: 'High' },
  { v: 'max', label: 'Max' },
];
const LAYOUTS = { comfortable: '380px', compact: '280px', dense: '210px' };
let currentLayout = localStorage.getItem('mc-layout') || 'comfortable';

let S = { projects: [], templates: [], agents: [], activeProjectId: null };
const cards = new Map();     // agentId -> { transcript, ta, badge, tok, send, fileInput, attachments, pending: [] }
let editingAgentId = null;
let editingTemplate = null;  // working copy in template editor

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function activeProject() { return S.projects.find((p) => p.id === S.activeProjectId); }
function projectAgents() { return S.agents.filter((a) => a.projectId === S.activeProjectId); }

async function api(path, method, body) {
  const opt = { method: method || 'GET' };
  if (body) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  return res.json();
}

async function refresh() {
  S = await api('/api/state');
  render();
}

// ---------------- Render ----------------
function render() {
  // Project selector
  const sel = $('projSelect');
  sel.innerHTML = '';
  if (!S.projects.length) { const o = el('option', null, 'No projects'); o.value = ''; sel.appendChild(o); }
  S.projects.forEach((p) => { const o = el('option', null, p.name); o.value = p.id; if (p.id === S.activeProjectId) o.selected = true; sel.appendChild(o); });

  const proj = activeProject();
  $('pName').textContent = proj ? proj.name : 'No project';
  $('pCwd').textContent = proj ? proj.cwd : '';

  // Shared files
  const pf = $('pFiles'); pf.innerHTML = '';
  if (proj) (proj.contextFiles || []).forEach((f) => {
    const chip = el('div', 'chip'); chip.append(el('span', null, '📄 ' + f.name));
    const rm = el('span', 'rm', '✕'); rm.onclick = () => removeSharedFile(f.path); chip.append(rm); pf.appendChild(chip);
  });

  renderCards();
  renderDiagram();
  updateDashboard();
}

function applyLayout() {
  const min = LAYOUTS[currentLayout] || LAYOUTS.comfortable;
  $('grid').style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + min + ',1fr))';
  const isDense = currentLayout === 'dense';
  document.querySelectorAll('.card').forEach((c) => {
    c.style.minHeight = isDense ? '280px' : (currentLayout === 'compact' ? '360px' : '460px');
  });
  document.querySelectorAll('#layoutBar button').forEach((b) => b.classList.toggle('on', b.dataset.layout === currentLayout));
}

function renderCards() {
  const grid = $('grid');
  grid.innerHTML = '';
  cards.clear();
  const list = projectAgents();
  if (!activeProject()) {
    const b = el('div', 'empty'); b.innerHTML = '<h2>Welcome to Mission Control</h2><p>Create a project to begin. Pick the <b>Marketing Department</b> template to spawn a full team, or start blank and add your own workers.</p>';
    grid.appendChild(b); return;
  }
  if (!list.length) {
    const b = el('div', 'empty'); b.innerHTML = '<h2>No workers yet</h2><p>Click <b>+ Worker</b> to add an agent, or <b>Templates</b> to load a department.</p>';
    grid.appendChild(b); return;
  }
  list.forEach((meta) => grid.appendChild(makeCard(meta)));
  applyLayout();
}

function isDirector(meta) { return !meta.reportsTo && /director|lead|manager|chief/i.test(meta.role || meta.name); }

function makeCard(meta) {
  const director = isDirector(meta);
  const card = el('div', 'card' + (director ? ' director' : ''));

  const head = el('div', 'card-head');
  head.append(el('span', 'num', '#' + meta.num));
  head.append(el('span', 'role', meta.role || meta.name));
  if (meta.reportsTo) head.append(el('span', 'reports', '↳ ' + meta.reportsTo));

  const modelSel = el('select', 'model-sel');
  MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (meta.model || '')) o.selected = true; modelSel.appendChild(o); });
  modelSel.onchange = async () => { await api('/api/agents/' + meta.id + '/model', 'POST', { model: modelSel.value }); };
  head.append(modelSel);

  const effortSel = el('select', 'model-sel');
  EFFORTS.forEach((e) => { const o = el('option', null, e.label); o.value = e.v; if (e.v === (meta.effort || '')) o.selected = true; effortSel.appendChild(o); });
  effortSel.onchange = async () => { await api('/api/agents/' + meta.id + '/edit', 'POST', { effort: effortSel.value }); };
  head.append(effortSel);

  if (meta.engine === 'api') { modelSel.style.display = 'none'; head.append(el('span', 'badge', 'API: ' + (meta.apiModel || '?'))); }
  else if (meta.ccModel || meta.ccBaseUrl) { head.append(el('span', 'badge', '⇄ ' + (meta.ccModel || 'proxy'))); }

  const badge = el('span', 'badge', 'idle');
  const editB = el('button', 'ic', '✎'); editB.title = 'Edit soul'; editB.onclick = () => openWorker(meta.id);
  const x = el('button', 'ic x', '✕'); x.onclick = () => removeWorker(meta.id);
  head.append(badge, editB, x);

  const tok = el('div', 'tok'); head.append(tok);

  const transcript = el('div', 'transcript');
  const attachments = el('div', 'attachments');

  const composer = el('div', 'composer');
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
  const attach = el('button', 'attach', '📎'); attach.title = 'Attach file to this agent only'; attach.onclick = () => fileInput.click();
  const ta = el('textarea'); ta.rows = 2; ta.placeholder = 'Message ' + (meta.role || meta.name) + '…';
  const sendBtn = el('button', null, 'Send'); sendBtn.onclick = () => doSend(meta.id);
  const stopBtn = el('button', 'stopbtn', '■ Stop'); stopBtn.style.display = 'none'; stopBtn.onclick = () => stopRun(meta.id);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(meta.id); } });
  composer.append(attach, ta, sendBtn, stopBtn, fileInput);

  card.append(head, transcript, attachments, composer);

  const c = { meta, card, transcript, ta, badge, tok, send: sendBtn, stop: stopBtn, fileInput, attachments, pending: [] };
  cards.set(meta.id, c);
  fileInput.onchange = () => handleAgentFiles(meta.id, fileInput.files);
  renderTok(c);
  return card;
}

function renderTok(c) {
  const t = c.meta.totals || {};
  c.tok.innerHTML = `in <b>${fmt(t.input)}</b> · out <b>${fmt(t.output)}</b> · cache <b>${fmt(t.cache)}</b> · turns <b>${t.turns || 0}</b> · <b>$${(t.cost || 0).toFixed(4)}</b>`;
}

function addMsg(c, cls, text) { const m = el('div', 'msg ' + cls, text); c.transcript.appendChild(m); c.transcript.scrollTop = c.transcript.scrollHeight; return m; }

// ---------------- Dispatch parsing ----------------
function parseAssignments(text) {
  const out = [];
  text.split('\n').forEach((line) => {
    const m = line.match(/^\s*@([^:]+):\s*(.+)$/);
    if (m) { const name = m[1].trim(); const task = m[2].trim(); if (norm(name) !== 'none') out.push({ name, task }); }
  });
  return out;
}
function findAgentByName(name) {
  const list = projectAgents();
  return list.find((a) => norm(a.role) === norm(name) || norm(a.name) === norm(name))
      || list.find((a) => norm(a.role).includes(norm(name)) || norm(name).includes(norm(a.role)));
}
function renderDispatch(c, assignments) {
  const box = el('div', 'dispatch');
  box.append(el('div', 'dh', '⇡ DISPATCH — click to send each task to the worker'));
  assignments.forEach((a) => {
    const target = findAgentByName(a.name);
    const row = el('div', 'row');
    row.append(el('span', 'to', '@' + a.name));
    row.append(el('span', 'task', a.task));
    const btn = el('button', 'sm', target ? 'Dispatch ▶' : 'No match');
    btn.disabled = !target;
    btn.onclick = () => { doSend(target.id, a.task); btn.textContent = 'Sent ✓'; btn.classList.add('done'); btn.disabled = true; };
    row.append(btn);
    box.append(row);
  });
  c.transcript.appendChild(box);
  c.transcript.scrollTop = c.transcript.scrollHeight;
}

// ---------------- Messaging ----------------
async function doSend(id, overrideText) {
  const c = cards.get(id);
  if (!c) return;
  let text = (overrideText != null ? overrideText : c.ta.value).trim();
  if (!text && !c.pending.length) return;
  if (c.pending.length) {
    text = `[Files attached for you on disk — read with your tools:\n${c.pending.map((p) => '- ' + p).join('\n')}]\n\n` + text;
    c.pending = []; c.attachments.innerHTML = '';
  }
  if (overrideText == null) c.ta.value = '';
  c.ta.disabled = true; c.send.disabled = true;
  c.send.style.display = 'none'; c.stop.style.display = '';
  c.badge.textContent = 'working'; c.badge.classList.add('live');
  addMsg(c, 'user', text);
  const thinking = el('div', 'thinking dots'); thinking.textContent = 'thinking'; c.transcript.appendChild(thinking);
  c.transcript.scrollTop = c.transcript.scrollHeight;

  try {
    const res = await fetch('/api/agents/' + id + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', gotFirst = false;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        if (!gotFirst && (evt.type === 'text' || evt.type === 'tool')) { thinking.remove(); gotFirst = true; }
        renderEvent(c, evt);
      }
    }
  } catch (e) { addMsg(c, 'err', 'Connection error: ' + e.message); }
  finally {
    if (thinking.isConnected) thinking.remove();
    c.ta.disabled = false; c.send.disabled = false;
    c.send.style.display = ''; c.stop.style.display = 'none';
    c.badge.textContent = c.meta.hasSession ? 'ready' : 'idle'; c.badge.classList.remove('live');
  }
}

async function stopRun(id) {
  const c = cards.get(id);
  if (c) { c.stop.disabled = true; c.stop.textContent = 'stopping…'; }
  try { await api('/api/agents/' + id + '/stop', 'POST'); } catch {}
  if (c) setTimeout(() => { c.stop.disabled = false; c.stop.textContent = '■ Stop'; }, 1500);
}

function renderEvent(c, evt) {
  switch (evt.type) {
    case 'system':
      if (evt.stopped) { addMsg(c, 'system', '■ Stopped by you'); break; }
      c.meta.hasSession = true; if (evt.model) c.badge.title = evt.model; break;
    case 'text': {
      addMsg(c, 'assistant', evt.text);
      const assignments = parseAssignments(evt.text);
      if (assignments.length) renderDispatch(c, assignments);
      break;
    }
    case 'tool': {
      let d = evt.name; const i = evt.input || {};
      if (i.command) d += ': ' + i.command; else if (i.file_path) d += ': ' + i.file_path; else if (i.pattern) d += ': ' + i.pattern;
      addMsg(c, 'tool', '🔧 ' + d); break;
    }
    case 'result':
      if (evt.totals) { c.meta.totals = evt.totals; renderTok(c); updateDashboard(); }
      if (typeof evt.cost === 'number') { const s = evt.duration ? (evt.duration / 1000).toFixed(1) + 's · ' : ''; addMsg(c, 'system', s + '$' + evt.cost.toFixed(4)); }
      break;
    case 'error': addMsg(c, 'err', evt.error); break;
  }
}

// ---------------- Files ----------------
function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

async function handleAgentFiles(id, fileList) {
  const c = cards.get(id);
  for (const file of fileList) {
    try {
      const dataBase64 = await readAsDataURL(file);
      const out = await api('/api/agents/' + id + '/upload', 'POST', { filename: file.name, dataBase64 });
      if (out.path) { c.pending.push(out.path); const chip = el('div', 'chip'); chip.append(el('span', null, '📎 ' + file.name)); c.attachments.appendChild(chip); }
    } catch (e) { addMsg(c, 'err', 'Upload failed: ' + e.message); }
  }
  c.fileInput.value = '';
}

async function addSharedFiles(fileList) {
  const proj = activeProject(); if (!proj) return;
  for (const file of fileList) {
    const dataBase64 = await readAsDataURL(file);
    S = await api('/api/projects/' + proj.id + '/files', 'POST', { filename: file.name, dataBase64 });
  }
  render();
}
async function removeSharedFile(p) {
  const proj = activeProject(); if (!proj) return;
  S = await api('/api/projects/' + proj.id + '/files', 'POST', { removePath: p });
  render();
}

// ---------------- Workers ----------------
function fillReportsOptions(sel, currentVal, excludeRole) {
  sel.innerHTML = '';
  sel.appendChild(Object.assign(el('option', null, '— Top level (no manager) —'), { value: '' }));
  projectAgents().forEach((a) => {
    const label = a.role || a.name; if (label === excludeRole) return;
    const o = el('option', null, label); o.value = label; if (label === currentVal) o.selected = true; sel.appendChild(o);
  });
}
function fillModelOptions(sel, currentVal) {
  sel.innerHTML = '';
  MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (currentVal || '')) o.selected = true; sel.appendChild(o); });
}
function syncEngineFields() {
  const api = $('wmEngine').value === 'api';
  $('wmApiFields').classList.toggle('hidden', !api);
  $('wmCcFields').classList.toggle('hidden', api);
}
function openWorker(id, presetReports) {
  editingAgentId = id || null;
  const a = id ? S.agents.find((x) => x.id === id) : null;
  $('wmTitle').textContent = id ? 'Edit Worker' : 'Add Worker';
  $('wmName').value = a ? (a.role || a.name) : '';
  fillReportsOptions($('wmReports'), a ? a.reportsTo : (presetReports || ''), a ? (a.role || a.name) : '');
  fillModelOptions($('wmModel'), a ? a.model : '');
  $('wmEffort').value = a ? (a.effort || '') : '';
  $('wmEngine').value = a ? (a.engine || 'claude-code') : 'claude-code';
  $('wmApiBase').value = a ? (a.apiBaseUrl || '') : '';
  $('wmApiKey').value = a ? (a.apiKey || '') : '';
  $('wmApiModel').value = a ? (a.apiModel || '') : '';
  $('wmCcBase').value = a ? (a.ccBaseUrl || '') : '';
  $('wmCcToken').value = a ? (a.ccAuthToken || '') : '';
  $('wmCcModel').value = a ? (a.ccModel || '') : '';
  $('wmSoul').value = a ? a.soul : '';
  syncEngineFields();
  openModal('workerModal');
}
async function saveWorker() {
  const proj = activeProject(); if (!proj) return;
  const body = {
    name: $('wmName').value.trim(), role: $('wmName').value.trim(), reportsTo: $('wmReports').value,
    model: $('wmModel').value, effort: $('wmEffort').value, soul: $('wmSoul').value, engine: $('wmEngine').value,
    apiBaseUrl: $('wmApiBase').value.trim(), apiKey: $('wmApiKey').value.trim(), apiModel: $('wmApiModel').value.trim(),
    ccBaseUrl: $('wmCcBase').value.trim(), ccAuthToken: $('wmCcToken').value.trim(), ccModel: $('wmCcModel').value.trim(),
  };
  if (editingAgentId) await api('/api/agents/' + editingAgentId + '/edit', 'POST', body);
  else await api('/api/agents', 'POST', { ...body, projectId: proj.id });
  closeModals(); refresh();
}
async function removeWorker(id) { await api('/api/agents/' + id, 'DELETE'); refresh(); }

// ---------------- Diagram ----------------
function focusAgent(id) {
  setView('chat');
  const c = cards.get(id);
  if (c) { c.card.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => c.ta.focus(), 300); }
}
async function setReports(id, value) { await api('/api/agents/' + id + '/edit', 'POST', { reportsTo: value }); await refresh(); setView('diagram'); }

function renderDiagram() {
  const d = $('diagram'); d.innerHTML = '';
  const list = projectAgents();
  if (!activeProject()) { d.innerHTML = '<div class="empty"><p>Create a project to see its team diagram.</p></div>'; return; }
  if (!list.length) {
    d.innerHTML = '<div class="empty"><p>No team yet.</p></div>';
    const a = el('div', 'diag-actions'); const b = el('button', null, '+ Add first worker'); b.onclick = () => openWorker(null); a.appendChild(b); d.appendChild(a);
    return;
  }
  d.appendChild(el('div', 'dhint', 'Click a name to chat · use “Reports to” to connect/disconnect · ＋ adds a worker under that role'));

  const byRole = (r) => list.filter((a) => norm(a.reportsTo) === norm(r));
  const roots = list.filter((a) => !a.reportsTo || !list.some((b) => norm(b.role || b.name) === norm(a.reportsTo)));

  function nodeHtml(a) {
    const role = a.role || a.name;
    const children = byRole(role);
    const node = el('li');
    const box = el('div', 'node' + (isDirector(a) ? ' director' : ''));

    const title = el('div', 'nr', role); title.title = 'Click to chat'; title.onclick = () => focusAgent(a.id);
    box.append(title);
    const eng = a.engine === 'api' ? 'API:' + (a.apiModel || '?') : (a.ccModel ? '⇄' + a.ccModel : (MODELS.find((m) => m.v === a.model) || {}).label || 'Default');
    box.append(el('div', 'nn', '#' + a.num + ' · ' + eng));
    const t = a.totals || {}; box.append(el('div', 'nt', '$' + (t.cost || 0).toFixed(3) + ' · ' + fmt((t.input || 0) + (t.output || 0)) + ' tok'));

    const tools = el('div', 'ntools');
    const chat = el('button', null, '💬'); chat.title = 'Chat'; chat.onclick = () => focusAgent(a.id);
    const edit = el('button', null, '✎'); edit.title = 'Edit soul'; edit.onclick = () => openWorker(a.id);
    const add = el('button', null, '＋'); add.title = 'Add worker under ' + role; add.onclick = () => openWorker(null, role);
    const del = el('button', null, '✕'); del.title = 'Remove'; del.onclick = () => removeWorker(a.id);
    tools.append(chat, edit, add, del); box.append(tools);

    // Reports-to selector: connect / disconnect.
    const rsel = el('select', 'rsel');
    rsel.appendChild(Object.assign(el('option', null, '↑ Top level (disconnect)'), { value: '' }));
    list.forEach((b) => { const lbl = b.role || b.name; if (lbl === role) return; const o = el('option', null, '↳ ' + lbl); o.value = lbl; if (norm(lbl) === norm(a.reportsTo)) o.selected = true; rsel.appendChild(o); });
    rsel.onchange = () => setReports(a.id, rsel.value);
    box.append(rsel);

    node.append(box);
    if (children.length) { const ul = el('ul'); children.forEach((ch) => ul.append(nodeHtml(ch))); node.append(ul); }
    return node;
  }

  const tree = el('div', 'tree'); const ul = el('ul'); roots.forEach((r) => ul.append(nodeHtml(r))); tree.append(ul); d.append(tree);
  const acts = el('div', 'diag-actions'); const b = el('button', null, '+ Add worker'); b.onclick = () => openWorker(null); acts.appendChild(b); d.appendChild(acts);
}

// ---------------- Dashboard ----------------
function updateDashboard() {
  let tokens = 0, cost = 0;
  S.agents.forEach((a) => { const t = a.totals || {}; tokens += (t.input || 0) + (t.output || 0) + (t.cache || 0); cost += t.cost || 0; });
  $('sAgents').textContent = projectAgents().length;
  $('sTokens').textContent = fmt(tokens);
  $('sCost').textContent = cost.toFixed(4);
  const budget = parseFloat($('budgetInput').value);
  $('sLeft').textContent = budget > 0 ? Math.max(0, budget - cost).toFixed(4) : '—';
}

// ---------------- Views ----------------
function setView(v) {
  $('viewChat').classList.toggle('on', v === 'chat');
  $('viewDiagram').classList.toggle('on', v === 'diagram');
  $('grid').classList.toggle('hidden', v !== 'chat');
  $('diagram').classList.toggle('hidden', v !== 'diagram');
  if (v === 'diagram') renderDiagram();
}

// ---------------- Modals ----------------
function openModal(id) { $(id).classList.add('open'); }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => m.classList.remove('open')); }

// New project
function openNewProject() {
  $('npName').value = '';
  $('npCwd').value = (S.projects[0] && S.projects[0].cwd) || '';
  const sel = $('npTemplate'); sel.innerHTML = '';
  sel.appendChild(Object.assign(el('option', null, 'Blank (no team)'), { value: '' }));
  S.templates.forEach((t) => { const o = el('option', null, t.name + ' (' + t.roles.length + ')'); o.value = t.name; sel.appendChild(o); });
  openModal('projModal');
}
async function createProject() {
  const hadTemplate = !!$('npTemplate').value;
  await api('/api/projects', 'POST', { name: $('npName').value.trim() || 'Untitled Project', cwd: $('npCwd').value.trim(), templateName: $('npTemplate').value });
  closeModals(); await refresh();
  if (hadTemplate) setView('diagram'); // show the new team's org chart immediately
}

// Templates manager
function openTemplates() {
  const list = $('tplList'); list.innerHTML = '';
  S.templates.forEach((t) => {
    const row = el('div', 'tpl-row');
    row.append(el('span', 'tn', t.name));
    row.append(el('span', 'td', (t.roles || []).map((r) => r.role).join(', ')));
    const edit = el('button', 'ghost sm', 'Edit'); edit.onclick = () => openTemplateEditor(t);
    const del = el('button', 'ghost sm', 'Delete'); del.onclick = async () => { await api('/api/templates/' + encodeURIComponent(t.name), 'DELETE'); await refresh(); openTemplates(); };
    row.append(edit, del); list.appendChild(row);
  });
  openModal('tplModal');
}
function openTemplateEditor(t) {
  editingTemplate = t ? JSON.parse(JSON.stringify(t)) : { name: '', description: '', roles: [] };
  $('teTitle').textContent = t ? 'Edit Template' : 'New Template';
  $('teName').value = editingTemplate.name;
  $('teDesc').value = editingTemplate.description;
  renderTemplateRoles();
  closeModals(); openModal('tplEditModal');
}
function renderTemplateRoles() {
  const wrap = $('teRoles'); wrap.innerHTML = '';
  editingTemplate.roles.forEach((r, i) => {
    const box = el('div', 'role-edit');
    const top = el('div', 'top');
    const roleIn = el('input'); roleIn.placeholder = 'Role title'; roleIn.value = r.role || ''; roleIn.oninput = () => (r.role = roleIn.value);
    const reportsIn = el('input'); reportsIn.placeholder = 'Reports to (role title, blank = top)'; reportsIn.value = r.reportsTo || ''; reportsIn.oninput = () => (r.reportsTo = reportsIn.value);
    const modelSel = el('select'); MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (r.model || '')) o.selected = true; modelSel.appendChild(o); }); modelSel.onchange = () => (r.model = modelSel.value);
    const del = el('button', 'ghost sm', '✕'); del.onclick = () => { editingTemplate.roles.splice(i, 1); renderTemplateRoles(); };
    top.append(roleIn, reportsIn, modelSel, del);
    const soul = el('textarea'); soul.placeholder = 'Soul / persona (.md)'; soul.value = r.soul || ''; soul.style.width = '100%'; soul.style.minHeight = '90px'; soul.oninput = () => (r.soul = soul.value);
    box.append(top, soul); wrap.appendChild(box);
  });
}
async function saveTemplate() {
  editingTemplate.name = $('teName').value.trim();
  editingTemplate.description = $('teDesc').value.trim();
  if (!editingTemplate.name) { alert('Template needs a name'); return; }
  await api('/api/templates', 'POST', editingTemplate);
  closeModals(); await refresh(); openTemplates();
}
async function saveProjectAsTemplate() {
  const proj = activeProject(); if (!proj) return;
  const name = prompt('Template name:', proj.name + ' Team'); if (!name) return;
  await api('/api/save-template-from-project/' + proj.id, 'POST', { name });
  await refresh(); alert('Saved as template: ' + name);
}

// ---------------- Wire up ----------------
$('projSelect').onchange = async (e) => { if (e.target.value) { await api('/api/projects/' + e.target.value + '/activate', 'POST'); refresh(); } };
$('newProjBtn').onclick = openNewProject;
$('tplBtn').onclick = openTemplates;
$('viewChat').onclick = () => setView('chat');
$('viewDiagram').onclick = () => setView('diagram');
$('addWorkerBtn').onclick = () => openWorker(null);
$('saveTplBtn').onclick = saveProjectAsTemplate;
$('addFileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => addSharedFiles($('fileInput').files);
$('budgetInput').oninput = updateDashboard;
document.querySelectorAll('#layoutBar button').forEach((b) => {
  b.onclick = () => { currentLayout = b.dataset.layout; localStorage.setItem('mc-layout', currentLayout); applyLayout(); };
});
$('npCreate').onclick = createProject;
$('wmSave').onclick = saveWorker;
$('wmEngine').onchange = syncEngineFields;
$('tplNew').onclick = () => openTemplateEditor(null);
$('teSave').onclick = saveTemplate;
$('teAddRole').onclick = () => { editingTemplate.roles.push({ role: '', soul: '', model: '', reportsTo: '' }); renderTemplateRoles(); };
$('bcBtn').onclick = broadcast;
$('bcInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') broadcast(); });
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModals));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

function broadcast() {
  const input = $('bcInput'); const text = input.value.trim(); if (!text) return;
  input.value = '';
  projectAgents().forEach((a) => doSend(a.id, text));
}

refresh();
