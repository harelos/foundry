// The Reel — content atelier inside Foundry.
// Self-contained mini-app. Exposes window.ReelUI = { render(container) }.

(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    briefs: [],
    posts: [],
    formulas: [],
    settingsSet: { anthropic: false, higgsKeyId: false, higgsKeySecret: false },
    view: 'home',              // home | briefEditor | brief | generator | result | settings
    selectedBriefId: null,
    selectedPostId: null,
    editingBriefId: null,
    generating: false,
    genProgress: '',
    lastError: '',
    // Per-slide editing state (all indices into selected post's slides array; null = none)
    editingSlideCopy: null,    // which slide's copy is in edit mode
    regenSlideIdx: null,       // which slide has the regen form open
    regeneratingSlideIdx: null, // which slide is currently being regenerated
    editingCaption: false,     // caption edit mode
  };

  let container = null;
  let stylesInjected = false;

  // ---------- Helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (attrs[k] === false || attrs[k] == null) continue;
      else el.setAttribute(k, attrs[k]);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }
  const $ = (sel, root) => (root || container).querySelector(sel);
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const fmt = (t) => {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api/reel' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function refresh() {
    try {
      const s = await api('/state');
      state.briefs = s.briefs || [];
      state.posts = s.posts || [];
      state.formulas = s.formulas || [];
      state.settingsSet = s.settingsSet || {};
    } catch (e) { state.lastError = e.message; }
  }

  // ---------- Styles ----------
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      #reelView { position:relative; overflow:hidden; display:flex; flex-direction:column; height:100%; }
      .reel-shell { display:grid; grid-template-columns:280px 1fr; height:100%; overflow:hidden; }

      /* Sidebar */
      .reel-side { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; overflow:hidden; }
      .reel-side-head { padding:20px 18px 14px; border-bottom:1px solid var(--line); }
      .reel-brand { font-family:var(--font-display); font-size:20px; font-weight:600; color:var(--text); letter-spacing:-0.01em; }
      .reel-brand em { color:var(--accent); font-style:normal; }
      .reel-tag { font-size:11px; color:var(--muted); letter-spacing:0.5px; text-transform:uppercase; margin-top:4px; font-family:var(--font-mono); }

      .reel-side-scroll { flex:1; overflow-y:auto; padding:10px 8px 12px; }
      .reel-brief-item {
        display:block; width:100%; text-align:left; cursor:pointer;
        padding:10px 12px; border-radius:8px; margin-bottom:4px;
        background:transparent; border:1px solid transparent; color:var(--text);
        transition:background .12s, border-color .12s;
      }
      .reel-brief-item:hover { background:var(--panel2); border-color:var(--line); }
      .reel-brief-item.on { background:var(--accent-soft); border-color:var(--accent); }
      .reel-brief-item .b-name { font-weight:600; font-size:14px; letter-spacing:-0.005em; }
      .reel-brief-item .b-sub { font-size:11px; color:var(--muted); margin-top:2px; font-family:var(--font-mono); }
      .reel-brief-item .b-count { display:inline-block; background:var(--surface); color:var(--muted); font-family:var(--font-mono); font-size:10px; padding:2px 6px; border-radius:8px; margin-left:6px; }
      .reel-brief-item.on .b-count { background:var(--accent); color:#141210; }

      .reel-side-foot { padding:12px; border-top:1px solid var(--line); display:flex; gap:6px; }
      .reel-btn {
        background:var(--surface); color:var(--text); border:1px solid var(--line);
        padding:9px 14px; border-radius:8px; cursor:pointer;
        font:600 13px var(--font-body); letter-spacing:-0.005em;
        transition:background .12s, border-color .12s;
      }
      .reel-btn:hover { background:var(--panel2); border-color:var(--muted); }
      .reel-btn.primary { background:var(--accent); color:#141210; border-color:var(--accent); }
      .reel-btn.primary:hover { background:#f2b559; border-color:#f2b559; }
      .reel-btn.ghost { background:transparent; }
      .reel-btn.small { padding:6px 10px; font-size:12px; }
      .reel-btn.danger { color:var(--err); border-color:var(--err); }
      .reel-btn.danger:hover { background:var(--err-soft); }
      .reel-btn.big { padding:12px 20px; font-size:14px; }
      .reel-btn:disabled { opacity:0.4; cursor:not-allowed; }

      /* Main */
      .reel-main { padding:32px 40px; overflow-y:auto; background:var(--canvas); }
      .reel-head { display:flex; align-items:baseline; gap:12px; margin-bottom:8px; }
      .reel-title { font-family:var(--font-display); font-size:32px; font-weight:600; letter-spacing:-0.02em; color:var(--text); }
      .reel-subtitle { color:var(--muted); font-family:var(--font-mono); font-size:12px; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:24px; }
      .reel-crumb { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; font-family:var(--font-mono); margin-bottom:20px; }
      .reel-crumb a { color:var(--muted); text-decoration:none; cursor:pointer; }
      .reel-crumb a:hover { color:var(--accent); }

      /* Empty / prompts */
      .reel-empty { text-align:center; padding:64px 24px; color:var(--muted); }
      .reel-empty .big-num { font-family:var(--font-display); font-size:64px; color:var(--dim); line-height:1; margin-bottom:16px; }
      .reel-empty h2 { font-family:var(--font-display); color:var(--text); font-weight:600; letter-spacing:-0.01em; margin:0 0 8px; }
      .reel-empty p { margin:0 auto 20px; max-width:440px; }

      /* Brief detail */
      .reel-brief-info { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:28px; }
      .reel-info-cell { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
      .reel-info-cell.wide { grid-column:span 2; }
      .reel-info-cell h4 { margin:0 0 6px; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:var(--muted); font-family:var(--font-mono); font-weight:500; }
      .reel-info-cell p { margin:0; color:var(--text); line-height:1.55; }
      .reel-info-cell .empty-cell { color:var(--dim); font-style:italic; }
      .reel-info-actions { display:flex; gap:8px; margin-bottom:28px; }

      /* Posts grid */
      .reel-section-title { font-family:var(--font-display); font-size:20px; font-weight:600; margin:0 0 12px; letter-spacing:-0.01em; color:var(--text); }
      .reel-section-title .num { font-family:var(--font-mono); font-size:12px; color:var(--muted); margin-left:8px; font-weight:400; }
      .reel-posts-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:16px; }
      .reel-post-card {
        background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden;
        cursor:pointer; transition:transform .15s, border-color .15s;
      }
      .reel-post-card:hover { transform:translateY(-2px); border-color:var(--accent); }
      .reel-post-thumb { aspect-ratio:3/4; background:var(--input); background-size:cover; background-position:center; }
      .reel-post-thumb.no-image { display:flex; align-items:center; justify-content:center; color:var(--dim); font-family:var(--font-mono); font-size:11px; }
      .reel-post-meta { padding:10px 12px; font-size:11px; color:var(--muted); font-family:var(--font-mono); }
      .reel-post-meta .p-copy { color:var(--text); font-family:var(--font-body); font-size:12px; line-height:1.4; margin-bottom:4px;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }

      /* Briefs grid (home) */
      .reel-brief-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:18px; }
      .reel-brief-card {
        background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:22px 22px 18px;
        cursor:pointer; transition:transform .15s, border-color .15s, background .15s;
      }
      .reel-brief-card:hover { transform:translateY(-3px); border-color:var(--accent); background:var(--panel2); }
      .reel-brief-card h3 { margin:0 0 4px; font-family:var(--font-display); font-weight:600; font-size:20px; letter-spacing:-0.01em; }
      .reel-brief-card .b-lang { display:inline-block; background:var(--surface); border:1px solid var(--line); color:var(--muted); font-family:var(--font-mono); font-size:10px; padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:0.5px; }
      .reel-brief-card .b-desc { color:var(--muted); font-size:13px; margin:12px 0 16px; line-height:1.5; min-height:60px;
        display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .reel-brief-card .b-foot { display:flex; align-items:center; justify-content:space-between; padding-top:12px; border-top:1px solid var(--line); font-family:var(--font-mono); font-size:11px; color:var(--muted); }
      .reel-add-tile {
        background:transparent; border:2px dashed var(--line); border-radius:12px; padding:32px 22px;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        cursor:pointer; color:var(--muted); transition:border-color .15s, color .15s;
        min-height:180px;
      }
      .reel-add-tile:hover { border-color:var(--accent); color:var(--accent); }
      .reel-add-tile .plus { font-size:28px; margin-bottom:6px; font-family:var(--font-display); }

      /* Editor form */
      .reel-form { max-width:640px; }
      .reel-field { margin-bottom:18px; }
      .reel-field label { display:block; font-size:11px; color:var(--muted); letter-spacing:0.5px; text-transform:uppercase; font-family:var(--font-mono); margin-bottom:6px; font-weight:500; }
      .reel-field .hint { font-size:12px; color:var(--dim); font-family:var(--font-body); margin-top:4px; letter-spacing:0; text-transform:none; }
      .reel-field input[type=text], .reel-field textarea, .reel-field select {
        width:100%; background:var(--input); border:1px solid var(--line); border-radius:8px;
        color:var(--text); padding:11px 14px; font:14px var(--font-body); letter-spacing:-0.005em;
        transition:border-color .12s;
      }
      .reel-field input:focus, .reel-field textarea:focus, .reel-field select:focus { outline:none; border-color:var(--accent); }
      .reel-field textarea { resize:vertical; min-height:80px; line-height:1.5; }
      .reel-form-actions { display:flex; gap:10px; margin-top:24px; }

      /* Generator */
      .reel-gen-form { display:grid; grid-template-columns:1fr 1fr; gap:14px 20px; max-width:640px; }
      .reel-gen-form .full { grid-column:span 2; }

      /* Result view */
      .reel-slides { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:20px; margin-top:20px; }
      .reel-slide {
        background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden;
      }
      .reel-slide .s-img { aspect-ratio:3/4; background:var(--input); background-size:cover; background-position:center; position:relative; }
      .reel-slide .s-img.missing { display:flex; align-items:center; justify-content:center; color:var(--err); font-family:var(--font-mono); font-size:11px; text-align:center; padding:16px; }
      .reel-slide .s-img.regenerating { display:flex; flex-direction:column; align-items:center; justify-content:center; background:linear-gradient(135deg, var(--input) 0%, var(--panel2) 100%); }
      .reel-slide .s-num { position:absolute; top:10px; left:10px; background:rgba(20,18,16,0.85); color:var(--accent); font-family:var(--font-mono); font-size:11px; padding:4px 8px; border-radius:6px; }
      .reel-slide .s-copy { padding:14px 16px 4px; font-size:14px; line-height:1.55; color:var(--text); white-space:pre-wrap; }
      .reel-slide .s-actions { padding:6px 12px 14px; display:flex; gap:6px; flex-wrap:wrap; }
      .reel-slide .s-actions .reel-btn { padding:5px 10px; font-size:11px; font-weight:500; }
      .reel-slide .s-edit { padding:14px 16px; display:flex; flex-direction:column; gap:4px; background:var(--panel2); border-top:1px solid var(--line); }
      .reel-slide .s-edit label { font-family:var(--font-mono); font-size:10px; letter-spacing:1px; color:var(--muted); text-transform:uppercase; font-weight:500; margin-bottom:4px; }
      .reel-slide .s-edit textarea, .reel-slide .s-edit select, .reel-slide .s-edit input { width:100%; background:var(--input); border:1px solid var(--line); color:var(--text); border-radius:6px; padding:8px 10px; font:13px var(--font-body); resize:vertical; font-family:var(--font-body); }
      .reel-slide .s-edit textarea:focus, .reel-slide .s-edit select:focus, .reel-slide .s-edit input:focus { outline:none; border-color:var(--accent); }
      .reel-slide .s-edit-actions { display:flex; gap:6px; margin-top:10px; }
      .reel-slide .s-regen-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; }
      .reel-slide .s-regen-field { display:flex; flex-direction:column; }
      .mini-spinner { display:inline-block; width:22px; height:22px; border:2px solid var(--surface); border-top-color:var(--accent); border-radius:50%; animation:reel-spin 1s linear infinite; }

      .reel-caption-box { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; margin-top:24px; }
      .reel-caption-box h4 { margin:0 0 8px; font-size:11px; color:var(--muted); letter-spacing:0.5px; text-transform:uppercase; font-family:var(--font-mono); font-weight:500; }
      .reel-caption-box p { margin:0 0 8px; color:var(--text); line-height:1.55; white-space:pre-wrap; }
      .reel-caption-box .tags { color:var(--accent); font-family:var(--font-mono); font-size:13px; }
      .reel-copy-row { display:flex; gap:8px; margin-top:12px; }

      /* Loading state */
      .reel-loading { text-align:center; padding:80px 24px; }
      .reel-loading .spinner {
        display:inline-block; width:40px; height:40px; border:3px solid var(--surface);
        border-top-color:var(--accent); border-radius:50%;
        animation:reel-spin 1s linear infinite;
      }
      @keyframes reel-spin { to { transform:rotate(360deg); } }
      .reel-loading h3 { font-family:var(--font-display); font-weight:600; margin:20px 0 8px; letter-spacing:-0.01em; }
      .reel-loading p { color:var(--muted); font-family:var(--font-mono); font-size:12px; letter-spacing:0.5px; }

      .reel-error {
        background:var(--err-soft); border:1px solid var(--err); border-radius:8px;
        padding:12px 16px; margin-bottom:16px; color:var(--err); font-family:var(--font-mono); font-size:13px;
      }

      /* Settings panel */
      .reel-settings-status { display:inline-flex; gap:6px; align-items:center; font-family:var(--font-mono); font-size:11px; margin-left:8px; }
      .reel-settings-status.ok { color:var(--accent2); }
      .reel-settings-status.miss { color:var(--muted); }
      .reel-settings-status.miss::before { content:'○'; }
      .reel-settings-status.ok::before { content:'●'; }

      /* Toolbar row */
      .reel-toolbar { display:flex; gap:8px; margin-bottom:20px; align-items:center; }
      .reel-toolbar .spacer { flex:1; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- Rendering ----------
  function render(root) {
    container = root;
    injectStyles();
    clear(container);
    const shell = h('div', { class: 'reel-shell' });
    shell.append(renderSidebar(), renderMain());
    container.append(shell);
  }

  function renderSidebar() {
    const side = h('div', { class: 'reel-side' });
    const head = h('div', { class: 'reel-side-head' });
    head.append(
      h('div', { class: 'reel-brand' }, 'The ', h('em', {}, 'Reel')),
      h('div', { class: 'reel-tag' }, 'content atelier')
    );
    side.append(head);

    const scroll = h('div', { class: 'reel-side-scroll' });
    if (state.briefs.length === 0) {
      scroll.append(h('div', { style: { padding: '12px', color: 'var(--dim)', fontSize: '13px', textAlign: 'center' } },
        'No briefs yet. Create your first one to get started.'));
    } else {
      state.briefs
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .forEach((b) => {
          const postCount = state.posts.filter((p) => p.briefId === b.id).length;
          const item = h('button', {
            class: 'reel-brief-item' + (state.selectedBriefId === b.id && (state.view === 'brief' || state.view === 'generator' || state.view === 'result') ? ' on' : ''),
            onclick: () => { state.selectedBriefId = b.id; state.view = 'brief'; render(container); }
          },
          h('div', { class: 'b-name' }, b.name, postCount > 0 ? h('span', { class: 'b-count' }, String(postCount)) : ''),
          h('div', { class: 'b-sub' }, (b.language || 'English').toUpperCase())
          );
          scroll.append(item);
        });
    }
    side.append(scroll);

    const foot = h('div', { class: 'reel-side-foot' });
    foot.append(
      h('button', {
        class: 'reel-btn primary',
        style: { flex: 1 },
        onclick: () => { state.editingBriefId = null; state.view = 'briefEditor'; render(container); }
      }, '+ New brief'),
      h('button', {
        class: 'reel-btn ghost',
        title: 'Settings — API keys',
        onclick: () => { state.view = 'settings'; render(container); }
      }, '⚙')
    );
    side.append(foot);
    return side;
  }

  function renderMain() {
    const main = h('div', { class: 'reel-main' });
    if (state.view === 'briefEditor') return renderBriefEditor(main);
    if (state.view === 'brief') return renderBriefDetail(main);
    if (state.view === 'generator') return renderGenerator(main);
    if (state.view === 'result') return renderResult(main);
    if (state.view === 'settings') return renderSettings(main);
    return renderHome(main);
  }

  function renderHome(main) {
    main.append(
      h('div', { class: 'reel-head' },
        h('div', { class: 'reel-title' }, 'Your briefs'),
      ),
      h('div', { class: 'reel-subtitle' }, 'each brief is one thing you\'re promoting — an app, a service, an info product, an offer.')
    );

    if (!state.settingsSet.anthropic || !state.settingsSet.higgsKeyId || !state.settingsSet.higgsKeySecret) {
      const banner = h('div', {
        class: 'reel-error',
        style: { background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)', cursor: 'pointer' },
        onclick: () => { state.view = 'settings'; render(container); }
      }, '⚙ Before you can generate — set your Anthropic + Higgsfield API keys in Settings.');
      main.append(banner);
    }

    const grid = h('div', { class: 'reel-brief-grid' });
    state.briefs
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .forEach((b) => {
        const postCount = state.posts.filter((p) => p.briefId === b.id).length;
        const card = h('div', {
          class: 'reel-brief-card',
          onclick: () => { state.selectedBriefId = b.id; state.view = 'brief'; render(container); }
        },
          h('h3', {}, b.name),
          h('span', { class: 'b-lang' }, (b.language || 'English')),
          h('div', { class: 'b-desc' }, b.product || 'No product summary yet.'),
          h('div', { class: 'b-foot' },
            h('span', {}, postCount + ' post' + (postCount === 1 ? '' : 's')),
            h('span', {}, b.updatedAt ? fmt(b.updatedAt) : '—')
          )
        );
        grid.append(card);
      });

    // Add tile
    const add = h('div', {
      class: 'reel-add-tile',
      onclick: () => { state.editingBriefId = null; state.view = 'briefEditor'; render(container); }
    },
      h('div', { class: 'plus' }, '+'),
      h('div', {}, 'New brief')
    );
    grid.append(add);
    main.append(grid);
    return main;
  }

  function renderBriefEditor(main) {
    const editing = state.editingBriefId ? state.briefs.find((b) => b.id === state.editingBriefId) : null;
    const b = editing || { name: '', product: '', avatar: '', angle: '', tone: '', hooks: [], language: 'English' };

    main.append(
      h('div', { class: 'reel-crumb' },
        h('a', { onclick: () => { state.view = editing ? 'brief' : 'home'; render(container); } }, editing ? '← back to brief' : '← back to briefs')
      ),
      h('div', { class: 'reel-title' }, editing ? 'Edit brief' : 'New brief'),
      h('div', { class: 'reel-subtitle' }, 'the more specific you are here, the sharper the copy comes out.')
    );

    const form = h('div', { class: 'reel-form' });
    const val = {};

    const mkField = (name, label, hint, type = 'text', defaultVal = '') => {
      const field = h('div', { class: 'reel-field' });
      field.append(h('label', {}, label));
      let input;
      if (type === 'textarea') {
        input = h('textarea', { rows: 3 });
        input.value = defaultVal;
      } else if (type === 'select') {
        input = h('select', {});
        ['English', 'Hebrew', 'Spanish', 'Portuguese', 'French'].forEach((lang) => {
          const opt = h('option', { value: lang }, lang);
          if (lang === defaultVal) opt.selected = true;
          input.append(opt);
        });
      } else {
        input = h('input', { type: 'text', value: defaultVal });
      }
      val[name] = () => input.value;
      field.append(input);
      if (hint) field.append(h('div', { class: 'hint' }, hint));
      return field;
    };

    form.append(
      mkField('name', 'Brief name', 'A short identifier for you — e.g. "Pack v1 launch", "September promo".', 'text', b.name),
      mkField('product', 'What we\'re promoting', 'Product / service / offer in 2-4 lines. What it is, who it\'s for, what makes it distinct.', 'textarea', b.product),
      mkField('avatar', 'Avatar (who is this for)', 'The specific person — age, situation, pain, dream. The more concrete, the better.', 'textarea', b.avatar),
      mkField('angle', 'Angle / core desire', 'The LF8 desire you\'re hitting. Status? Fear of missing out? Getting the body they want? Ending the guilt of skipping workouts?', 'textarea', b.angle),
      mkField('tone', 'Tone / voice', 'How the brand sounds. Blunt? Warm? Nerdy? Cinematic? Sample lines are great here.', 'textarea', b.tone),
      mkField('language', 'Language', 'What language the copy should be written in.', 'select', b.language || 'English'),
    );

    const hooksField = h('div', { class: 'reel-field' });
    hooksField.append(h('label', {}, 'Existing hooks (optional)'));
    const hooksInput = h('textarea', { rows: 3, placeholder: 'One hook per line. The AI will match this style.' });
    hooksInput.value = (b.hooks || []).join('\n');
    val.hooks = () => hooksInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
    hooksField.append(hooksInput);
    form.append(hooksField);

    const actions = h('div', { class: 'reel-form-actions' });
    actions.append(
      h('button', {
        class: 'reel-btn primary',
        onclick: async () => {
          const payload = { name: val.name(), product: val.product(), avatar: val.avatar(), angle: val.angle(), tone: val.tone(), language: val.language(), hooks: val.hooks() };
          if (editing) payload.id = editing.id;
          try {
            const saved = await api('/brief', { method: 'POST', body: payload });
            await refresh();
            state.selectedBriefId = saved.id;
            state.view = 'brief';
            state.editingBriefId = null;
            render(container);
          } catch (e) { state.lastError = e.message; render(container); }
        }
      }, editing ? 'Save changes' : 'Create brief'),
      h('button', {
        class: 'reel-btn ghost',
        onclick: () => { state.view = editing ? 'brief' : 'home'; render(container); }
      }, 'Cancel')
    );

    if (editing) {
      actions.append(
        h('div', { style: { flex: 1 } }),
        h('button', {
          class: 'reel-btn danger',
          onclick: async () => {
            if (!confirm(`Delete brief "${editing.name}" and all its posts? This cannot be undone.`)) return;
            try { await api('/brief/' + editing.id, { method: 'DELETE' }); await refresh(); state.selectedBriefId = null; state.view = 'home'; render(container); }
            catch (e) { state.lastError = e.message; render(container); }
          }
        }, 'Delete brief')
      );
    }

    form.append(actions);
    if (state.lastError) main.append(h('div', { class: 'reel-error' }, state.lastError));
    main.append(form);
    state.lastError = '';
    return main;
  }

  function renderBriefDetail(main) {
    const b = state.briefs.find((x) => x.id === state.selectedBriefId);
    if (!b) { state.view = 'home'; return renderHome(main); }
    const posts = state.posts.filter((p) => p.briefId === b.id).sort((a, x) => (x.createdAt || 0) - (a.createdAt || 0));

    main.append(
      h('div', { class: 'reel-crumb' }, h('a', { onclick: () => { state.view = 'home'; render(container); } }, '← briefs'), ' / ', b.name),
      h('div', { class: 'reel-head' }, h('div', { class: 'reel-title' }, b.name)),
      h('div', { class: 'reel-subtitle' }, (b.language || 'English').toUpperCase() + ' · ' + posts.length + ' post' + (posts.length === 1 ? '' : 's'))
    );

    // Toolbar
    const tb = h('div', { class: 'reel-toolbar' });
    tb.append(
      h('button', {
        class: 'reel-btn primary big',
        onclick: () => { state.view = 'generator'; render(container); }
      }, '+ New carousel'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'reel-btn ghost',
        title: 'Copy this brief into a new "(variant)" for A/B testing',
        onclick: async () => {
          try {
            const dup = await api('/brief/' + b.id + '/duplicate', { method: 'POST' });
            await refresh();
            state.selectedBriefId = dup.id;
            render(container);
          } catch (e) { state.lastError = e.message; render(container); }
        }
      }, '⧉ Duplicate'),
      h('button', {
        class: 'reel-btn ghost',
        onclick: () => { state.editingBriefId = b.id; state.view = 'briefEditor'; render(container); }
      }, 'Edit brief')
    );
    main.append(tb);
    if (state.lastError) { main.append(h('div', { class: 'reel-error' }, state.lastError)); state.lastError = ''; }

    // Brief info grid
    const info = h('div', { class: 'reel-brief-info' });
    const cell = (label, value, wide) => {
      const c = h('div', { class: 'reel-info-cell' + (wide ? ' wide' : '') });
      c.append(h('h4', {}, label));
      if (value && String(value).trim()) c.append(h('p', {}, value));
      else c.append(h('p', { class: 'empty-cell' }, '(empty — add it in Edit brief)'));
      return c;
    };
    info.append(
      cell('Product', b.product, true),
      cell('Avatar', b.avatar),
      cell('Angle', b.angle),
      cell('Tone', b.tone),
      cell('Hooks', (b.hooks && b.hooks.length) ? b.hooks.join(' · ') : '')
    );
    main.append(info);

    // Posts
    main.append(h('h3', { class: 'reel-section-title' }, 'Posts', h('span', { class: 'num' }, String(posts.length))));
    if (posts.length === 0) {
      main.append(h('div', { class: 'reel-empty', style: { padding: '32px 16px' } },
        h('p', {}, 'No posts yet. Click "New carousel" to generate your first one.')
      ));
    } else {
      const grid = h('div', { class: 'reel-posts-grid' });
      posts.forEach((p) => {
        const firstImg = p.slides.find((s) => s.imageLocal);
        const thumb = firstImg
          ? h('div', { class: 'reel-post-thumb', style: { backgroundImage: `url('/api/reel/asset/${firstImg.imageLocal}')` } })
          : h('div', { class: 'reel-post-thumb no-image' }, p.slides.length + ' slides');
        const card = h('div', {
          class: 'reel-post-card',
          onclick: () => { state.selectedPostId = p.id; state.view = 'result'; render(container); }
        },
          thumb,
          h('div', { class: 'reel-post-meta' },
            h('div', { class: 'p-copy' }, p.slides[0]?.copy || ''),
            fmt(p.createdAt)
          )
        );
        grid.append(card);
      });
      main.append(grid);
    }
    return main;
  }

  function renderGenerator(main) {
    const b = state.briefs.find((x) => x.id === state.selectedBriefId);
    if (!b) { state.view = 'home'; return renderHome(main); }

    if (state.generating) {
      main.append(renderLoading());
      return main;
    }

    main.append(
      h('div', { class: 'reel-crumb' },
        h('a', { onclick: () => { state.view = 'brief'; render(container); } }, '← ' + b.name)
      ),
      h('div', { class: 'reel-title' }, 'New carousel'),
      h('div', { class: 'reel-subtitle' }, 'pick the shape. the built-in agent writes the copy and generates the images.')
    );

    if (state.lastError) main.append(h('div', { class: 'reel-error' }, state.lastError));
    state.lastError = '';

    const form = h('div', { class: 'reel-gen-form' });
    const controls = {};

    const mkSelect = (name, label, options, defaultVal, full) => {
      const field = h('div', { class: 'reel-field' + (full ? ' full' : '') });
      field.append(h('label', {}, label));
      const sel = h('select', {});
      options.forEach((opt) => {
        const o = h('option', { value: opt.v }, opt.l);
        if (opt.v === defaultVal) o.selected = true;
        sel.append(o);
      });
      field.append(sel);
      controls[name] = () => sel.value;
      return field;
    };

    form.append(
      mkSelect('hookStyle', 'Hook style', [
        { v: 'curiosity gap', l: 'Curiosity gap' },
        { v: 'contrarian', l: 'Contrarian take' },
        { v: 'question', l: 'Direct question' },
        { v: 'POV', l: 'POV / relatable' },
        { v: 'transformation', l: 'Before → after' },
        { v: 'pattern interrupt', l: 'Pattern interrupt' },
        { v: 'meme', l: 'Meme / joke' },
      ], 'curiosity gap'),
      mkSelect('format', 'Structure', [
        { v: 'list', l: 'List (X ways to…)' },
        { v: 'story', l: 'Story arc' },
        { v: 'tutorial', l: 'How-to steps' },
        { v: 'comparison', l: 'This vs that' },
        { v: 'reveal', l: 'Reveal / big claim' },
        { v: 'checklist', l: 'Do this / don\'t that' },
      ], 'list'),
      mkSelect('slideCount', 'Slides', [
        { v: '3', l: '3 slides' },
        { v: '4', l: '4 slides (default)' },
        { v: '5', l: '5 slides' },
        { v: '6', l: '6 slides' },
        { v: '7', l: '7 slides' },
        { v: '8', l: '8 slides' },
      ], '4'),
      mkSelect('language', 'Language', [
        { v: '', l: 'Use brief default (' + (b.language || 'English') + ')' },
        { v: 'English', l: 'English' },
        { v: 'Hebrew', l: 'Hebrew' },
        { v: 'Spanish', l: 'Spanish' },
        { v: 'Portuguese', l: 'Portuguese' },
        { v: 'French', l: 'French' },
      ], ''),
      mkSelect('aspectRatio', 'Image aspect', [
        { v: '3:4', l: '3:4 (TikTok / IG carousel)' },
        { v: '4:5', l: '4:5 (Instagram feed)' },
        { v: '1:1', l: '1:1 (square)' },
        { v: '9:16', l: '9:16 (story / reel)' },
      ], '3:4'),
      mkSelect('includeImages', 'Images', [
        { v: 'yes', l: 'Generate images (Nano Banana Pro)' },
        { v: 'no', l: 'Copy only (test / draft mode)' },
      ], 'yes', true),
    );

    // Visual formula — full-width, with a live description of the picked photoshoot recipe
    const fmField = h('div', { class: 'reel-field full' });
    fmField.append(h('label', {}, 'Visual formula'));
    const fmSel = h('select', {});
    fmSel.append(h('option', { value: '' }, 'Auto — let the agent decide'));
    state.formulas.forEach((f) => fmSel.append(h('option', { value: f.id }, f.name)));
    const fmHint = h('div', { class: 'hint' });
    const setFmHint = () => {
      const f = state.formulas.find((x) => x.id === fmSel.value);
      clear(fmHint);
      if (f) {
        fmHint.append(
          h('div', {}, f.tagline),
          h('div', { style: { marginTop: '3px', color: 'var(--accent2)', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.5px' } }, f.emotion),
          h('div', { style: { marginTop: '3px' } }, 'Use for: ' + f.useFor)
        );
      } else {
        fmHint.append(h('div', {}, 'One coherent photography look across every slide. The brief sets the subject, the formula sets the style.'));
      }
    };
    fmSel.addEventListener('change', setFmHint);
    setFmHint();
    fmField.append(fmSel, fmHint);
    controls.formula = () => fmSel.value;
    form.append(fmField);

    const actions = h('div', { class: 'reel-form-actions full' });
    actions.append(
      h('button', {
        class: 'reel-btn primary big',
        onclick: async () => {
          state.generating = true;
          state.lastError = '';
          state.genProgress = 'Writing copy…';
          render(container);
          const body = {
            briefId: b.id,
            hookStyle: controls.hookStyle(),
            format: controls.format(),
            formula: controls.formula(),
            slideCount: parseInt(controls.slideCount(), 10),
            language: controls.language() || (b.language || 'English'),
            aspectRatio: controls.aspectRatio(),
            includeImages: controls.includeImages() === 'yes',
          };
          try {
            const post = await api('/generate', { method: 'POST', body });
            await refresh();
            state.selectedPostId = post.id;
            state.generating = false;
            state.view = 'result';
            render(container);
          } catch (e) {
            state.generating = false;
            state.lastError = e.message;
            render(container);
          }
        }
      }, 'Generate carousel'),
      h('button', {
        class: 'reel-btn ghost',
        onclick: () => { state.view = 'brief'; render(container); }
      }, 'Cancel')
    );
    form.append(actions);
    main.append(form);
    return main;
  }

  function renderLoading() {
    const msgs = ['Distilling brief…', 'Pressing the copy…', 'Sending to the image lab…', 'Firing the kiln…'];
    const msg = msgs[Math.floor(Math.random() * msgs.length)];
    return h('div', { class: 'reel-loading' },
      h('div', { class: 'spinner' }),
      h('h3', {}, msg),
      h('p', {}, 'this takes 30–90 seconds. copy first, then images one by one.')
    );
  }

  function renderResult(main) {
    const p = state.posts.find((x) => x.id === state.selectedPostId);
    const b = p ? state.briefs.find((x) => x.id === p.briefId) : null;
    if (!p || !b) { state.view = 'home'; return renderHome(main); }

    main.append(
      h('div', { class: 'reel-crumb' },
        h('a', { onclick: () => { state.view = 'brief'; render(container); } }, '← ' + b.name)
      ),
      h('div', { class: 'reel-head' }, h('div', { class: 'reel-title' }, 'Carousel')),
      h('div', { class: 'reel-subtitle' },
        (p.hookStyle ? p.hookStyle.toUpperCase() : '') +
        (p.format ? ' · ' + p.format.toUpperCase() : '') +
        (p.formulaId ? ' · ' + (state.formulas.find((f) => f.id === p.formulaId)?.name || p.formulaId).toUpperCase() : '') +
        (p.language ? ' · ' + p.language.toUpperCase() : '') +
        ' · ' + fmt(p.createdAt)
      )
    );

    // Toolbar
    const tb = h('div', { class: 'reel-toolbar' });
    tb.append(
      h('button', {
        class: 'reel-btn ghost',
        onclick: () => { state.view = 'generator'; render(container); }
      }, '＋ Regenerate (new)'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'reel-btn danger small',
        onclick: async () => {
          if (!confirm('Delete this post?')) return;
          try { await api('/post/' + p.id, { method: 'DELETE' }); await refresh(); state.view = 'brief'; state.selectedPostId = null; render(container); }
          catch (e) { state.lastError = e.message; render(container); }
        }
      }, 'Delete')
    );
    main.append(tb);

    // Slides — each with edit + regen actions
    const slides = h('div', { class: 'reel-slides' });
    p.slides.forEach((s, i) => {
      const slide = h('div', { class: 'reel-slide' });

      // ---- Image section
      const isRegenerating = state.regeneratingSlideIdx === i;
      if (isRegenerating) {
        slide.append(h('div', { class: 's-img regenerating' },
          h('div', { class: 'mini-spinner' }),
          h('div', { style: { marginTop: '8px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--muted)' } }, 'regenerating…')
        ));
      } else if (s.imageLocal) {
        const img = h('div', { class: 's-img', style: { backgroundImage: `url('/api/reel/asset/${s.imageLocal}?t=${Date.now()}')` } });
        img.append(h('div', { class: 's-num' }, String(i + 1)));
        slide.append(img);
      } else if (s.imageError) {
        slide.append(h('div', { class: 's-img missing' }, 'image failed: ' + s.imageError));
      } else {
        slide.append(h('div', { class: 's-img missing' }, 'no image'));
      }

      // ---- Copy section (view or edit mode)
      if (state.editingSlideCopy === i) {
        const copyTa = h('textarea', { class: 's-copy-edit', rows: 4 });
        copyTa.value = s.copy || '';
        const promptTa = h('textarea', { class: 's-prompt-edit', rows: 2, placeholder: 'Image prompt (for next regeneration)' });
        promptTa.value = s.imagePrompt || '';
        slide.append(
          h('div', { class: 's-edit' },
            h('label', {}, 'Slide copy'),
            copyTa,
            h('label', { style: { marginTop: '10px' } }, 'Image prompt'),
            promptTa,
            h('div', { class: 's-edit-actions' },
              h('button', {
                class: 'reel-btn primary small',
                onclick: async () => {
                  try {
                    await api('/post/' + p.id + '/slide/' + i, { method: 'POST', body: { copy: copyTa.value, imagePrompt: promptTa.value } });
                    await refresh();
                    state.editingSlideCopy = null;
                    render(container);
                  } catch (e) { state.lastError = e.message; render(container); }
                }
              }, 'Save'),
              h('button', {
                class: 'reel-btn ghost small',
                onclick: () => { state.editingSlideCopy = null; render(container); }
              }, 'Cancel')
            )
          )
        );
      } else if (state.regenSlideIdx === i) {
        // Regen form — editable prompt + model + aspect
        const promptTa = h('textarea', { class: 's-prompt-edit', rows: 3, placeholder: 'Describe the image you want' });
        promptTa.value = s.imagePrompt || '';
        const modelSel = h('select', {},
          h('option', { value: 'nano_banana_pro' }, 'Nano Banana Pro (cheap, quality)'),
          h('option', { value: 'gpt_image_2' }, 'GPT Image 2 (text fidelity, expensive)'),
          h('option', { value: 'soul_2' }, 'Soul 2 (portraits, editorial)')
        );
        const aspectSel = h('select', {},
          h('option', { value: '3:4' }, '3:4 (TikTok / IG carousel)'),
          h('option', { value: '4:5' }, '4:5 (IG feed)'),
          h('option', { value: '1:1' }, '1:1 (square)'),
          h('option', { value: '9:16' }, '9:16 (story / reel)')
        );
        const fmSel = h('select', {});
        fmSel.append(h('option', { value: '' }, 'No formula'));
        state.formulas.forEach((f) => {
          const o = h('option', { value: f.id }, f.name);
          if (f.id === p.formulaId) o.selected = true;
          fmSel.append(o);
        });
        slide.append(
          h('div', { class: 's-edit' },
            h('label', {}, 'Image prompt'),
            promptTa,
            h('div', { class: 's-regen-row' },
              h('div', { class: 's-regen-field' },
                h('label', { style: { fontSize: '10px' } }, 'Model'),
                modelSel
              ),
              h('div', { class: 's-regen-field' },
                h('label', { style: { fontSize: '10px' } }, 'Aspect'),
                aspectSel
              )
            ),
            h('div', { class: 's-regen-field', style: { marginTop: '8px' } },
              h('label', { style: { fontSize: '10px' } }, 'Visual formula'),
              fmSel
            ),
            h('div', { class: 's-edit-actions' },
              h('button', {
                class: 'reel-btn primary small',
                onclick: async () => {
                  state.regenSlideIdx = null;
                  state.regeneratingSlideIdx = i;
                  render(container);
                  try {
                    await api('/post/' + p.id + '/slide/' + i + '/regen-image', {
                      method: 'POST',
                      body: { imagePrompt: promptTa.value, imageModel: modelSel.value, aspectRatio: aspectSel.value, formula: fmSel.value }
                    });
                    await refresh();
                    state.regeneratingSlideIdx = null;
                    render(container);
                  } catch (e) {
                    state.lastError = e.message;
                    state.regeneratingSlideIdx = null;
                    render(container);
                  }
                }
              }, 'Regenerate image'),
              h('button', {
                class: 'reel-btn ghost small',
                onclick: () => { state.regenSlideIdx = null; render(container); }
              }, 'Cancel')
            )
          )
        );
      } else {
        // Normal view mode
        slide.append(h('div', { class: 's-copy' }, s.copy));
        slide.append(
          h('div', { class: 's-actions' },
            h('button', {
              class: 'reel-btn small',
              title: 'Regenerate this slide\'s image only',
              onclick: () => { state.regenSlideIdx = i; state.editingSlideCopy = null; render(container); }
            }, '↻ Image'),
            h('button', {
              class: 'reel-btn small',
              title: 'Edit copy and image prompt',
              onclick: () => { state.editingSlideCopy = i; state.regenSlideIdx = null; render(container); }
            }, '✎ Edit'),
            h('button', {
              class: 'reel-btn small ghost',
              title: 'Copy this slide\'s text',
              onclick: () => {
                navigator.clipboard.writeText(s.copy || '');
                state.genProgress = 'Slide ' + (i + 1) + ' copy copied';
                setTimeout(() => { state.genProgress = ''; render(container); }, 1200);
              }
            }, '⧉')
          )
        );
      }

      slides.append(slide);
    });
    main.append(slides);

    // Caption + hashtags (with edit mode)
    const cap = h('div', { class: 'reel-caption-box' });
    if (state.editingCaption) {
      const capTa = h('textarea', { rows: 3 });
      capTa.value = p.caption || '';
      const tagsInput = h('input', { type: 'text', placeholder: '#tag1 #tag2 #tag3' });
      tagsInput.value = (p.hashtags || []).join(' ');
      cap.append(
        h('h4', {}, 'Caption'),
        h('div', { class: 's-edit' },
          capTa,
          h('label', { style: { marginTop: '10px' } }, 'Hashtags'),
          tagsInput,
          h('div', { class: 's-edit-actions' },
            h('button', {
              class: 'reel-btn primary small',
              onclick: async () => {
                const tags = tagsInput.value.split(/\s+/).map((t) => t.trim()).filter(Boolean).map((t) => t.startsWith('#') ? t : '#' + t);
                try {
                  await api('/post/' + p.id + '/meta', { method: 'POST', body: { caption: capTa.value, hashtags: tags } });
                  await refresh();
                  state.editingCaption = false;
                  render(container);
                } catch (e) { state.lastError = e.message; render(container); }
              }
            }, 'Save'),
            h('button', {
              class: 'reel-btn ghost small',
              onclick: () => { state.editingCaption = false; render(container); }
            }, 'Cancel')
          )
        )
      );
    } else {
      cap.append(
        h('h4', {}, 'Caption'),
        h('p', {}, p.caption || '(no caption)'),
        (p.hashtags && p.hashtags.length) ? h('div', { class: 'tags' }, p.hashtags.join(' ')) : null,
        h('div', { class: 'reel-copy-row' },
          h('button', {
            class: 'reel-btn small',
            onclick: () => { state.editingCaption = true; render(container); }
          }, '✎ Edit caption'),
          h('button', {
            class: 'reel-btn small',
            onclick: () => {
              const text = (p.caption || '') + (p.hashtags && p.hashtags.length ? '\n\n' + p.hashtags.join(' ') : '');
              navigator.clipboard.writeText(text);
              state.genProgress = 'Copied caption';
              setTimeout(() => { state.genProgress = ''; render(container); }, 1200);
            }
          }, 'Copy caption'),
          h('button', {
            class: 'reel-btn small',
            onclick: () => {
              const text = p.slides.map((s, i) => `Slide ${i + 1}:\n${s.copy}`).join('\n\n');
              navigator.clipboard.writeText(text);
              state.genProgress = 'Copied all slide copy';
              setTimeout(() => { state.genProgress = ''; render(container); }, 1200);
            }
          }, 'Copy all slide copy')
        )
      );
    }
    main.append(cap);
    if (state.genProgress) main.append(h('div', { style: { marginTop: '12px', color: 'var(--accent2)', fontSize: '12px', fontFamily: 'var(--font-mono)' } }, '✓ ' + state.genProgress));
    return main;
  }

  function renderSettings(main) {
    main.append(
      h('div', { class: 'reel-crumb' }, h('a', { onclick: () => { state.view = 'home'; render(container); } }, '← back')),
      h('div', { class: 'reel-title' }, 'Settings'),
      h('div', { class: 'reel-subtitle' }, 'the built-in agent needs two things: an Anthropic key for copy, and Higgsfield keys for images.')
    );

    const form = h('div', { class: 'reel-form' });

    const mkKeyField = (name, label, hint, isSet) => {
      const field = h('div', { class: 'reel-field' });
      const lab = h('label', {}, label);
      lab.append(h('span', { class: 'reel-settings-status ' + (isSet ? 'ok' : 'miss') }, isSet ? 'set' : 'not set'));
      field.append(lab);
      const input = h('input', { type: 'text', placeholder: isSet ? '(leave blank to keep existing)' : 'paste your key here' });
      field.append(input);
      if (hint) field.append(h('div', { class: 'hint' }, hint));
      return { field, input };
    };

    const a = mkKeyField('anthropicKey', 'Anthropic API key', 'For Claude — writes the carousel copy. Starts with sk-ant-...', state.settingsSet.anthropic);
    const k = mkKeyField('higgsKeyId', 'Higgsfield key ID', 'From cloud.higgsfield.ai → API Keys. UUID format.', state.settingsSet.higgsKeyId);
    const s = mkKeyField('higgsKeySecret', 'Higgsfield key secret', 'The secret shown once when you created the API key.', state.settingsSet.higgsKeySecret);

    form.append(a.field, k.field, s.field);

    if (state.lastError) form.append(h('div', { class: 'reel-error' }, state.lastError));

    const actions = h('div', { class: 'reel-form-actions' });
    actions.append(
      h('button', {
        class: 'reel-btn primary',
        onclick: async () => {
          const body = {};
          if (a.input.value) body.anthropicKey = a.input.value;
          if (k.input.value) body.higgsKeyId = k.input.value;
          if (s.input.value) body.higgsKeySecret = s.input.value;
          if (!Object.keys(body).length) { state.view = 'home'; render(container); return; }
          try { await api('/settings', { method: 'POST', body }); await refresh(); state.view = 'home'; render(container); }
          catch (e) { state.lastError = e.message; render(container); }
        }
      }, 'Save settings'),
      h('button', {
        class: 'reel-btn ghost',
        onclick: () => { state.view = 'home'; render(container); }
      }, 'Cancel')
    );
    form.append(actions);
    main.append(form);
    state.lastError = '';
    return main;
  }

  // ---------- Public API ----------
  window.ReelUI = {
    async render(root) {
      if (!container || root !== container) {
        // fresh view — refresh state
        await refresh();
      }
      render(root);
    }
  };
})();
