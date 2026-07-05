// Mission Control v2 — projects, role-based agent "departments", templates,
// shared context files, org diagram, and Director dispatch.
// Zero dependencies. Node built-ins only.

const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MC_PORT || 4317;
const DEFAULT_CWD = process.env.MC_PROJECT_DIR || process.cwd();
const PERMISSION_MODE = process.env.MC_PERMISSION_MODE || 'bypassPermissions';

const DATA_FILE = path.join(__dirname, 'data.json');
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

// ---------- State ----------
let state = { projects: [], activeProjectId: null, nextNum: 1 };
let templates = [];
const agents = new Map(); // id -> agent (runtime + persisted)

function newTotals() { return { input: 0, output: 0, cache: 0, cost: 0, turns: 0 }; }

// ---------- Persistence ----------
function loadAll() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.projects = d.projects || [];
      state.activeProjectId = d.activeProjectId || null;
      state.nextNum = d.nextNum || 1;
      (d.agents || []).forEach((a) => {
        a.busy = false;
        a.totals = a.totals || newTotals();
        agents.set(a.id, a);
      });
    }
  } catch (e) { console.log('  (could not load data.json:', e.message, ')'); }

  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    }
  } catch (e) { console.log('  (could not load templates.json:', e.message, ')'); }

  ensureBuiltins();
  saveTemplates();
}

// Add any built-in template that isn't already present (by name). Won't clobber edits.
function ensureBuiltins() {
  for (const b of builtinTemplates()) {
    if (!templates.some((t) => t.name === b.name)) templates.push(b);
  }
}

function saveData() {
  const d = {
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    nextNum: state.nextNum,
    agents: [...agents.values()].map((a) => ({
      id: a.id, num: a.num, name: a.name, role: a.role, soul: a.soul,
      model: a.model, effort: a.effort, reportsTo: a.reportsTo, projectId: a.projectId,
      cwd: a.cwd, sessionId: a.sessionId, totals: a.totals, primedSoul: a.primedSoul,
      engine: a.engine, apiBaseUrl: a.apiBaseUrl, apiKey: a.apiKey, apiModel: a.apiModel,
      ccBaseUrl: a.ccBaseUrl, ccAuthToken: a.ccAuthToken, ccModel: a.ccModel, apiHistory: a.apiHistory || [],
    })),
  };
  try {
    // Keep a one-step backup before every write (accidental-delete safety net).
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  } catch (e) { console.log('save error', e.message); }
}
function saveTemplates() {
  try { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2)); } catch (e) { console.log('tpl save error', e.message); }
}

// ---------- Helpers ----------
function getProject(id) { return state.projects.find((p) => p.id === id); }
function projectAgents(pid) { return [...agents.values()].filter((a) => a.projectId === pid); }

function publicAgent(a) {
  return { id: a.id, num: a.num, name: a.name, role: a.role || '', soul: a.soul || '',
           model: a.model || '', effort: a.effort || '', reportsTo: a.reportsTo || '', projectId: a.projectId,
           cwd: a.cwd, busy: a.busy, hasSession: !!a.sessionId, totals: a.totals,
           engine: a.engine || 'claude-code',
           apiBaseUrl: a.apiBaseUrl || '', apiKey: a.apiKey || '', apiModel: a.apiModel || '',
           ccBaseUrl: a.ccBaseUrl || '', ccAuthToken: a.ccAuthToken || '', ccModel: a.ccModel || '' };
}
function publicState() {
  return {
    activeProjectId: state.activeProjectId,
    projects: state.projects,
    templates,
    agents: [...agents.values()].map(publicAgent),
  };
}

function buildPersona(agent, opts = {}) {
  const proj = getProject(agent.projectId);
  const team = proj ? projectAgents(proj.id).map((t) => t.role || t.name) : [];
  const files = proj ? (proj.contextFiles || []).map((f) => f.path) : [];
  const parts = [];
  parts.push(`You are "${agent.name}"${agent.role ? `, the ${agent.role}` : ''}.`);
  if (agent.soul) parts.push(agent.soul);
  if (proj) parts.push(`You are part of the project "${proj.name}". Team members: ${team.join(', ') || '(none yet)'}.`);
  if (files.length) {
    if (opts.withContents) {
      // API mode has no file tools — embed the contents directly.
      const blocks = files.map((f) => {
        let body = '';
        try { body = fs.readFileSync(f, 'utf8'); } catch { body = '(could not read this file)'; }
        if (body.length > 20000) body = body.slice(0, 20000) + '\n…(truncated)';
        return `=== FILE: ${path.basename(f)} ===\n${body}`;
      });
      parts.push('Shared project files (full contents below):\n\n' + blocks.join('\n\n'));
    } else {
      parts.push(`Shared project files on disk — read them first with your tools:\n${files.map((f) => '- ' + f).join('\n')}`);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---------- HTTP utils ----------
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function serveStatic(res, file) {
  const full = path.join(__dirname, 'public', file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
function send(res, obj) { res.write(JSON.stringify(obj) + '\n'); }

// ---------- File upload ----------
function saveUpload(cwd, filename, dataBase64) {
  const safe = path.basename(String(filename || 'file')).replace(/[^\w.\- ]+/g, '_') || 'file';
  const dir = path.join(cwd, 'mc-uploads');
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, safe);
  if (fs.existsSync(target)) {
    const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
    let n = 1;
    while (fs.existsSync(path.join(dir, `${base}-${n}${ext}`))) n++;
    target = path.join(dir, `${base}-${n}${ext}`);
  }
  const comma = dataBase64.indexOf(',');
  const b64 = comma >= 0 ? dataBase64.slice(comma + 1) : dataBase64;
  fs.writeFileSync(target, Buffer.from(b64, 'base64'));
  return { name: safe, path: target };
}

// ---------- Agent creation ----------
function createAgent(o) {
  const id = randomUUID().slice(0, 8);
  const num = state.nextNum++;
  const agent = {
    id, num, name: o.name || o.role || `Agent #${num}`, role: o.role || '', soul: o.soul || '',
    model: o.model || '', reportsTo: o.reportsTo || '', projectId: o.projectId,
    cwd: o.cwd || (getProject(o.projectId) || {}).cwd || DEFAULT_CWD,
    // Engine: 'claude-code' (full tools) or 'api' (direct OpenAI-compatible, chat only)
    engine: o.engine || 'claude-code', effort: o.effort || '',
    apiBaseUrl: o.apiBaseUrl || '', apiKey: o.apiKey || '', apiModel: o.apiModel || '',
    ccBaseUrl: o.ccBaseUrl || '', ccAuthToken: o.ccAuthToken || '', ccModel: o.ccModel || '',
    sessionId: null, busy: false, totals: newTotals(), primedSoul: false, pendingContext: null,
    apiHistory: [],
  };
  agents.set(id, agent);
  return agent;
}

// ---------- Run a turn ----------
// Abort a running turn (Claude Code child process or in-flight API request).
function stopAgent(agent) {
  agent.stopped = true;
  if (agent.child) {
    const pid = agent.child.pid;
    // shell:true spawns cmd -> claude.cmd -> node. Kill the WHOLE tree by pid
    // while it's still intact (do NOT child.kill() first — that orphans node).
    if (pid && process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F']); } catch {}
    } else {
      try { agent.child.kill('SIGKILL'); } catch {}
    }
  }
  if (agent.apiAbort) { try { agent.apiAbort.abort(); } catch {} }
}

function runTurn(agent, text, res) {
  if (agent.engine === 'api') return runApiTurn(agent, text, res);

  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  // Persona priming happens through stdin (no shell-quoting headaches).
  let toSend = text;
  if (!agent.primedSoul) {
    const persona = buildPersona(agent);
    if (persona) toSend = persona + '\n\n=== YOUR TASK ===\n' + text;
    agent.primedSoul = true;
  } else if (agent.pendingContext) {
    toSend = agent.pendingContext + '\n\n' + text;
  }
  agent.pendingContext = null;

  const model = agent.ccModel || agent.model;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION_MODE];
  if (model) args.push('--model', model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.sessionId) args.push('--resume', agent.sessionId);

  // Optional proxy: run Claude Code (with all its tools) on a non-Anthropic model.
  const env = { ...process.env };
  if (agent.ccBaseUrl) env.ANTHROPIC_BASE_URL = agent.ccBaseUrl;
  if (agent.ccAuthToken) { env.ANTHROPIC_AUTH_TOKEN = agent.ccAuthToken; env.ANTHROPIC_API_KEY = agent.ccAuthToken; }

  let child;
  try { child = spawn('claude', args, { cwd: agent.cwd, shell: true, env }); }
  catch (e) { send(res, { type: 'error', error: String(e) }); agent.busy = false; return res.end(); }

  agent.child = child;
  agent.stopped = false;
  child.stdin.write(toSend);
  child.stdin.end();

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      handleEvent(agent, evt, res);
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));

  child.on('close', (code) => {
    if (buf.trim()) { try { handleEvent(agent, JSON.parse(buf.trim()), res); } catch {} }
    agent.child = null;
    if (agent.stopped) { send(res, { type: 'system', stopped: true }); agent.stopped = false; }
    else if (code) send(res, { type: 'error', error: stderr.trim() || `claude exited with code ${code}` });
    agent.busy = false;
    saveData();
    send(res, { type: 'done' });
    res.end();
  });

  child.on('error', (err) => {
    send(res, { type: 'error', error: 'Failed to start claude: ' + err.message });
    agent.busy = false;
    res.end();
  });
}

function handleEvent(agent, evt, res) {
  if (evt.session_id) agent.sessionId = evt.session_id;
  if (evt.type === 'system' && evt.subtype === 'init') {
    send(res, { type: 'system', model: evt.model, session: evt.session_id });
  } else if (evt.type === 'assistant' && evt.message) {
    for (const block of evt.message.content || []) {
      if (block.type === 'text' && block.text) send(res, { type: 'text', text: block.text });
      else if (block.type === 'tool_use') send(res, { type: 'tool', name: block.name, input: block.input });
    }
  } else if (evt.type === 'result') {
    const u = evt.usage || {};
    agent.totals.input += u.input_tokens || 0;
    agent.totals.output += u.output_tokens || 0;
    agent.totals.cache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    agent.totals.cost += evt.total_cost_usd || 0;
    agent.totals.turns += 1;
    send(res, { type: 'result', subtype: evt.subtype, cost: evt.total_cost_usd, duration: evt.duration_ms, totals: agent.totals });
  }
}

// ---------- Direct API turn (OpenAI-compatible, chat only, no tools) ----------
async function runApiTurn(agent, text, res) {
  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  const base = (agent.apiBaseUrl || '').replace(/\/+$/, '');
  if (!base || !agent.apiModel) {
    send(res, { type: 'error', error: 'Direct API agent needs a Base URL and Model (open ✎ Edit to set them).' });
    agent.busy = false; send(res, { type: 'done' }); return res.end();
  }

  if (!agent.apiHistory) agent.apiHistory = [];
  const messages = [{ role: 'system', content: buildPersona(agent, { withContents: true }) }];
  for (const h of agent.apiHistory) messages.push(h);
  messages.push({ role: 'user', content: text });

  agent.apiAbort = new AbortController();
  agent.stopped = false;
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (agent.apiKey || '') },
      body: JSON.stringify({ model: agent.apiModel, messages, temperature: 0.7 }),
      signal: agent.apiAbort.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && (data.error.message || data.error)) || ('HTTP ' + r.status);
      send(res, { type: 'error', error: 'API error: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)) });
    } else {
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '(no content returned)';
      agent.apiHistory.push({ role: 'user', content: text });
      agent.apiHistory.push({ role: 'assistant', content });
      send(res, { type: 'text', text: content });
      const u = data.usage || {};
      agent.totals.input += u.prompt_tokens || 0;
      agent.totals.output += u.completion_tokens || 0;
      agent.totals.turns += 1;
      agent.hasSession = true;
      agent.sessionId = agent.sessionId || ('api-' + agent.id);
      send(res, { type: 'result', subtype: 'success', cost: 0, totals: agent.totals });
    }
  } catch (e) {
    if (agent.stopped || e.name === 'AbortError') send(res, { type: 'system', stopped: true });
    else send(res, { type: 'error', error: 'API request failed: ' + e.message });
  }
  agent.apiAbort = null;
  agent.stopped = false;
  agent.busy = false;
  saveData();
  send(res, { type: 'done' });
  res.end();
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (pathname === '/') return serveStatic(res, 'index.html');
  if (pathname === '/app.js') return serveStatic(res, 'app.js');

  if (pathname === '/api/state' && method === 'GET') return json(res, 200, publicState());

  // ----- Projects -----
  if (pathname === '/api/projects' && method === 'POST') {
    const b = await readBody(req);
    const id = randomUUID().slice(0, 8);
    const proj = { id, name: b.name || 'Untitled Project', cwd: (b.cwd && b.cwd.trim()) || DEFAULT_CWD, contextFiles: [] };
    state.projects.push(proj);
    state.activeProjectId = id;
    // Instantiate a template's roles, if requested.
    const tpl = templates.find((t) => t.name === b.templateName);
    if (tpl) for (const r of tpl.roles) createAgent({ projectId: id, name: r.role, role: r.role, soul: r.soul, model: r.model, reportsTo: r.reportsTo });
    saveData();
    return json(res, 200, publicState());
  }

  let m;
  if ((m = pathname.match(/^\/api\/projects\/([^/]+)(\/activate|\/files)?$/))) {
    const proj = getProject(m[1]);
    if (method === 'DELETE') {
      projectAgents(m[1]).forEach((a) => agents.delete(a.id));
      state.projects = state.projects.filter((p) => p.id !== m[1]);
      if (state.activeProjectId === m[1]) state.activeProjectId = state.projects[0] ? state.projects[0].id : null;
      saveData();
      return json(res, 200, publicState());
    }
    if (!proj) return json(res, 404, { error: 'no such project' });
    if (m[2] === '/activate' && method === 'POST') { state.activeProjectId = proj.id; saveData(); return json(res, 200, publicState()); }
    if (m[2] === '/files' && method === 'POST') {
      const b = await readBody(req);
      if (b.removePath) {
        proj.contextFiles = (proj.contextFiles || []).filter((f) => f.path !== b.removePath);
      } else {
        const saved = saveUpload(proj.cwd, b.filename, b.dataBase64 || '');
        proj.contextFiles = proj.contextFiles || [];
        proj.contextFiles.push(saved);
        projectAgents(proj.id).forEach((a) => { a.pendingContext = `[New shared project file added: ${saved.path}. Read it with your tools when relevant.]`; });
      }
      saveData();
      return json(res, 200, publicState());
    }
  }

  // ----- Workers (agents) -----
  if (pathname === '/api/agents' && method === 'POST') {
    const b = await readBody(req);
    if (!getProject(b.projectId)) return json(res, 400, { error: 'projectId required' });
    createAgent(b);
    saveData();
    return json(res, 200, publicState());
  }
  if ((m = pathname.match(/^\/api\/agents\/([^/]+)(\/message|\/model|\/upload|\/edit|\/stop)?$/))) {
    const agent = agents.get(m[1]);
    if (method === 'DELETE') { agents.delete(m[1]); saveData(); return json(res, 200, publicState()); }
    if (!agent) return json(res, 404, { error: 'no such agent' });

    if (m[2] === '/stop' && method === 'POST') { stopAgent(agent); return json(res, 200, { ok: true }); }
    if (m[2] === '/message' && method === 'POST') {
      const b = await readBody(req);
      const text = (b.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      return runTurn(agent, text, res);
    }
    if (m[2] === '/model' && method === 'POST') { const b = await readBody(req); agent.model = b.model || ''; saveData(); return json(res, 200, publicAgent(agent)); }
    if (m[2] === '/edit' && method === 'POST') {
      const b = await readBody(req);
      if (b.name != null) agent.name = b.name;
      if (b.role != null) agent.role = b.role;
      if (b.reportsTo != null) agent.reportsTo = b.reportsTo;
      if (b.soul != null && b.soul !== agent.soul) { agent.soul = b.soul; agent.primedSoul = false; }
      if (b.effort != null) agent.effort = b.effort;
      if (b.engine != null) agent.engine = b.engine;
      if (b.apiBaseUrl != null) agent.apiBaseUrl = b.apiBaseUrl;
      if (b.apiKey != null) agent.apiKey = b.apiKey;
      if (b.apiModel != null) agent.apiModel = b.apiModel;
      if (b.ccBaseUrl != null) agent.ccBaseUrl = b.ccBaseUrl;
      if (b.ccAuthToken != null) agent.ccAuthToken = b.ccAuthToken;
      if (b.ccModel != null) agent.ccModel = b.ccModel;
      saveData();
      return json(res, 200, publicAgent(agent));
    }
    if (m[2] === '/upload' && method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, saveUpload(agent.cwd, b.filename, b.dataBase64 || '')); }
      catch (e) { return json(res, 500, { error: String(e) }); }
    }
  }

  // ----- Templates -----
  if (pathname === '/api/templates' && method === 'POST') {
    const b = await readBody(req);
    if (!b.name) return json(res, 400, { error: 'name required' });
    const idx = templates.findIndex((t) => t.name === b.name);
    const tpl = { name: b.name, description: b.description || '', roles: b.roles || [] };
    if (idx >= 0) templates[idx] = tpl; else templates.push(tpl);
    saveTemplates();
    return json(res, 200, { templates });
  }
  if ((m = pathname.match(/^\/api\/templates\/(.+)$/)) && method === 'DELETE') {
    templates = templates.filter((t) => t.name !== decodeURIComponent(m[1]));
    saveTemplates();
    return json(res, 200, { templates });
  }
  // Save a project's current team as a new template.
  if ((m = pathname.match(/^\/api\/save-template-from-project\/([^/]+)$/)) && method === 'POST') {
    const b = await readBody(req);
    const proj = getProject(m[1]);
    if (!proj) return json(res, 404, { error: 'no such project' });
    const roles = projectAgents(proj.id).map((a) => ({ role: a.role || a.name, soul: a.soul, model: a.model, reportsTo: a.reportsTo }));
    const name = b.name || (proj.name + ' Team');
    const idx = templates.findIndex((t) => t.name === name);
    const tpl = { name, description: b.description || `Saved from project "${proj.name}"`, roles };
    if (idx >= 0) templates[idx] = tpl; else templates.push(tpl);
    saveTemplates();
    return json(res, 200, { templates });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  ERROR: Port ${PORT} is already in use.`);
    console.log(`  Mission Control may already be running — open http://localhost:${PORT}`);
    console.log(`  or set a different port: set MC_PORT=4400 and run again.\n`);
  } else { console.log('\n  Server error:', err.message, '\n'); }
  process.exitCode = 1;
});

loadAll();
server.listen(PORT, () => {
  console.log(`\n  Mission Control v2  ->  http://localhost:${PORT}`);
  console.log(`  Default project dir: ${DEFAULT_CWD}`);
  console.log(`  Permission mode: ${PERMISSION_MODE}`);
  console.log(`  Projects: ${state.projects.length} · Templates: ${templates.length}`);
  console.log(`\n  Open the URL above in your browser. Ctrl+C to stop.\n`);
});

// ---------- Built-in templates ----------
function builtinTemplates() {
  const director = `You are the Marketing Director of a high-performing ecommerce growth team for the store "99 Jerseys" (football/soccer jerseys).
You own outcomes: conversion rate, average order value, and revenue from upsells and landing pages. You think in offers, funnels, and customer psychology.

Your job: read the brief and the shared project files, form a sharp strategy, then break the work into clear assignments for your team.

CRITICAL — always finish your message with an "ASSIGNMENTS" section. Put each assignment on its own line in EXACTLY this format:
@RoleName: the specific, action-oriented task
RoleName must be one of: Researcher, Copywriter, UI/UX Designer, Frontend Developer.
Only assign what is needed right now. If nothing needs assigning, write: @none: waiting on input.
Keep strategy tight and decision-driven. No fluff.`;

  const researcher = `You are a senior ecommerce and market researcher for "99 Jerseys".
You investigate competitors, audience psychology, pricing, objections, and proven upsell/cross-sell patterns.
Always read the shared project files first. Deliver concrete, actionable findings as tight bullet insights the team can use immediately — not essays. Cite sources where possible. Flag the biggest risks and opportunities explicitly.`;

  const copywriter = `You are a direct-response copywriter for "99 Jerseys" (football/soccer jerseys).
You write punchy, high-converting copy: headlines, subheads, bullets, CTAs, urgency, and social-proof framing, in a voice that excites passionate sports fans.
Always provide multiple labeled variants (A/B/C). Tie copy to a clear offer and handle the top objections. Read the shared files for product and brand context first.`;

  const uiux = `You are a conversion-focused UI/UX designer for ecommerce upsell and landing pages.
You think in layout, visual hierarchy, trust signals, mobile-first design, and friction reduction.
Provide concrete specs the Frontend Developer can implement directly: section order, components, spacing, color/contrast intent, and annotated layout descriptions. Critique existing pages ruthlessly but constructively. Read the shared files first.`;

  const frontend = `You are a senior frontend developer.
You build clean, fast, responsive ecommerce pages in vanilla HTML/CSS/JS (no build step unless the project already uses one).
You implement the UI/UX Designer's specs and the Copywriter's copy faithfully, writing production-quality, accessible, mobile-first code. You operate on files in the project directory using your tools, and explain key decisions briefly. Read the shared files first.`;

  const marketing = {
    name: 'Marketing Department',
    description: 'A full ecommerce growth team: Director, Researcher, Copywriter, UI/UX Designer, Frontend Developer.',
    roles: [
      { role: 'Marketing Director', soul: director, model: '', reportsTo: '' },
      { role: 'Researcher', soul: researcher, model: '', reportsTo: 'Marketing Director' },
      { role: 'Copywriter', soul: copywriter, model: '', reportsTo: 'Marketing Director' },
      { role: 'UI/UX Designer', soul: uiux, model: '', reportsTo: 'Marketing Director' },
      { role: 'Frontend Developer', soul: frontend, model: '', reportsTo: 'UI/UX Designer' },
    ],
  };

  // ----- Google Play app development team -----
  const pm = `You are the Product Manager and team lead for a mobile app being shipped to the Google Play Store.
You own the product: scope, roadmap, priorities, and release readiness. You think in user value, MVP cuts, and Play Store policy compliance.
Read the brief and shared files, set a tight plan, and break work into assignments for your team.

CRITICAL — always finish your message with an "ASSIGNMENTS" section. Each assignment on its own line, EXACTLY:
@RoleName: the specific task
RoleName must be one of: UI/UX Designer, Android Developer, Backend Developer, QA Engineer, ASO Specialist.
Only assign what is needed now. If nothing to assign, write: @none: waiting on input. Be decisive, no fluff.`;

  const appDesigner = `You are a mobile UI/UX designer specializing in Android (Material Design 3).
You design clean, accessible, thumb-friendly flows. You deliver concrete specs the Android Developer can build directly: screen list, navigation, component choices, states (empty/loading/error), spacing, and color/typography intent. You think mobile-first and respect platform conventions. Read the shared files first.`;

  const androidDev = `You are a senior Android developer (Kotlin, Jetpack Compose).
You build clean, performant, production-quality app code from the designer's specs and the PM's scope. You handle navigation, state, lifecycle, permissions, and Play Store build requirements (target SDK, signing, app bundle). You operate on files in the project directory using your tools, and explain key decisions briefly. Read the shared files first.`;

  const backendDev = `You are a backend developer for a mobile app.
You design and build the APIs, data models, and auth the app needs — pragmatic, secure, and well-documented. You think in endpoints, payloads, error handling, and scalability for a consumer app. You operate on files using your tools and explain the contract the Android Developer should code against. Read the shared files first.`;

  const qa = `You are a QA engineer for Android apps.
You write test plans and find bugs before users do: functional, edge cases, offline behavior, different screen sizes/API levels, and Play Store pre-launch concerns. You give clear, reproducible reports (steps, expected, actual, severity) and verify fixes. Read the shared files first.`;

  const aso = `You are an ASO (App Store Optimization) and growth specialist for Google Play.
You optimize title, short/long description, keywords, screenshots, and listing experiments to maximize installs and conversion. You know Play Store ranking factors, ratings/reviews strategy, and policy limits. Deliver concrete, copy-ready listing assets and experiment ideas. Read the shared files first.`;

  const googlePlay = {
    name: 'Google Play App Team',
    description: 'A mobile app team shipping to Google Play: Product Manager, UI/UX Designer, Android Developer, Backend Developer, QA Engineer, ASO Specialist.',
    roles: [
      { role: 'Product Manager', soul: pm, model: '', reportsTo: '' },
      { role: 'UI/UX Designer', soul: appDesigner, model: '', reportsTo: 'Product Manager' },
      { role: 'Android Developer', soul: androidDev, model: '', reportsTo: 'Product Manager' },
      { role: 'Backend Developer', soul: backendDev, model: '', reportsTo: 'Product Manager' },
      { role: 'QA Engineer', soul: qa, model: '', reportsTo: 'Android Developer' },
      { role: 'ASO Specialist', soul: aso, model: '', reportsTo: 'Product Manager' },
    ],
  };

  return [marketing, googlePlay];
}