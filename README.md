# Mission Control v2

Run a whole **department of Claude Code agents** on one screen. Projects, role-based
teams with editable "souls", reusable templates, shared context files, an org-chart
diagram, and Director-driven dispatch. No dependencies, no build step.

**Location:** `C:\Users\Lenovo\Desktop\mission-control`

## Run it

Double-click **`start.bat`** → opens http://localhost:4317.
(Or `node server.js` and open that URL.)

## Core concepts

- **Project** — a workspace with a working folder (where agents read/write files) and
  **shared context files** every agent can see. Switch projects from the top dropdown.
- **Worker (agent)** — a role with its own **soul** (`.md` persona), model, and a
  "reports to" link. Each has its own chat, memory, and token meter.
- **Template** — a reusable team blueprint. Ships with **Marketing Department**
  (Director, Researcher, Copywriter, UI/UX Designer, Frontend Developer). Fully
  editable: change names, souls, models, hierarchy — or save your own from any project.

## How a department works (Hybrid dispatch)

1. Create a project from the **Marketing Department** template.
2. Add your spec/brief as a **shared file** (📎 Shared file) so the whole team has context.
3. Message the **Director** with your goal.
4. The Director replies with strategy + an **ASSIGNMENTS** list. Each assignment shows a
   **Dispatch ▶** button — click it to send that task straight to the right worker.
5. Work with each worker individually, or **Broadcast** to the whole team.

## Features

- **Diagram view** — org chart of the team (click a node to jump to its chat).
- **Per-agent model** — Default / Opus 4.8 / Sonnet 4.6 / Haiku 4.5.
- **Per-agent token + cost meter**, plus a session dashboard and optional **Budget**.
- **Shared files** (project-wide) and **per-agent attachments** (📎 on a card).
- **Edit soul** (✎ on a card) any time; **+ Worker** to add custom roles.
- **Persistent** — projects, teams, and conversations are saved to `data.json` and
  survive restarts (sessions resume by id). Templates live in `templates.json`.

## Engines & non-Anthropic models (per agent)

Open ✎ on any worker and pick an **Engine**:

- **Claude Code** (default) — full tools: reads/writes files, runs commands, builds the page.
- **Direct API** — talks straight to any **OpenAI-compatible** endpoint (OpenAI,
  OpenRouter, Groq, local LLMs). Set Base URL + Key + Model. **Chat only — no file tools.**
  Good for Researcher/Copywriter/Director; not for building files.

### Want a non-Anthropic model that STILL has tools? Use the proxy.

Claude Code speaks the Anthropic API, so to run it on GPT/Gemini/etc. *with tools intact*,
put a small translator proxy in front. One-time setup:

```
npm install -g @musistudio/claude-code-router    # or use LiteLLM
# configure it with your OpenAI/OpenRouter/Gemini key, then start it:
ccr start                                         # listens on http://localhost:3456
```

Then on the agent (✎ → "Advanced: run Claude Code via proxy"):
- **Proxy Base URL:** `http://localhost:3456`
- **Auth token:** the key your proxy expects
- **Model override:** e.g. `gpt-4o`, `gemini-2.5-pro`, `deepseek-chat`

Now that agent keeps every Claude Code tool but thinks with the model you chose. You can
mix freely — some agents on Claude, some on GPT, some on a local model.

> Note: `data.json` stores API keys in plain text on your disk. It's a local-only tool;
> don't share that file.

## Configure (edit `start.bat`)

| Variable | Meaning | Default |
|---|---|---|
| `MC_PROJECT_DIR` | Default working folder for new projects | flowmate-pro-final |
| `MC_PORT` | Web UI port | 4317 |
| `MC_PERMISSION_MODE` | `bypassPermissions` / `acceptEdits` / `default` | bypassPermissions |

## Notes

- `bypassPermissions` = agents act without asking. They share the project folder, so two
  agents editing the same file at once can clobber each other.
- "How much of my plan is left" isn't exposed by the Claude CLI — the dashboard shows
  tokens + estimated $ used this session; set a Budget to track against it.
- Local tool — don't expose the port to the internet.
```
data.json       <- your projects, teams, and conversations (auto-saved)
templates.json  <- your team templates (edit in-app)
mc-uploads/     <- files you upload land here, inside each project's folder
```