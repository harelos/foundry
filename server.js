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
// Each Vault account gets its own isolated Claude config dir here (Multi-Claude model).
const ACCOUNTS_BASE = path.join(process.env.USERPROFILE || process.env.HOME || __dirname, '.foundry-accounts');

// The Reel — mini-app router
const reel = require('./reel');

// ---------- State ----------
let state = { projects: [], activeProjectId: null, nextNum: 1, accounts: [] };
let templates = [];
const agents = new Map(); // id -> agent (runtime + persisted)

function newTotals() { return { input: 0, output: 0, cache: 0, cost: 0, turns: 0, history: [] }; }
// Autonomous loop state: the agent keeps running turn-after-turn until a cap is hit or the user stops it.
function newLoop() { return { active: false, prompt: '', startedAt: 0, maxMs: 0, maxIterations: 0, maxCostUsd: 0, iterations: 0, startCost: 0, reason: '' }; }
function agentCost(agent) {
  const h = (agent.totals && agent.totals.history) || [];
  return h.reduce((s, e) => s + (e.cost || 0), 0);
}
// Decide whether a looping agent should run another turn. Increments the iteration count
// for the turn that just finished, then checks all four stop conditions.
function loopTick(agent) {
  const lp = agent.loop;
  if (!lp || !lp.active) return { continue: false, reason: 'not looping' };
  lp.iterations += 1;
  if (lp.maxIterations && lp.iterations >= lp.maxIterations) { lp.active = false; lp.reason = `iteration cap (${lp.maxIterations})`; }
  else if (lp.maxMs && (Date.now() - lp.startedAt) >= lp.maxMs) { lp.active = false; lp.reason = 'time limit'; }
  else if (lp.maxCostUsd && (agentCost(agent) - lp.startCost) >= lp.maxCostUsd) { lp.active = false; lp.reason = `budget ($${lp.maxCostUsd})`; }
  return lp.active ? { continue: true, prompt: lp.prompt } : { continue: false, reason: lp.reason };
}

// ---------- Persistence ----------
function loadAll() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.projects = d.projects || [];
      state.activeProjectId = d.activeProjectId || null;
      state.nextNum = d.nextNum || 1;
      state.accounts = d.accounts || [];
      (d.agents || []).forEach((a) => {
        a.busy = false;
        a.totals = a.totals || newTotals();
        if (!a.totals.history) a.totals.history = a.totalsHistory || [];
        delete a.totalsHistory;
        // Backward-compat + never resume a loop across a restart.
        a.loop = a.loop || newLoop();
        a.loop.active = false;
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
    accounts: state.accounts,
    agents: [...agents.values()].map((a) => ({
      id: a.id, num: a.num, name: a.name, role: a.role, soul: a.soul,
      model: a.model, effort: a.effort, reportsTo: a.reportsTo, projectId: a.projectId,
      cwd: a.cwd, sessionId: a.sessionId, totals: a.totals, primedSoul: a.primedSoul,
      accountId: a.accountId,
      engine: a.engine, apiBaseUrl: a.apiBaseUrl, apiKey: a.apiKey, apiModel: a.apiModel,
      ccBaseUrl: a.ccBaseUrl, ccAuthToken: a.ccAuthToken, ccModel: a.ccModel, ccOauthToken: a.ccOauthToken,
      ocModel: a.ocModel, ocApiKey: a.ocApiKey, ocProvider: a.ocProvider,
      codexModel: a.codexModel, codexApiKey: a.codexApiKey,
      hermesProvider: a.hermesProvider, hermesModel: a.hermesModel, hermesApiKey: a.hermesApiKey,
      loop: a.loop, apiHistory: a.apiHistory || [],
      totalsHistory: (a.totals && a.totals.history) || [],
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
function accountById(id) { return (state.accounts || []).find((a) => a.id === id); }
function projectAgents(pid) { return [...agents.values()].filter((a) => a.projectId === pid); }

function publicAgent(a) {
  return { id: a.id, num: a.num, name: a.name, role: a.role || '', soul: a.soul || '',
           model: a.model || '', effort: a.effort || '', reportsTo: a.reportsTo || '', projectId: a.projectId,
           cwd: a.cwd, busy: a.busy, hasSession: !!a.sessionId, totals: a.totals,
           accountId: a.accountId || '',
           engine: a.engine || 'claude-code',
           apiBaseUrl: a.apiBaseUrl || '', apiKey: a.apiKey || '', apiModel: a.apiModel || '',
           ccBaseUrl: a.ccBaseUrl || '', ccAuthToken: a.ccAuthToken || '', ccModel: a.ccModel || '', ccOauthToken: a.ccOauthToken || '',
           ocModel: a.ocModel || '', ocApiKey: a.ocApiKey || '', ocProvider: a.ocProvider || '',
           codexModel: a.codexModel || '', codexApiKey: a.codexApiKey || '',
           hermesProvider: a.hermesProvider || '', hermesModel: a.hermesModel || '', hermesApiKey: a.hermesApiKey || '',
           loop: a.loop || newLoop() };
}
function publicState() {
  return {
    activeProjectId: state.activeProjectId,
    projects: state.projects,
    templates,
    accounts: state.accounts,
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
    accountId: o.accountId || '',
    // Engine: 'claude-code' (full tools) or 'api' (direct OpenAI-compatible, chat only)
    engine: o.engine || 'claude-code', effort: o.effort || '',
    apiBaseUrl: o.apiBaseUrl || '', apiKey: o.apiKey || '', apiModel: o.apiModel || '',
    ccBaseUrl: o.ccBaseUrl || '', ccAuthToken: o.ccAuthToken || '', ccModel: o.ccModel || '', ccOauthToken: o.ccOauthToken || '',
    ocModel: o.ocModel || '', ocApiKey: o.ocApiKey || '', ocProvider: o.ocProvider || '',
    codexModel: o.codexModel || '', codexApiKey: o.codexApiKey || '',
    hermesProvider: o.hermesProvider || '', hermesModel: o.hermesModel || '', hermesApiKey: o.hermesApiKey || '',
    loop: newLoop(),
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
  if (agent.engine === 'openclaw') return runOpenClawTurn(agent, text, res);
  if (agent.engine === 'codex') return runCodexTurn(agent, text, res);
  if (agent.engine === 'hermes') return runHermesTurn(agent, text, res);

  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  // Per-agent Claude account (resolved once). Preferred: a Vault account with its own
  // isolated config dir (Multi-Claude model). Fallbacks: a raw OAuth token, then the
  // machine login. Proxy settings still win if configured.
  const acct = agent.accountId ? accountById(agent.accountId) : null;
  const oauthToken = (acct && acct.provider === 'claude' && acct.token) ? acct.token : agent.ccOauthToken;

  const env = { ...process.env };
  if (agent.ccBaseUrl) env.ANTHROPIC_BASE_URL = agent.ccBaseUrl;
  if (agent.ccAuthToken) { env.ANTHROPIC_AUTH_TOKEN = agent.ccAuthToken; env.ANTHROPIC_API_KEY = agent.ccAuthToken; }
  else if (acct && acct.configDir) {
    // Isolated login (Multi-Claude model): this worker reads its own credentials
    // from the account's dedicated config dir, leaving the machine's main login
    // untouched — so two Max accounts can run in parallel.
    env.CLAUDE_CONFIG_DIR = acct.configDir;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  else if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;   // clear inherited key so the token wins
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  const model = agent.ccModel || agent.model;

  const launch = (isRetry) => {
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

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION_MODE];
    if (model) args.push('--model', model);
    if (agent.effort) args.push('--effort', agent.effort);
    const resuming = !!agent.sessionId;
    if (resuming) args.push('--resume', agent.sessionId);

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
      else if (code) {
        const errText = stderr.trim() || `claude exited with code ${code}`;
        // A resume against a session that doesn't exist in THIS account's profile
        // (e.g. the worker's account was just switched) — drop it and start fresh once.
        if (resuming && !isRetry && /no conversation found|session id|session not found/i.test(errText)) {
          agent.sessionId = null;
          agent.primedSoul = false;
          return launch(true);
        }
        send(res, { type: 'error', error: errText });
      }
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
  };

  launch(false);
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
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cac = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const cost = evt.total_cost_usd || 0;
    agent.totals.input += inp;
    agent.totals.output += out;
    agent.totals.cache += cac;
    agent.totals.cost += cost;
    agent.totals.turns += 1;
    if (!agent.totals.history) agent.totals.history = [];
    agent.totals.history.push({ ts: Date.now(), input: inp, output: out, cache: cac, cost, engine: agent.engine || 'claude-code' });
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
      const inp = u.prompt_tokens || 0;
      const out = u.completion_tokens || 0;
      agent.totals.input += inp;
      agent.totals.output += out;
      agent.totals.turns += 1;
      if (!agent.totals.history) agent.totals.history = [];
      agent.totals.history.push({ ts: Date.now(), input: inp, output: out, cache: 0, cost: 0, engine: 'api' });
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

// ---------- OpenClaw turn (full autonomy, any model) ----------
async function runOpenClawTurn(agent, text, res) {
  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  const provider = (agent.ocProvider || '').trim();
  const model = (agent.ocModel || '').trim();
  if (!provider || !model) {
    send(res, { type: 'error', error: 'OpenClaw agent needs a Provider and Model (open ✎ Edit to set them).' });
    agent.busy = false; send(res, { type: 'done' }); return res.end();
  }

  const fullModel = provider + '/' + model;

  let toSend = text;
  if (!agent.primedSoul) {
    const persona = buildPersona(agent, { withContents: true });
    if (persona) toSend = persona + '\n\n=== YOUR TASK ===\n' + text;
    agent.primedSoul = true;
  }

  const env = { ...process.env };
  const apiKey = (agent.ocApiKey || '').trim();
  if (apiKey) {
    const envName = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
    env[envName] = apiKey;
    if (provider === 'openai') env.OPENAI_API_KEY = apiKey;
    else if (provider === 'anthropic') env.ANTHROPIC_API_KEY = apiKey;
    else if (provider === 'deepseek') env.DEEPSEEK_API_KEY = apiKey;
    else if (provider === 'google' || provider === 'gemini') { env.GOOGLE_API_KEY = apiKey; env.GEMINI_API_KEY = apiKey; }
    else if (provider === 'mistral') env.MISTRAL_API_KEY = apiKey;
  }

  const args = ['agent', '--local', '--message', toSend, '--model', fullModel, '--json'];

  let child;
  try { child = spawn('openclaw', args, { cwd: agent.cwd, shell: true, env }); }
  catch (e) { send(res, { type: 'error', error: 'Failed to start openclaw: ' + String(e) }); agent.busy = false; send(res, { type: 'done' }); return res.end(); }

  agent.child = child;
  agent.stopped = false;

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch {
        send(res, { type: 'text', text: line });
        continue;
      }
      if (evt.type === 'text' || evt.content) {
        send(res, { type: 'text', text: evt.content || evt.text || '' });
      } else if (evt.type === 'tool_call' || evt.tool) {
        send(res, { type: 'tool', name: evt.tool || evt.name || 'tool', input: evt.input || evt.args || {} });
      } else if (evt.type === 'error') {
        send(res, { type: 'error', error: evt.message || evt.error || JSON.stringify(evt) });
      } else {
        send(res, { type: 'text', text: JSON.stringify(evt) });
      }
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));

  child.on('close', (code) => {
    if (buf.trim()) {
      try {
        const evt = JSON.parse(buf.trim());
        if (evt.content || evt.text) send(res, { type: 'text', text: evt.content || evt.text });
        else send(res, { type: 'text', text: JSON.stringify(evt) });
      } catch { if (buf.trim()) send(res, { type: 'text', text: buf.trim() }); }
    }
    agent.child = null;
    if (agent.stopped) { send(res, { type: 'system', stopped: true }); agent.stopped = false; }
    else if (code && code !== 0) send(res, { type: 'error', error: stderr.trim() || `openclaw exited with code ${code}` });
    agent.totals.turns += 1;
    if (!agent.totals.history) agent.totals.history = [];
    agent.totals.history.push({ ts: Date.now(), input: 0, output: 0, cache: 0, cost: 0, engine: 'openclaw' });
    agent.busy = false;
    agent.sessionId = agent.sessionId || ('oc-' + agent.id);
    saveData();
    send(res, { type: 'done' });
    res.end();
  });

  child.on('error', (err) => {
    send(res, { type: 'error', error: 'Failed to start openclaw: ' + err.message });
    agent.busy = false;
    send(res, { type: 'done' });
    res.end();
  });
}

// ---------- Codex turn (OpenAI Codex CLI, full tools) ----------
// Assumes the `codex` CLI is installed (npm i -g @openai/codex) and runs headless via
// `codex exec`. Auth via OPENAI_API_KEY (or the CLI's own ChatGPT login if no key set).
// JSONL event schema varies across Codex versions, so parsing is intentionally lenient.
async function runCodexTurn(agent, text, res) {
  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  let toSend = text;
  if (!agent.primedSoul) {
    const persona = buildPersona(agent, { withContents: true });
    if (persona) toSend = persona + '\n\n=== YOUR TASK ===\n' + text;
    agent.primedSoul = true;
  }

  const env = { ...process.env };
  const apiKey = (agent.codexApiKey || '').trim();
  if (apiKey) env.OPENAI_API_KEY = apiKey;

  const model = (agent.codexModel || '').trim();
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (model) args.push('-m', model);
  args.push(toSend);

  let child;
  try { child = spawn('codex', args, { cwd: agent.cwd, shell: true, env }); }
  catch (e) { send(res, { type: 'error', error: 'Failed to start codex: ' + String(e) }); agent.busy = false; send(res, { type: 'done' }); return res.end(); }

  agent.child = child;
  agent.stopped = false;

  // Pull any human-readable text out of a Codex JSONL event, whatever its shape.
  const extractText = (evt) => {
    if (!evt || typeof evt !== 'object') return '';
    if (typeof evt.text === 'string') return evt.text;
    if (typeof evt.content === 'string') return evt.content;
    if (typeof evt.message === 'string') return evt.message;
    if (typeof evt.delta === 'string') return evt.delta;
    const it = evt.item || evt.msg || {};
    if (typeof it.text === 'string') return it.text;
    if (typeof it.message === 'string') return it.message;
    return '';
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { send(res, { type: 'text', text: line }); continue; }
      const t = extractText(evt);
      const kind = evt.type || (evt.item && evt.item.type) || (evt.msg && evt.msg.type) || '';
      if (/command|exec|tool|patch|file/i.test(String(kind)) && !t) {
        send(res, { type: 'tool', name: String(kind), input: evt.item || evt.msg || {} });
      } else if (t) {
        send(res, { type: 'text', text: t });
      }
      // silently ignore pure-metadata events (reasoning traces, token counts, etc.)
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));

  child.on('close', (code) => {
    if (buf.trim()) {
      try { const evt = JSON.parse(buf.trim()); const t = extractText(evt); if (t) send(res, { type: 'text', text: t }); }
      catch { send(res, { type: 'text', text: buf.trim() }); }
    }
    agent.child = null;
    if (agent.stopped) { send(res, { type: 'system', stopped: true }); agent.stopped = false; }
    else if (code && code !== 0) send(res, { type: 'error', error: stderr.trim() || `codex exited with code ${code}` });
    agent.totals.turns += 1;
    if (!agent.totals.history) agent.totals.history = [];
    agent.totals.history.push({ ts: Date.now(), input: 0, output: 0, cache: 0, cost: 0, engine: 'codex' });
    agent.busy = false;
    agent.sessionId = agent.sessionId || ('codex-' + agent.id);
    saveData();
    send(res, { type: 'done' });
    res.end();
  });

  child.on('error', (err) => {
    send(res, { type: 'error', error: 'Failed to start codex: ' + err.message });
    agent.busy = false;
    send(res, { type: 'done' });
    res.end();
  });
}

// ---------- Hermes turn (Nous Research Hermes Agent CLI, autonomous, provider-agnostic) ----------
// Assumes the `hermes` CLI is installed (github.com/NousResearch/hermes-agent). Hermes is
// model/provider-agnostic (OpenRouter / OpenAI / Anthropic / Gemini), so it takes a provider +
// model like OpenClaw. NOTE: the exact non-interactive invocation below is a best-effort first
// pass — confirm `hermes --help` on the target machine and adjust `args` if the flags differ.
async function runHermesTurn(agent, text, res) {
  agent.busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });

  const provider = (agent.hermesProvider || '').trim();
  const model = (agent.hermesModel || '').trim();
  if (!model) {
    send(res, { type: 'error', error: 'Hermes agent needs a Model (open ✎ Edit to set it). Provider is optional (e.g. openrouter/anthropic).' });
    agent.busy = false; send(res, { type: 'done' }); return res.end();
  }
  const fullModel = provider ? provider + '/' + model : model;

  let toSend = text;
  if (!agent.primedSoul) {
    const persona = buildPersona(agent, { withContents: true });
    if (persona) toSend = persona + '\n\n=== YOUR TASK ===\n' + text;
    agent.primedSoul = true;
  }

  const env = { ...process.env };
  const apiKey = (agent.hermesApiKey || '').trim();
  if (apiKey) {
    if (provider === 'openrouter') env.OPENROUTER_API_KEY = apiKey;
    else if (provider === 'openai') env.OPENAI_API_KEY = apiKey;
    else if (provider === 'anthropic') env.ANTHROPIC_API_KEY = apiKey;
    else if (provider === 'google' || provider === 'gemini') { env.GOOGLE_API_KEY = apiKey; env.GEMINI_API_KEY = apiKey; }
    else env[(provider || 'HERMES').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'] = apiKey;
  }

  // Best-effort headless invocation — adjust to the real Hermes CLI contract if needed.
  const args = ['--message', toSend, '--model', fullModel, '--json'];

  let child;
  try { child = spawn('hermes', args, { cwd: agent.cwd, shell: true, env }); }
  catch (e) { send(res, { type: 'error', error: 'Failed to start hermes: ' + String(e) }); agent.busy = false; send(res, { type: 'done' }); return res.end(); }

  agent.child = child;
  agent.stopped = false;

  const extractText = (evt) => {
    if (!evt || typeof evt !== 'object') return '';
    if (typeof evt.text === 'string') return evt.text;
    if (typeof evt.content === 'string') return evt.content;
    if (typeof evt.message === 'string') return evt.message;
    if (typeof evt.delta === 'string') return evt.delta;
    const it = evt.item || evt.msg || {};
    if (typeof it.text === 'string') return it.text;
    if (typeof it.message === 'string') return it.message;
    return '';
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { send(res, { type: 'text', text: line }); continue; }
      const t = extractText(evt);
      const kind = evt.type || (evt.item && evt.item.type) || (evt.msg && evt.msg.type) || '';
      if (/tool|command|skill|browser|search|patch|file/i.test(String(kind)) && !t) {
        send(res, { type: 'tool', name: String(kind), input: evt.input || evt.args || evt.item || {} });
      } else if (t) {
        send(res, { type: 'text', text: t });
      }
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));

  child.on('close', (code) => {
    if (buf.trim()) {
      try { const evt = JSON.parse(buf.trim()); const t = extractText(evt); if (t) send(res, { type: 'text', text: t }); else send(res, { type: 'text', text: buf.trim() }); }
      catch { send(res, { type: 'text', text: buf.trim() }); }
    }
    agent.child = null;
    if (agent.stopped) { send(res, { type: 'system', stopped: true }); agent.stopped = false; }
    else if (code && code !== 0) send(res, { type: 'error', error: stderr.trim() || `hermes exited with code ${code}` });
    agent.totals.turns += 1;
    if (!agent.totals.history) agent.totals.history = [];
    agent.totals.history.push({ ts: Date.now(), input: 0, output: 0, cache: 0, cost: 0, engine: 'hermes' });
    agent.busy = false;
    agent.sessionId = agent.sessionId || ('hermes-' + agent.id);
    saveData();
    send(res, { type: 'done' });
    res.end();
  });

  child.on('error', (err) => {
    send(res, { type: 'error', error: 'Failed to start hermes: ' + err.message });
    agent.busy = false;
    send(res, { type: 'done' });
    res.end();
  });
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (pathname === '/') return serveStatic(res, 'index.html');
  if (pathname === '/app.js') return serveStatic(res, 'app.js');
  if (pathname === '/reel-ui.js') return serveStatic(res, 'reel-ui.js');

  if (pathname === '/api/state' && method === 'GET') return json(res, 200, publicState());

  if (pathname === '/api/browse' && method === 'GET') {
    // List subdirectories of a path. If no path given, list common roots.
    try {
      const url = new URL(req.url, 'http://localhost');
      let target = url.searchParams.get('path') || '';
      if (!target) {
        // Root listing on Windows = drive letters; on Unix = home + /.
        if (process.platform === 'win32') {
          const drives = [];
          for (let c = 65; c <= 90; c++) {
            const letter = String.fromCharCode(c);
            const p = letter + ':\\';
            try { if (fs.existsSync(p)) drives.push({ name: letter + ':', path: p }); } catch {}
          }
          return json(res, 200, { path: '', parent: null, dirs: drives });
        } else {
          target = process.env.HOME || '/';
        }
      }
      // Normalize + safety: prevent access to nothing suspicious (this is local so it's ok)
      target = path.resolve(target);
      if (!fs.existsSync(target)) return json(res, 400, { error: 'Path does not exist: ' + target });
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) return json(res, 400, { error: 'Not a directory: ' + target });
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }));
      const parent = path.dirname(target);
      return json(res, 200, {
        path: target,
        parent: parent !== target ? parent : null,
        dirs: entries,
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/usage' && method === 'GET') {
    const all = [];
    for (const a of agents.values()) {
      const h = (a.totals && a.totals.history) || [];
      h.forEach((e) => all.push({ ...e, agentId: a.id, agentName: a.name, agentRole: a.role, projectId: a.projectId }));
    }
    all.sort((a, b) => a.ts - b.ts);
    return json(res, 200, { usage: all });
  }

  if (pathname === '/api/account' && method === 'GET') {
    try {
      const child = spawn('claude', ['auth', 'status'], { shell: true, timeout: 8000 });
      let out = '';
      child.stdout.on('data', (d) => out += d);
      child.on('close', (code) => {
        try {
          const info = JSON.parse(out.trim());
          json(res, 200, {
            logged_in: !!info.loggedIn,
            email: info.email || null,
            org: info.orgName || null,
            plan: info.subscriptionType || null,
          });
        } catch {
          json(res, 200, { logged_in: code === 0, email: null, org: null, plan: null, raw: out.trim() });
        }
      });
    } catch (e) { json(res, 200, { logged_in: false, error: e.message }); }
    return;
  }

  const CRED_FILE = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', '.credentials.json');
  const BACKUP_DIR = String.raw`C:\Users\Lenovo\Documents\Archive June 2026\Zvi Funnel Docs\Projects`;

  if (pathname === '/api/account/logout' && method === 'POST') {
    try {
      if (fs.existsSync(CRED_FILE)) {
        const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
        const email = cred.claudeAiOauth?.email || 'unknown';
        const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const ts = new Date().toISOString().slice(0, 10);
        const backupName = `claude-credentials--${safe}--${ts}.json`;
        const backupPath = path.join(BACKUP_DIR, backupName);
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.copyFileSync(CRED_FILE, backupPath);
        const child = spawn('claude', ['auth', 'logout'], { shell: true, timeout: 8000 });
        child.on('close', () => json(res, 200, { ok: true, backup: backupName }));
      } else {
        json(res, 200, { ok: false, error: 'No credentials file found' });
      }
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (pathname === '/api/account/login' && method === 'POST') {
    try {
      const child = spawn('claude', ['auth', 'login'], { shell: true, timeout: 30000 });
      let out = '';
      child.stdout.on('data', (d) => out += d);
      child.on('close', (code) => json(res, 200, { ok: code === 0, output: out.trim() }));
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  // Run `claude setup-token`, which opens the browser for the user to Authorize the
  // account they want, then prints a long-lived OAuth token (sk-ant-oat…) to stdout.
  // We capture that token and return it so the app drops it straight into the Vault
  // field — no terminal hunting. This does NOT touch the machine login; the token is
  // used per-agent via CLAUDE_CODE_OAUTH_TOKEN. The request blocks (up to 3 min) while
  // the user completes the browser step.
  if (pathname === '/api/account/setup-token' && method === 'POST') {
    try {
      const child = spawn('claude', ['setup-token'], { shell: true });
      let out = '';
      const grab = (d) => { out += d.toString(); };
      child.stdout.on('data', grab);
      child.stderr.on('data', grab);
      let done = false;
      const finish = (extra) => {
        if (done) return; done = true;
        const token = (out.match(/sk-ant-oat[A-Za-z0-9_-]+/) || [])[0] || '';
        const url = (out.match(/https?:\/\/[^\s'"]+/) || [])[0] || '';
        json(res, 200, { ok: !!token, token, url, output: out.slice(-2000), ...(extra || {}) });
      };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ timedOut: true }); }, 180000);
      child.on('close', () => { clearTimeout(timer); finish(); });
      child.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  // ---- Account Vault: named, reusable Claude accounts (one token, many workers) ----
  if (pathname === '/api/accounts' && method === 'POST') {
    const b = await readBody(req);
    const name = (b.name || '').trim();
    if (!name) return json(res, 400, { error: 'Name required' });
    let acct;
    if (b.id && (acct = accountById(b.id))) {
      acct.name = name;
      if (b.color != null) acct.color = b.color;
      if (b.provider != null) acct.provider = b.provider;
      if (b.token != null && b.token !== '') acct.token = b.token; // keep old token if blank on edit
    } else {
      const id = randomUUID().slice(0, 8);
      const configDir = path.join(ACCOUNTS_BASE, id);
      try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
      acct = { id, name, color: b.color || '#E8A33D', provider: b.provider || 'claude', token: b.token || '', configDir };
      state.accounts.push(acct);
    }
    saveData();
    return json(res, 200, acct);
  }

  // Open a terminal that logs this account into its OWN config dir (isolated login,
  // does not touch the machine's main Claude login). The user completes the browser
  // OAuth; credentials land in <configDir>\.credentials.json.
  if (pathname === '/api/account/login-dir' && method === 'POST') {
    const b = await readBody(req);
    const acct = accountById(b.id);
    if (!acct || !acct.configDir) return json(res, 404, { ok: false, error: 'Account not found' });
    try { fs.mkdirSync(acct.configDir, { recursive: true }); } catch {}
    try {
      const flag = acct.provider === 'console' ? '--console' : '--claudeai';
      spawn('start "" cmd /k set "CLAUDE_CONFIG_DIR=' + acct.configDir + '" ^& claude auth login ' + flag, [], { shell: true, detached: true });
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  // Report whether an account's config dir holds a valid login (via `claude auth status`).
  if (pathname === '/api/account/status-dir' && method === 'GET') {
    const acct = accountById(new URL(req.url, 'http://localhost').searchParams.get('id'));
    if (!acct || !acct.configDir) return json(res, 404, { loggedIn: false, error: 'Account not found' });
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: acct.configDir };
      const child = spawn('claude', ['auth', 'status', '--json'], { shell: true, env });
      let out = '';
      child.stdout.on('data', (d) => out += d.toString());
      child.stderr.on('data', (d) => out += d.toString());
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        let email = '', loggedIn = false;
        try { const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]); loggedIn = !!(j.loggedIn ?? j.authenticated ?? j.email); email = j.email || (j.account && j.account.email) || ''; } catch {}
        // fallback: read the credentials file directly
        if (!email) { try { const c = JSON.parse(fs.readFileSync(path.join(acct.configDir, '.credentials.json'), 'utf8')); email = (c.claudeAiOauth && c.claudeAiOauth.email) || ''; loggedIn = loggedIn || !!email; } catch {} }
        json(res, 200, { loggedIn, email });
      };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, 12000);
      child.on('close', () => { clearTimeout(timer); finish(); });
      child.on('error', () => { clearTimeout(timer); finish(); });
    } catch (e) { json(res, 500, { loggedIn: false, error: e.message }); }
    return;
  }
  const acctDel = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (acctDel && method === 'DELETE') {
    state.accounts = state.accounts.filter((a) => a.id !== acctDel[1]);
    // Unlink any agents that referenced it so they fall back to the machine login.
    for (const a of agents.values()) if (a.accountId === acctDel[1]) a.accountId = '';
    saveData();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/account/backups' && method === 'GET') {
    try {
      const files = fs.existsSync(BACKUP_DIR)
        ? fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('claude-credentials--') && f.endsWith('.json'))
        : [];
      const backups = files.map((f) => {
        const m = f.match(/^claude-credentials--(.+?)--(\d{4}-\d{2}-\d{2})\.json$/);
        return { file: f, email: m ? m[1] : f, date: m ? m[2] : '', path: path.join(BACKUP_DIR, f) };
      }).sort((a, b) => b.date.localeCompare(a.date));
      json(res, 200, { backups });
    } catch (e) { json(res, 200, { backups: [], error: e.message }); }
    return;
  }

  if (pathname === '/api/account/restore' && method === 'POST') {
    try {
      const b = await readBody(req);
      const backupPath = path.join(BACKUP_DIR, path.basename(b.file));
      if (!fs.existsSync(backupPath)) return json(res, 404, { ok: false, error: 'Backup not found' });
      fs.copyFileSync(backupPath, CRED_FILE);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  // ----- Projects -----
  if (pathname === '/api/projects' && method === 'POST') {
    const b = await readBody(req);
    const id = randomUUID().slice(0, 8);
    const proj = { id, name: b.name || 'Untitled Project', cwd: (b.cwd && b.cwd.trim()) || DEFAULT_CWD, contextFiles: [], size: b.size || '', goal: b.goal || '' };
    state.projects.push(proj);
    state.activeProjectId = id;
    // Instantiate a template's roles, if requested. Size + goal biases the leader's soul.
    const tpl = templates.find((t) => t.name === b.templateName);
    if (tpl) for (const r of tpl.roles) {
      let soul = r.soul || '';
      const isLeader = !r.reportsTo && /director|lead|manager|chief|founder|owner|editor|ceo|cmo|pm/i.test(r.role || '');
      if (isLeader && (b.size || b.goal)) {
        const bias = [];
        if (b.size === 'S') bias.push('This is a SMALL operation (solo / 1-3 people). Bias toward simplicity, single-owner accountability, and lean execution. Avoid recommending headcount you do not have.');
        if (b.size === 'M') bias.push('This is a MEDIUM operation (4-20 people). Bias toward repeatable processes, delegation, and cross-functional handoffs.');
        if (b.size === 'L') bias.push('This is a LARGE operation (20+ people). Bias toward specialization, formal review gates, and documented playbooks.');
        if (b.goal === 'launch') bias.push('The current goal is LAUNCH — ship the MVP fast. Prioritize speed to first revenue over polish. Cut anything not on the critical path.');
        if (b.goal === 'scale') bias.push('The current goal is SCALE — repeatable growth. Prioritize funnels, tracking, and processes that unlock 10x volume without breaking.');
        if (b.goal === 'retain') bias.push('The current goal is RETENTION — LTV and lifecycle. Prioritize email flows, post-purchase experience, referrals, and cohort behavior.');
        if (b.goal === 'hire') bias.push('The current goal is HIRING — find and onboard people. Prioritize sourcing, job descriptions, screening loops, and 30-60-90 plans.');
        if (bias.length) soul = soul + '\n\n=== PROJECT CONTEXT ===\n' + bias.join('\n');
      }
      createAgent({ projectId: id, name: r.role, role: r.role, soul, model: r.model, reportsTo: r.reportsTo });
    }
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
  if ((m = pathname.match(/^\/api\/agents\/([^/]+)(\/message|\/model|\/upload|\/edit|\/stop|\/save|\/loop)?$/))) {
    const agent = agents.get(m[1]);
    if (method === 'DELETE') { agents.delete(m[1]); saveData(); return json(res, 200, publicState()); }
    if (!agent) return json(res, 404, { error: 'no such agent' });

    if (m[2] === '/stop' && method === 'POST') {
      if (agent.loop && agent.loop.active) { agent.loop.active = false; agent.loop.reason = 'stopped by you'; }
      stopAgent(agent); return json(res, 200, { ok: true });
    }
    if (m[2] === '/loop' && method === 'POST') {
      const b = await readBody(req);
      if (b.action === 'start') {
        const prompt = (b.prompt || '').trim();
        if (!prompt) return json(res, 400, { error: 'A recurring instruction is required to start a loop.' });
        agent.loop = {
          active: true, prompt,
          startedAt: Date.now(),
          maxMs: Math.max(0, Number(b.maxMinutes) || 0) * 60000,
          maxIterations: Math.max(0, Number(b.maxIterations) || 0),
          maxCostUsd: Math.max(0, Number(b.maxCostUsd) || 0),
          iterations: 0, startCost: agentCost(agent), reason: '',
        };
        saveData();
        return json(res, 200, { ok: true, loop: agent.loop });
      }
      if (b.action === 'stop') {
        if (agent.loop) { agent.loop.active = false; agent.loop.reason = 'stopped by you'; }
        stopAgent(agent); saveData();
        return json(res, 200, { ok: true, loop: agent.loop || newLoop() });
      }
      if (b.action === 'tick') {
        const r = loopTick(agent); saveData();
        return json(res, 200, { ...r, loop: agent.loop });
      }
      return json(res, 400, { error: 'unknown loop action' });
    }
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
      if (b.accountId != null && b.accountId !== agent.accountId) {
        // Switching account = different login/profile. The old session lives in the
        // old profile and can't be resumed here, so drop it and re-prime fresh.
        agent.accountId = b.accountId; agent.sessionId = null; agent.primedSoul = false;
      }
      if (b.soul != null && b.soul !== agent.soul) { agent.soul = b.soul; agent.primedSoul = false; }
      if (b.effort != null) agent.effort = b.effort;
      if (b.engine != null) agent.engine = b.engine;
      if (b.apiBaseUrl != null) agent.apiBaseUrl = b.apiBaseUrl;
      if (b.apiKey != null) agent.apiKey = b.apiKey;
      if (b.apiModel != null) agent.apiModel = b.apiModel;
      if (b.ccBaseUrl != null) agent.ccBaseUrl = b.ccBaseUrl;
      if (b.ccAuthToken != null) agent.ccAuthToken = b.ccAuthToken;
      if (b.ccModel != null) agent.ccModel = b.ccModel;
      if (b.ccOauthToken != null) agent.ccOauthToken = b.ccOauthToken;
      if (b.ocProvider != null) agent.ocProvider = b.ocProvider;
      if (b.ocModel != null) agent.ocModel = b.ocModel;
      if (b.ocApiKey != null) agent.ocApiKey = b.ocApiKey;
      if (b.codexModel != null) agent.codexModel = b.codexModel;
      if (b.codexApiKey != null) agent.codexApiKey = b.codexApiKey;
      if (b.hermesProvider != null) agent.hermesProvider = b.hermesProvider;
      if (b.hermesModel != null) agent.hermesModel = b.hermesModel;
      if (b.hermesApiKey != null) agent.hermesApiKey = b.hermesApiKey;
      saveData();
      return json(res, 200, publicAgent(agent));
    }
    if (m[2] === '/upload' && method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, saveUpload(agent.cwd, b.filename, b.dataBase64 || '')); }
      catch (e) { return json(res, 500, { error: String(e) }); }
    }
    if (m[2] === '/save' && method === 'POST') {
      const b = await readBody(req);
      const md = b.markdown || '';
      if (!md.trim()) return json(res, 400, { error: 'empty session' });
      const proj = getProject(agent.projectId);
      const projName = proj ? proj.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/ +/g, '-') : 'project';
      const role = (agent.role || agent.name || 'agent').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/ +/g, '-');
      const ts = new Date().toISOString().slice(0, 10);
      const filename = `mc-session--${projName}--${role}--${ts}.md`;
      const savePath = path.join(BACKUP_DIR, filename);
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(savePath, md, 'utf8');
      return json(res, 200, { ok: true, path: savePath, filename });
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

  // The Reel — mini-app routes (/api/reel/*)
  if (pathname.startsWith('/api/reel/')) {
    const handled = await reel.route(pathname, method, req, res, { json, readBody });
    if (handled !== false) return;
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

  // ============ E-COMMERCE STORE (S) — Launch ============
  const ecomOwner = `You are the Founder-Operator of a small e-commerce store. You wear every strategic hat — merchant, marketer, ops.
You think in offers, unit economics, first-order profit, and simple funnels. Read the brief and shared files, form a sharp plan, break work into assignments.
Always finish with an ASSIGNMENTS section. Format:
@RoleName: the task
RoleName must be one of: Copywriter, Product Photographer, Ad Buyer, Customer Service.
If nothing to assign, write: @none: waiting on input.`;
  const ecomCopy = `You are a direct-response copywriter for a small e-commerce store. You write punchy headlines, product descriptions, ad copy, and email flows. Give A/B/C variants. Handle top objections. Read the shared files first.`;
  const ecomPhoto = `You are a product photographer and creative director. You spec product shots, lifestyle photos, unboxing angles, and UGC directions. Deliver shot lists the Founder can send to a photographer or create with a phone.`;
  const ecomAd = `You are a Meta/Google ad buyer for a small store. You spec creative angles, audience targeting, budget tiers, and daily kill/scale rules. Read shared files. Report on hypothesis → creative → audience → spend for each test.`;
  const ecomCS = `You are a customer service lead. You draft response templates, refund policy language, FAQ entries, and post-purchase communication that reduces support tickets and lifts LTV.`;

  const ecomSmall = {
    name: 'E-commerce Store (Small)',
    description: 'Solo/small-team e-commerce operator: Founder + Copywriter + Product Photographer + Ad Buyer + Customer Service.',
    roles: [
      { role: 'Founder-Operator', soul: ecomOwner, model: '', reportsTo: '' },
      { role: 'Copywriter', soul: ecomCopy, model: '', reportsTo: 'Founder-Operator' },
      { role: 'Product Photographer', soul: ecomPhoto, model: '', reportsTo: 'Founder-Operator' },
      { role: 'Ad Buyer', soul: ecomAd, model: '', reportsTo: 'Founder-Operator' },
      { role: 'Customer Service', soul: ecomCS, model: '', reportsTo: 'Founder-Operator' },
    ],
  };

  // ============ E-COMMERCE STORE (M) — Scale ============
  const cmo = `You are the CMO of a medium e-commerce brand ($1-30M/yr). You own conversion, AOV, retention, and blended ROAS. You think in funnels, cohorts, and category-level bets.
Read the brief and shared files, form strategy, break work into assignments.
Always finish with an ASSIGNMENTS section:
@RoleName: task
Roles: Copywriter, Email Marketer, Ad Buyer, CRO Analyst, Backend Dev, Data Analyst.
No fluff. Decision-driven.`;
  const emailM = `You are a lifecycle email marketer (Klaviyo/Attentive). You design welcome flows, abandoned cart, browse abandonment, post-purchase, VIP, winback, and campaign calendars. Deliver subject lines, previews, and modular blocks. Handle top objections in-flow.`;
  const cro = `You are a CRO analyst. You audit landing pages, PDPs, cart, and checkout for friction. You spec A/B tests with hypothesis, control, variant, primary metric, and expected lift. Cite behavioral principles when relevant.`;
  const dataAn = `You are a data analyst for e-commerce. You build daily/weekly dashboards, cohort retention curves, LTV/CAC by channel, and product-mix analysis. Report actionable insights in tight bullets. Cite the numbers.`;
  const ecomBackend = `You are a backend developer for Shopify/BigCommerce with expertise in headless architectures. You handle API integrations, custom apps, checkout customizations, and data pipelines to warehouses.`;

  const ecomMed = {
    name: 'E-commerce Store (Medium)',
    description: 'Scaling e-commerce team: CMO + Copywriter + Email Marketer + Ad Buyer + CRO Analyst + Backend Dev + Data Analyst.',
    roles: [
      { role: 'CMO', soul: cmo, model: '', reportsTo: '' },
      { role: 'Copywriter', soul: ecomCopy, model: '', reportsTo: 'CMO' },
      { role: 'Email Marketer', soul: emailM, model: '', reportsTo: 'CMO' },
      { role: 'Ad Buyer', soul: ecomAd, model: '', reportsTo: 'CMO' },
      { role: 'CRO Analyst', soul: cro, model: '', reportsTo: 'CMO' },
      { role: 'Backend Developer', soul: ecomBackend, model: '', reportsTo: 'CMO' },
      { role: 'Data Analyst', soul: dataAn, model: '', reportsTo: 'CMO' },
    ],
  };

  // ============ SAAS STARTUP (S) — MVP ============
  const saasFounder = `You are the Founder/PM of a small SaaS startup. You think in wedge, ICP, TTFV (time to first value), and shipping cadence.
Read the brief and shared files, form a sharp plan, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Full-Stack Dev, Designer, Growth Marketer.
Only assign what unlocks the next milestone. If nothing to assign: @none: waiting on input.`;
  const fullStackDev = `You are a senior full-stack developer (Next.js + Postgres + Node stack). You ship end-to-end features fast — schema, API, UI. You prefer boring tech and small PRs. Read the shared files first; operate on the codebase directly.`;
  const productDesigner = `You are a product designer for SaaS. You think in flows, first-run experience, and reducing time-to-first-value. Deliver concrete specs the developer can build — screen list, states (empty/loading/error), key interactions, mobile behavior. Reference Linear/Attio/Superhuman patterns.`;
  const growthM = `You are a growth marketer for early-stage SaaS. You think in acquisition channels, activation loops, and PLG mechanics. Deliver channel tests with hypothesis + minimum viable experiment + kill criteria. Cite the ICP.`;

  const saasSmall = {
    name: 'SaaS Startup (Small)',
    description: 'Early SaaS team pre-PMF: Founder/PM + Full-Stack Dev + Designer + Growth Marketer.',
    roles: [
      { role: 'Founder/PM', soul: saasFounder, model: '', reportsTo: '' },
      { role: 'Full-Stack Developer', soul: fullStackDev, model: '', reportsTo: 'Founder/PM' },
      { role: 'Product Designer', soul: productDesigner, model: '', reportsTo: 'Founder/PM' },
      { role: 'Growth Marketer', soul: growthM, model: '', reportsTo: 'Founder/PM' },
    ],
  };

  // ============ SAAS STARTUP (M) — Growth ============
  const ceo = `You are the CEO of a growth-stage SaaS ($1-10M ARR). You think in retention, expansion revenue, ICP tightness, and the north-star metric.
Read the brief and shared files, set the plan, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Head of Growth, Copywriter, Designer, Frontend Dev, Backend Dev, Data Analyst, Support.
Decisive, no fluff.`;
  const hog = `You are the Head of Growth for a growth-stage SaaS. You own funnel from anonymous → activation → expansion. You think in cohort retention, PQLs, and channel unit economics. Deliver experiment briefs and channel prioritization matrices.`;
  const saasFront = `You are a senior frontend developer (React/TypeScript, TailwindCSS). You ship pixel-perfect UI from designer specs, accessible and performant. Read shared files; operate on the codebase.`;
  const saasBack = `You are a senior backend developer (Node.js + Postgres, or Python + Postgres). You design APIs, schemas, background jobs, and integrations. You care about type safety, migrations, and observability. Read shared files.`;
  const saasSupport = `You are a customer support engineer for SaaS. You triage tickets, write help-doc articles, spot patterns that hint at product bugs, and escalate cleanly. Deliver macros, article outlines, and weekly digests of top themes.`;

  const saasMed = {
    name: 'SaaS Startup (Medium)',
    description: 'Growth-stage SaaS team: CEO + Head of Growth + Copywriter + Designer + Frontend + Backend + Data Analyst + Support.',
    roles: [
      { role: 'CEO', soul: ceo, model: '', reportsTo: '' },
      { role: 'Head of Growth', soul: hog, model: '', reportsTo: 'CEO' },
      { role: 'Copywriter', soul: ecomCopy, model: '', reportsTo: 'Head of Growth' },
      { role: 'Product Designer', soul: productDesigner, model: '', reportsTo: 'CEO' },
      { role: 'Frontend Developer', soul: saasFront, model: '', reportsTo: 'CEO' },
      { role: 'Backend Developer', soul: saasBack, model: '', reportsTo: 'CEO' },
      { role: 'Data Analyst', soul: dataAn, model: '', reportsTo: 'CEO' },
      { role: 'Support', soul: saasSupport, model: '', reportsTo: 'CEO' },
    ],
  };

  // ============ CONTENT STUDIO ============
  const editor = `You are the Editor-in-Chief of a content studio (blog + newsletter + YouTube). You own the editorial calendar, angle selection, and quality bar.
Read the brief and shared files, set direction, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Researcher, Copywriter, Video Producer, Distribution Lead.
Only assign what serves this week's publishing calendar. If nothing to assign: @none: waiting on input.`;
  const contentResearcher = `You are a senior content researcher. You dig into topics, competitor coverage, primary sources, expert quotes, and data. Deliver research memos: TL;DR + 5-10 sharp bullets + list of sources with quotes. No fluff.`;
  const videoProducer = `You are a video producer for YouTube. You spec scripts (hook / setup / turn / payoff / CTA), B-roll ideas, on-screen graphics, and thumbnail concepts (3 A/B options). You think in retention curves and pattern interrupts.`;
  const distro = `You are a content distribution lead. Every published piece gets a distribution plan: Twitter thread, LinkedIn post, newsletter blurb, Reddit-appropriate variant, and community-specific angles. Deliver ready-to-post copy per platform.`;

  const contentStudio = {
    name: 'Content Studio',
    description: 'Blog + newsletter + YouTube content team: Editor + Researcher + Copywriter + Video Producer + Distribution Lead.',
    roles: [
      { role: 'Editor-in-Chief', soul: editor, model: '', reportsTo: '' },
      { role: 'Researcher', soul: contentResearcher, model: '', reportsTo: 'Editor-in-Chief' },
      { role: 'Copywriter', soul: ecomCopy, model: '', reportsTo: 'Editor-in-Chief' },
      { role: 'Video Producer', soul: videoProducer, model: '', reportsTo: 'Editor-in-Chief' },
      { role: 'Distribution Lead', soul: distro, model: '', reportsTo: 'Editor-in-Chief' },
    ],
  };

  // ============ SOLO FOUNDER (Bootstrap) ============
  const chiefOfStaff = `You are the Chief of Staff for a solo founder. Your job is to be the founder's second brain — you triage, prioritize, and orchestrate two specialist workers.
Read the brief. Decide if this needs a marketer, a developer, or both. Then break the work into 1-2 assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Marketer, Developer.
If nothing to assign right now (founder needs to think first): @none: waiting on input.
Bias toward tiny, shippable next actions. This is a bootstrapped operation — every hour matters.`;
  const soloMarketer = `You are the marketing generalist for a solo founder. You do everything: copy, content, ads, email, community, SEO. You bias toward channels with fast feedback loops. Always propose the smallest viable experiment first.`;
  const soloDev = `You are the technical generalist for a solo founder. You build MVPs fast, glue APIs, ship landing pages, wire analytics, and automate manual work. Boring tech first; only fancy when it earns its keep.`;

  const soloFounder = {
    name: 'Solo Founder (Bootstrap)',
    description: 'Chief of Staff (director) + Marketer + Developer. Minimum viable team for a side-hustle or bootstrapped operation.',
    roles: [
      { role: 'Chief of Staff', soul: chiefOfStaff, model: '', reportsTo: '' },
      { role: 'Marketer', soul: soloMarketer, model: '', reportsTo: 'Chief of Staff' },
      { role: 'Developer', soul: soloDev, model: '', reportsTo: 'Chief of Staff' },
    ],
  };

  // ============ AGENCY (DTC Retention) ============
  const accountMgr = `You are the Account Manager at a DTC retention agency. Your job is client outcomes — you own the roadmap, weekly check-ins, and the "why" behind every deliverable.
Read the brief and shared files, decide the plan, break work into assignments for the specialists.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Advertorial Writer, Email Marketer, Designer, Frontend Developer, Analyst.
Everything ties back to a metric — CVR, AOV, LTV, or repeat rate. If nothing to assign: @none: waiting on input.`;
  const advertorial = `You are an advertorial copywriter for DTC brands. You write long-form advertorials in the customer's voice with heavy proof stacking (testimonials, before/afters, expert cites, data). Story-first, product-later. Deliver full drafts with clear angle + hook + turn + CTA sections.`;
  const agencyEmail = emailM;
  const agencyDesigner = `You are a designer specializing in DTC — landing pages, PDPs, email templates, and creative briefs for photo/video shoots. You think mobile-first, above-the-fold, and reduce-cognitive-load. Deliver concrete specs and Figma-ready component descriptions.`;
  const agencyFront = `You are a frontend developer for DTC stores (Shopify Liquid, custom sections, headless Next.js). You implement designer specs and copywriter's copy faithfully. Fast page loads. Mobile-first.`;
  const agencyAnalyst = dataAn;

  const agency = {
    name: 'Agency — DTC Retention',
    description: 'DTC retention studio: Account Manager + Advertorial Writer + Email Marketer + Designer + Frontend Dev + Analyst.',
    roles: [
      { role: 'Account Manager', soul: accountMgr, model: '', reportsTo: '' },
      { role: 'Advertorial Writer', soul: advertorial, model: '', reportsTo: 'Account Manager' },
      { role: 'Email Marketer', soul: agencyEmail, model: '', reportsTo: 'Account Manager' },
      { role: 'Designer', soul: agencyDesigner, model: '', reportsTo: 'Account Manager' },
      { role: 'Frontend Developer', soul: agencyFront, model: '', reportsTo: 'Designer' },
      { role: 'Analyst', soul: agencyAnalyst, model: '', reportsTo: 'Account Manager' },
    ],
  };

  // ============ COACHING BUSINESS ============
  const coach = `You are the Coach/Founder of a coaching business. Your product is your expertise + a delivery mechanism (courses, cohorts, 1:1s, group programs).
Read the brief and shared files, set the plan, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Content Creator, Video Editor, Community Manager.
Focus on the client transformation. If nothing to assign: @none: waiting on input.`;
  const contentCreator = `You are a content creator for a coach's personal brand. You write threads, hooks, case-study posts, and short-form video scripts. You extract the coach's frameworks into 60-second hooks. You publish daily rhythms across LinkedIn + Twitter + IG.`;
  const videoEditor = `You are a short-form video editor. You cut 60-90s clips from long-form coach content (podcast, YouTube, webinar). Hook in first 3s, captions, jump cuts, B-roll. Deliver 3-5 cut variants per source video.`;
  const communityMgr = `You are the community manager for a coach's paid community (Discord/Circle/Skool). You handle onboarding, prompt daily discussion, surface success stories, and flag members at churn risk. Deliver weekly community health reports and topic calendars.`;

  const coaching = {
    name: 'Coaching Business',
    description: 'Personal brand + coaching program: Coach + Content Creator + Video Editor + Community Manager.',
    roles: [
      { role: 'Coach/Founder', soul: coach, model: '', reportsTo: '' },
      { role: 'Content Creator', soul: contentCreator, model: '', reportsTo: 'Coach/Founder' },
      { role: 'Video Editor', soul: videoEditor, model: '', reportsTo: 'Content Creator' },
      { role: 'Community Manager', soul: communityMgr, model: '', reportsTo: 'Coach/Founder' },
    ],
  };

  // ============ LOCAL SERVICE (Restaurant / Salon / etc.) ============
  const localOwner = `You are the Owner of a local service business (restaurant, salon, gym, clinic, etc.). You think in foot traffic, repeat visits, local reputation, and staff scheduling.
Read the brief and shared files, set the plan, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Local Marketer, Social Media Manager, Reviews Manager.
Focus on this week's revenue. If nothing to assign: @none: waiting on input.`;
  const localMarketer = `You are a local marketing specialist. You handle Google Business Profile optimization, local SEO, community sponsorships, referral programs, and neighborhood promotions. Deliver concrete this-week actions and quarterly plans.`;
  const socialMgr = `You are a social media manager for local businesses. You post daily on Instagram + TikTok + Facebook with location-tagged content — behind-the-scenes, staff spotlights, customer moments, weekly specials. Deliver a week's worth of drafts at a time.`;
  const reviewsMgr = `You are a reviews and reputation manager. You draft response templates to Google/Yelp reviews (positive + negative + neutral), design a review-solicitation flow, and monitor for reputation risks. Every response is warm, specific, and on-brand.`;

  const localService = {
    name: 'Local Service Business',
    description: 'Owner-operated local business: Owner + Local Marketer + Social Media Manager + Reviews Manager.',
    roles: [
      { role: 'Owner', soul: localOwner, model: '', reportsTo: '' },
      { role: 'Local Marketer', soul: localMarketer, model: '', reportsTo: 'Owner' },
      { role: 'Social Media Manager', soul: socialMgr, model: '', reportsTo: 'Owner' },
      { role: 'Reviews Manager', soul: reviewsMgr, model: '', reportsTo: 'Owner' },
    ],
  };

  // ============ REAL ESTATE INVESTOR ============
  const investor = `You are a Real Estate Investor / Portfolio Manager. You focus on deal flow, underwriting, and portfolio-level returns (single-family / multi-family / short-term rentals depending on the brief).
Read the brief and shared files, set the plan, break work into assignments.
Always finish with ASSIGNMENTS:
@RoleName: task
Roles: Deal Analyst, Copywriter, Property Researcher, Content Creator.
Every action ties to a deal or portfolio metric. If nothing to assign: @none: waiting on input.`;
  const dealAnalyst = `You are a real estate deal analyst. You underwrite deals — comps, cap rates, cash-on-cash, IRR, DSCR, exit assumptions. Deliver clean underwriting memos with sensitivity analysis and a go/no-go recommendation. Show the numbers.`;
  const propResearcher = `You are a property researcher. You dig into markets (permits, migration, employment), neighborhoods (crime, schools, walkability), and specific properties (title, liens, deferred maintenance signals). Deliver market briefs and property dossiers.`;
  const investorCopy = `You are a copywriter for a real estate investor's brand. You write investor updates, deal memos to LPs, listing descriptions (for exits), and thought-leadership posts on LinkedIn/X. Cite specific numbers.`;
  const investorContent = `You are a content creator for a real estate investor's personal brand. You extract case studies from actual deals into shareable posts. Deals → lessons → posts. Weekly rhythm.`;

  const realEstate = {
    name: 'Real Estate Investor',
    description: 'RE portfolio operator: Investor + Deal Analyst + Copywriter + Property Researcher + Content Creator.',
    roles: [
      { role: 'Investor/PM', soul: investor, model: '', reportsTo: '' },
      { role: 'Deal Analyst', soul: dealAnalyst, model: '', reportsTo: 'Investor/PM' },
      { role: 'Property Researcher', soul: propResearcher, model: '', reportsTo: 'Investor/PM' },
      { role: 'Copywriter', soul: investorCopy, model: '', reportsTo: 'Investor/PM' },
      { role: 'Content Creator', soul: investorContent, model: '', reportsTo: 'Investor/PM' },
    ],
  };

  return [
    marketing, googlePlay,
    ecomSmall, ecomMed,
    saasSmall, saasMed,
    contentStudio, soloFounder, agency, coaching,
    localService, realEstate,
  ];
}