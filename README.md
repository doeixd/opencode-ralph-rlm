[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/doeixd/opencode-ralph-rlm)

# ralph-rlm

An [OpenCode](https://opencode.ai) integration for **long-running, hands-off coding work**. Describe a goal, walk away, and come back to finished work. Behind the scenes a fresh agent keeps working in a loop — checking itself against *your* tests after every attempt — until the job is actually done.

It combines two ideas:

- **Ralph** — the "just run the agent in a loop until it's done" technique ([ralph-wiggum.ai](https://ralph-wiggum.ai/)). Instead of one long, drifting chat, each attempt starts with a **fresh** agent whose real memory lives in files on disk. Simple, relentless, and surprisingly effective for overnight-style runs.
- **RLM (Recursive Language Models)** — instead of stuffing huge reference material into the context window, the agent treats it as a store it **greps and slices on demand** ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601)).

You talk to **one** model in the OpenCode TUI — `ralph-rlm/supervisor`. Behind it, a small local helper runs the loop for you: it plans the work *with* you, starts a fresh worker for each attempt, runs your test command to decide "done," and carries lessons forward between attempts — all in the background. You steer in plain language ("status?", "pause", "the API changed, replan") and review durable files, not an endless chat log.

### Why use it

- **Set a goal and leave.** The loop self-corrects across many attempts without babysitting.
- **Your tests are the finish line.** A `verify.command` you choose is the single source of truth for "done" — not vibes.
- **Memory you can read, edit, and trust.** Progress lives in plain files (`PLAN.md`, notes, …) you can version and steer.
- **Plan before building.** A short interview turns a one-line goal into a real plan with a definition of done — before any code is written.

### How a run feels

```text
You:   Add JWT auth; the test suite must pass.
Ralph: Let's plan first — refresh tokens too? which test command counts as "done"?
You:   yes, refresh tokens; npm test
Ralph: Plan locked (PLAN.md). Attempt 1 running in the background — ask "status?" anytime.

       …worker implements → verify fails → notes the reason → attempt 2 → verify passes…

You:   status?
Ralph: Done — verify passed on attempt 2. Summary is in CONVERSATION.md.
```


## Quick start

**Fastest path — let your agent set it up.** From your project, install the setup skill:

```bash
npx skills add doeixd/opencode-ralph-rlm
```

Then paste this to your coding agent:

```text
Use the setup-opencode-ralph-rlm skill to install Ralph RLM in this project.
```

That's it — the skill inspects the repo, installs the wiring, picks a sensible `verify.command`, runs diagnostics, and offers to add Ralph guidance to your `AGENT.md`. Then jump to [Start the provider](#3-start-the-provider).

Prefer to drive it yourself? The same steps by hand:

### 1. Install with the agent skill (recommended)

The two commands above are the whole step. The skill handles repo inspection, setup, config review, `verify.command`, diagnostics, and asks whether to add Ralph guidance to `AGENT.md` / `AGENTS.md`.

### 2. Or use the CLI directly

In your target repo:

```bash
npm install -D @doeixd/opencode-ralph-rlm
npx @doeixd/opencode-ralph-rlm setup
```

This path uses Node/npm; Bun is not required for end users.

This creates conservative project-local wiring:

- `.opencode/plugins/ralph-worker.ts`
- `.opencode/plugins/ralph-session-bridge.ts`
- `.opencode/plugins/ralph-autostart.ts` — auto-starts the provider when OpenCode loads (skip with `setup --no-autostart`)
- `.opencode/ralph.json`
- `opencode.json` provider entry for `ralph-rlm/supervisor`

Existing managed files are skipped unless you pass `--force`. Preview changes with:

```bash
npx @doeixd/opencode-ralph-rlm setup --dry-run
```

Manual examples remain in [`.opencode/opencode.provider.example.json`](.opencode/opencode.provider.example.json) and [`.opencode/ralph-provider.example.json`](.opencode/ralph-provider.example.json).

For full setup options, including manual installation, see [`INSTALLATION.md`](docs/INSTALLATION.md).

### 3. Start the provider

After setup, the provider **auto-starts when you open OpenCode** (via the `ralph-autostart` plugin) — so you can usually skip this. To run it manually (or if you used `--no-autostart` / `RALPH_AUTOSTART=0`):

```bash
npx @doeixd/opencode-ralph-rlm serve
# optional: --port 8787 --opencode-url http://127.0.0.1:4096
#           --worktree /path/to/your/repo
```

Supervisor LLM credentials (provider process). **If you've already authenticated a keyed provider in OpenCode** (e.g. Google, OpenCode Zen via `opencode auth login`), the provider auto-detects it — no extra config needed. To force a specific provider/model instead:

```bash
export RALPH_SUPERVISOR_API_KEY="..."
export RALPH_SUPERVISOR_MODEL="gpt-5.4-mini"   # + RALPH_SUPERVISOR_BASE_URL for non-OpenAI endpoints
```

Or `.opencode/ralph-provider.json` — see [`.opencode/ralph-provider.example.json`](.opencode/ralph-provider.example.json). Check what resolved with `curl http://127.0.0.1:8787/api/health` (`supervisor.ready` / `model` / `source`).

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
npx @doeixd/opencode-ralph-rlm doctor --worktree .
# automated HTTP smoke (provider must be running with RALPH_TEST_MODE=1, or use --spawn):
bun run e2e-smoke -- --spawn
```


## Documentation

| Doc | Start here if you want to… |
|-----|----------|
| [`GETTINGSTARTEDGUIDE.md`](docs/GETTINGSTARTEDGUIDE.md) | **Set it up and run your first loop** (start here) |
| [`INSTALLATION.md`](docs/INSTALLATION.md) | Compare install paths (agent skill, CLI, manual) |
| [`MIGRATION.md`](docs/MIGRATION.md) | Upgrade from the v0.1 plugin |
| [`CHANGELOG.md`](CHANGELOG.md) | See what changed |
| [DeepWiki](https://deepwiki.com/doeixd/opencode-ralph-rlm) | Browse / ask questions about the codebase |

The rest of this README is reference material — tools, config, the management API, and how it works under the hood. New here? Follow the [getting-started guide](docs/GETTINGSTARTEDGUIDE.md) instead, or [ask DeepWiki](https://deepwiki.com/doeixd/opencode-ralph-rlm) anything about the code.


## Plan before the loop

A loop is only as good as its `PLAN.md` — every worker treats it as authority over chat history. The **`interview-and-create-plan`** skill turns a vague goal into an authored plan *before* attempt 1, two ways:

- **Path A — supervisor runs it.** When you delegate a goal and no authored plan exists, the supervisor enters a planning phase: it explores the repo (`repo_search` / `repo_grep`), interviews you to sharpen the goal and stress-test the design, writes `PLAN.md` via `write_plan`, **agrees a strong `verify.command` with you** (`set_verify` + `run_verify` to confirm it fails before the work is done), and only calls `start_loop` after you approve.
- **Path B — run the skill yourself.** Run the `interview-and-create-plan` skill in a normal session (full tools, your chosen model). It writes `PLAN.md` to the path `opencode-ralph-rlm plan-path` reports (the active plan dir, not necessarily the repo root). Then switch to `ralph-rlm/supervisor` and say "go" — `start_loop` detects the authored plan and launches against it without re-bootstrapping.

Both paths share one source of truth: the skill at `skills/interview-and-create-plan/SKILL.md` (a repo-local copy overrides the baked-in default). `start_loop` never overwrites an authored plan, and when it does bootstrap a fresh one it weaves your goal in instead of leaving a placeholder.

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
- **Memory:** protocol files in the active plan dir (`.ralph-rlm/plans/<name>/`, or repo root in legacy mode) — not chat history.
- **Workers:** fresh OpenCode session per attempt; engine spawns via SDK.
- **Worker plugin:** gates `edit`/`bash` until `ralph_load_context()`; provides FFF-accelerated `rlm_grep`, `rlm_file_search`, `rlm_glob`, and `rlm_slice`. Its `ralph_*` / `rlm_*` tools are **hidden from your normal OpenCode sessions** — they're denied globally and re-enabled only in the dedicated `ralph-worker` agent that workers run under.
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
| `NOTES_AND_LEARNINGS.md` | Curated durable knowledge — editable, not append-only; link to domain glossary / ADRs / design docs |
| `CONTEXT_FOR_RLM.md` | Large reference — workers use `rlm_grep` + `rlm_slice` only |
| `SUPERVISOR_LOG.md` / `CONVERSATION.md` | Engine + worker progress feed |
| `.opencode/loop_attempt.json` | Attempt marker (worker `ralph_ask` sync) |

Supervisor updates strategy via `update_plan` / `update_rlm_instructions`. Workers may patch `PLAN.md` / `RLM_INSTRUCTIONS.md` with `ralph_update_plan` / `ralph_update_rlm_instructions` when playbooks need to change mid-attempt.


## Named plans (versions)

Protocol files live in a per-plan directory so you can keep multiple versions and switch between them:

```
.ralph-rlm/plans/
  default/      PLAN.md  RLM_INSTRUCTIONS.md  NOTES_AND_LEARNINGS.md  …  .state/
  jwt-auth/     …
  refactor-api/ …
  .active       → active plan name
```

- **Layout** is set by `plans.dir` in `.opencode/ralph.json` (default `.ralph-rlm/plans`). Set it to `""` or `"."` for the legacy root layout.
- **Backward compatible:** if a repo already has a root `PLAN.md` (a pre-named-plans install) and no `.ralph-rlm/plans`, the legacy root layout is auto-detected and kept.
- **Switching:** the supervisor exposes `list_plans`, `select_plan <name>`, and `new_plan <name>`. `start_loop`, `read_protocol`, and `write_plan` all target the active plan. The active plan is tracked by the `.active` pointer (per worktree).
- **Config location:** `ralph.json` is read from `.ralph-rlm/ralph.json` first, then `.opencode/ralph.json`.
- **Markers** (`loop_attempt.json`, `pending_input.json`) live in each plan's `.state/` dir, so plans don't collide.

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
| `start_loop` | Bootstrap protocol files, begin attempt 1 (launches against an authored `PLAN.md` when one exists) |
| `repo_search` / `repo_grep` | Planning-phase repo exploration (cross-reference the goal against the code) |
| `write_plan` | Write the authored `PLAN.md` after the planning interview is approved |
| `list_plans` / `select_plan` / `new_plan` | List, switch, or create named plans (versions) under the configured plans dir |
| `loop_status` | Attempt, paused/done/stopped, worker id, last verify |
| `pause_loop` / `resume_loop` / `stop_loop` | Control background orchestration |
| `peek_worker` | Tail of `CURRENT_STATE.md` |
| `read_protocol` | Read allowlisted protocol file |
| `update_plan` / `update_rlm_instructions` | Unified diff patches + changelog |
| `get_verify` / `set_verify` / `run_verify` | Read / write / dry-run `verify.command` — craft & validate the loop's stop condition with the user |
| `last_verify_output` | Raw verify stdout/stderr |
| `list_worker_questions` / `answer_worker` | Worker `ralph_ask` queue |
| `spawn_swarm` | Parallel side agents (declarative tasks) |
| `swarm_status` / `swarm_cancel` / `swarm_collect` | Manage swarms |
| `swarm_unsafe_runtime_code_eval` | Opt-in SDK script eval (localhost only) |

Test mode (no external LLM): `RALPH_TEST_MODE=1 npx @doeixd/opencode-ralph-rlm serve --worktree .`


## Worker tools

Available in background worker sessions (ralph-worker plugin):

| Tool | Purpose |
|------|---------|
| `ralph_load_context` | **First call every attempt** — loads protocol files + agent rules |
| `ralph_report` | Progress to `SUPERVISOR_LOG.md` / `CONVERSATION.md` |
| `ralph_set_status` | `running` \| `blocked` \| `done` \| `error` |
| `ralph_verify` | Run `verify.command` once; then STOP |
| `rlm_file_search` | Fuzzy file search across the worktree |
| `rlm_glob` | Fast glob discovery, e.g. `**/*.ts` |
| `rlm_grep` / `rlm_slice` | Search/slice large files (especially `CONTEXT_FOR_RLM.md`) |
| `ralph_update_plan` / `ralph_update_rlm_instructions` | Durable strategy patches |
| `ralph_ask` | Blocking question to supervisor (use sparingly) |

`rlm_file_search`, `rlm_glob`, and `rlm_grep` use optional [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node) acceleration when it is available. If the native package cannot load or scan, Ralph keeps working: `rlm_grep` falls back to its exact TypeScript file scan and the discovery tools return a structured unavailable reason.


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

Confirm after your first supervisor message: response header `x-ralph-session-source` should be `header:x-opencode-session-id`, not `anonymous`. See [GETTINGSTARTEDGUIDE.md § Session correlation](docs/GETTINGSTARTEDGUIDE.md#session-correlation-required-for-multi-session).


## Management API

With `npx @doeixd/opencode-ralph-rlm serve --worktree .` running:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Provider + OpenCode connectivity |
| `GET /api/loops` | Active loop runs |
| `GET /api/loops/:sessionId` | Loop status |
| `POST /api/loops/:sessionId/pause` | Pause |
| `POST /api/loops/:sessionId/resume` | Resume |
| `POST /api/loops/:sessionId/stop` | Stop + abort worker |
| `POST /api/loops/:sessionId/message` | Inject an out-of-band message to the supervisor (watchers/scripts) |
| `GET /api/swarms` | List swarms (`?sessionId=`) |
| `POST /api/swarms/:swarmId/cancel` | Cancel swarm |

OpenAPI UI: `http://127.0.0.1:8787/_scalar`


## External messages (watchers)

Scripts and schedulers can send the supervisor a message out-of-band — useful for "watch for X, then tell the supervisor." The message is recorded to the active plan's `CONVERSATION.md` / `SUPERVISOR_LOG.md`, shown as a TUI toast, and (by default) runs a supervisor turn so it can **act autonomously** (pause, replan, spawn a swarm, even start a loop).

```bash
# Discover the session id, then send a message
opencode-ralph-rlm sessions
opencode-ralph-rlm send-message -s <sessionId> -m "CI went red — pause and replan."

# Just notify (record + toast), don't run a supervisor turn:
opencode-ralph-rlm send-message -s <sessionId> -m "deploy finished" --no-run --source deploy-bot
```

Or hit the endpoint directly so any language/cron can drive it:

```bash
curl -s http://127.0.0.1:8787/api/loops/<sessionId>/message \
  -H 'content-type: application/json' \
  -d '{"message":"main branch updated — rebase and re-verify","source":"git-hook"}'
```

A watcher then becomes a small script the agent can write, e.g. PowerShell polling a condition:

```powershell
while ($true) {
  if (Test-Path .\BUILD_FAILED) {
    opencode-ralph-rlm send-message -s $env:RALPH_SESSION -m "Build failed — stop and diagnose."
    Remove-Item .\BUILD_FAILED
  }
  Start-Sleep -Seconds 30
}
```

Body fields: `message` (required), `source` (label), `toast` (default `true`), `runTurn` (default `true`; `false` records + toasts only). The provider is localhost-only by default and the management API is unauthenticated — keep it bound to loopback.


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
| `plans.dir` | `.ralph-rlm/plans` | Base dir for named plans. `""`/`"."` = legacy root layout |
| `plans.active` | `default` | Default active plan name (overridden by the `.active` pointer) |
| `fff.enabled` | `true` | Optional native search acceleration |
| `fff.scanTimeoutMs` | `10000` | Initial FFF index scan timeout |
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
| `RALPH_OPENCODE_AUTH_PATH` | Override path to OpenCode `auth.json` for supervisor credential auto-detect |
| `OPENCODE_BASE_URL` | Engine SDK (default `http://127.0.0.1:4096`) |
| `RALPH_PROVIDER_PORT` | Provider port (default `8787`) |
| `RALPH_WORKTREE` | Default worktree for `opencode-ralph-rlm doctor` / `serve` |
| `RALPH_TEST_MODE` | Scripted supervisor (tests / CI / smoke) |
| `RALPH_SESSION_DEBUG` | Log session correlation headers on completions |
| `RALPH_ALLOW_ANONYMOUS_SESSION` | Opt-in `anonymous` session key (`1`) — avoid in production |
| `RALPH_SWARM_UNSAFE_EVAL` | Enable unsafe swarm scripts (`1`) |
| `RALPH_WORKER_SYSTEM_PROMPT` | Override worker system prompt |
| `RALPH_COMPACTION_CONTEXT` | Override compaction context block |
| `RALPH_CONTEXT_GATE_ERROR` | Override context-gate error message |
| `RALPH_FFF_DISABLED` | Disable optional FFF worker search acceleration (`1`) |


## Architecture (under the hood)

You don't need this to use Ralph — it's here if you want to know what's running.

v0.2 uses a **provider-as-supervisor** design. The loop is exposed as a custom OpenCode provider model (`ralph-rlm/supervisor`), so you talk to one session while deterministic code owns verify, rollover, and worker lifecycle behind the API.

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

**Recommended for users:** run `npx @doeixd/opencode-ralph-rlm setup`, then `npx @doeixd/opencode-ralph-rlm serve`.

**Recommended for development:** clone this repo and run `bun run ralph-serve`.


## Philosophy

- **Fresh worker context** each attempt — state in files, not chat history.
- **Supervisor never edits repo code** — workers implement; engine verifies.
- **Search-first RLM** — `rlm_file_search` / `rlm_glob` to find files, then `rlm_grep` → `rlm_slice` for large references.
- **Verify is the contract** — invest in a strong `verify.command`.

## Credits

- **Ralph** — the loop-until-done agent pattern. [ralph-wiggum.ai](https://ralph-wiggum.ai/) is the reference for the technique: run a coding agent in a deliberately simple loop, keep its memory in files rather than an ever-growing chat, and let repetition do the work.
- **RLM (Recursive Language Models)** — the search-first approach to large context, [arXiv:2512.24601](https://arxiv.org/abs/2512.24601).


## License

MIT (see `package.json`).
