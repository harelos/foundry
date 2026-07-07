# Foundry

**Forge a whole marketing department on one screen.**

Foundry is a self-hosted control room for running a team of AI workers — copywriters,
researchers, designers, developers, QA — each with their own persona, memory, and
model. Send a brief to your Director, watch them break it into assignments, and
click *Forge ▶* to dispatch every task to the right worker. All from one
warm-dark screen you own.

Zero dependencies. Node built-ins only. No build step.

<!-- TODO: drop a real screenshot at docs/hero.png and uncomment:
![Foundry — a warm-dark command room for AI workers](docs/hero.png)
-->

---

## What it does

- **Run 12+ AI workers in parallel** on a single project — each with their own
  chat, token meter, and cost.
- **Three engines per worker:** Claude Code (full file/shell tools), Direct API
  (OpenAI-compatible chat), or OpenClaw (any model + browser autonomy).
- **Director dispatch:** the Director role reads your brief, writes strategy,
  and outputs an `ASSIGNMENTS:` list. Each assignment gets a *Forge ▶* button
  that dispatches the task to the matching worker.
- **12 built-in Blueprints** for common businesses: Marketing Department,
  E-commerce Store (S/M), SaaS Startup (S/M), Content Studio, Solo Founder,
  Agency, Coaching, Local Service, Real Estate, Google Play App team.
- **Business size × goal parameters** at project creation (Small/Medium/Large ·
  Launch/Scale/Retain/Hire) — the Director's persona gets biased accordingly.
- **The Ledger:** daily / weekly / monthly / all-time token usage with plan-vs-API
  cost separation.
- **The Wire:** live activity feed showing every tool call, response, and error
  across every worker.
- **The Bell (⌘K):** command palette for every action — spawn workers, dispatch
  missions, switch projects, open Blueprints.
- **Shared context files** at project level (every worker reads them) and
  drag-and-drop attachments at agent level.
- **Save any session** as a Markdown transcript to your Projects folder.

---

## You need your own Claude account

**Foundry does not include Claude API credits.** It's a UI on top of your own
Claude Code installation (and optionally your own OpenAI / DeepSeek / Gemini
keys for Direct API and OpenClaw workers).

Before running Foundry, you need:

1. **Claude Code** installed and logged into your own Anthropic account.
   Install from https://docs.claude.com/claude-code.
2. Node.js 18+ installed.
3. (Optional) an OpenAI-compatible API key if you want to run *Direct API*
   workers on GPT / Groq / DeepSeek / local Ollama.
4. (Optional) OpenClaw installed if you want *OpenClaw* workers.
   See https://github.com/openclaw.

Your Claude usage is billed to *your* account. Foundry runs 100% locally on
your machine.

---

## Install & run

```bash
git clone https://github.com/YOUR-USERNAME/foundry.git
cd foundry
node server.js
```

Then open http://localhost:4317.

Or on Windows: double-click `start.bat`.

**First run:** click *+ Project* → pick a Blueprint (e.g. Marketing Department) →
give it a working folder → *Create Project*. You now have a team on the Floor.
Focus a worker on the left rail, send them a message, and watch The Wire.

---

## Configure

Environment variables (edit `start.bat` or export them):

| Variable | Meaning | Default |
|---|---|---|
| `MC_PROJECT_DIR` | Default working folder for new projects | current directory |
| `MC_PORT` | Web UI port | `4317` |
| `MC_PERMISSION_MODE` | `bypassPermissions` / `acceptEdits` / `default` | `bypassPermissions` |

`bypassPermissions` means agents act without asking (fastest for solo use).
Change to `acceptEdits` or `default` for stricter workflows.

---

## Core concepts

- **Project** — a workspace with a working folder (where agents read/write
  files) and shared context files every worker can see. Switch projects from
  the top-left dropdown.
- **Worker** — a role with its own persona (soul.md), model, engine, and
  reports-to link. Each has its own chat, session ID, and token meter.
- **Blueprint** — a reusable team template (marketing, SaaS, e-commerce, etc.).
  Fully editable — change names, souls, models, hierarchy. Save your own from
  any project.
- **The Anvil** — the dispatch panel that appears when a Director outputs
  assignments. One click sends a task to the named worker.
- **The Wire** — live activity feed on the right. Every tool call, message,
  and error across every worker in one stream.
- **The Ledger** — full history view (mission log + usage/billing).
- **The Bell (⌘K)** — command palette. Hire, dispatch, save, switch, muster.
- **Muster** — broadcast bar at the bottom. Send one prompt to every worker
  in the project.

---

## Engines & non-Anthropic models

Open ✎ on any worker and pick an **Engine**:

- **Claude Code** (default) — full tools: reads/writes files, runs commands,
  builds the page. Uses your Claude account.
- **Direct API** — talks to any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, DeepSeek, local Ollama). Chat only — no file tools. Good
  for Researcher / Copywriter / Director roles that don't need to edit files.
- **OpenClaw** — full autonomy + browser control, any model. Requires
  OpenClaw installed separately.

### Want a non-Anthropic model that STILL has tools? Use the proxy.

Claude Code speaks the Anthropic API. To run it on GPT / Gemini / DeepSeek
with tools intact, put a translator proxy in front:

```bash
npm install -g @musistudio/claude-code-router
ccr start                    # listens on http://localhost:3456
```

Then on the agent (✎ → "Advanced: run Claude Code via proxy"):
- **Proxy Base URL:** `http://localhost:3456`
- **Auth token:** the key your proxy expects
- **Model override:** e.g. `gpt-4o`, `gemini-2.5-pro`, `deepseek-chat`

Mix freely — some workers on Claude, some on GPT, some on a local model.

---

## Files & data

```
data.json          Your projects, workers, and conversations (auto-saved)
templates.json     Your Blueprints (edit in-app or by hand)
mc-uploads/        Files you attach land here, inside each project's folder
public/            Front-end (index.html + app.js). No build step.
server.js          Node.js server. Zero npm dependencies.
```

Foundry never phones home. Everything is local.

---

## Security notes

- **API keys are stored in plain text in `data.json`.** This is a local-only
  tool. Do not share `data.json`, don't commit it, don't expose the port to
  the internet. `.gitignore` already excludes it.
- **`bypassPermissions` = agents act without asking.** Two agents editing the
  same file at once can clobber each other. Use `acceptEdits` if you want a
  confirmation step.
- **Never expose port 4317 publicly.** No auth is built in — it's a personal
  tool. If you need remote access, tunnel it (Tailscale, Cloudflare Tunnel)
  with your own auth layer.

---

## The stack

- **Backend:** Node.js built-ins only (`http`, `child_process`, `fs`). Zero npm
  dependencies. One file: `server.js`.
- **Frontend:** vanilla JavaScript + CSS. No React, no build. Two files:
  `public/index.html` + `public/app.js`.
- **Type stack:** Fraunces (display + hero numbers), Inter (body), IBM Plex
  Mono (data). All free via Google Fonts.
- **Motion:** AutoAnimate + CountUp.js loaded via CDN, only when the app needs
  them.

---

## Contributing

Foundry is opinionated by design — one warm-dark screen, one accent color,
one type stack, one keyboard-first flow. PRs that change the aesthetic will be
declined; PRs that fix bugs, add engines, or ship new Blueprints are welcome.

- **Bugs:** open an issue with steps to reproduce.
- **New Blueprint:** open a PR editing the `builtinTemplates()` function in
  `server.js`. Include the business type, size, and goal biases in the
  Director's soul.
- **New engine:** open an issue first so we can talk architecture — the
  `runTurn()` router in `server.js` is where engines plug in.

---

## Why "Foundry"?

Because a solo operator running AI workers isn't running "Mission Control"
(that's naval, distant, cold). They're running a *foundry* — a workshop where
raw briefs get forged into copy, code, campaigns, and outputs. Warm, active,
owned.

The word is also our invitation. If you're the kind of operator who ships
daily, refuses seat-license SaaS bloat, and would rather forge their own team
than pay for enterprise seats, you're already in the tribe. Welcome to the
Foundry.

---

## License

MIT. See `LICENSE`. Do what you want with it. If you fork it into a paid
product, at least name your fork something else.

---

**Foundry** · a warm workshop for people who ship.

---

## About the builder

I'm Zvi — a direct-response marketer who spent years running DTC ecommerce
funnels before deciding I'd rather build the tools than keep paying for them.

Foundry exists because every multi-agent framework I found (LangGraph, CrewAI,
AutoGen) was built for engineers who already know how to write a Python
orchestration graph. I don't want to write a graph. I want to open a screen,
hire a team, and ship a campaign before lunch. So I built the tool I needed —
zero dependencies, one file per layer, no framework, warm interface instead
of another cold enterprise dashboard.

If you're hiring for **AI product**, **agent orchestration**, **developer
tools**, or **applied LLM engineering** and you want someone who ships fast,
designs with taste, and understands both the marketing side and the systems
side of AI products — this repo is my proof of work. Read the code. It's
short enough to read in one sitting.

- **What I actually did here:** multi-engine agent runtime (Claude Code CLI +
  any OpenAI-compatible API + OpenClaw), a custom protocol for dispatching
  work between agents based on parsed structured output, a Node HTTP server
  with zero npm dependencies, and a full design system built from primary
  research (see `/docs` in the commit history for the research trail —
  typography, color psychology, competitive UI teardowns, brand strategy).
- **What I'm looking for:** remote roles in AI product, developer tools, or
  applied agent engineering. Open to contract or full-time.
- **Reach me:** harel@adlersmedia.com

If Foundry is useful to you, a star helps other operators find it — and
tells me it's worth continuing to build in public.
