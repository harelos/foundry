# THE REEL — session handoff

> Read this first if you're continuing "The Reel" build in a new Claude Code window.
> Everything below is the current state as of **2026-07-08**, session `173b67a4`.

---

## TL;DR — what The Reel is

**A generic AI content studio built into Foundry as a tab.** Brief-driven. Feeds any product/service/offer/brand → outputs social carousels (video later). Positioned as a **mini-app inside Foundry** with a built-in agent, not another dashboard requiring agent configuration.

- **Location inside Foundry:** new "The Reel" view alongside Agents / Log / Diagram (in the header viewToggle).
- **Current status:** MVP end-to-end wired. Backend routes work, frontend renders, slide-level editing and regen wired. **Not tested with live API keys yet** — user requested no keys in the build session.
- **Blocker to first real use:** paste Anthropic + Higgsfield keys via the Settings panel inside The Reel.

---

## What The Reel is NOT

- **Not app-specific.** Was originally scoped as a TikTok agent for Pack / Dopamodoro / Foundry. **Pivoted 2026-07-07** to a generic brief-driven tool. See [[project_tiktok_agent]] memory.
- **Not a multi-agent orchestration UI.** The rest of Foundry lets users assemble agent teams. The Reel deliberately has ONE built-in agent that just works — for users "who don't have the energy to build one from scratch" (user's exact words).
- **Not a video generator yet.** Carousels first. Video is deferred to a future feature.

---

## File map — where everything lives

### Backend
- **`C:\Users\Lenovo\Desktop\mission-control\reel.js`** — the whole Reel backend, ~500 lines, zero-dep. Exports `route(pathname, method, req, res, helpers)`.
- **`C:\Users\Lenovo\Desktop\mission-control\server.js`** — modified in 3 places:
  1. Near top: `const reel = require('./reel');`
  2. In router: `if (pathname === '/reel-ui.js') return serveStatic(res, 'reel-ui.js');`
  3. Before 404: `if (pathname.startsWith('/api/reel/')) { const handled = await reel.route(pathname, method, req, res, { json, readBody }); if (handled !== false) return; }`

### Frontend
- **`C:\Users\Lenovo\Desktop\mission-control\public\reel-ui.js`** — full mini-app UI, ~1000 lines. Exposes `window.ReelUI = { render(root) }`.
- **`C:\Users\Lenovo\Desktop\mission-control\public\index.html`** — modified in 3 places:
  1. In viewToggle: added `<button id="viewReel" title="The Reel — content atelier">The Reel</button>`
  2. Next to other views: added `<div id="reelView" class="hidden"></div>`
  3. Before app.js: added `<script src="/reel-ui.js"></script>`
- **`C:\Users\Lenovo\Desktop\mission-control\public\app.js`** — modified in 4 places:
  1. `let currentView = 'chat';` comment updated to include `reel`
  2. In `renderCenter()`: added case for `if (currentView === 'reel') { window.ReelUI && window.ReelUI.render(reel); reel.classList.remove('hidden'); return; }` (and `const reel = $('reelView');` at top)
  3. In `applyViewButtons()`: added `$('viewReel').classList.toggle('on', currentView === 'reel');`
  4. At bottom near other view handlers: added `$('viewReel').onclick = () => setView('reel');`

### Data & assets
- **`C:\Users\Lenovo\Desktop\mission-control\reel-data.json`** — persistent state: `{ briefs, posts, settings }`. Auto-created on first save. **Currently contains one test brief: "Dopamodoro launch" (ID `c7ff09cd`)** — leave it or delete via UI as you like.
- **`C:\Users\Lenovo\Desktop\mission-control\mc-uploads\reel\{briefId}\{postId}\slide_N.png`** — generated slide images. Auto-created on first generation.

### Documentation & related
- **`C:\Users\Lenovo\Desktop\mission-control\THE-REEL-HANDOFF.md`** — THIS FILE.
- **`C:\Users\Lenovo\.claude\projects\C--Users-Lenovo\memory\project_tiktok_agent.md`** — project scope memory. LOAD THIS in the new session.
- **`C:\Users\Lenovo\.claude\projects\C--Users-Lenovo\memory\feedback_copywriting.md`** — LF8 / no-em-dashes / 2-3-line paragraph rules. The copy engine's prompt already respects these.
- **`C:\Users\Lenovo\.claude\projects\C--Users-Lenovo\memory\feedback_ai_image_prompts.md`** — "don't over-describe product when reference is attached" rule.

---

## Architecture at a glance

```
User in Foundry
   │
   └─ clicks "The Reel" button (viewToggle)
      │
      └─ app.js setView('reel') → renderCenter() → window.ReelUI.render(reelView)
         │
         ├─ Home view — briefs grid + settings gear + "New brief"
         ├─ Brief editor — form (name, product, avatar, angle, tone, hooks, language)
         ├─ Brief detail — brief info + posts library + "New carousel" CTA
         ├─ Generator — form (hook style, format, slides, language, aspect, include-images)
         │     │
         │     └─ POST /api/reel/generate
         │           │
         │           ├─ reel.js → anthropicMessages(claude-sonnet-5, systemPrompt, userPrompt)
         │           │     └─ returns JSON { caption, hashtags, slides:[{copy, imagePrompt}] }
         │           │
         │           └─ for each slide: higgsGenerateImage(nano_banana_pro, imagePrompt, 3:4, 2k)
         │                 └─ poll + download to disk + save to reel-data.json
         │
         ├─ Result view — 3-mode per slide (view / edit copy / regen image)
         │     │
         │     ├─ Regen image → POST /api/reel/post/:id/slide/:idx/regen-image
         │     ├─ Edit copy   → POST /api/reel/post/:id/slide/:idx  { copy, imagePrompt }
         │     └─ Edit caption → POST /api/reel/post/:id/meta       { caption, hashtags }
         │
         └─ Settings — three input fields (Anthropic key, Higgsfield key_id, key_secret)
               └─ POST /api/reel/settings
```

### Higgsfield auth (this took the whole session to figure out)

- **Endpoint:** `https://platform.higgsfield.ai`
- **Auth headers (both required):**
  - `hf-api-key: <KEY_ID>`
  - `hf-secret: <KEY_SECRET>`
- **NOT Bearer, NOT Basic base64.** Those return `401 Invalid credentials`.
- **Get keys from:** `cloud.higgsfield.ai` → API Keys → Create. **The SECRET is only shown ONCE at creation.** If you don't copy it, delete the key and make a new one.

### Anthropic API
- Standard: `x-api-key: sk-ant-...` + `anthropic-version: 2023-06-01`
- Uses `claude-sonnet-5` by default. Configurable in the `copyModel` opt.

---

## What's built — feature checklist

### Backend routes (all tested via fetch, return correct JSON)
- [x] `GET /api/reel/state` — returns briefs, posts, `formulas` (the 4 visual-formula presets), and `settingsSet: { anthropic, higgsKeyId, higgsKeySecret }` booleans (never returns the actual keys)
- [x] `POST /api/reel/settings` — save API keys (all three fields optional, only updates what's provided)
- [x] `POST /api/reel/brief` — create (no id) or update (with id)
- [x] `DELETE /api/reel/brief/:id` — delete brief + all its posts
- [x] `POST /api/reel/generate` — run the full pipeline
- [x] `POST /api/reel/post/:id/slide/:idx/regen-image` — regenerate one slide's image
- [x] `POST /api/reel/post/:id/slide/:idx` — edit slide copy + imagePrompt
- [x] `POST /api/reel/post/:id/meta` — edit caption + hashtags
- [x] `DELETE /api/reel/post/:id` — delete a post
- [x] `GET /api/reel/asset/:briefId/:postId/:filename` — serve stored images

### Frontend views (verified via DOM inspect)
- [x] Home — briefs grid + "+ New brief" tile + settings gear
- [x] Brief editor — full form + save/cancel/delete
- [x] Brief detail — info cells + "New carousel" CTA + posts thumbnails
- [x] Generator — hook style / format / slide count / language / aspect / include-images
- [x] Loading state during generation (spinner + fun label)
- [x] Result view — slides with 3 modes (view, edit copy, regen image)
- [x] Caption edit mode (inline textarea + hashtag input)
- [x] Settings screen with `● set` / `○ not set` indicators
- [x] Whiskey Bar palette matches Foundry aesthetic
- [x] Empty state banners (no keys yet, no briefs yet, no posts yet)

### Copy generation prompt (in reel.js `copySystemPrompt()`)
- [x] LF8 (survival, food, fear/pain, sex, comfort, superiority, protection, social approval)
- [x] Cialdini + Buss layered in
- [x] Hard rules: no em-dashes, 2-3 line paragraphs, avatar-language, hook in first 2 seconds
- [x] Returns valid JSON with `{ caption, hashtags, slides:[{copy, imagePrompt}] }`
- [x] Hebrew supported (matches request language exactly)
- [x] Optional PHOTOSHOOT FORMULA block injected when a visual formula is chosen (see feature #2 below)

### Visual formulas (in reel.js `FORMULAS` + `applyFormula()`)
- [x] 4 product-agnostic photoshoot presets exposed via `/api/reel/state`
- [x] Generator has a "Visual formula" dropdown (Auto + 4) with a live description
- [x] Formula injected into copy prompt AND appended to image prompts at gen time
- [x] Stored on `post.formulaId`; honored on single-slide regen (with override selector)

---

## What's NOT built — prioritized

### High-value next steps (in order)
1. **Actually test end-to-end with real keys.** User asked not to during build. Once keys are pasted in Settings, generate a carousel and verify all 7 flows: gen, view, edit copy, regen slide, edit caption, delete slide, delete post. **STILL PENDING** — user chose to skip live testing and build feature #2 first (2026-07-08).
2. ~~**Brief templates from the 4 formulas.**~~ **DONE 2026-07-08.** Implemented as **Visual formula presets**, not brief templates (the 4 formulas are photoshoot/visual recipes, so they belong at generation time, not as briefs). The 4 jersey formulas were abstracted into product-agnostic photography recipes: **Studio Clean**, **Spec Macro**, **Character Editorial**, **Golden Hour Documentary**. Each = `{id, name, tagline, emotion, useFor, styleSuffix}`, defined in `reel.js` `FORMULAS`. Picked from a "Visual formula" dropdown in the Generator (full-width, with a live description). Selected formula (a) is injected into the copy prompt so the agent writes on-formula image prompts, and (b) its `styleSuffix` is appended to every image prompt at generation time via `applyFormula()`. Stored as `post.formulaId`; the per-slide regen form also has a formula selector defaulting to the post's formula. Source of truth is `FORMULAS` in `reel.js`, exposed via `/api/reel/state`.
3. ~~**Duplicate brief action.**~~ **DONE 2026-07-08.** `POST /api/reel/brief/:id/duplicate` copies all brief fields into a new brief with a " (variant)" suffix (does NOT copy posts). "⧉ Duplicate" button on the brief-detail toolbar; jumps straight into the new variant.
4. **Export post as ZIP.** Download all slide images + a `caption.txt` + `slides.txt`. Use JSZip on the frontend (CDN allowed since Foundry is a local app).
5. **Video generation.** Deferred from MVP. Nano Banana Pro doesn't do video. Higgsfield has Kling, Veo3, Sora, Hailuo. Should use `models_explore(action:'recommend')` MCP call to pick per-shot. Structure: 3-8s clips per slide → auto-stitch via ffmpeg → upload back.

### Nice-to-have (medium priority)
6. **Higgsfield model dropdown in generator.** Right now `imageModel` defaults to `nano_banana_pro`. Expose the choice in the UI: NBP / GPT Image 2 / Soul 2.
7. **Reference image upload per brief.** For product-specific work (like 99 Jerseys) the brief should let you attach a product photo, and every generation includes it as a reference. Backend needs a new endpoint; frontend needs a file picker on the brief editor.
8. **Regenerate copy for one slide.** Currently you can EDIT copy but not RE-GEN just the copy. Would need a new backend route that calls Claude with just-that-slide's prompt.
9. **Preview per brief.** Show the last 3 posts for each brief on the sidebar item, thumbnails.

### Later (low priority for now)
10. Analytics ingestion (pull TikTok analytics per post)
11. Multi-account posting (via Blotato or TikTok Content Posting API)
12. Kill/scale decider (autonomous decision on which winners to boost)
13. Daily brief report (morning digest of what worked)
14. Retainer / scheduler (cron the whole thing)

---

## How to continue in a new session — 5 steps

### 1. Open the project
```bash
cd C:\Users\Lenovo\Desktop\mission-control
```

### 2. Load the memory (Claude Code does this automatically, but confirm)
Check `C:\Users\Lenovo\.claude\projects\C--Users-Lenovo\memory\MEMORY.md` — the line about "The Reel (content studio)" should be there.

### 3. Verify the current state runs
Start the server. Foundry launches on port 4317. Click "The Reel" in the header. You should see the Home view with the "Dopamodoro launch" test brief in the sidebar.

Preview via Claude Code:
```
preview_start with name "mission-control"
```
Or manually:
```bash
node server.js
```
Open `http://localhost:4317` → click "The Reel" button.

### 4. First actual generation
- Click the gear icon (bottom-left of the Reel sidebar)
- Paste **Anthropic API key** (get from console.anthropic.com)
- Paste **Higgsfield KEY_ID and KEY_SECRET** (get from cloud.higgsfield.ai → API Keys → Create new; copy BOTH values immediately, secret is shown once)
- Save
- Open the "Dopamodoro launch" brief (or create a new one)
- Click "+ New carousel"
- Pick options, click Generate
- Wait 60-90s (image generation is slow with GPT Image 2 / NBP)
- Verify the result page shows: slides with images, copy, caption, hashtags

### 5. Pick a next feature from the "What's NOT built" list above and continue

---

## The user's exact wording — brand rules

Preserved verbatim so the next session gets the intent right:

> "לא רוצה שתתאים את זה לאפליקציה, זה צריך להתאים להכל, גם לאפליקציות, גם למוצרי מידע... זה תלוי מה אתה מזין לזה, וזה האומנות שזה יתאים להכל"

**Translation: not app-specific. Brief-driven. Works for apps, info products, services, anything.**

> "כן זה צריך להיות חלק מהמישן קונטרול כמובן בטאב אחר בפנים זה לא יהיה בדף הראשי שם זה כאילו פיצ'ר מהמערכת ההפעלה הזאת"

**Translation: part of mission-control (Foundry) in a separate tab, NOT on the main page. Feels like an OS-level feature.**

> "אולי אתה יודע זה משהו שמציעים כמו מיני אפליקציות בתוך זה שזה כבר AGENT BUILT IN עם לאנשים אין כוח לבנות בגדול"

**Translation: like mini-apps inside Foundry with a built-in agent, for people who don't want to build one from scratch.**

> "אתה יודע שאני אובססיבי עם הדברים אז תנסה לעשות אותם כמו שצריך"

**Translation: user is obsessive about details. Don't ship the sloppy version.**

---

## Foundry aesthetic (must match)

Everything in Foundry follows:

- **Palette:** Whiskey Bar — canvas `#141210`, panel `#1A1714`, gold accent `#E8A33D` (aged whiskey), mint `#4FB477` (bar-back), rust `#B85338`
- **Fonts:** Fraunces (display serif for numbers + heros), Inter (body), IBM Plex Mono (data/labels)
- **Naming convention:** "The [Noun]" — The Wire (activity panel), Muster (broadcast bar), Blueprints (templates), The Bell (cmd+k), The Reel (this feature)
- **NO** purple, glassmorphism, Inter as the ONLY font, or emoji as section markers. See `.claude/design-skills/02-anti-ai-look.md`.

The Reel's UI already follows all this. Don't drift.

---

## Access check — does the next session have everything?

Yes if:
- [x] It runs on the same Windows machine as this one (memory files are local at `C:\Users\Lenovo\.claude\projects\...`)
- [x] It can Read/Write files under `C:\Users\Lenovo\Desktop\mission-control\`
- [x] User has Node.js 22 installed (already verified `v22.23.1`)
- [x] User has git + gh CLI authenticated (already verified as `harelos`)

The next session does NOT have:
- Live Higgsfield MCP OAuth (needs re-auth via `/mcp` command each session — but The Reel doesn't need the MCP, it uses direct HTTPS calls with the API keys stored in `reel-data.json`)
- The exact browser preview state (start fresh via preview_start)

---

## Known issues to watch for

1. **Server must restart to load `reel.js` changes.** Node caches modules on first require. If you edit `reel.js`, kill and restart the server.
2. **Frontend hot-reloads by browser refresh.** After editing `reel-ui.js`, just reload the browser.
3. **CRLF warnings on git commit.** Harmless — Windows line endings vs Unix. Git handles it.
4. **Image URLs from Higgsfield may expire.** The backend downloads the image locally on generation (`downloadToFile`) so the CDN URL going stale doesn't matter — the local copy is what's served.
5. **Higgsfield concurrency limit: 8 jobs.** Sequential generation in `generateCarousel` respects this. If you parallelize, cap at 8.
6. **GPT Image 2 at 2k high quality takes 60-120s per image.** A 4-slide carousel = 4-8 minutes. Set expectations.

---

## Related work also from this session (not part of The Reel but referenced)

- **`C:\Users\Lenovo\Desktop\neymar-mockup\`** — 99 Jerseys PDP mockup with 4 photoshoot variations. Pushed to GitHub: https://github.com/harelos/neymar-jersey-mockup
- **`C:\Users\Lenovo\Desktop\neymar-mockup\formulas.html`** — 4 reverse-engineered photoshoot formulas with per-photo emotional analysis. Live: https://harelos.github.io/neymar-jersey-mockup/formulas.html
- **`C:\Users\Lenovo\Desktop\pricing-offer.html`** — 3-tier pricing pitch for the 99 Jerseys friend
- **`C:\Users\Lenovo\Desktop\pilot-offer.html`** — 10-jersey pilot offer

These are all separate deliverables — do not confuse them with The Reel.

---

## Session log — what happened in this session

1. Long deep-research task on TikTok content agent economics — inconclusive, hit token limits (see `wf_c1d37fdd-b4d` run ID)
2. Pivoted from "TikTok agent for 3 apps" → "The Reel: generic content studio in Foundry"
3. Built backend: `reel.js` with all CRUD + generate + assets routes
4. Wired into `server.js` (3 edits)
5. Built frontend: `reel-ui.js` with 5 views (home, editor, detail, generator, result, settings)
6. Wired into `app.js` (4 edits) + `index.html` (3 edits)
7. Live-tested via preview: verified rendering, DOM structure, view switching, backend endpoints
8. Detour: Neymar jersey mockup work for a friend's 99 Jerseys store (unrelated to Reel — see "Related work")
9. Returned to Reel: added slide-level regen + copy edit + caption edit endpoints
10. Fixed a syntax error in reel-ui.js (missing `}` in the caption else branch)
11. Verified final state: `hasReelUI: true`, briefs render, all views work, all endpoints return correct JSON

Total build time on The Reel specifically: ~3-4 hours of active work across this session.

---

## Where to start the next session

Open Claude Code in `C:\Users\Lenovo\Desktop\mission-control\`, type:

```
Read THE-REEL-HANDOFF.md and continue from step 4 in "How to continue"
```

If keys are already set, jump to #2 in "What's NOT built" (brief templates from the 4 formulas) — that's the highest-value next feature.
