// The Reel — mini-app inside Foundry: generic AI content studio.
// Brief-driven carousel generator. Copy via Anthropic API, images via Higgsfield Nano Banana Pro.
// Zero-dep, matches server.js style. Wired in via reel.route(pathname, method, req, res, helpers).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { randomUUID } = require('crypto');

const DATA_FILE = path.join(__dirname, 'reel-data.json');
const ASSETS_DIR = path.join(__dirname, 'mc-uploads', 'reel');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

let db = {
  briefs: [], posts: [],
  accounts: [],            // [{ id, label, platform, accessToken, openId, addedAt }]
  activeAccountId: '',
  settings: { anthropicKey: '', higgsKeyId: '', higgsKeySecret: '', publicBaseUrl: '' },
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.briefs = d.briefs || [];
      db.posts = d.posts || [];
      db.accounts = d.accounts || [];
      db.activeAccountId = d.activeAccountId || '';
      db.settings = { ...db.settings, ...(d.settings || {}) };
    }
  } catch (e) { console.log('  (reel: could not load reel-data.json:', e.message, ')'); }
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.log('  (reel: save error:', e.message, ')'); }
}
load();

// ---------- HTTP helpers ----------
function httpsRequest(url, opts, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: opts.method || 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: opts.headers || {},
      timeout: opts.timeout || 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function anthropicMessages(apiKey, model, systemPrompt, userMessage, maxTokens = 4000) {
  const bodyStr = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);
  if (r.status !== 200) {
    let msg = '';
    try { msg = JSON.parse(r.body.toString()).error?.message || ''; } catch {}
    throw new Error(`Anthropic ${r.status}: ${msg || r.body.toString().slice(0, 200)}`);
  }
  const data = JSON.parse(r.body.toString());
  return data.content?.[0]?.text || '';
}

// Higgsfield: submit generate_image via the same MCP-equivalent JSON-RPC endpoint the SDK uses.
// Auth: hf-api-key + hf-secret headers, POST /v1/text2image/{modelId} with { params: {...} }.
async function higgsGenerateImage(keyId, keySecret, model, prompt, aspectRatio = '3:4', resolution = '2k') {
  // Nano Banana Pro uses aspect_ratio, resolution. No width_and_height.
  const bodyObj = {
    params: {
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      batch_size: 1,
    },
  };
  const bodyStr = JSON.stringify(bodyObj);
  // The REST endpoint path for models is currently /v1/text2image/{model} for validated ones.
  // For nano_banana_pro / gpt_image_2 the REST is NOT publicly exposed on the same paths;
  // The MCP internally proxies. Since we can't call MCP from server.js easily, we use the
  // OLD Higgsfield REST endpoint we validated: /v1/text2image/soul as a fallback IF the specific
  // model endpoint 404s. We'll try model-specific first.
  const endpoints = [
    `/${model.replace(/_/g, '-')}/text-to-image`,
    `/v1/text2image/${model}`,
  ];
  let lastErr = '';
  for (const ep of endpoints) {
    const r = await httpsRequest(`https://platform.higgsfield.ai${ep}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'hf-api-key': keyId,
        'hf-secret': keySecret,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, bodyStr);
    if (r.status === 200) {
      const data = JSON.parse(r.body.toString());
      return data;
    }
    lastErr = `${ep} → ${r.status}: ${r.body.toString().slice(0, 200)}`;
  }
  throw new Error('Higgsfield image submit failed: ' + lastErr);
}

async function higgsJobStatus(keyId, keySecret, requestId) {
  const r = await httpsRequest(`https://platform.higgsfield.ai/requests/${requestId}/status`, {
    method: 'GET',
    headers: { 'hf-api-key': keyId, 'hf-secret': keySecret },
  });
  if (r.status !== 200) throw new Error(`Higgsfield status ${r.status}: ${r.body.toString().slice(0, 200)}`);
  return JSON.parse(r.body.toString());
}

async function higgsPollUntilDone(keyId, keySecret, requestId, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await higgsJobStatus(keyId, keySecret, requestId);
    if (s.status === 'completed') return s;
    if (s.status === 'failed' || s.status === 'nsfw') throw new Error(`Higgsfield job ${s.status}`);
    await new Promise((r) => setTimeout(r, 3500));
  }
  throw new Error('Higgsfield poll timed out');
}

async function downloadToFile(url, destPath) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`Download ${res.statusCode}`)); return; }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => stream.close(() => resolve()));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- Visual formulas ----------
// Reverse-engineered from the 4 photoshoot batches, abstracted to be product-agnostic.
// Each formula is a reusable photography recipe: the brief supplies the subject/message,
// the formula supplies the look + emotional register. `styleSuffix` is appended to every
// image prompt at generation time so all slides share one coherent aesthetic.
const FORMULAS = [
  {
    id: 'studio-clean',
    name: 'Studio Clean',
    tagline: 'Pure white studio, soft diffused light, subject-forward. Quiet, aspirational, catalog-hero.',
    emotion: 'Calm confidence · aspirational · premium',
    useFor: 'Premium or spec-driven products. The clean, trust-establishing baseline.',
    styleSuffix: 'shot on a pure white seamless infinity backdrop, soft diffused key light with minimal shadow, subject-forward composition, quiet premium catalog aesthetic, crisp and clean, photorealistic, high detail, no text, no logos, no watermark',
  },
  {
    id: 'spec-macro',
    name: 'Spec Macro',
    tagline: 'Clinical, every-angle coverage with extreme macro detail. Proves the craftsmanship.',
    emotion: 'Precision · trust · craftsmanship',
    useFor: 'Products where material, texture, or fine detail is the differentiator.',
    styleSuffix: 'clinical flat even studio lighting, extreme macro close-up on texture and material detail, spec-sheet precision, neutral seamless background, razor-sharp focus, photorealistic, no text, no logos, no watermark',
  },
  {
    id: 'character-editorial',
    name: 'Character Editorial',
    tagline: 'Warm cream studio, directional cinematic light, character-heavy human. Sells identity, not spec.',
    emotion: 'Identity · culture · editorial cool',
    useFor: 'Culturally-loaded products where the buyer is buying an identity, not a spec.',
    styleSuffix: 'warm cream and beige seamless backdrop, warm directional side light with cinematic falloff, character-driven editorial portrait, textured and human, film-like color grade, shallow depth of field, photorealistic, no text, no logos, no watermark',
  },
  {
    id: 'golden-hour',
    name: 'Golden Hour Documentary',
    tagline: 'Real environment, golden-hour backlight, sun flare, motion. Joy, energy, real life.',
    emotion: 'JOY · energy · real life · connection',
    useFor: 'Emotional-purchase hero shots. Launch campaigns, social ads, homepage banners.',
    styleSuffix: 'real-world environment, golden hour warm backlight with natural sun flare, documentary photojournalism style, candid genuine emotion and motion, dust and atmosphere catching the light, shallow depth of field, photorealistic, no text, no logos, no watermark',
  },
];
function getFormula(id) { return id ? FORMULAS.find((f) => f.id === id) || null : null; }
function applyFormula(prompt, formulaId) {
  const f = getFormula(formulaId);
  if (!f || !f.styleSuffix) return prompt;
  return `${prompt.replace(/\s*\.?\s*$/, '')}. Photography style: ${f.styleSuffix}`;
}

// ---------- Prompt engineering ----------
function copySystemPrompt() {
  return [
    'You are an elite direct-response social copywriter for TikTok, Instagram Reels, and short-form carousels.',
    'You are steeped in LF8 (Life Force 8): survival, food, freedom from fear/pain, sex, comfortable living, superiority, protection of loved ones, social approval.',
    'You apply Cialdini (reciprocity, commitment, social proof, authority, liking, scarcity) and evolutionary Buss drives (status, mating, tribe belonging).',
    '',
    'HARD RULES — do not violate:',
    '- NEVER use em-dashes.',
    '- Mobile paragraphs are 2-3 short lines max.',
    '- Inject the avatar\'s own language and internal monologue. Not corporate-speak. Not "elevate your journey".',
    '- Slide 1 is a HOOK that stops the scroll in the first 2 seconds. Concrete, specific, high-tension.',
    '- One idea per slide. No stacking.',
    '- Last slide has a soft CTA matched to the platform (link in bio / DM / save / comment).',
    '- Match the requested language exactly. If Hebrew, write in fluent native Hebrew, RTL-friendly, no English filler.',
    '- Output valid JSON only. No preamble, no code fences, no commentary. Just the JSON object.',
  ].join('\n');
}

function copyUserPrompt(brief, opts) {
  const lang = opts.language || brief.language || 'English';
  const slideCount = Math.max(3, Math.min(10, opts.slideCount || 4));
  const hookStyle = opts.hookStyle || 'curiosity gap';
  const format = opts.format || 'list';
  const formula = getFormula(opts.formula);
  return [
    'BRIEF:',
    `Name: ${brief.name}`,
    `Product / what we\'re promoting: ${brief.product}`,
    `Avatar (who this is for): ${brief.avatar}`,
    `Angle / core desire: ${brief.angle}`,
    `Tone / voice: ${brief.tone}`,
    brief.hooks?.length ? `Hooks the brand already uses: ${brief.hooks.join(' | ')}` : '',
    '',
    'TASK:',
    `Write a ${slideCount}-slide carousel post for this brand.`,
    `Hook style: ${hookStyle}`,
    `Structure: ${format}`,
    `Language: ${lang}`,
    '',
    formula ? [
      'PHOTOSHOOT FORMULA (apply to every image prompt):',
      `Formula: ${formula.name} — ${formula.tagline}`,
      `Emotional register: ${formula.emotion}`,
      'Write each slide\'s image prompt so the shot fits this formula\'s look and feeling. Keep the subject appropriate to the brief; the formula controls the photography, not the product.',
      '',
    ].join('\n') : '',
    'For each slide, also write a short cinematic image prompt (10-25 words, concrete, no logos, no text on image, no watermarks). The image should reinforce the slide\'s message, not compete with it.',
    '',
    'Return JSON in exactly this shape:',
    '{',
    '  "caption": "the caption for the post (short, 1-3 sentences, natural, plus 3-5 relevant hashtags at the end)",',
    '  "hashtags": ["#tag", "..."],',
    '  "slides": [',
    '    { "copy": "slide text", "imagePrompt": "concise visual prompt" }',
    '  ]',
    '}',
  ].filter(Boolean).join('\n');
}

function parseCopyJson(text) {
  // Claude sometimes wraps in ```json ... ```. Strip it.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  // Find first { and last } to be safe
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

// ---------- Business logic ----------
function findBrief(id) { return db.briefs.find((b) => b.id === id); }
function findPost(id) { return db.posts.find((p) => p.id === id); }
function findAccount(id) { return db.accounts.find((a) => a.id === id); }

// Publish a carousel's slides to TikTok via the official Content Posting API (photo mode).
// TikTok PULLS the images from public URLs, so slide assets must be reachable from the
// internet — set settings.publicBaseUrl to a tunnel (e.g. ngrok) pointing at this server.
// Unaudited dev apps can only send to the TikTok inbox as a draft (post_mode MEDIA_UPLOAD,
// privacy SELF_ONLY); DIRECT_POST needs an audited app. Defaults are chosen accordingly.
async function tiktokPublish(account, post, opts = {}) {
  if (!account || !account.accessToken) throw new Error('This TikTok account has no access token. Add one in Accounts.');
  const base = (db.settings.publicBaseUrl || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('TikTok pulls images from public URLs. Set a Public base URL (a tunnel like ngrok pointing at this server) in Settings first.');
  if (/localhost|127\.0\.0\.1/.test(base)) throw new Error('Public base URL cannot be localhost — TikTok\'s servers must be able to reach it. Use a public tunnel URL.');

  const images = post.slides.filter((s) => s.imageLocal).map((s) => `${base}/api/reel/asset/${s.imageLocal}`);
  if (!images.length) throw new Error('No generated slide images to publish.');

  const body = JSON.stringify({
    post_info: {
      title: (post.caption || '').slice(0, 90),
      description: [(post.caption || ''), (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n').slice(0, 4000),
      privacy_level: opts.privacyLevel || 'SELF_ONLY',
      disable_comment: false,
    },
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: images },
    post_mode: opts.postMode || 'MEDIA_UPLOAD',   // MEDIA_UPLOAD = draft in TikTok inbox (works for unaudited apps)
    media_type: 'PHOTO',
  });
  const r = await httpsRequest('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + account.accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  let data = {};
  try { data = JSON.parse(r.body.toString()); } catch {}
  if (r.status !== 200 || (data.error && data.error.code && data.error.code !== 'ok')) {
    const msg = (data.error && (data.error.message || data.error.code)) || r.body.toString().slice(0, 200);
    throw new Error(`TikTok ${r.status}: ${msg}`);
  }
  return { publishId: data.data && data.data.publish_id, imageCount: images.length, postMode: opts.postMode || 'MEDIA_UPLOAD' };
}

async function generateCarousel(briefId, opts) {
  const brief = findBrief(briefId);
  if (!brief) throw new Error('Brief not found');
  const s = db.settings;
  if (!s.anthropicKey) throw new Error('Set your Anthropic API key in Reel settings first.');
  if (!s.higgsKeyId || !s.higgsKeySecret) throw new Error('Set your Higgsfield API key ID and secret in Reel settings first.');

  const includeImages = opts.includeImages !== false;
  const model = opts.copyModel || 'claude-sonnet-5';

  // 1. Generate copy
  const raw = await anthropicMessages(
    s.anthropicKey, model,
    copySystemPrompt(),
    copyUserPrompt(brief, opts),
    4000
  );
  let parsed;
  try { parsed = parseCopyJson(raw); }
  catch (e) { throw new Error('Copy JSON parse failed. Raw response: ' + raw.slice(0, 400)); }

  // 2. Prepare post record
  const post = {
    id: randomUUID().slice(0, 8),
    briefId,
    type: 'carousel',
    hookStyle: opts.hookStyle || '',
    format: opts.format || '',
    formulaId: opts.formula || '',
    language: opts.language || brief.language || 'English',
    caption: parsed.caption || '',
    hashtags: parsed.hashtags || [],
    slides: (parsed.slides || []).map((sl) => ({
      copy: sl.copy || '',
      imagePrompt: sl.imagePrompt || '',
      imageUrl: '',    // absolute cloudfront URL
      imageLocal: '',  // local path relative to reel-assets/
    })),
    status: 'draft',
    createdAt: Date.now(),
  };

  // 3. Generate images (if requested) — sequential to respect rate limits
  if (includeImages) {
    const postDir = path.join(ASSETS_DIR, briefId, post.id);
    fs.mkdirSync(postDir, { recursive: true });
    const imgModel = opts.imageModel || 'nano_banana_pro';
    for (let i = 0; i < post.slides.length; i++) {
      const sl = post.slides[i];
      if (!sl.imagePrompt) continue;
      try {
        const submit = await higgsGenerateImage(
          s.higgsKeyId, s.higgsKeySecret, imgModel, applyFormula(sl.imagePrompt, post.formulaId), opts.aspectRatio || '3:4', '2k'
        );
        // JobSet shape: { jobs: [{ id, ... }] } OR direct { request_id }
        const reqId = submit.request_id || submit.id || submit.jobs?.[0]?.id || submit.jobs?.[0]?.request_id || null;
        if (!reqId) throw new Error('No request_id in submit response');
        const result = await higgsPollUntilDone(s.higgsKeyId, s.higgsKeySecret, reqId);
        const url = result.images?.[0]?.url || result.results?.[0]?.image?.url || result.output?.[0]?.url;
        if (!url) throw new Error('No image URL in result');
        const filename = `slide_${i + 1}.png`;
        const abs = path.join(postDir, filename);
        await downloadToFile(url, abs);
        sl.imageUrl = url;
        sl.imageLocal = `${briefId}/${post.id}/${filename}`;
      } catch (e) {
        sl.imageError = e.message.slice(0, 200);
      }
    }
  }

  db.posts.push(post);
  save();
  return post;
}

// ---------- Static asset serving ----------
function serveAsset(res, relPath) {
  const clean = path.normalize(relPath).replace(/^([\\/])+/, '');
  const full = path.join(ASSETS_DIR, clean);
  if (!full.startsWith(ASSETS_DIR)) { res.writeHead(403); res.end(); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- Router ----------
async function route(pathname, method, req, res, helpers) {
  const { json, readBody } = helpers;

  // Public state (briefs + posts index, no secrets)
  if (pathname === '/api/reel/state' && method === 'GET') {
    return json(res, 200, {
      briefs: db.briefs,
      formulas: FORMULAS.map((f) => ({ id: f.id, name: f.name, tagline: f.tagline, emotion: f.emotion, useFor: f.useFor })),
      posts: db.posts.map((p) => ({
        id: p.id, briefId: p.briefId, type: p.type, caption: p.caption, hashtags: p.hashtags,
        slides: p.slides.map((s) => ({ copy: s.copy, imagePrompt: s.imagePrompt, imageLocal: s.imageLocal, imageError: s.imageError })),
        status: p.status, createdAt: p.createdAt, hookStyle: p.hookStyle, format: p.format, formulaId: p.formulaId, language: p.language,
        published: p.published || [],
      })),
      accounts: db.accounts.map((a) => ({ id: a.id, label: a.label, platform: a.platform || 'tiktok', hasToken: !!a.accessToken })),
      activeAccountId: db.activeAccountId,
      settingsSet: {
        anthropic: !!db.settings.anthropicKey,
        higgsKeyId: !!db.settings.higgsKeyId,
        higgsKeySecret: !!db.settings.higgsKeySecret,
        publicBaseUrl: db.settings.publicBaseUrl || '',
      },
    });
  }

  // Settings (get returns only which are set; post saves)
  if (pathname === '/api/reel/settings' && method === 'POST') {
    const b = await readBody(req);
    if (b.anthropicKey !== undefined) db.settings.anthropicKey = String(b.anthropicKey || '').trim();
    if (b.higgsKeyId !== undefined) db.settings.higgsKeyId = String(b.higgsKeyId || '').trim();
    if (b.higgsKeySecret !== undefined) db.settings.higgsKeySecret = String(b.higgsKeySecret || '').trim();
    if (b.publicBaseUrl !== undefined) db.settings.publicBaseUrl = String(b.publicBaseUrl || '').trim();
    save();
    return json(res, 200, { ok: true });
  }

  // ---- Social accounts (TikTok etc.) ----
  if (pathname === '/api/reel/account' && method === 'POST') {
    const b = await readBody(req);
    if (b.id) {
      const acct = findAccount(b.id);
      if (!acct) return json(res, 404, { error: 'Account not found' });
      if (b.label !== undefined) acct.label = String(b.label || '').trim() || acct.label;
      if (b.platform !== undefined) acct.platform = b.platform || acct.platform;
      if (b.accessToken) acct.accessToken = String(b.accessToken).trim();   // keep old if blank
      if (b.openId !== undefined) acct.openId = String(b.openId || '').trim();
      save();
      return json(res, 200, { id: acct.id, label: acct.label, platform: acct.platform, hasToken: !!acct.accessToken });
    }
    const acct = {
      id: randomUUID().slice(0, 8),
      label: String(b.label || '').trim() || 'Untitled account',
      platform: b.platform || 'tiktok',
      accessToken: String(b.accessToken || '').trim(),
      openId: String(b.openId || '').trim(),
      addedAt: Date.now(),
    };
    db.accounts.push(acct);
    if (!db.activeAccountId) db.activeAccountId = acct.id;
    save();
    return json(res, 200, { id: acct.id, label: acct.label, platform: acct.platform, hasToken: !!acct.accessToken });
  }
  const acctDelMatch = pathname.match(/^\/api\/reel\/account\/([^/]+)$/);
  if (acctDelMatch && method === 'DELETE') {
    const aid = acctDelMatch[1];
    const idx = db.accounts.findIndex((a) => a.id === aid);
    if (idx < 0) return json(res, 404, { error: 'Account not found' });
    db.accounts.splice(idx, 1);
    if (db.activeAccountId === aid) db.activeAccountId = db.accounts[0] ? db.accounts[0].id : '';
    save();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/reel/account/active' && method === 'POST') {
    const b = await readBody(req);
    if (b.id && !findAccount(b.id)) return json(res, 404, { error: 'Account not found' });
    db.activeAccountId = b.id || '';
    save();
    return json(res, 200, { ok: true, activeAccountId: db.activeAccountId });
  }

  // Briefs
  if (pathname === '/api/reel/brief' && method === 'POST') {
    const b = await readBody(req);
    if (b.id) {
      const brief = findBrief(b.id);
      if (!brief) return json(res, 404, { error: 'Brief not found' });
      Object.assign(brief, {
        name: b.name || brief.name,
        product: b.product ?? brief.product,
        avatar: b.avatar ?? brief.avatar,
        angle: b.angle ?? brief.angle,
        tone: b.tone ?? brief.tone,
        hooks: Array.isArray(b.hooks) ? b.hooks : brief.hooks,
        language: b.language || brief.language,
        updatedAt: Date.now(),
      });
      save();
      return json(res, 200, brief);
    } else {
      const brief = {
        id: randomUUID().slice(0, 8),
        name: b.name || 'Untitled brief',
        product: b.product || '',
        avatar: b.avatar || '',
        angle: b.angle || '',
        tone: b.tone || '',
        hooks: Array.isArray(b.hooks) ? b.hooks : [],
        language: b.language || 'English',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.briefs.push(brief);
      save();
      return json(res, 200, brief);
    }
  }
  let m;
  // Duplicate a brief (for A/B testing variants) — copies fields, NOT posts
  if ((m = pathname.match(/^\/api\/reel\/brief\/([^/]+)\/duplicate$/)) && method === 'POST') {
    const src = findBrief(m[1]);
    if (!src) return json(res, 404, { error: 'Brief not found' });
    const copy = {
      id: randomUUID().slice(0, 8),
      name: `${src.name} (variant)`,
      product: src.product,
      avatar: src.avatar,
      angle: src.angle,
      tone: src.tone,
      hooks: Array.isArray(src.hooks) ? src.hooks.slice() : [],
      language: src.language || 'English',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.briefs.push(copy);
    save();
    return json(res, 200, copy);
  }
  if ((m = pathname.match(/^\/api\/reel\/brief\/([^/]+)$/)) && method === 'DELETE') {
    const idx = db.briefs.findIndex((x) => x.id === m[1]);
    if (idx < 0) return json(res, 404, { error: 'Brief not found' });
    db.briefs.splice(idx, 1);
    db.posts = db.posts.filter((p) => p.briefId !== m[1]);
    save();
    return json(res, 200, { ok: true });
  }

  // Generate
  if (pathname === '/api/reel/generate' && method === 'POST') {
    const b = await readBody(req);
    try {
      const post = await generateCarousel(b.briefId, {
        hookStyle: b.hookStyle,
        format: b.format,
        formula: b.formula,
        slideCount: b.slideCount,
        language: b.language,
        includeImages: b.includeImages !== false,
        copyModel: b.copyModel,
        imageModel: b.imageModel,
        aspectRatio: b.aspectRatio,
      });
      return json(res, 200, {
        id: post.id, briefId: post.briefId, type: post.type,
        caption: post.caption, hashtags: post.hashtags,
        slides: post.slides.map((s) => ({ copy: s.copy, imagePrompt: s.imagePrompt, imageLocal: s.imageLocal, imageError: s.imageError })),
        status: post.status, createdAt: post.createdAt,
      });
    } catch (e) {
      console.log('  (reel: generate failed:', e.message, ')');
      return json(res, 400, { error: e.message });
    }
  }

  // Regenerate a single slide's image
  if ((m = pathname.match(/^\/api\/reel\/post\/([^/]+)\/slide\/(\d+)\/regen-image$/)) && method === 'POST') {
    const post = findPost(m[1]);
    if (!post) return json(res, 404, { error: 'Post not found' });
    const idx = parseInt(m[2], 10);
    if (idx < 0 || idx >= post.slides.length) return json(res, 400, { error: 'Slide index out of range' });
    const s = db.settings;
    if (!s.higgsKeyId || !s.higgsKeySecret) return json(res, 400, { error: 'Set your Higgsfield API keys first' });
    const b = await readBody(req);
    const slide = post.slides[idx];
    if (typeof b.imagePrompt === 'string' && b.imagePrompt.trim()) slide.imagePrompt = b.imagePrompt.trim();
    if (!slide.imagePrompt) return json(res, 400, { error: 'No image prompt on this slide' });
    const imgModel = b.imageModel || 'nano_banana_pro';
    const aspectRatio = b.aspectRatio || '3:4';
    const formulaId = (typeof b.formula === 'string') ? b.formula : post.formulaId;
    try {
      const postDir = path.join(ASSETS_DIR, post.briefId, post.id);
      fs.mkdirSync(postDir, { recursive: true });
      const submit = await higgsGenerateImage(s.higgsKeyId, s.higgsKeySecret, imgModel, applyFormula(slide.imagePrompt, formulaId), aspectRatio, '2k');
      const reqId = submit.request_id || submit.id || submit.jobs?.[0]?.id || submit.jobs?.[0]?.request_id || null;
      if (!reqId) throw new Error('No request_id in submit response');
      const result = await higgsPollUntilDone(s.higgsKeyId, s.higgsKeySecret, reqId);
      const url = result.images?.[0]?.url || result.results?.[0]?.image?.url || result.output?.[0]?.url;
      if (!url) throw new Error('No image URL in result');
      const filename = `slide_${idx + 1}_v${Date.now()}.png`;
      const abs = path.join(postDir, filename);
      await downloadToFile(url, abs);
      slide.imageUrl = url;
      slide.imageLocal = `${post.briefId}/${post.id}/${filename}`;
      delete slide.imageError;
      save();
      return json(res, 200, { slide });
    } catch (e) {
      slide.imageError = e.message.slice(0, 200);
      save();
      return json(res, 400, { error: e.message });
    }
  }

  // Edit slide copy and/or image prompt (no regeneration — manual edit)
  if ((m = pathname.match(/^\/api\/reel\/post\/([^/]+)\/slide\/(\d+)$/)) && method === 'POST') {
    const post = findPost(m[1]);
    if (!post) return json(res, 404, { error: 'Post not found' });
    const idx = parseInt(m[2], 10);
    if (idx < 0 || idx >= post.slides.length) return json(res, 400, { error: 'Slide index out of range' });
    const b = await readBody(req);
    const slide = post.slides[idx];
    if (typeof b.copy === 'string') slide.copy = b.copy;
    if (typeof b.imagePrompt === 'string') slide.imagePrompt = b.imagePrompt;
    save();
    return json(res, 200, { slide });
  }

  // Edit post caption + hashtags
  if ((m = pathname.match(/^\/api\/reel\/post\/([^/]+)\/meta$/)) && method === 'POST') {
    const post = findPost(m[1]);
    if (!post) return json(res, 404, { error: 'Post not found' });
    const b = await readBody(req);
    if (typeof b.caption === 'string') post.caption = b.caption;
    if (Array.isArray(b.hashtags)) post.hashtags = b.hashtags;
    save();
    return json(res, 200, { caption: post.caption, hashtags: post.hashtags });
  }

  // Publish a post to TikTok (active account, or one named in the body)
  if ((m = pathname.match(/^\/api\/reel\/post\/([^/]+)\/publish$/)) && method === 'POST') {
    const post = findPost(m[1]);
    if (!post) return json(res, 404, { error: 'Post not found' });
    const b = await readBody(req);
    const account = findAccount(b.accountId || db.activeAccountId);
    if (!account) return json(res, 400, { error: 'No TikTok account selected. Add one and pick it as active in Accounts.' });
    try {
      const r = await tiktokPublish(account, post, { postMode: b.postMode, privacyLevel: b.privacyLevel });
      post.published = post.published || [];
      post.published.push({ accountId: account.id, label: account.label, publishId: r.publishId, postMode: r.postMode, at: Date.now() });
      save();
      return json(res, 200, { ok: true, ...r, account: account.label });
    } catch (e) {
      console.log('  (reel: publish failed:', e.message, ')');
      return json(res, 400, { error: e.message });
    }
  }

  // Delete post
  if ((m = pathname.match(/^\/api\/reel\/post\/([^/]+)$/)) && method === 'DELETE') {
    const idx = db.posts.findIndex((p) => p.id === m[1]);
    if (idx < 0) return json(res, 404, { error: 'Post not found' });
    db.posts.splice(idx, 1);
    save();
    return json(res, 200, { ok: true });
  }

  // Static assets — /api/reel/asset/<briefId>/<postId>/<file>
  if ((m = pathname.match(/^\/api\/reel\/asset\/(.+)$/)) && method === 'GET') {
    return serveAsset(res, decodeURIComponent(m[1]));
  }

  return false;
}

module.exports = { route };
