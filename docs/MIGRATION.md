# Migration: v0.1 plugin → v0.2 provider

This guide maps the experimental **plugin-as-orchestrator** model (v0.1) to the **provider-as-supervisor** model (v0.2).

v0.2 is **implemented** (see [`REVISION_PLAN.md`](REVISION_PLAN.md)): monorepo packages, provider server, loop engine, worker plugin, session bridge, swarms, and production hardening (M7).

---

## Summary

| v0.1 | v0.2 |
|------|------|
| Main chat session orchestrates via plugin hooks | One TUI session uses model `ralph-rlm/supervisor` |
| `ralph_create_supervisor_session()` | Select provider model in OpenCode |
| `ralph_spawn_worker()` in chat | `LoopEngine` spawns workers via SDK (automatic on `start_loop`) |
| `session.idle` plugin hooks | `event.subscribe()` in engine (+ shared `WorktreeEventBridge`) |
| `ralph_supervision_status()` | Chat: "status?" or `GET /api/loops/:sessionId` |
| `ralph_doctor()` | `bun run ralph-serve -- --doctor [--autofix]` |
| `ralph_ask` / `ralph_respond` | Worker `ralph_ask` + supervisor `answer_worker` tool |
| `subagent_spawn` in worker | Supervisor `spawn_swarm` (provider layer) |
| Monolithic `.opencode/plugins/ralph-rlm.ts` | `ralph-worker.ts` + `ralph-session-bridge.ts` + provider |

**Unchanged:** protocol files (`PLAN.md`, `RLM_INSTRUCTIONS.md`, …), most `.opencode/ralph.json` keys, `verify.command` semantics, worker RLM tools (`rlm_grep`, `rlm_slice`, context gate).

**New in v0.2:** session bridge plugin, default agent instructions (supervisor + worker templates), HTTP management API, CI verify workflow, `bin/e2e-smoke.ts`.

---

## Migration steps

### 1. Stop relying on the legacy plugin

Remove or rename the old plugin so OpenCode does not auto-load it:

```text
.opencode/plugins/ralph-rlm.ts  →  move to plugins-legacy/ (this repo already does this)
```

Install the v0.2 plugins:

```text
.opencode/plugins/
├── ralph-worker.ts
└── ralph-session-bridge.ts
```

### 2. Add provider + OpenCode config

1. Copy [`.opencode/opencode.provider.example.json`](../.opencode/opencode.provider.example.json) into your `opencode.json`.
2. Copy [`.opencode/ralph-provider.example.json`](../.opencode/ralph-provider.example.json) if you want file-based supervisor LLM config.
3. Keep your existing `.opencode/ralph.json` (add `swarm` section if using swarms).
4. Ensure **`ralph-session-bridge.ts`** is present — required for per-session loop isolation.

### 3. Run the provider alongside OpenCode

```bash
# terminal 1
bun run ralph-serve

# terminal 2
opencode
```

Set `RALPH_SUPERVISOR_API_KEY` (or `ralph-provider.json`) before starting the provider.

Validate:

```bash
bun run ralph-serve -- --doctor --worktree .
bun run e2e-smoke -- --spawn
```

### 4. Start loops in chat

**Before (v0.1):**

```text
ralph_create_supervisor_session(start_loop=true)
ralph_spawn_worker()
```

**After (v0.2):**

Select `ralph-rlm/supervisor`, then:

```text
Implement feature X; tests must pass. Start the loop.
```

The supervisor calls `start_loop` internally. Protocol files bootstrap automatically with v0.2 default templates.

### 5. Update mental model for supervision tools

| v0.1 tool | v0.2 equivalent |
|-----------|-----------------|
| `ralph_supervision_status()` | "status?" in chat / `/api/loops/:id` |
| `ralph_pause_supervision()` | "pause the loop" / `POST .../pause` |
| `ralph_resume_supervision()` | "resume" / `POST .../resume` |
| `ralph_end_supervision()` | "stop the loop" / `POST .../stop` |
| `ralph_peek_worker()` | "peek worker" / `peek_worker` tool |
| `ralph_bootstrap_plan()` | `start_loop` bootstraps protocol files; use `update_plan` for edits |
| `ralph_update_plan()` | `update_plan` supervisor tool |
| `ralph_respond(id, answer)` | `answer_worker` supervisor tool |
| `subagent_spawn` / `subagent_await` | `spawn_swarm` / `swarm_status` / `swarm_collect` |

### 6. Agent instructions

v0.1 relied on plugin-injected prompts and LLM discipline. v0.2 splits instructions by layer:

| Layer | v0.2 source |
|-------|-------------|
| Supervisor system prompt | Provider `SupervisorAgent` (tool routing, no repo edits) |
| Worker system prompt | `packages/engine/src/templates.ts` (injected by worker plugin) |
| Per-attempt worker message | `templates.workerPrompt` on SDK spawn |
| Durable steering | `PLAN.md`, `RLM_INSTRUCTIONS.md` (bootstrap + your edits) |

Override worker system prompt: `RALPH_WORKER_SYSTEM_PROMPT` env var (see README).

### 7. Mid-loop migration

If you have an active v0.1 loop in progress:

1. Let the current attempt finish or call `ralph_end_supervision()`.
2. Protocol files are compatible — commit or stash them.
3. Switch to v0.2 provider + both plugins.
4. Start a new supervisor session with `ralph-rlm/supervisor` and delegate the remaining goal.

There is no automatic handoff of in-flight worker sessions across architectures.

---

## Config keys

### Used by v0.2 engine

- `enabled`, `maxAttempts`, `heartbeatMinutes`, `verifyTimeoutMinutes`, `verify`
- `gateDestructiveToolsUntilContextLoaded`, `maxRlmSliceLines`, `requireGrepBeforeLargeSlice`, `grepRequiredThresholdLines`
- `subAgentEnabled`, `maxSubAgents` (swarms)
- `agentMdPath`
- `swarm.*` (declarative swarms + unsafe eval gate)

### Ignored by v0.2 provider (legacy / deferred to v0.3+)

- `autoStartOnMainIdle` — no main-session idle orchestration
- `strategistHandoffMinutes`, `strategistHandoffMaxRetries`
- `reviewerEnabled`, `reviewerRequireExplicitReady`, … — reviewer deferred
- `statusVerbosity`, `maxConversationLines`, `conversationArchiveCount` — partial parity via file logs

---

## Running both versions

For comparison or rollback, load the legacy plugin from `.opencode/plugins-legacy/ralph-rlm.ts` **without** registering the v0.2 provider. Do not run both orchestrators on the same repo simultaneously.

---

## Getting help

- Setup: [`GETTINGSTARTEDGUIDE.md`](GETTINGSTARTEDGUIDE.md)
- Reference: [`README.md`](../README.md)
- Architecture: [`REVISION_PLAN.md`](REVISION_PLAN.md)
- Issues: GitHub issues on [opencode-ralph-rlm](https://github.com/doeixd/opencode-ralph-rlm)