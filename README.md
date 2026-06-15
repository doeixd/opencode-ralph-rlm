# ralph-rlm

An [OpenCode](https://opencode.ai) integration that runs a **persistent, self-correcting Ralph + RLM loop**. Describe a goal in the TUI, walk away, and come back to protocol files and verify output — not a polluted chat history.

**v0.2** uses a **provider-as-supervisor** architecture: you talk to one OpenCode model; a local HTTP provider runs the loop, spawns workers, and verifies results in the background.

| Doc | Audience |
|-----|----------|
| [`GETTINGSTARTEDGUIDE.md`](GETTINGSTARTEDGUIDE.md) | First-time setup (start here) |
| [`MIGRATION.md`](MIGRATION.md) | Upgrading from the v0.1 plugin |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |


## v0.2 architecture

v0.2 exposes the loop as a **custom OpenCode provider model** (`ralph-rlm/supervisor`). You talk to one supervisor session. Behind the API, deterministic code owns verify, rollover, and worker lifecycle.

```
You — OpenCode TUI (model: ralph-rlm/supervisor)
        │  POST /v1/chat/completions (+ session bridge headers)
        ▼
packages/provider — Nitro :8787
  SupervisorAgent (LLM + tools)  →  LoopEngine  →  OpenCode SDK :4096
        │                                              │
        │                                              ▼
        │                         Worker sessions + ralph-worker plugin
        ▼
Protocol files (PLAN.md, RLM_INSTRUCTIONS.md, CURRENT_STATE.md, …)
```

| Layer | Module | Role |
|-------|--------|------|
| Supervisor API | `packages/provider` | OpenAI-compatible `/v1/chat/completions`, management `/api/*` |
| Loop engine | `packages/engine` | Verify, rollover, worker spawn, swarms — no LLM orchestration |
| Worker tools | `packages/worker-plugin` | RLM tools, context gate, `ralph_ask` |
| Session bridge | `.opencode/plugins/ralph-session-bridge.ts` | Injects `x-opencode-session-id` on provider requests |

The legacy monolithic plugin (`.opencode/plugins-legacy/ralph-rlm.ts`) remains for reference and is **not loaded by default**. Do not use `ralph_spawn_worker()` or `ralph_create_supervisor_session()` in v0.2.


## Quick start

### 1. Install

```bash
git clone https://github.com/doeixd/opencode-ralph-rlm
cd opencode-ralph-rlm
bun install
bun run build   # optional; verify script builds packages
```

### 2. Configure your project

Copy plugins and config into your target repo (or develop inside this repo):

```text
your-repo/
├── .opencode/
│   ├── plugins/
│   │   ├── ralph-worker.ts           # worker RLM tools + context gate
│   │   └── ralph-session-bridge.ts   # per-session LoopRun correlation (required)
│   ├── ralph.json                    # loop config (verify.command, maxAttempts, …)
│   └── ralph-provider.json           # supervisor LLM + worker agent defaults (optional)
├── opencode.json                     # register ralph-rlm provider
└── AGENT.md                          # optional static project rules (agentMdPath)
```

Register the provider in `opencode.json` — full example: [`.opencode/opencode.provider.example.json`](.opencode/opencode.provider.example.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ralph-rlm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ralph RLM",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "supervisor": {
          "name": "Ralph Supervisor (loop orchestrator)"
        }
      }
    }
  }
}
```

Minimal `.opencode/ralph.json`:

```json
{
  "enabled": true,
  "maxAttempts": 20,
  "verify": { "command": ["bun", "run", "test"], "cwd": "." },
  "gateDestructiveToolsUntilContextLoaded": true,
  "subAgentEnabled": true,
  "swarm": {
    "enabled": true,
    "maxConcurrent": 5,
    "unsafeEvalEnabled": false
  }
}
```

### 3. Start the provider

```bash
bun run ralph-serve
# optional: --port 8787 --opencode-url http://127.0.0.1:4096
#           --doctor --autofix --worktree /path/to/your/repo
```

Supervisor LLM credentials (provider process):

```bash
export RALPH_SUPERVISOR_API_KEY="..."
export RALPH_SUPERVISOR_MODEL="gpt-4o-mini"
```

Or `.opencode/ralph-provider.json` — see [`.opencode/ralph-provider.example.json`](.opencode/ralph-provider.example.json).

### 4. OpenCode + supervisor model

```bash
opencode
```

Choose **`ralph-rlm/supervisor`** and delegate a goal:

```text
Implement JWT auth; tests must pass when done.
```

The supervisor starts **attempt 1** in the background. Ask `status?` anytime.

### 5. Verify setup

```bash
bun run ralph-serve -- --doctor --worktree .
# automated HTTP smoke (provider must be running with RALPH_TEST_MODE=1, or use --spawn):
bun run e2e-smoke -- --spawn
```


## How the loop behaves

Each user message is a **short** supervisor turn. Long work runs in the background:

```text
You:  Implement JWT auth; tests must pass
Model: Started loop — attempt 1 running. Ask for status anytime.

[background: worker → idle → verify → fail → rollover → attempt 2 → …]

You:  status?
Model: Attempt 2. Last verify failed. Worker idle. …
```

- **Exit criterion:** `verify.command` in `.opencode/ralph.json` (single source of truth for “done”).
- **Memory:** protocol files at repo root — not chat history.
- **Workers:** fresh OpenCode session per attempt; engine spawns via SDK.
- **Worker plugin:** gates `edit`/`bash` until `ralph_load_context()`; provides `rlm_grep` / `rlm_slice`.
- **Permissions:** bash/edit prompts appear in the **worker session** TUI (answer there).


## Protocol files

Created on first `start_loop` (bootstrap) and updated across attempts:

| File | Role |
|------|------|
| `PLAN.md` | Goal and definition of done |
| `RLM_INSTRUCTIONS.md` | Worker playbooks (debug, refactor, repo conventions) |
| `CURRENT_STATE.md` | Scratch pad for the active attempt only |
| `PREVIOUS_STATE.md` | Snapshot after failed verify |
| `AGENT_CONTEXT_FOR_NEXT_RALPH.md` | Handoff: verdict + next-step instructions |
| `NOTES_AND_LEARNINGS.md` | Append-only durable learnings |
| `CONTEXT_FOR_RLM.md` | Large reference — workers use `rlm_grep` + `rlm_slice` only |
| `SUPERVISOR_LOG.md` / `CONVERSATION.md` | Engine + worker progress feed |
| `.opencode/loop_attempt.json` | Attempt marker (worker `ralph_ask` sync) |

Supervisor updates strategy via `update_plan` / `update_rlm_instructions`. Workers may patch `PLAN.md` / `RLM_INSTRUCTIONS.md` with `ralph_update_plan` / `ralph_update_rlm_instructions` when playbooks need to change mid-attempt.


## Default agent instructions

v0.2 ships opinionated defaults so loops work without hand-authored prompts:

| Layer | Source | What it defines |
|-------|--------|-----------------|
| **Supervisor** | `packages/provider/server/lib/supervisor-agent.ts` | Role boundaries, user-intent → tool routing, communication style |
| **Worker system** | `packages/engine/src/templates.ts` → injected by worker plugin | File-first protocol, one-pass lifecycle, anti-patterns |
| **Worker spawn** | `templates.workerPrompt` | Numbered steps per attempt (`ralph_load_context` → … → `ralph_verify` → STOP) |
| **Bootstrap** | `templates.bootstrapPlan`, `bootstrapRlmInstructions` | Initial `PLAN.md` + `RLM_INSTRUCTIONS.md` on `start_loop` |
| **Rollover** | `templates.continuePrompt` | Next-step block in `AGENT_CONTEXT_FOR_NEXT_RALPH.md` after failed verify |

**Customize** without forking:

| Variable | Overrides |
|----------|-----------|
| `RALPH_WORKER_SYSTEM_PROMPT` | Worker system prompt (use `@path/to/file` for multiline) |
| `RALPH_COMPACTION_CONTEXT` | Context injected on session compaction |
| `RALPH_CONTEXT_GATE_ERROR` | Message when edit/bash blocked before `ralph_load_context()` |

Tune `RLM_INSTRUCTIONS.md` and `PLAN.md` in your repo after the first failures — that is the durable steering surface for workers.


## Supervisor tools (chat)

The provider supervisor LLM calls these internally — you steer in natural language.

| Tool | Purpose |
|------|---------|
| `start_loop` | Bootstrap protocol files, begin attempt 1 |
| `loop_status` | Attempt, paused/done/stopped, worker id, last verify |
| `pause_loop` / `resume_loop` / `stop_loop` | Control background orchestration |
| `peek_worker` | Tail of `CURRENT_STATE.md` |
| `read_protocol` | Read allowlisted protocol file |
| `update_plan` / `update_rlm_instructions` | Unified diff patches + changelog |
| `last_verify_output` | Raw verify stdout/stderr |
| `list_worker_questions` / `answer_worker` | Worker `ralph_ask` queue |
| `spawn_swarm` | Parallel side agents (declarative tasks) |
| `swarm_status` / `swarm_cancel` / `swarm_collect` | Manage swarms |
| `swarm_unsafe_runtime_code_eval` | Opt-in SDK script eval (localhost only) |

Test mode (no external LLM): `RALPH_TEST_MODE=1 bun run ralph-serve`


## Worker tools

Available in background worker sessions (ralph-worker plugin):

| Tool | Purpose |
|------|---------|
| `ralph_load_context` | **First call every attempt** — loads protocol files + agent rules |
| `ralph_report` | Progress to `SUPERVISOR_LOG.md` / `CONVERSATION.md` |
| `ralph_set_status` | `running` \| `blocked` \| `done` \| `error` |
| `ralph_verify` | Run `verify.command` once; then STOP |
| `rlm_grep` / `rlm_slice` | Search/slice large files (especially `CONTEXT_FOR_RLM.md`) |
| `ralph_update_plan` / `ralph_update_rlm_instructions` | Durable strategy patches |
| `ralph_ask` | Blocking question to supervisor (use sparingly) |


## Swarm parallelism

Run **side** parallel agents alongside the main verify loop (does not replace `verify.command`):

```text
Spawn parallel agents for auth, api routes, and test fixes.
```

The supervisor uses `spawn_swarm` with structured tasks. Caps: `swarm.maxConcurrent`, `swarm.maxTasksPerRun`, `maxSubAgents` in `ralph.json`.

### Unsafe script eval (opt-in)

`swarm_unsafe_runtime_code_eval` runs supervisor-authored TypeScript in a **subprocess** with an injected OpenCode SDK client. **Disabled by default.**

```json
{ "swarm": { "unsafeEvalEnabled": true } }
```

or `RALPH_SWARM_UNSAFE_EVAL=1`. Scripts are audited under `.opencode/swarm/runs/<id>/`. Prefer declarative `spawn_swarm` for normal use.


## Session correlation

OpenCode does not forward session IDs to custom providers by default. Load **`ralph-session-bridge.ts`** so each TUI session gets its own `LoopRun`.

Confirm after your first supervisor message: response header `x-ralph-session-source` should be `header:x-opencode-session-id`, not `anonymous`. See [GETTINGSTARTEDGUIDE.md § Session correlation](GETTINGSTARTEDGUIDE.md#session-correlation-required-for-multi-session).


## Management API

With `bun run ralph-serve` running:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Provider + OpenCode connectivity |
| `GET /api/loops` | Active loop runs |
| `GET /api/loops/:sessionId` | Loop status |
| `POST /api/loops/:sessionId/pause` | Pause |
| `POST /api/loops/:sessionId/resume` | Resume |
| `POST /api/loops/:sessionId/stop` | Stop + abort worker |
| `GET /api/swarms` | List swarms (`?sessionId=`) |
| `POST /api/swarms/:swarmId/cancel` | Cancel swarm |

OpenAPI UI: `http://127.0.0.1:8787/_scalar`


## Configuration reference

### `.opencode/ralph.json`

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `true` | Master switch |
| `maxAttempts` | `20` | Stop after N failed verify cycles |
| `verify.command` | — | **Required** for real loops |
| `verifyTimeoutMinutes` | `0` | 0 = no timeout |
| `heartbeatMinutes` | `15` | Staleness warning threshold |
| `gateDestructiveToolsUntilContextLoaded` | `true` | Worker must call `ralph_load_context()` first |
| `agentMdPath` | — | Static rules file (e.g. `AGENT.md`) |
| `subAgentEnabled` | `true` | Required for swarms |
| `swarm.enabled` | `true` | Declarative swarms |
| `swarm.maxConcurrent` | `5` | Parallel spawn cap |
| `swarm.unsafeEvalEnabled` | `false` | Script eval gate |

Legacy keys (`autoStartOnMainIdle`, `strategistHandoffMinutes`, reviewer settings) remain in schema for compatibility but are ignored by the v0.2 provider.

### Environment variables

| Variable | Used by |
|----------|---------|
| `RALPH_SUPERVISOR_API_KEY` | Provider supervisor LLM |
| `RALPH_SUPERVISOR_MODEL` | Provider supervisor LLM |
| `RALPH_SUPERVISOR_BASE_URL` | Provider supervisor LLM |
| `OPENCODE_BASE_URL` | Engine SDK (default `http://127.0.0.1:4096`) |
| `RALPH_PROVIDER_PORT` | Provider port (default `8787`) |
| `RALPH_WORKTREE` | Default worktree for `ralph-serve --doctor` |
| `RALPH_TEST_MODE` | Scripted supervisor (tests / CI / smoke) |
| `RALPH_SESSION_DEBUG` | Log session correlation headers on completions |
| `RALPH_ALLOW_ANONYMOUS_SESSION` | Opt-in `anonymous` session key (`1`) — avoid in production |
| `RALPH_SWARM_UNSAFE_EVAL` | Enable unsafe swarm scripts (`1`) |
| `RALPH_WORKER_SYSTEM_PROMPT` | Override worker system prompt |
| `RALPH_COMPACTION_CONTEXT` | Override compaction context block |
| `RALPH_CONTEXT_GATE_ERROR` | Override context-gate error message |


## Development and verification

```bash
bun install
bun run verify              # typecheck + 55 tests + Nitro build (CI uses bin/verify.ts)
bun run e2e-smoke -- --spawn   # HTTP smoke against ephemeral provider
bun run ralph-serve
```

Monorepo modules: `packages/engine`, `packages/provider`, `packages/worker-plugin`.

CI: [`.github/workflows/verify.yml`](.github/workflows/verify.yml)


## npm package

Published as a **single package** with subpath exports:

```bash
npm install @doeixd/opencode-ralph-rlm
```

| Import | Contents |
|--------|----------|
| `@doeixd/opencode-ralph-rlm` | Legacy v0.1 bundle (`dist/ralph-rlm.js`) |
| `@doeixd/opencode-ralph-rlm/engine` | Loop + swarm engine |
| `@doeixd/opencode-ralph-rlm/worker-plugin` | Thin OpenCode worker plugin |
| `@doeixd/opencode-ralph-rlm/provider` | Nitro supervisor server entry |

**Recommended for development:** clone this repo and run `bun run ralph-serve`, or copy `.opencode/plugins/` + config into your project.


## Philosophy

- **Fresh worker context** each attempt — state in files, not chat history.
- **Supervisor never edits repo code** — workers implement; engine verifies.
- **Grep-first RLM** — `rlm_grep` → `rlm_slice`; large reference in `CONTEXT_FOR_RLM.md`.
- **Verify is the contract** — invest in a strong `verify.command`.

Based on [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601) and the Ralph overnight-loop pattern.


## License

MIT (see `package.json`).