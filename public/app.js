// Foundry — solo-operator agency runtime.
// Whiskey Bar palette + Fraunces/Inter/Plex Mono stack. 3-panel forge layout,
// worker dock, The Wire (activity), The Bell (Cmd+K), Muster (broadcast).

// ---- Load animation libraries via CDN (idempotent) ----
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
Promise.all([
  loadScript('https://cdn.jsdelivr.net/npm/@formkit/auto-animate@0.8.4/index.min.js'),
  loadScript('https://cdn.jsdelivr.net/npm/countup.js@2.8.0/dist/countUp.umd.js'),
]).catch(() => {});

// ---- Constants ----
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

// Role → initials + accent color (Linear-style agent identity)
function roleInitials(role) {
  const name = (role || '').trim();
  if (!name) return '?';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ---- State ----
let S = { projects: [], templates: [], agents: [], activeProjectId: null };
const cards = new Map();
let editingAgentId = null;
let editingTemplate = null;
let focusedAgentId = null;
let currentView = 'chat';       // chat | log | diagram | reel
let currentLayout = 'focus';    // focus | grid
const missionLogEntries = [];
const activityFeed = [];
let activityFilter = 'all';
let costHistory = [];           // per-turn cost samples for sparkline

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function activeProject() { return S.projects.find((p) => p.id === S.activeProjectId); }
function projectAgents() { return S.agents.filter((a) => a.projectId === S.activeProjectId); }
function findAgent(id) { return S.agents.find((a) => a.id === id); }
function isDirector(meta) { return !meta.reportsTo && /director|lead|manager|chief|founder|owner|editor|ceo|cmo|pm/i.test(meta.role || meta.name); }

async function api(path, method, body) {
  const opt = { method: method || 'GET' };
  if (body) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  return res.json();
}

async function refresh() {
  S = await api('/api/state');
  // Preserve focused agent if it still exists
  if (focusedAgentId && !findAgent(focusedAgentId)) focusedAgentId = null;
  const list = projectAgents();
  if (!focusedAgentId && list.length) focusedAgentId = list[0].id;
  render();
}

// ---- Render ----
function render() {
  renderProjectSelect();
  renderProjectBar();
  renderRail();
  renderCenter();
  updateStats();
  renderActivity();
}

function renderProjectSelect() {
  const sel = $('projSelect');
  sel.innerHTML = '';
  if (!S.projects.length) {
    const o = el('option', null, 'No projects');
    o.value = ''; sel.appendChild(o);
    return;
  }
  S.projects.forEach((p) => {
    const o = el('option', null, p.name);
    o.value = p.id;
    if (p.id === S.activeProjectId) o.selected = true;
    sel.appendChild(o);
  });
}

function renderProjectBar() {
  const proj = activeProject();
  $('pName').textContent = proj ? proj.name : 'No project';
  $('pCwd').textContent = proj ? proj.cwd : '';
  const pf = $('pFiles'); pf.innerHTML = '';
  if (proj) (proj.contextFiles || []).forEach((f) => {
    const chip = el('div', 'chip');
    chip.append(el('span', null, '📄 ' + f.name));
    const rm = el('span', 'rm', '✕');
    rm.onclick = () => removeSharedFile(f.path);
    chip.append(rm); pf.appendChild(chip);
  });
}

// ---- Left rail (Discord-style agent dock) ----
function renderRail() {
  const rail = $('rail'); rail.innerHTML = '';
  const list = projectAgents();
  if (!list.length) {
    const add = el('button', 'rail-add', '+');
    add.title = 'Add first worker';
    add.onclick = () => openWorker(null);
    const slot = el('div', 'rail-slot');
    slot.append(add);
    rail.append(slot);
    return;
  }

  list.forEach((meta) => {
    const slot = el('div', 'rail-slot');
    const icon = el('button', 'agent-icon');
    if (isDirector(meta)) icon.classList.add('director');
    if (meta.id === focusedAgentId) icon.classList.add('active');
    if (meta.hasSession) icon.classList.add('active-session');
    if (meta.busy) icon.classList.add('working');
    icon.textContent = roleInitials(meta.role || meta.name);
    icon.title = (meta.role || meta.name) + ' — #' + meta.num;
    icon.onclick = () => focusAgent(meta.id);
    slot.append(icon);
    // tooltip element
    const tip = el('div', 'rail-tooltip', (meta.role || meta.name) + ' · #' + meta.num);
    slot.append(tip);
    rail.append(slot);
  });

  const divider = el('div', 'rail-divider');
  rail.append(divider);

  const add = el('button', 'rail-add', '+');
  add.title = 'Add worker';
  add.onclick = () => openWorker(null);
  const addSlot = el('div', 'rail-slot');
  addSlot.append(add);
  rail.append(addSlot);
}

// ---- Center — router between focus / grid / log / diagram ----
function renderCenter() {
  const ws = $('workspace');
  const grid = $('gridView');
  const log = $('missionLog');
  const diag = $('diagram');
  const reel = $('reelView');

  ws.classList.add('hidden');
  grid.classList.add('hidden');
  log.classList.add('hidden');
  diag.classList.add('hidden');
  reel.classList.add('hidden');

  if (currentView === 'log') { renderMissionLog(); log.classList.remove('hidden'); return; }
  if (currentView === 'diagram') { renderDiagram(); diag.classList.remove('hidden'); return; }
  if (currentView === 'reel') { window.ReelUI && window.ReelUI.render(reel); reel.classList.remove('hidden'); return; }

  // chat view
  if (currentLayout === 'grid') {
    grid.classList.remove('hidden');
    renderGrid();
  } else {
    ws.classList.remove('hidden');
    renderFocus();
  }
}

// ---- Focus mode (single active agent, full workspace) ----
function renderFocus() {
  const ws = $('workspace');
  ws.innerHTML = '';
  cards.clear();

  if (!activeProject()) {
    const b = el('div', 'empty');
    b.innerHTML = '<h2>The Foundry is quiet</h2><p>Start a project to open the forge. Pick a Blueprint to spawn a full team, or start empty.</p>';
    ws.append(b); return;
  }

  const list = projectAgents();
  if (!list.length) {
    const b = el('div', 'empty');
    b.innerHTML = '<h2>No workers yet</h2><p>Click <b>+ Worker</b> or open <b>Blueprints</b> to assemble a team.</p>';
    ws.append(b); return;
  }

  const meta = findAgent(focusedAgentId) || list[0];
  focusedAgentId = meta.id;

  // Header
  const head = el('div', 'focus-head');
  const avatar = el('div', 'focus-avatar');
  if (isDirector(meta)) avatar.style.cssText = 'background:linear-gradient(135deg,rgba(232,163,61,.25),rgba(232,163,61,.05));border-color:rgba(232,163,61,.4);color:var(--accent)';
  avatar.textContent = roleInitials(meta.role || meta.name);
  head.append(avatar);

  const info = el('div', 'focus-info');
  const title = el('div', 'focus-title');
  title.append(el('span', 'role', meta.role || meta.name));
  const numTag = el('span', 'num-tag', '#' + meta.num);
  title.append(numTag);
  info.append(title);

  const sub = el('div', 'focus-sub');
  const dot = el('span', 'dot-inline' + (meta.busy ? ' working' : (meta.hasSession ? ' active' : '')));
  sub.append(dot);
  sub.append(el('span', null, meta.busy ? 'Working…' : (meta.hasSession ? 'Ready' : 'Idle')));
  if (meta.reportsTo) sub.append(el('span', null, ' · Reports to ' + meta.reportsTo));
  info.append(sub);
  head.append(info);

  // Meta tags (engine / model)
  const meta_ = el('div', 'focus-meta');
  if (meta.engine === 'openclaw') {
    meta_.append(makeMetaTag('OC ' + (meta.ocProvider ? meta.ocProvider + '/' : '') + (meta.ocModel || '?'), 'oc'));
  } else if (meta.engine === 'api') {
    meta_.append(makeMetaTag('API ' + (meta.apiModel || '?'), 'api'));
  } else if (meta.engine === 'codex') {
    meta_.append(makeMetaTag('CODEX ' + (meta.codexModel || 'default'), 'oc'));
  } else if (meta.engine === 'hermes') {
    meta_.append(makeMetaTag('HERMES ' + (meta.hermesProvider ? meta.hermesProvider + '/' : '') + (meta.hermesModel || '?'), 'oc'));
  } else {
    // model + effort selectors inline
    const modelSel = el('select', null); modelSel.style.cssText = 'background:var(--input);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:3px 6px;font-size:11px;';
    MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (meta.model || '')) o.selected = true; modelSel.appendChild(o); });
    modelSel.onchange = async () => { await api('/api/agents/' + meta.id + '/model', 'POST', { model: modelSel.value }); refresh(); };
    meta_.append(modelSel);

    const effortSel = el('select', null); effortSel.style.cssText = modelSel.style.cssText;
    EFFORTS.forEach((e) => { const o = el('option', null, e.label); o.value = e.v; if (e.v === (meta.effort || '')) o.selected = true; effortSel.appendChild(o); });
    effortSel.onchange = async () => { await api('/api/agents/' + meta.id + '/edit', 'POST', { effort: effortSel.value }); refresh(); };
    meta_.append(effortSel);

    if (meta.ccModel || meta.ccBaseUrl) meta_.append(makeMetaTag('⇄ ' + (meta.ccModel || 'proxy'), null));
  }
  head.append(meta_);

  const actions = el('div', 'focus-actions');
  const saveB = mkIcon('💾', 'Save session', () => saveSession(meta.id));
  const editB = mkIcon('✎', 'Edit', () => openWorker(meta.id));
  const delB = mkIcon('✕', 'Remove', () => removeWorker(meta.id));
  delB.classList.add('x');
  actions.append(saveB, editB, delB);
  head.append(actions);

  ws.append(head);

  // Token summary strip
  const t = meta.totals || {};
  const toks = el('div', 'focus-tokens');
  toks.innerHTML = `
    <span>in <b>${fmt(t.input)}</b></span>
    <span class="tok-sep">·</span>
    <span>out <b>${fmt(t.output)}</b></span>
    <span class="tok-sep">·</span>
    <span>cache <b>${fmt(t.cache)}</b></span>
    <span class="tok-sep">·</span>
    <span>turns <b>${t.turns || 0}</b></span>
    <span class="tok-sep">·</span>
    <span style="color:var(--accent);font-weight:700">$${(t.cost || 0).toFixed(4)}</span>
  `;
  ws.append(toks);

  // Transcript (scroll area)
  const transcript = el('div', 'transcript');
  transcript.id = 'transcript-' + meta.id;
  // Restore prior msgs if we have them cached
  const prev = cardCache.get(meta.id);
  if (prev) prev.forEach((n) => transcript.appendChild(n.cloneNode(true)));
  ws.append(transcript);

  // Drag-drop
  ws.addEventListener('dragover', (e) => { e.preventDefault(); ws.classList.add('dragover'); });
  ws.addEventListener('dragleave', () => ws.classList.remove('dragover'));
  ws.addEventListener('drop', (e) => {
    e.preventDefault(); ws.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleAgentFiles(meta.id, e.dataTransfer.files);
  });

  // Attachments strip
  const attach = el('div', 'attachments-strip');
  attach.id = 'attach-' + meta.id;
  ws.append(attach);

  // Composer
  const composer = el('div', 'composer');
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
  const attachBtn = el('button', 'attach', '📎'); attachBtn.title = 'Attach file'; attachBtn.onclick = () => fileInput.click();
  const ta = el('textarea'); ta.rows = 2; ta.placeholder = 'Message ' + (meta.role || meta.name) + '…    (Enter to send · Shift+Enter for newline · / for commands)';
  const sendBtn = el('button', 'send-btn');
  sendBtn.innerHTML = 'Send <span class="send-kbd">⏎</span>';
  sendBtn.onclick = () => doSend(meta.id);
  const stopBtn = el('button', 'stop-btn', '■ Stop'); stopBtn.style.display = 'none';
  stopBtn.onclick = () => stopRun(meta.id);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(meta.id); }
    if (e.key === '/' && ta.value === '') { e.preventDefault(); openCmdk('/'); }
  });
  fileInput.onchange = () => handleAgentFiles(meta.id, fileInput.files);
  composer.append(attachBtn, ta, sendBtn, stopBtn, fileInput);
  ws.append(composer);

  const c = { meta, card: ws, transcript, ta, dot, send: sendBtn, stop: stopBtn, fileInput, attachments: attach, pending: [] };
  cards.set(meta.id, c);

  // Autofocus composer
  setTimeout(() => ta.focus(), 40);
  transcript.scrollTop = transcript.scrollHeight;

  // AutoAnimate on transcript
  if (window.autoAnimate) window.autoAnimate(transcript, { duration: 220 });
}

function makeMetaTag(label, cls) {
  const t = el('span', 'meta-tag' + (cls ? ' ' + cls : ''), label);
  return t;
}
function mkIcon(glyph, title, onclick) {
  const b = el('button', 'ic'); b.textContent = glyph; b.title = title; b.onclick = onclick; return b;
}

// Cache msg DOM per agent so switching focus preserves transcript
const cardCache = new Map(); // agentId -> Array<Node>
function cacheTranscript(agentId) {
  const c = cards.get(agentId);
  if (!c) return;
  const nodes = [];
  c.transcript.childNodes.forEach((n) => nodes.push(n.cloneNode(true)));
  cardCache.set(agentId, nodes);
}

// Focus an agent (switch center pane to it)
function focusAgent(id) {
  if (focusedAgentId && focusedAgentId !== id) cacheTranscript(focusedAgentId);
  focusedAgentId = id;
  currentView = 'chat';
  currentLayout = 'focus';
  applyLayoutButtons();
  applyViewButtons();
  render();
}

// ---- Grid mode (all agents at once) ----
function renderGrid() {
  const grid = $('gridView');
  grid.innerHTML = '';
  cards.clear();
  const list = projectAgents();
  if (!list.length) {
    const b = el('div', 'empty');
    b.innerHTML = '<h2>No workers yet</h2><p>Click <b>+ Worker</b> to add one.</p>';
    grid.append(b); return;
  }
  list.forEach((meta) => grid.append(makeCard(meta)));
}

function makeCard(meta) {
  const isDir = isDirector(meta);
  const card = el('div', 'card' + (isDir ? ' director' : ''));
  if (meta.busy) card.classList.add('active-breath');

  const head = el('div', 'card-head');
  const avatar = el('div', 'card-avatar' + (isDir ? ' director' : ''));
  avatar.textContent = roleInitials(meta.role || meta.name);
  head.append(avatar);

  const title = el('div', 'card-title');
  const roleRow = el('div', 'card-role');
  roleRow.append(el('span', null, meta.role || meta.name));
  roleRow.append(el('span', 'num-tag', '#' + meta.num));
  title.append(roleRow);
  const subRow = el('div', 'card-sub');
  const dot = el('span', 'status-dot' + (meta.busy ? ' working' : (meta.hasSession ? ' active' : '')));
  subRow.append(dot);
  subRow.append(el('span', null, meta.busy ? 'Working' : (meta.hasSession ? 'Ready' : 'Idle')));
  if (meta.reportsTo) subRow.append(el('span', null, ' · ↳ ' + meta.reportsTo));
  title.append(subRow);
  head.append(title);

  const ctrl = el('div', 'card-controls');
  const modelSel = el('select');
  MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (meta.model || '')) o.selected = true; modelSel.appendChild(o); });
  modelSel.onchange = async () => { await api('/api/agents/' + meta.id + '/model', 'POST', { model: modelSel.value }); };
  if (meta.engine === 'api' || meta.engine === 'openclaw' || meta.engine === 'codex' || meta.engine === 'hermes') modelSel.style.display = 'none';
  ctrl.append(modelSel);

  if (meta.engine === 'openclaw') ctrl.append(makeMetaTag('OC ' + (meta.ocProvider ? meta.ocProvider + '/' : '') + (meta.ocModel || '?'), 'oc'));
  else if (meta.engine === 'api') ctrl.append(makeMetaTag('API ' + (meta.apiModel || '?'), 'api'));
  else if (meta.engine === 'codex') ctrl.append(makeMetaTag('CODEX ' + (meta.codexModel || 'default'), 'oc'));
  else if (meta.engine === 'hermes') ctrl.append(makeMetaTag('HERMES ' + (meta.hermesProvider ? meta.hermesProvider + '/' : '') + (meta.hermesModel || '?'), 'oc'));

  ctrl.append(mkIcon('💾', 'Save', () => saveSession(meta.id)));
  ctrl.append(mkIcon('✎', 'Edit', () => openWorker(meta.id)));
  const del = mkIcon('✕', 'Remove', () => removeWorker(meta.id)); del.classList.add('x');
  ctrl.append(del);
  head.append(ctrl);

  // Tokens row + inline sparkline
  const toks = el('div', 'card-tokens');
  const t = meta.totals || {};
  const left = el('div');
  left.innerHTML = `in <b style="color:var(--text)">${fmt(t.input)}</b> · out <b style="color:var(--text)">${fmt(t.output)}</b> · <b class="cost-inline">$${(t.cost || 0).toFixed(3)}</b>`;
  toks.append(left);
  const spark = drawSparkline((t.history || []).map((h) => h.cost || 0), 60, 16);
  spark.classList.add('card-spark');
  toks.append(spark);

  // Transcript
  const transcript = el('div', 'transcript');

  // Drop zone
  const drop = el('div', 'drop-zone', 'Drop files here');

  // Attachments strip
  const attach = el('div', 'attachments');

  // Composer
  const composer = el('div', 'composer');
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
  const attachBtn = el('button', 'attach', '📎'); attachBtn.onclick = () => fileInput.click();
  const ta = el('textarea'); ta.rows = 2; ta.placeholder = 'Message ' + (meta.role || meta.name) + '…';
  const sendBtn = el('button', 'send-btn'); sendBtn.innerHTML = 'Send'; sendBtn.onclick = () => doSend(meta.id);
  const stopBtn = el('button', 'stop-btn', '■ Stop'); stopBtn.style.display = 'none';
  stopBtn.onclick = () => stopRun(meta.id);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(meta.id); } });
  fileInput.onchange = () => handleAgentFiles(meta.id, fileInput.files);
  composer.append(attachBtn, ta, sendBtn, stopBtn, fileInput);

  card.append(head, toks, transcript, drop, attach, composer);

  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragover'); });
  card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('dragover'); });
  card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('dragover'); if (e.dataTransfer.files.length) handleAgentFiles(meta.id, e.dataTransfer.files); });

  const c = { meta, card, transcript, ta, dot, send: sendBtn, stop: stopBtn, fileInput, attachments: attach, pending: [] };
  cards.set(meta.id, c);

  if (window.autoAnimate) window.autoAnimate(transcript, { duration: 220 });

  return card;
}

// ---- Message / dispatch ----
function addMsg(c, cls, text) {
  const m = el('div', 'msg ' + cls);
  c.transcript.appendChild(m);
  // Assistant messages get a typewriter reveal — Claude Code CLI emits full blocks,
  // not token-by-token, so we simulate the streaming feel client-side.
  if (cls === 'assistant' && text && text.length > 24) {
    typewriter(m, text, c.transcript);
  } else {
    m.textContent = text || '';
    c.transcript.scrollTop = c.transcript.scrollHeight;
  }
  return m;
}

function typewriter(node, text, scrollEl) {
  // Reveal ~90 chars per animation frame → feels like fast confident typing.
  // Blinking caret span at the tail while writing.
  const caret = document.createElement('span');
  caret.className = 'caret';
  node.appendChild(caret);
  let i = 0;
  const chunkSize = 3;
  const stepMs = 12;
  const step = () => {
    if (i >= text.length) {
      caret.remove();
      return;
    }
    const slice = text.slice(i, i + chunkSize);
    caret.insertAdjacentText('beforebegin', slice);
    i += chunkSize;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    node._twTimer = setTimeout(step, stepMs);
  };
  step();
}

function parseAssignments(text) {
  const out = [];
  text.split('\n').forEach((line) => {
    const m = line.match(/^\s*@([^:]+):\s*(.+)$/);
    if (m) {
      const name = m[1].trim(), task = m[2].trim();
      if (norm(name) !== 'none') out.push({ name, task });
    }
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
  box.append(el('div', 'dh', 'The Anvil — forge each task to a worker'));
  assignments.forEach((a) => {
    const target = findAgentByName(a.name);
    const row = el('div', 'row');
    row.append(el('span', 'to', '@' + a.name));
    row.append(el('span', 'task', a.task));
    const btn = el('button', 'sm', target ? 'Forge ▶' : 'No match');
    btn.disabled = !target;
    btn.onclick = () => {
      doSend(target.id, a.task);
      btn.textContent = 'Sent ✓';
      btn.classList.add('done');
      btn.disabled = true;
    };
    row.append(btn);
    box.append(row);
  });
  c.transcript.appendChild(box);
  c.transcript.scrollTop = c.transcript.scrollHeight;
}

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
  if (c.dot) c.dot.className = c.dot.className.replace(/dot-inline|status-dot/g, (m) => m + ' working').replace(/(working )+/g, 'working ').trim();
  // simpler: recompute classes
  c.dot.className = c.dot.className.split(' ')[0] + ' working';
  addMsg(c, 'user', text);
  logEvent(id, 'user', text.slice(0, 200));

  const thinking = el('div', 'thinking');
  const step = el('span', 'th-step');
  step.append(el('span', 'th-dot'));
  step.append(el('span', 'dots', 'Thinking'));
  thinking.appendChild(step);
  c.transcript.appendChild(thinking);
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
  } catch (e) { addMsg(c, 'err', 'Connection error: ' + e.message); logEvent(id, 'error', e.message); }
  finally {
    if (thinking.isConnected) thinking.remove();
    c.ta.disabled = false; c.send.disabled = false;
    c.send.style.display = ''; c.stop.style.display = 'none';
    const isActive = c.meta && c.meta.hasSession;
    c.dot.className = c.dot.className.split(' ')[0] + (isActive ? ' active' : '');
    // Cache the transcript BEFORE refresh() rebuilds the DOM, or messages disappear.
    cacheTranscript(id);
    refresh();
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
      if (evt.stopped) { addMsg(c, 'system', '■ Stopped by you'); logEvent(c.meta.id, 'system', 'Stopped'); break; }
      c.meta.hasSession = true;
      logEvent(c.meta.id, 'system', 'Session init' + (evt.model ? ' — ' + evt.model : ''));
      break;
    case 'text': {
      addMsg(c, 'assistant', evt.text);
      logEvent(c.meta.id, 'assistant', evt.text.slice(0, 200));
      const assignments = parseAssignments(evt.text);
      if (assignments.length) renderDispatch(c, assignments);
      break;
    }
    case 'tool': {
      let d = evt.name; const i = evt.input || {};
      if (i.command) d += ': ' + i.command;
      else if (i.file_path) d += ': ' + i.file_path;
      else if (i.pattern) d += ': ' + i.pattern;
      addMsg(c, 'tool', '◆ ' + d);
      logEvent(c.meta.id, 'tool', d);
      break;
    }
    case 'result':
      if (evt.totals) { c.meta.totals = evt.totals; updateStats(); }
      if (typeof evt.cost === 'number') {
        const s = evt.duration ? (evt.duration / 1000).toFixed(1) + 's · ' : '';
        addMsg(c, 'system', s + '$' + evt.cost.toFixed(4));
        logEvent(c.meta.id, 'system', 'Turn done — $' + evt.cost.toFixed(4));
      }
      break;
    case 'error':
      addMsg(c, 'err', evt.error);
      logEvent(c.meta.id, 'error', evt.error);
      break;
  }
}

// ---- Files ----
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej;
    r.readAsDataURL(file);
  });
}
async function handleAgentFiles(id, fileList) {
  const c = cards.get(id);
  for (const file of fileList) {
    try {
      const dataBase64 = await readAsDataURL(file);
      const out = await api('/api/agents/' + id + '/upload', 'POST', { filename: file.name, dataBase64 });
      if (out.path) {
        c.pending.push(out.path);
        const chip = el('div', 'chip');
        chip.append(el('span', null, '📎 ' + file.name));
        c.attachments.appendChild(chip);
      }
    } catch (e) { addMsg(c, 'err', 'Upload failed: ' + e.message); }
  }
  if (c.fileInput) c.fileInput.value = '';
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

// ---- Workers CRUD ----
function fillReportsOptions(sel, currentVal, excludeRole) {
  sel.innerHTML = '';
  sel.appendChild(Object.assign(el('option', null, '— Top level (no manager) —'), { value: '' }));
  projectAgents().forEach((a) => {
    const label = a.role || a.name;
    if (label === excludeRole) return;
    const o = el('option', null, label);
    o.value = label;
    if (label === currentVal) o.selected = true;
    sel.appendChild(o);
  });
}
function fillModelOptions(sel, currentVal) {
  sel.innerHTML = '';
  MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (currentVal || '')) o.selected = true; sel.appendChild(o); });
}
function syncEngineFields() {
  const eng = $('wmEngine').value;
  $('wmApiFields').classList.toggle('hidden', eng !== 'api');
  $('wmCcFields').classList.toggle('hidden', eng !== 'claude-code');
  $('wmOcFields').classList.toggle('hidden', eng !== 'openclaw');
  $('wmCodexFields').classList.toggle('hidden', eng !== 'codex');
  $('wmHermesFields').classList.toggle('hidden', eng !== 'hermes');
}
function openWorker(id, presetReports) {
  editingAgentId = id || null;
  const a = id ? findAgent(id) : null;
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
  $('wmCcOauth').value = a ? (a.ccOauthToken || '') : '';
  $('wmOcProvider').value = a ? (a.ocProvider || '') : '';
  $('wmOcModel').value = a ? (a.ocModel || '') : '';
  $('wmOcApiKey').value = a ? (a.ocApiKey || '') : '';
  $('wmCodexModel').value = a ? (a.codexModel || '') : '';
  $('wmCodexApiKey').value = a ? (a.codexApiKey || '') : '';
  $('wmHermesProvider').value = a ? (a.hermesProvider || '') : '';
  $('wmHermesModel').value = a ? (a.hermesModel || '') : '';
  $('wmHermesApiKey').value = a ? (a.hermesApiKey || '') : '';
  $('wmSoul').value = a ? a.soul : '';
  $('wmCcOauthGet').onclick = async () => {
    const btn = $('wmCcOauthGet');
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const r = await api('/api/account/setup-token', 'POST');
      alert(r && r.ok
        ? 'A terminal window opened running `claude setup-token`.\n\nApprove the account you want in the browser, then copy the printed token and paste it into the field.'
        : 'Could not open the terminal: ' + ((r && r.error) || 'unknown error') + '\n\nRun `claude setup-token` manually and paste the token here.');
    } catch (e) {
      alert('Could not open the terminal. Run `claude setup-token` manually and paste the token here.');
    } finally { btn.disabled = false; btn.textContent = 'Get token'; }
  };
  syncEngineFields();
  openModal('workerModal');
}
async function saveWorker() {
  const proj = activeProject(); if (!proj) return;
  const body = {
    name: $('wmName').value.trim(), role: $('wmName').value.trim(),
    reportsTo: $('wmReports').value, model: $('wmModel').value,
    effort: $('wmEffort').value, soul: $('wmSoul').value, engine: $('wmEngine').value,
    apiBaseUrl: $('wmApiBase').value.trim(), apiKey: $('wmApiKey').value.trim(), apiModel: $('wmApiModel').value.trim(),
    ccBaseUrl: $('wmCcBase').value.trim(), ccAuthToken: $('wmCcToken').value.trim(), ccModel: $('wmCcModel').value.trim(), ccOauthToken: $('wmCcOauth').value.trim(),
    ocProvider: $('wmOcProvider').value.trim(), ocModel: $('wmOcModel').value.trim(), ocApiKey: $('wmOcApiKey').value.trim(),
    codexModel: $('wmCodexModel').value.trim(), codexApiKey: $('wmCodexApiKey').value.trim(),
    hermesProvider: $('wmHermesProvider').value.trim(), hermesModel: $('wmHermesModel').value.trim(), hermesApiKey: $('wmHermesApiKey').value.trim(),
  };
  if (editingAgentId) await api('/api/agents/' + editingAgentId + '/edit', 'POST', body);
  else await api('/api/agents', 'POST', { ...body, projectId: proj.id });
  closeModals(); refresh();
}
async function removeWorker(id) {
  if (!confirm('Remove this worker?')) return;
  await api('/api/agents/' + id, 'DELETE');
  if (focusedAgentId === id) focusedAgentId = null;
  refresh();
}

// ---- Sparkline (self-contained SVG) ----
function drawSparkline(values, w, h) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = w + 'px'; svg.style.height = h + 'px';
  if (!values.length) return svg;

  const n = values.length;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 0.0001);
  const pts = values.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const areaPath = `M0,${h} L${pts.split(' ').join(' L')} L${w},${h} Z`;
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', 'rgba(232,163,61,.12)');
  svg.appendChild(area);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('points', pts);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#E8A33D');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  return svg;
}

function renderCostSpark() {
  const svg = $('costSpark');
  if (!svg) return;
  svg.innerHTML = '';
  // Collect last 7 days of daily cost totals from all agents' history
  const buckets = {};
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * dayMs).toDateString();
    buckets[d] = 0;
  }
  S.agents.forEach((a) => {
    ((a.totals && a.totals.history) || []).forEach((h) => {
      const d = new Date(h.ts).toDateString();
      if (d in buckets) buckets[d] += h.cost || 0;
    });
  });
  const values = Object.values(buckets);
  const drawn = drawSparkline(values, 80, 32);
  drawn.childNodes.forEach((n) => svg.appendChild(n.cloneNode(true)));
}

// ---- Stats bar + cost hero ----
let lastCost = 0;
function updateStats() {
  let tokens = 0, cost = 0, planCost = 0, apiCost = 0, turns = 0, active = 0;
  S.agents.forEach((a) => {
    const t = a.totals || {};
    tokens += (t.input || 0) + (t.output || 0) + (t.cache || 0);
    cost += t.cost || 0;
    turns += t.turns || 0;
    if (a.busy) active++;
    if (a.engine === 'claude-code' && !a.ccBaseUrl) planCost += t.cost || 0;
    else apiCost += t.cost || 0;
  });
  const projList = projectAgents();
  $('sAgents').textContent = projList.length;
  $('sAgentsSub').textContent = active + ' active';
  $('sTokens').textContent = fmt(tokens);
  $('sTurns').textContent = turns + ' turns';

  // Cost hero — animate on change if CountUp is available
  const hero = $('sCostHero');
  if (window.countUp && window.countUp.CountUp && Math.abs(cost - lastCost) > 0.001) {
    try {
      const c = new window.countUp.CountUp('sCostHero', cost, { prefix: '$', decimalPlaces: 2, duration: 0.8, startVal: lastCost });
      if (!c.error) c.start(); else hero.textContent = '$' + cost.toFixed(2);
    } catch { hero.textContent = '$' + cost.toFixed(2); }
  } else {
    hero.textContent = '$' + cost.toFixed(2);
  }
  lastCost = cost;

  $('sCostPlan').textContent = 'plan $' + planCost.toFixed(2);
  $('sCostApi').textContent = 'api $' + apiCost.toFixed(2);

  const budget = parseFloat($('budgetInput').value);
  $('sLeft').textContent = budget > 0 ? Math.max(0, budget - cost).toFixed(2) : '—';

  renderCostSpark();
}

// ---- Views + layout ----
function applyViewButtons() {
  $('viewChat').classList.toggle('on', currentView === 'chat');
  $('viewLog').classList.toggle('on', currentView === 'log');
  $('viewDiagram').classList.toggle('on', currentView === 'diagram');
  $('viewReel').classList.toggle('on', currentView === 'reel');
}
function applyLayoutButtons() {
  document.querySelectorAll('#layoutBar button').forEach((b) => b.classList.toggle('on', b.dataset.layout === currentLayout));
}
function setView(v) { currentView = v; applyViewButtons(); render(); }
function setLayout(l) { currentLayout = l; applyLayoutButtons(); render(); }

// ---- Diagram ----
function renderDiagram() {
  const d = $('diagram'); d.innerHTML = '';
  const list = projectAgents();
  if (!activeProject()) { d.innerHTML = '<div class="empty"><p>Create a project to see its team diagram.</p></div>'; return; }
  if (!list.length) {
    d.innerHTML = '<div class="empty"><p>No team yet.</p></div>';
    const a = el('div', 'diag-actions');
    const b = el('button', 'icon-btn', '+ Add first worker');
    b.onclick = () => openWorker(null); a.appendChild(b); d.appendChild(a);
    return;
  }
  d.appendChild(el('div', 'dhint', 'Click a name to focus · use "Reports to" to connect/disconnect · ＋ adds a worker under that role'));

  const byRole = (r) => list.filter((a) => norm(a.reportsTo) === norm(r));
  const roots = list.filter((a) => !a.reportsTo || !list.some((b) => norm(b.role || b.name) === norm(a.reportsTo)));

  function nodeHtml(a) {
    const role = a.role || a.name;
    const children = byRole(role);
    const node = el('li');
    const box = el('div', 'node' + (isDirector(a) ? ' director' : ''));
    const title = el('div', 'nr', role); title.title = 'Click to focus'; title.onclick = () => focusAgent(a.id);
    box.append(title);
    const eng = a.engine === 'api' ? 'API:' + (a.apiModel || '?') : a.engine === 'openclaw' ? 'OC:' + (a.ocProvider ? a.ocProvider + '/' : '') + (a.ocModel || '?') : a.engine === 'codex' ? 'CODEX:' + (a.codexModel || 'default') : a.engine === 'hermes' ? 'HERMES:' + (a.hermesProvider ? a.hermesProvider + '/' : '') + (a.hermesModel || '?') : (a.ccModel ? '⇄' + a.ccModel : (MODELS.find((m) => m.v === a.model) || {}).label || 'Default');
    box.append(el('div', 'nn', '#' + a.num + ' · ' + eng));
    const t = a.totals || {};
    box.append(el('div', 'nt', '$' + (t.cost || 0).toFixed(3) + ' · ' + fmt((t.input || 0) + (t.output || 0)) + ' tok'));

    const tools = el('div', 'ntools');
    const chat = el('button', null, '💬'); chat.onclick = () => focusAgent(a.id);
    const edit = el('button', null, '✎'); edit.onclick = () => openWorker(a.id);
    const add = el('button', null, '＋'); add.onclick = () => openWorker(null, role);
    const del = el('button', null, '✕'); del.onclick = () => removeWorker(a.id);
    tools.append(chat, edit, add, del); box.append(tools);

    const rsel = el('select', 'rsel');
    rsel.appendChild(Object.assign(el('option', null, '↑ Top level (disconnect)'), { value: '' }));
    list.forEach((b) => { const lbl = b.role || b.name; if (lbl === role) return; const o = el('option', null, '↳ ' + lbl); o.value = lbl; if (norm(lbl) === norm(a.reportsTo)) o.selected = true; rsel.appendChild(o); });
    rsel.onchange = () => setReports(a.id, rsel.value);
    box.append(rsel);

    node.append(box);
    if (children.length) { const ul = el('ul'); children.forEach((ch) => ul.append(nodeHtml(ch))); node.append(ul); }
    return node;
  }
  const tree = el('div', 'tree'); const ul = el('ul');
  roots.forEach((r) => ul.append(nodeHtml(r))); tree.append(ul); d.append(tree);
  const acts = el('div', 'diag-actions');
  const b = el('button', 'icon-btn', '+ Add worker'); b.onclick = () => openWorker(null);
  acts.appendChild(b); d.appendChild(acts);
}

async function setReports(id, value) {
  await api('/api/agents/' + id + '/edit', 'POST', { reportsTo: value });
  await refresh();
  setView('diagram');
}

// ---- Activity feed (right panel) ----
function logEvent(agentId, type, detail) {
  const a = findAgent(agentId);
  const name = a ? (a.role || a.name) : agentId;
  const entry = { ts: Date.now(), agentId, agentName: name, type, detail };
  activityFeed.unshift(entry);
  missionLogEntries.push(entry);
  if (activityFeed.length > 200) activityFeed.pop();
  if (missionLogEntries.length > 1000) missionLogEntries.shift();
  renderActivity();
}

function renderActivity() {
  const body = $('activityBody');
  if (!body) return;
  const items = activityFeed.filter((e) => activityFilter === 'all' ? true : e.type === activityFilter);
  body.innerHTML = '';
  if (!items.length) {
    body.innerHTML = '<div class="activity-empty">The fire is warm.<br>Every hammer stroke will show here.</div>';
    return;
  }
  items.slice(0, 80).forEach((e) => {
    const row = el('div', 'activity-entry ' + e.type);
    const d = new Date(e.ts);
    const ts = el('span', 'ae-ts', d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const agent = el('span', 'ae-agent', e.agentName);
    agent.onclick = () => focusAgent(e.agentId);
    agent.style.cursor = 'pointer';
    const detail = el('span', 'ae-detail', e.detail);
    row.append(ts, agent, detail);
    body.appendChild(row);
  });
}

// ---- Mission Log (full view) ----
function renderMissionLog() {
  const wrap = $('missionLog');
  wrap.innerHTML = '';
  if (!missionLogEntries.length) {
    const b = el('div', 'empty');
    b.innerHTML = '<h2>The Ledger</h2><p>Every mark the Foundry makes will be recorded here. Send the first task to start the ledger.</p>';
    wrap.append(b);
    return;
  }
  wrap.appendChild(el('h2', null, 'The Ledger · ' + missionLogEntries.length + ' entries'));
  [...missionLogEntries].reverse().slice(0, 400).forEach((e) => {
    const row = el('div', 'log-row');
    const d = new Date(e.ts);
    row.append(el('span', 'lr-ts', d.toLocaleTimeString('en-US', { hour12: false })));
    row.append(el('span', 'lr-agent', e.agentName));
    row.append(el('span', 'lr-type ' + e.type, e.type));
    row.append(el('span', 'lr-detail', e.detail));
    wrap.appendChild(row);
  });
}

// ---- Save session ----
async function saveSession(id) {
  const c = cards.get(id);
  if (!c) return;
  const msgs = c.transcript.querySelectorAll('.msg, .dispatch');
  if (!msgs.length) { alert('No messages to save.'); return; }
  const meta = c.meta;
  const lines = [
    `# Session — ${meta.role || meta.name}`,
    `**Agent #${meta.num}** | Engine: ${meta.engine || 'claude-code'}`,
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    '',
  ];
  msgs.forEach((m) => {
    if (m.classList.contains('user')) lines.push('## You', m.textContent, '');
    else if (m.classList.contains('assistant')) lines.push('## Assistant', m.textContent, '');
    else if (m.classList.contains('tool')) lines.push('> ' + m.textContent, '');
    else if (m.classList.contains('err')) lines.push('**ERROR:** ' + m.textContent, '');
    else if (m.classList.contains('system')) lines.push('*' + m.textContent + '*', '');
    else if (m.classList.contains('dispatch')) lines.push('### Dispatch', m.textContent, '');
  });
  const t = meta.totals || {};
  lines.push('---', `Tokens in: ${fmt(t.input)} | out: ${fmt(t.output)} | cache: ${fmt(t.cache)} | turns: ${t.turns || 0} | cost: $${(t.cost || 0).toFixed(4)}`);
  const md = lines.join('\n');
  try {
    const r = await api('/api/agents/' + id + '/save', 'POST', { markdown: md });
    if (r.ok) addMsg(c, 'system', 'Session saved: ' + r.filename);
    else addMsg(c, 'err', 'Save failed: ' + (r.error || 'unknown'));
  } catch (e) { addMsg(c, 'err', 'Save error: ' + e.message); }
}

// ---- Broadcast ----
function broadcast() {
  const input = $('bcInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  projectAgents().forEach((a) => doSend(a.id, text));
}

// ---- Folder browser ----
let browseTargetInput = null;
let browseCurrentPath = '';
async function openBrowser(targetInputId, startPath) {
  browseTargetInput = targetInputId;
  openModal('browseModal');
  await browseTo(startPath || $(targetInputId).value || '');
}
async function browseTo(p) {
  try {
    const q = p ? '?path=' + encodeURIComponent(p) : '';
    const r = await fetch('/api/browse' + q);
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    browseCurrentPath = d.path || '';
    $('browseCurrent').value = browseCurrentPath || '(select a drive/root)';
    const list = $('browseList');
    list.innerHTML = '';
    if (!d.dirs || !d.dirs.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">(empty folder — you can still pick it)</div>';
      return;
    }
    d.dirs.forEach((entry) => {
      const row = el('div');
      row.style.cssText = 'padding:8px 12px;cursor:pointer;border-radius:6px;font-size:13px;display:flex;align-items:center;gap:8px;transition:background .1s';
      row.innerHTML = '<span style="color:var(--accent);font-size:14px">📁</span><span>' + esc(entry.name) + '</span>';
      row.onmouseenter = () => row.style.background = 'var(--panel2)';
      row.onmouseleave = () => row.style.background = 'transparent';
      row.onclick = () => browseTo(entry.path);
      list.appendChild(row);
    });
  } catch (e) { alert('Browse failed: ' + e.message); }
}
function pickCurrentFolder() {
  if (!browseCurrentPath) { alert('Navigate into a folder first.'); return; }
  if (browseTargetInput) $(browseTargetInput).value = browseCurrentPath;
  closeModals();
}

// ---- Modals ----
function openModal(id) { $(id).classList.add('open'); }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => m.classList.remove('open')); }

function openNewProject() {
  $('npName').value = '';
  $('npCwd').value = (S.projects[0] && S.projects[0].cwd) || '';
  const sel = $('npTemplate'); sel.innerHTML = '';
  sel.appendChild(Object.assign(el('option', null, 'Blank (no team)'), { value: '' }));
  S.templates.forEach((t) => { const o = el('option', null, t.name + ' (' + t.roles.length + ')'); o.value = t.name; sel.appendChild(o); });
  syncTemplateParamsVis();
  openModal('projModal');
}
function syncTemplateParamsVis() {
  const on = !!$('npTemplate').value;
  $('tplParamsWrap').style.display = on ? '' : 'none';
  $('tplGoalWrap').style.display = on ? '' : 'none';
}
async function createProject() {
  const hadTemplate = !!$('npTemplate').value;
  await api('/api/projects', 'POST', {
    name: $('npName').value.trim() || 'Untitled Project',
    cwd: $('npCwd').value.trim(),
    templateName: $('npTemplate').value,
    size: $('npSize').value,
    goal: $('npGoal').value,
  });
  closeModals();
  await refresh();
  if (hadTemplate) setView('diagram');
}

// Templates manager
function openTemplates() {
  const list = $('tplList'); list.innerHTML = '';
  S.templates.forEach((t) => {
    const row = el('div', 'tpl-row');
    row.append(el('span', 'tn', t.name));
    row.append(el('span', 'td', (t.roles || []).map((r) => r.role).join(', ')));
    const edit = el('button', 'icon-btn', 'Edit'); edit.onclick = () => openTemplateEditor(t);
    const del = el('button', 'icon-btn', 'Delete'); del.onclick = async () => { await api('/api/templates/' + encodeURIComponent(t.name), 'DELETE'); await refresh(); openTemplates(); };
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
  closeModals();
  openModal('tplEditModal');
}
function renderTemplateRoles() {
  const wrap = $('teRoles'); wrap.innerHTML = '';
  editingTemplate.roles.forEach((r, i) => {
    const box = el('div', 'role-edit');
    const top = el('div', 'top');
    const roleIn = el('input'); roleIn.placeholder = 'Role title'; roleIn.value = r.role || ''; roleIn.oninput = () => (r.role = roleIn.value);
    const reportsIn = el('input'); reportsIn.placeholder = 'Reports to (role, blank = top)'; reportsIn.value = r.reportsTo || ''; reportsIn.oninput = () => (r.reportsTo = reportsIn.value);
    const modelSel = el('select');
    MODELS.forEach((m) => { const o = el('option', null, m.label); o.value = m.v; if (m.v === (r.model || '')) o.selected = true; modelSel.appendChild(o); });
    modelSel.onchange = () => (r.model = modelSel.value);
    const del = el('button', 'icon-btn', '✕'); del.onclick = () => { editingTemplate.roles.splice(i, 1); renderTemplateRoles(); };
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

// ---- Usage modal ----
let usagePeriod = 'today';
async function openUsageModal() { openModal('usageModal'); await renderUsage(); }
async function renderUsage() {
  const r = await api('/api/usage');
  const all = r.usage || [];
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const startOfMonth = new Date(startOfDay); startOfMonth.setDate(1);
  let cutoff = 0;
  if (usagePeriod === 'today') cutoff = startOfDay.getTime();
  else if (usagePeriod === 'week') cutoff = startOfWeek.getTime();
  else if (usagePeriod === 'month') cutoff = startOfMonth.getTime();
  const filtered = all.filter((e) => e.ts >= cutoff);

  let totalInput = 0, totalOutput = 0, totalCache = 0, totalCost = 0, totalTurns = 0;
  const byAgent = {}, byDay = {};
  filtered.forEach((e) => {
    totalInput += e.input || 0; totalOutput += e.output || 0; totalCache += e.cache || 0;
    totalCost += e.cost || 0; totalTurns++;
    const key = e.agentRole || e.agentName || e.agentId;
    if (!byAgent[key]) byAgent[key] = { input: 0, output: 0, cache: 0, cost: 0, turns: 0, engine: e.engine };
    byAgent[key].input += e.input || 0; byAgent[key].output += e.output || 0;
    byAgent[key].cache += e.cache || 0; byAgent[key].cost += e.cost || 0; byAgent[key].turns++;
    const day = new Date(e.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!byDay[day]) byDay[day] = { input: 0, output: 0, cost: 0, turns: 0 };
    byDay[day].input += e.input || 0; byDay[day].output += e.output || 0;
    byDay[day].cost += e.cost || 0; byDay[day].turns++;
  });

  const planCost = filtered.filter((e) => e.engine === 'claude-code').reduce((s, e) => s + (e.cost || 0), 0);
  const apiCostVal = totalCost - planCost;
  $('usageSummary').innerHTML = '<div class="usage-summary">'
    + '<div class="us-card"><div class="us-val">' + fmt(totalInput + totalOutput) + '</div><div class="us-label">Tokens</div></div>'
    + '<div class="us-card"><div class="us-val">$' + totalCost.toFixed(2) + '</div><div class="us-label">Total Cost</div></div>'
    + '<div class="us-card"><div class="us-val" style="color:var(--accent2)">$' + planCost.toFixed(2) + '</div><div class="us-label">Plan Included</div></div>'
    + '<div class="us-card"><div class="us-val" style="color:var(--accent)">$' + apiCostVal.toFixed(2) + '</div><div class="us-label">API Billed</div></div>'
    + '<div class="us-card"><div class="us-val">' + totalTurns + '</div><div class="us-label">Turns</div></div>'
    + '</div>';

  let html = '<table class="usage-grid"><thead><tr><th>Agent</th><th>Engine</th><th>Turns</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead><tbody>';
  for (const [name, d] of Object.entries(byAgent).sort((a, b) => b[1].cost - a[1].cost)) {
    html += '<tr><td class="uname">' + esc(name) + '</td><td>' + esc(d.engine || '—') + '</td><td>' + d.turns + '</td><td>' + fmt(d.input) + '</td><td>' + fmt(d.output) + '</td><td>' + fmt(d.cache) + '</td><td>$' + d.cost.toFixed(4) + '</td></tr>';
  }
  html += '</tbody></table>';
  if (Object.keys(byDay).length > 1) {
    html += '<h4 style="margin:18px 0 8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.14em">Daily Breakdown</h4>';
    html += '<table class="usage-grid"><thead><tr><th>Day</th><th>Turns</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead><tbody>';
    for (const [day, d] of Object.entries(byDay).reverse()) {
      html += '<tr><td class="uname">' + day + '</td><td>' + d.turns + '</td><td>' + fmt(d.input) + '</td><td>' + fmt(d.output) + '</td><td>$' + d.cost.toFixed(4) + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  $('usageTable').innerHTML = html;
}

// ---- Account ----
let lastAccount = null;
async function fetchAccount() {
  const badge = $('accountBadge');
  const em = $('sAccount');
  const plan = $('sAccountPlan');
  try {
    const r = await api('/api/account');
    lastAccount = r;
    if (r.logged_in) {
      badge.classList.remove('err'); badge.classList.add('ok');
      em.textContent = r.email || 'logged in';
      plan.textContent = r.plan || '';
      badge.title = [r.email, r.org, r.plan].filter(Boolean).join('\n') + '\nClick to manage';
    } else {
      badge.classList.remove('ok'); badge.classList.add('err');
      em.textContent = 'not logged in';
      plan.textContent = '';
      badge.title = 'Click to log in';
    }
  } catch { badge.classList.add('err'); em.textContent = 'error'; plan.textContent = ''; }
}
async function openAccountModal() {
  $('accountModal').classList.add('open');
  await fetchAccount();
  const info = $('acctInfo');
  if (lastAccount && lastAccount.logged_in) {
    info.innerHTML = '<div style="display:flex;flex-direction:column;gap:4px">'
      + '<div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em">Logged in as</div>'
      + '<div style="font-size:16px;font-weight:700;color:var(--accent2)">' + esc(lastAccount.email || '—') + '</div>'
      + (lastAccount.org ? '<div style="font-size:12px;color:var(--muted)">Org: ' + esc(lastAccount.org) + '</div>' : '')
      + '<div style="font-size:12px;color:var(--muted)">Plan: ' + esc(lastAccount.plan || '—') + '</div>'
      + '</div>';
    $('acctLogout').style.display = '';
  } else {
    info.innerHTML = '<div style="color:var(--err)">Not logged in</div>';
    $('acctLogout').style.display = 'none';
  }
  loadBackups();
}
async function loadBackups() {
  const r = await api('/api/account/backups');
  const wrap = $('acctBackups');
  if (!r.backups || !r.backups.length) { wrap.innerHTML = '<div style="color:var(--muted);font-size:12px">No saved account backups yet</div>'; return; }
  wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.12em">Saved accounts (click to restore)</div>';
  r.backups.forEach((b) => {
    const row = el('div', 'tpl-row'); row.style.cursor = 'pointer';
    row.append(el('span', 'tn', b.email));
    row.append(el('span', 'td', b.date));
    const btn = el('button', 'icon-btn', 'Restore');
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Restore account ' + b.email + '? This will overwrite current credentials.')) return;
      btn.disabled = true; btn.textContent = 'Restoring…';
      const res = await api('/api/account/restore', 'POST', { file: b.file });
      if (res.ok) { await fetchAccount(); openAccountModal(); }
      else { btn.textContent = 'Failed'; setTimeout(() => { btn.textContent = 'Restore'; btn.disabled = false; }, 2000); }
    };
    row.appendChild(btn); wrap.appendChild(row);
  });
}

// ---- CMD+K palette ----
function buildCmdkItems(query) {
  const q = norm(query.replace(/^\//, ''));
  const items = [];
  // Actions
  items.push({ group: 'Forge', label: 'Start a new project', kbd: '', icon: '＋', run: () => { closeCmdk(); openNewProject(); } });
  items.push({ group: 'Forge', label: 'Hire a worker', kbd: '', icon: '＋', run: () => { closeCmdk(); openWorker(null); } });
  items.push({ group: 'Forge', label: 'Open Blueprints', kbd: '', icon: 'B', run: () => { closeCmdk(); openTemplates(); } });
  items.push({ group: 'Forge', label: 'The Ledger — usage & billing', kbd: '', icon: '$', run: () => { closeCmdk(); openUsageModal(); } });
  items.push({ group: 'Forge', label: 'Save this shift', kbd: '', icon: '💾', run: () => { closeCmdk(); if (focusedAgentId) saveSession(focusedAgentId); } });
  items.push({ group: 'Forge', label: 'Muster all workers', kbd: '', icon: '◉', run: () => { closeCmdk(); $('bcInput').focus(); } });
  items.push({ group: 'Views', label: 'The Floor — workers', kbd: '', icon: '□', run: () => { closeCmdk(); setView('chat'); } });
  items.push({ group: 'Views', label: 'The Grid — every worker at once', kbd: '', icon: '⊞', run: () => { closeCmdk(); setView('chat'); setLayout('grid'); } });
  items.push({ group: 'Views', label: 'The Focus — one worker fullscreen', kbd: '', icon: '◧', run: () => { closeCmdk(); setView('chat'); setLayout('focus'); } });
  items.push({ group: 'Views', label: 'The Ledger — full history', kbd: '', icon: '⋮', run: () => { closeCmdk(); setView('log'); } });
  items.push({ group: 'Views', label: 'The Chart — team diagram', kbd: '', icon: '⋔', run: () => { closeCmdk(); setView('diagram'); } });

  // Agents (focus)
  projectAgents().forEach((a) => {
    items.push({ group: 'Workers on the floor', label: (a.role || a.name) + '  #' + a.num, kbd: '', icon: roleInitials(a.role || a.name), run: () => { closeCmdk(); focusAgent(a.id); } });
  });

  // Projects (switch)
  S.projects.forEach((p) => {
    items.push({ group: 'Switch project', label: p.name, kbd: '', icon: 'P', run: async () => { closeCmdk(); await api('/api/projects/' + p.id + '/activate', 'POST'); refresh(); } });
  });

  if (!q) return items;
  return items.filter((it) => norm(it.label).includes(q) || norm(it.group).includes(q));
}

let cmdkSelected = 0;
function openCmdk(prefill) {
  $('cmdkOverlay').classList.add('open');
  const input = $('cmdkInput');
  input.value = prefill || '';
  cmdkSelected = 0;
  renderCmdk();
  setTimeout(() => input.focus(), 30);
}
function closeCmdk() { $('cmdkOverlay').classList.remove('open'); }
function renderCmdk() {
  const q = $('cmdkInput').value;
  const items = buildCmdkItems(q);
  if (cmdkSelected >= items.length) cmdkSelected = 0;
  const list = $('cmdkList'); list.innerHTML = '';
  let curGroup = null;
  items.forEach((it, i) => {
    if (it.group !== curGroup) {
      list.appendChild(el('div', 'cmdk-group', it.group));
      curGroup = it.group;
    }
    const row = el('div', 'cmdk-item' + (i === cmdkSelected ? ' on' : ''));
    const icon = el('div', 'cmi-icon', it.icon);
    row.append(icon);
    row.append(el('div', 'cmi-label', it.label));
    if (it.kbd) { const k = el('span', 'cmi-kbd', it.kbd); row.append(k); }
    row.onclick = () => it.run();
    list.append(row);
  });
  // scroll selected into view
  const on = list.querySelector('.cmdk-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}

// ---- Wire up ----
$('projSelect').onchange = async (e) => { if (e.target.value) { await api('/api/projects/' + e.target.value + '/activate', 'POST'); refresh(); } };
$('newProjBtn').onclick = openNewProject;
$('tplBtn').onclick = openTemplates;
$('usageBtn').onclick = openUsageModal;
$('cmdkTrigger').onclick = () => openCmdk('');
$('viewChat').onclick = () => setView('chat');
$('viewLog').onclick = () => setView('log');
$('viewDiagram').onclick = () => setView('diagram');
$('viewReel').onclick = () => setView('reel');
$('addWorkerBtn').onclick = () => openWorker(null);
$('saveTplBtn').onclick = saveProjectAsTemplate;
$('addFileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => addSharedFiles($('fileInput').files);
// Restore + persist budget across sessions
(function initBudget() {
  const saved = localStorage.getItem('foundry-budget');
  if (saved) $('budgetInput').value = saved;
})();
$('budgetInput').oninput = () => {
  const v = $('budgetInput').value;
  if (v) localStorage.setItem('foundry-budget', v);
  else localStorage.removeItem('foundry-budget');
  updateStats();
};
$('npTemplate').onchange = syncTemplateParamsVis;
$('npBrowse').onclick = () => openBrowser('npCwd', $('npCwd').value);
$('browseUp').onclick = async () => {
  try {
    const q = browseCurrentPath ? '?path=' + encodeURIComponent(browseCurrentPath) : '';
    const r = await fetch('/api/browse' + q);
    const d = await r.json();
    browseTo(d.parent || '');
  } catch {}
};
$('browsePick').onclick = pickCurrentFolder;
document.querySelectorAll('#layoutBar button').forEach((b) => { b.onclick = () => setLayout(b.dataset.layout); });
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
document.querySelectorAll('#usagePeriod button').forEach((b) => {
  b.onclick = () => {
    usagePeriod = b.dataset.period;
    document.querySelectorAll('#usagePeriod button').forEach((x) => x.classList.toggle('on', x === b));
    renderUsage();
  };
});
document.querySelectorAll('.activity-tab').forEach((b) => {
  b.onclick = () => {
    activityFilter = b.dataset.tab;
    document.querySelectorAll('.activity-tab').forEach((x) => x.classList.toggle('on', x === b));
    renderActivity();
  };
});
$('accountBadge').onclick = openAccountModal;
$('acctLogout').onclick = async () => {
  if (!confirm('Log out of ' + (lastAccount?.email || 'current account') + '?\nCredentials will be backed up automatically.')) return;
  $('acctLogout').disabled = true; $('acctLogout').textContent = 'Backing up & logging out...';
  const r = await api('/api/account/logout', 'POST');
  $('acctLogout').disabled = false; $('acctLogout').textContent = 'Log out & backup';
  if (r.ok) { await fetchAccount(); openAccountModal(); }
  else { alert('Logout failed: ' + (r.error || 'unknown')); }
};
$('acctLogin').onclick = async () => {
  $('acctLogin').disabled = true; $('acctLogin').textContent = 'Opening browser login...';
  const r = await api('/api/account/login', 'POST');
  $('acctLogin').disabled = false; $('acctLogin').textContent = 'Log in to new account';
  if (r.ok) { await fetchAccount(); openAccountModal(); }
  else { alert('Login may need manual browser auth. Check your browser.'); await fetchAccount(); openAccountModal(); }
};

// Global keyboard: Cmd+K, Esc
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(''); }
  if (e.key === 'Escape') { closeCmdk(); }
});
$('cmdkInput').addEventListener('input', () => { cmdkSelected = 0; renderCmdk(); });
$('cmdkInput').addEventListener('keydown', (e) => {
  const items = buildCmdkItems($('cmdkInput').value);
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSelected = Math.min(cmdkSelected + 1, items.length - 1); renderCmdk(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSelected = Math.max(cmdkSelected - 1, 0); renderCmdk(); }
  if (e.key === 'Enter') { e.preventDefault(); const it = items[cmdkSelected]; if (it) it.run(); }
});
$('cmdkOverlay').addEventListener('click', (e) => { if (e.target === $('cmdkOverlay')) closeCmdk(); });

// Refresh state on visibility change
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// Boot
refresh();
fetchAccount();
