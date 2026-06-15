# Ralph-RLM Revision Plan

> **Status:** v0.2 complete — M0–M8 implemented; human-facing docs aligned; optional manual TUI validation + git tag/publish remain
> **Date:** 2026-06-15 (updated 2026-06-15)  
> **Audience:** Contributors implementing the v0.2 architecture and planning v0.3

This document describes the planned revision of `opencode-ralph-rlm` from a **plugin-as-orchestrator** model to a **provider-as-supervisor** model. It supersedes the experimental plugin-centric loop described in the current README caveat.

---

## 1. Executive summary

### Problem with v0.1 (current plugin)

The current implementation asks an OpenCode **chat session** to be both the user interface and the loop orchestrator. The plugin compensates with `session.idle` hooks, `promptAsync` re-injection, binding rituals (`ralph_create_supervisor_session`), and social enforcement (“call `ralph_spawn_worker()`, never code”). This creates:

- Split ownership of the state machine (plugin vs LLM discipline)
- Noisy UX (injected supervisor messages, multiple sessions)
- Fragile control flow (idle debouncing, handoff timers, prompt fallbacks)
- No clean request/response contract for the user

The README author’s note is correct: this works better as a **layer above OpenCode**, not as a plugin that tries to orchestrate from inside the host.

### Target (v0.2)

Expose the Ralph+RLM loop as an **OpenAI-compatible custom provider model** (`ralph-rlm/supervisor`). The user talks to one supervisor in the OpenCode TUI. Behind the API:

1. A **Nitro HTTP server** implements `/v1/chat/completions` (the “model”).
2. A **LoopEngine** (deterministic state machine) owns verify, rollover, and worker lifecycle.
3. The **OpenCode SDK** runs worker coding sessions in the background.
4. A **thin worker plugin** retains RLM file-first tools and context gating only.

Protocol files (`PLAN.md`, `RLM_INSTRUCTIONS.md`, etc.) remain the durable memory primitive.

---

## 2. Goals

| ID | Goal |
|----|------|
| G1 | User interacts with **one** OpenCode session using model `ralph-rlm/supervisor` |
| G2 | Workers run **in the background** without polluting the supervisor conversation |
| G3 | Loop orchestration is **deterministic code** (`LoopEngine`), not LLM self-discipline |
| G4 | Supervisor has **inspect/manage tools** (status, peek, pause, plan updates) |
| G5 | Workers retain **file-first RLM discipline** (grep/slice, context gate, one-pass) |
| G6 | `verify.command` remains the **single exit criterion** for “done” |
| G7 | Management/debug APIs are **documented** via Nitro OpenAPI (Scalar/Swagger) |
| G8 | Backward compatibility for **protocol files** and `.opencode/ralph.json` config keys where practical |
| G9 | Supervisor can launch **parallel agent swarms** (declarative first; optional unsafe script eval) without returning to the v0.1 plugin orchestration model |

## 3. Non-goals (v0.2)

- Replacing OpenCode’s native `build` / `plan` agents for manual coding
- Modeling strategist/worker as OpenCode primary/subagent profiles (README guidance unchanged)
- Full feature parity with v0.1 plugin on day one (reviewer, swarm, env-var prompt customization deferred to v0.3)
- Running LLM-generated code **in-process** inside the Nitro provider (swarm scripts always execute in an isolated subprocess)
- Publishing the provider to a public cloud (v0.2 is localhost-first)
- Implementing a custom LLM training/fine-tuning pipeline

---

## 4. Target architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  User — OpenCode TUI                                            │
│  model: ralph-rlm/supervisor                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ POST /v1/chat/completions (+ SSE)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/provider — Nitro server (:8787)                       │
│  ├─ /v1/models, /v1/chat/completions   ← OpenCode-facing       │
│  ├─ /api/loops/*, /api/health          ← OpenAPI-documented     │
│  ├─ SupervisorAgent (LLM + tool loop, internal)                 │
│  ├─ LoopRegistry (sessionId → LoopRun)                          │
│  └─ SwarmRegistry (sessionId → SwarmRun[])                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/engine — LoopEngine + SwarmRunner                     │
│  ├─ config load (.opencode/ralph.json)                          │
│  ├─ protocol file bootstrap / rollover                          │
│  ├─ verify runner                                               │
│  ├─ worker spawn / abort / await idle                           │
│  ├─ swarm spawn / track / cancel (side-tasks, parallel agents)  │
│  ├─ swarm script runner (Deno subprocess; unsafe opt-in)      │
│  ├─ WorktreeEventBridge (one event.subscribe per worktree)    │
│  ├─ AsyncEventQueue (serialized handleEvent; 10k cap)           │
│  └─ SUPERVISOR_LOG.md / CONVERSATION.md writes                  │
└────────────────────────────┬────────────────────────────────────┘
                             │ @opencode-ai/sdk
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode server (:4096) — execution plane                      │
│  Worker sessions (agent: build, parentID optional)              │
│  + packages/worker-plugin (rlm_grep, rlm_slice, context gate) │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Protocol files (repo root) — durable memory                    │
│  PLAN.md, RLM_INSTRUCTIONS.md, CURRENT_STATE.md, ...            │
└─────────────────────────────────────────────────────────────────┘
```

### Conversation model (async supervisor)

Each user message triggers a **short** `/v1/chat/completions` request. The supervisor LLM runs inside the provider with **supervisor-only tools**. Long-running work happens in a **background task** keyed by OpenCode session ID:

```
User:  "Implement JWT auth; tests must pass"
Model: "Started loop — attempt 1 running. Ask for status anytime."

[background: worker → idle → verify → fail → rollover → attempt 2 → ...]

User:  "status?"
Model: "Attempt 2. 3 tests failing in legacy JWT path. Worker still running."
```

Do **not** block a single HTTP request until `maxAttempts` exhausts or verify passes.

---

## 5. Repository structure (target)

Migrate from a single plugin file to a small monorepo:

```
opencode-ralph-rlm/
├── packages/
│   ├── engine/                 # @ralph-rlm/engine — pure loop logic
│   │   ├── src/
│   │   │   ├── config.ts
│   │   │   ├── protocol-files.ts
│   │   │   ├── verify.ts
│   │   │   ├── rollover.ts
│   │   │   ├── loop-engine.ts
│   │   │   ├── loop-run.ts
│   │   │   ├── swarm-runner.ts
│   │   │   ├── swarm-registry.ts
│   │   │   ├── swarm-script-runner.ts
│   │   │   └── opencode-client.ts
│   │   └── package.json
│   │
│   ├── provider/               # @ralph-rlm/provider — Nitro server
│   │   ├── nitro.config.ts
│   │   ├── routes/
│   │   │   ├── v1/models.get.ts
│   │   │   ├── v1/chat/completions.post.ts
│   │   │   └── api/...
│   │   ├── server/
│   │   │   ├── supervisor-agent.ts
│   │   │   ├── supervisor-tools.ts
│   │   │   ├── openai-compat.ts
│   │   │   └── loop-registry.ts
│   │   └── package.json
│   │
│   └── worker-plugin/          # @ralph-rlm/worker-plugin — thin OpenCode plugin
│       ├── src/ralph-worker.ts
│       └── package.json
│
├── bin/
│   └── ralph-serve.ts          # Starts provider + optional opencode connect
│
├── .opencode/
│   ├── ralph.json              # unchanged role
│   ├── plugins/ralph-worker.ts   # symlink or copy from worker-plugin build
│   └── opencode.provider.example.json
│
├── REVISION_PLAN.md            # this file
├── README.md                   # update in M5
└── package.json                # workspace root
```

### Technology choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Provider HTTP | [Nitro](https://nitro.build/) | File routing, Bun-friendly, SSE capable |
| API docs | [Nitro OpenAPI](https://nitro.build/docs/openapi) | Scalar/Swagger for `/api/*`; experimental is acceptable for ops |
| OpenCode integration | [`@opencode-ai/sdk`](https://opencode.ai/docs/sdk/) | Session create/prompt/events |
| Engine types/async | Effect-TS (optional) | Reuse patterns from v0.1; evaluate slimming to plain async if cost > benefit |
| Runtime | Bun | Matches repo and OpenCode plugin ecosystem |
| Supervisor LLM | Direct provider API (Anthropic/OpenAI) | Decoupled from worker model selection; configurable |

---

## 6. Component specifications

### 6.1 LoopEngine (`packages/engine`)

**Responsibility:** Deterministic loop state machine. No user-facing LLM logic.

**Extract from** `.opencode/plugins/ralph-rlm.ts`:

| Module | Source (approx) | Notes |
|--------|-----------------|-------|
| `config.ts` | `RalphConfigSchema`, `resolveConfig`, `CONFIG_DEFAULTS` | Preserve config keys |
| `protocol-files.ts` | `FILES`, `bootstrapProtocolFiles`, `applyPatch` | |
| `verify.ts` | `runCommand`, `runAndParseVerify` | |
| `rollover.ts` | `rolloverState`, done-file content | |
| `loop-run.ts` | `SupervisorState`, `SessionState` (worker half) | Drop main-session binding |
| `loop-engine.ts` | `spawnRlmWorker`, `handleWorkerIdle` logic | Event-driven, not plugin hooks |
| `opencode-client.ts` | SDK wrapper | `create`, `prompt`, `abort`, `subscribe` |

**LoopEngine public API (draft):**

```typescript
interface LoopEngine {
  start(run: LoopRunConfig): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  stop(sessionId: string, reason?: string): Promise<void>;
  status(sessionId: string): Promise<LoopStatus>;
  peekWorker(sessionId: string, maxLines?: number): Promise<string>;
  on(event: LoopEvent, handler: Handler): void;
}
```

**Events emitted:** `attempt.started`, `worker.spawned`, `worker.idle`, `verify.done`, `rollover`, `loop.done`, `loop.max_attempts`, `worker.question`.

**SwarmRunner (v0.3, `packages/engine`):**

Parallel OpenCode sessions orchestrated by deterministic engine code — not worker-plugin `subagent_spawn` and not in-process `eval`. Replaces v0.1 sub-agent parallelism at the provider layer.

| Module | Responsibility |
|--------|----------------|
| `swarm-runner.ts` | Declarative multi-session spawn, idle/error tracking, concurrency caps |
| `swarm-registry.ts` | `sessionId → SwarmRun[]` (multiple side-swarms per supervisor session) |
| `swarm-script-runner.ts` | Isolated subprocess execution for `swarm_unsafe_runtime_code_eval` |

**Swarm execution model (v0.3 decision):**

- **Side swarm** — default. Runs **alongside** the main verify loop; does **not** replace `LoopEngine` attempt/verify/rollover. Useful for parallel research, multi-file refactors, reviewer/doc agents, exploratory spikes.
- Main loop `verify.command` remains the single “done” criterion unless the user explicitly stops the loop and adopts swarm output manually.
- Each swarm task maps to one OpenCode `session.create` + `session.prompt` (same SDK path as `worker-spawn.ts`).
- `maxSubAgents` / new `swarm.maxConcurrent` / `swarm.maxTasksPerRun` enforced in engine code before any SDK call.

**Declarative swarm spec (primary path):**

```typescript
interface SpawnSwarmInput {
  label?: string;
  tasks: Array<{
    name: string;
    goal: string;
    agent?: string;           // default from ralph-provider.json worker.agent
    context?: string;
    providerID?: string;
    modelID?: string;
  }>;
  concurrency?: number;       // default min(tasks.length, swarm.maxConcurrent)
  waitPolicy?: "none" | "all" | "any";  // default "none" — fire-and-forget
  timeoutMinutes?: number;
}
```

**Unsafe script eval (opt-in power path):**

Tool: `swarm_unsafe_runtime_code_eval`. Supervisor supplies TypeScript that uses a **documented prelude API** — not the full Node/Bun/Deno stdlib unless unsafe mode is explicitly enabled.

| Mode | Config | Runtime | Sandbox |
|------|--------|---------|---------|
| **Safe script** (default when scripts enabled) | `swarm.scriptRunner: "deno"` | Deno subprocess | `--allow-net=127.0.0.1:<opencode-port>`, `--allow-env=OPENCODE_BASE_URL,RALPH_WORKTREE,RALPH_SWARM_RUN_ID`, deny fs/run/subprocess; pinned `npm:@opencode-ai/sdk@<version>` |
| **Unsafe eval** | `swarm.unsafeEvalEnabled: true` **or** `RALPH_SWARM_UNSAFE_EVAL=1` | Deno if installed, else Bun subprocess | Broader permissions (`--allow-all` on Deno / minimal env isolation on Bun); **localhost only**; loud startup warning in provider logs |

Rules for `swarm_unsafe_runtime_code_eval`:

1. **Never** execute in the Nitro process — always subprocess with wall-clock timeout and session spawn caps enforced by a wrapper, even in unsafe mode.
2. Persist script to `.opencode/swarm/runs/<runId>.ts` before execution (audit trail).
3. Inject frozen prelude globals: `{ client, directory, report, sleep, runId }` where `client` is `createOpencodeClient({ baseUrl })`.
4. Disabled by default; supervisor tool returns an error unless opt-in config/env is set.
5. Tool description and provider startup banner must say **UNSAFE** — user accepts arbitrary SDK calls and network to OpenCode only (unsafe mode may allow more).

**Example — declarative (typical):**

```
User: "Spin up parallel agents for auth, api routes, and test fixes."
Supervisor calls spawn_swarm({
  tasks: [
    { name: "auth", goal: "Implement JWT middleware in src/auth/" },
    { name: "api", goal: "Add /login and /refresh routes" },
    { name: "tests", goal: "Fix failing auth integration tests" }
  ],
  concurrency: 3
})
→ "Swarm swarm-abc running (3 tasks). Main loop unchanged."
```

**Example — unsafe eval (opt-in, audit logged):**

```typescript
// Passed to swarm_unsafe_runtime_code_eval — prelude injects client, directory, report, sleep
const names = ["auth", "api", "tests"];
const sessions = [];
for (const name of names) {
  const { data } = await client.session.create({ title: `swarm-${name}`, directory });
  sessions.push(data!.id);
  await client.session.prompt({
    sessionID: data!.id,
    directory,
    agent: "build",
    parts: [{ type: "text", text: `Work on ${name}` }],
  });
}
await report({ spawned: sessions.length, sessions });
```

**Why Deno preferred over Bun for scripts:** permission flags and `npm:` specifiers without a separate install step. Bun remains the repo runtime; Deno is an **optional** dependency detected at runtime (`deno --version`). If missing, fall back to Bun subprocess with stricter static checks and a warning.

**Swarm events emitted:** `swarm.started`, `swarm.task.spawned`, `swarm.task.idle`, `swarm.task.error`, `swarm.done`, `swarm.cancelled`, `swarm.script.started`, `swarm.script.done`, `swarm.script.error`.

### 6.2 Provider server (`packages/provider`)

**OpenCode-facing routes (hand-implemented, not OpenAPI-generated):**

#### `GET /v1/models`

Returns OpenAI-compatible model list:

```json
{
  "object": "list",
  "data": [
    {
      "id": "supervisor",
      "object": "model",
      "owned_by": "ralph-rlm"
    }
  ]
}
```

#### `POST /v1/chat/completions`

- Accepts OpenAI chat completion request body (`messages`, `stream`, `model`, …).
- Maps request → `SupervisorAgent.turn(sessionId, messages)`.
- Returns JSON or SSE (`data: {...}\n\n`, terminal `data: [DONE]\n\n`).
- **Session identity:** see §7.1 (critical spike).

**Management routes (OpenAPI-documented):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Provider + OpenCode SDK connectivity |
| `GET` | `/api/loops` | List active `LoopRun`s |
| `GET` | `/api/loops/:sessionId` | Full status |
| `POST` | `/api/loops/:sessionId/pause` | Pause background loop |
| `POST` | `/api/loops/:sessionId/resume` | Resume |
| `POST` | `/api/loops/:sessionId/stop` | Stop + optional worker abort |
| `GET` | `/api/loops/:sessionId/verify/last` | Last verify output |

Nitro config:

```typescript
export default defineConfig({
  experimental: { openAPI: true },
  openAPI: {
    meta: {
      title: "Ralph RLM Provider",
      description: "Supervisor provider and loop management API",
      version: "0.2.0",
    },
    production: "runtime",
  },
});
```

Protect `/_scalar`, `/_openapi.json`, and `/api/*` in production (localhost bind default).

### 6.3 SupervisorAgent (`packages/provider/server`)

**Responsibility:** One conversational turn per user message.

Flow:

1. Receive `messages[]` from OpenAI request.
2. Call configured LLM with **supervisor tool definitions**.
3. Execute tool calls internally (loop against LLM until no tools or max rounds).
4. Return final assistant text (stream tokens if `stream: true`).

**Supervisor tools (v0.2):**

| Tool | Mutates state | Description |
|------|---------------|-------------|
| `loop_status` | No | Attempt, done, paused, worker id, last verdict |
| `start_loop` | Yes | Bootstrap plan if needed, begin attempt 1 |
| `pause_loop` | Yes | Pause background orchestration |
| `resume_loop` | Yes | Resume |
| `stop_loop` | Yes | Stop loop, abort worker |
| `peek_worker` | No | Read `CURRENT_STATE.md` tail |
| `read_protocol` | No | Read named protocol file (allowlist) |
| `update_plan` | Yes | Unified diff patch + changelog |
| `update_rlm_instructions` | Yes | Unified diff patch + changelog |
| `last_verify_output` | No | Raw verify stdout/stderr |
| `answer_worker` | Yes | Respond to blocked worker question |
| `list_worker_questions` | No | Unanswered `ralph_ask` queue |

**Supervisor tools (v0.3 — swarm):**

| Tool | Mutates state | Description |
|------|---------------|-------------|
| `spawn_swarm` | Yes | Declarative parallel agents (primary); returns `swarmId` |
| `swarm_status` | No | Per-task session ids, idle/error/done, elapsed time |
| `swarm_cancel` | Yes | Abort all sessions in a swarm run |
| `swarm_collect` | No | Aggregate task outputs (protocol tails / peek messages) |
| `swarm_unsafe_runtime_code_eval` | Yes | Execute supervisor-authored TS in isolated subprocess (**opt-in**, audit log) |

**Explicitly excluded:** `write`, `edit`, `bash`, `grep` (repo code), `ralph_spawn_worker`.

**Supervisor LLM config (new):** `ralph-provider.json` or env vars:

```json
{
  "supervisor": {
    "providerID": "anthropic",
    "modelID": "claude-haiku-4-5-20251001"
  },
  "worker": {
    "agent": "build",
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-5-20250929"
  }
}
```

Worker model/agent passed to `client.session.prompt` for worker sessions.

### 6.4 Worker plugin (`packages/worker-plugin`)

**Responsibility:** RLM inner-loop mechanics only.

**Keep:**

- `ralph_load_context()` — gate + payload
- `rlm_grep`, `rlm_slice`
- `ralph_verify()` — optional; engine may also run verify independently on worker idle
- `ralph_report()` — append to logs (engine can mirror to provider stream)
- Context gate on destructive tools (`tool.execute.before`)

**Remove (moved to provider/engine):**

- `ralph_spawn_worker`, `ralph_create_supervisor_session`, all supervision tools
- `session.idle` orchestration hooks
- `experimental.chat.system.transform` supervisor prompts
- Sub-agent spawn tools (defer to v0.3)
- Reviewer tools (defer to v0.3)

**Worker system prompt:** Injected via `client.session.prompt({ body: { system } })` from engine, sourced from `RALPH_WORKER_*` env vars or defaults migrated from plugin templates.

### 6.5 OpenCode configuration (user-facing)

Example `.opencode/opencode.json` snippet (document in README):

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

Startup:

```bash
bun run ralph-serve          # provider on :8787, connects to opencode :4096
opencode                     # user selects ralph-rlm/supervisor
```

---

## 7. Open questions and spikes

### 7.1 Session ID passthrough (BLOCKING — Milestone 0)

OpenCode must correlate TUI sessions with `LoopRun`s.

**Spike tasks:**

1. Inspect whether OpenCode forwards `x-opencode-session-id`, `x-opencode-directory`, or similar headers to custom provider requests.
2. If not: implement thin bridge plugin hook (`experimental.*` or message metadata) to inject headers.
3. Fallback: derive key from `messages[0]` hash + cwd query param in `baseURL` (`http://127.0.0.1:8787/v1?directory=...`).

**Success:** Two separate OpenCode sessions in the same repo do not share a `LoopRun`.

**M0 implementation (2026-06-15):**

`packages/provider/server/lib/session-context.ts` resolves keys in priority order:

1. `x-opencode-session-id` (proposed bridge — **not yet confirmed** OpenCode sends this)
2. `x-session-id`
3. `?session_id=` on provider base URL
4. `?directory=` + hash of first user message
5. `anonymous` (logged; single shared run — avoid in production)

Response headers `x-ralph-session-key` and `x-ralph-session-source` are set on `/v1/chat/completions` for debugging.

**Spike result (M8.1, 2026-06-15):**

OpenCode provider docs do **not** document session-ID passthrough to custom `baseURL` endpoints. Community pattern: `auth.loader` custom `fetch` wrapper (see `opencode-helicone-session`) + `session.created` / `session.updated` events.

**M0.4b implemented:** `.opencode/plugins/ralph-session-bridge.ts`

- Tracks active TUI session ID from OpenCode events
- Injects `x-opencode-session-id` on `ralph-rlm` provider HTTP requests
- Appends `?directory=` (worktree) when missing on provider URLs
- Provider debug: `RALPH_SESSION_DEBUG=1` logs forwarded correlation headers

**Remaining manual step:** Confirm in live TUI that `x-ralph-session-source` response header is `header:x-opencode-session-id` (not `anonymous` or `query:directory+message` only).

**Production guard (M7, 2026-06-15):**

- `assertValidSessionContext()` rejects `anonymous` keys outside test mode (`RALPH_TEST_MODE=1`).
- Opt-in escape hatch: `RALPH_ALLOW_ANONYMOUS_SESSION=1`.
- `/v1/chat/completions` returns **400** with a clear error when correlation fails.
- This blocks accidental multi-user session collapse but does **not** replace the live TUI spike — we still need to confirm which header OpenCode sends by default.

### 7.2 Worker permission prompts

When worker hits `permission.asked` (bash, edit), who answers?

**Options:**

- A) Forward to supervisor LLM on next user message (queue in `pending_input.json`)
- B) Thin plugin shows toast; user answers in TUI permission UI (worker session)
- C) Engine auto-approves via SDK permission response (dangerous default)

**v0.2 decision (2026-06-15):** **B** for interactive localhost development.

- Workers run in background OpenCode sessions; permission prompts appear in the **worker session** TUI (standard OpenCode UX).
- The engine does **not** auto-approve permissions.
- The supervisor provider does **not** intercept `permission.asked` events in v0.2.
- For overnight/headless runs, configure OpenCode permission defaults in the user's environment or use permissive sandbox settings — documented as a v0.3 enhancement (option A via `pending_input.json` for permission decisions).

**Related (implemented):** Worker blocking **questions** (`ralph_ask`) use `pending_input.json` + supervisor `answer_worker` / `list_worker_questions` tools (distinct from bash/edit permission prompts).

### 7.3 Streaming semantics

Decide what tokens mean during background work:

- **v0.2:** Stream only supervisor prose for the current turn; background events go to files + optional toast via thin plugin.
- **v0.3:** Server-sent events bridged into TUI mid-turn.

### 7.4 Effect-TS in engine

v0.1 uses Effect throughout. Options:

- Port Effect modules verbatim (faster migration, heavier bundle)
- Rewrite hot path as async/await (cleaner for Nitro handlers)

**Decision point:** End of Milestone 1 based on porting cost.

### 7.5 Swarm vs single worker vs unsafe eval

**Problem:** Users want parallel agents (v0.1 `subagent_spawn`) and occasionally arbitrary OpenCode SDK orchestration (“just write the script”).

**Options:**

- A) Declarative `spawn_swarm` only — safe, testable, aligned with G3/G4
- B) Worker-plugin `subagent_*` restored — duplicates orchestration inside worker sessions (rejected for v0.3)
- C) In-process `eval` of supervisor-generated code in Nitro — maximum power, unacceptable risk (rejected)
- D) Subprocess script runner + optional `swarm_unsafe_runtime_code_eval` — power path with opt-in and audit log

**v0.3 decision (2026-06-15):** **A + D**.

- **Default:** `spawn_swarm` declarative tasks compiled to SDK calls in `SwarmRunner`.
- **Escape hatch:** `swarm_unsafe_runtime_code_eval` for advanced localhost experimentation; requires explicit opt-in (`swarm.unsafeEvalEnabled` or `RALPH_SWARM_UNSAFE_EVAL=1`).
- **Runtime:** Deno subprocess when available; Bun subprocess fallback with reduced surface.
- **Coupling:** Side swarms do not automatically gate `LoopEngine` verify; supervisor merges results via `update_plan` / `swarm_collect` / user direction.

### 7.6 Shared event bridge & concurrency (M7, 2026-06-15)

**Problem:** Each active `LoopEngine` and `SwarmRunner` opened its own `event.subscribe({ directory })` stream on the same worktree — duplicate OpenCode load and harder observability.

**Implementation:**

- `WorktreeEventBridge` in `@ralph-rlm/engine` — one SDK subscription per worktree, ref-counted fan-out to loop + swarm consumers.
- Wired in `loop-service.ts` and `swarm-service.ts` via `subscribeWorktreeEvents()`.
- Bridge entry removed from global map when last consumer unsubscribes.

**Concurrency hardening (same milestone):**

| Component | Protection |
|-----------|------------|
| `createAsyncEventQueue` | Serialized event processing; concurrent `handleEvent` callers await full drain (fixes early-return race in old `drainQueue`) |
| Event queue cap | `DEFAULT_MAX_EVENT_QUEUE_SIZE` (10_000) — rejects event storms |
| `LoopEngine` | `spawnInFlight`, `verifyInFlight`, `resumeInFlight` — no duplicate spawn/verify/resume |
| `SwarmRunner` | `startInFlight`; duplicate `session.idle` ignored; `ralph.subscription.error` terminates swarm |
| `ralph_ask` poll | Deadline + `maxPolls` (`timeoutMinutes × 30`) |
| Unsafe script wrapper | `swarm.maxUnsafeScriptSpawns` (default 10) patches `client.session.create` |

**Automated coverage:** 52 tests across engine (37), worker-plugin (6), provider (9); `bun run bin/verify.ts` green.

**Management API (v0.3):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/swarms` | List swarm runs for a session |
| `GET` | `/api/swarms/:swarmId` | Full swarm status |
| `POST` | `/api/swarms/:swarmId/cancel` | Cancel swarm + abort child sessions |

Query `?sessionId=` or header `x-ralph-session-key` consistent with loop routes.

**Config additions (`.opencode/ralph.json`):**

```json
{
  "swarm": {
    "enabled": true,
    "maxConcurrent": 5,
    "maxTasksPerRun": 12,
    "defaultTimeoutMinutes": 30,
    "scriptRunner": "deno",
    "unsafeEvalEnabled": false
  }
}
```

---

## 8. Migration map (v0.1 → v0.2)

| v0.1 artifact | v0.2 disposition |
|---------------|------------------|
| `ralph_spawn_worker` | `LoopEngine.startNextAttempt()` — code only |
| `ralph_create_supervisor_session` | User selects `ralph-rlm/supervisor` model |
| `session.idle` hooks | `client.event.subscribe()` in engine |
| `promptAsync` into main session | User message → `/v1/chat/completions` |
| `ralph_ask` / `ralph_respond` | `answer_worker` tool + `pending_input.json` |
| `ralph_doctor` / `ralph_quickstart_wizard` | `POST /api/loops` bootstrap + CLI `ralph-serve --doctor` |
| `subagent_spawn` / `subagent_await` / `subagent_peek` | v0.3: `spawn_swarm` / `swarm_status` / `swarm_collect` (provider); optional `swarm_unsafe_runtime_code_eval` |
| Protocol files | **Unchanged** |
| `.opencode/ralph.json` | **Mostly unchanged** |
| `GETTINGSTARTEDGUIDE.md` | Rewrite in M5 |
| npm package `opencode-ralph-rlm` | Publish `@ralph-rlm/provider`, `@ralph-rlm/engine`, `@ralph-rlm/worker-plugin` |

### Deprecation policy

- v0.1 plugin remains in `.opencode/plugins/ralph-rlm.ts` until v0.2.0 stable; mark deprecated in README.
- Remove monolithic plugin in v0.3.0 or when feature parity reached.

---

## 9. Milestones

### Milestone 0 — Spike and foundations (3–5 days)

**Status (2026-06-15):** Scaffold complete. Provider serves `/api/health`, `/v1/models`, `/v1/chat/completions` (stub). `@ralph-rlm/engine` SDK client + spawn-proof script ready. Session ID passthrough strategy coded; OpenCode header spike pending live TUI test.

**Objective:** Prove the integration path before large extraction.

| Task | Owner | Done when |
|------|-------|-----------|
| M0.1 Nitro skeleton with `GET /api/health` | — | Returns `{ healthy, opencode }` |
| M0.2 `GET /v1/models` stub | — | OpenCode `/models` lists `ralph-rlm/supervisor` |
| M0.3 `POST /v1/chat/completions` echo | — | Non-streaming response returns assistant message |
| M0.4 Session ID spike | — | Documented approach in this file §7.1 |
| M0.5 SDK worker spawn proof | — | Script creates session, prompts, observes idle |
| M0.6 Workspace `package.json` | — | `packages/*` layout, `bun run verify` passes |

**Success criteria:**

- [ ] User can select custom provider model in OpenCode and receive a response from Nitro
- [ ] One worker session can be spawned via SDK from provider process
- [ ] Session identity approach chosen and recorded

**Deliverables:** `packages/provider` skeleton, `packages/engine` empty package, spike notes appended to §7.

---

### Milestone 1 — LoopEngine extraction (5–8 days)

**Status (2026-06-15):** Complete. `@ralph-rlm/engine` exports config, protocol files, verify, rollover, `LoopEngine`, `LoopRegistry`, and OpenCode `event.subscribe` wiring. Integration test runs fail→pass over `fixtures/minimal-repo`. Effect-TS deferred — engine uses plain async/await.

**Objective:** Port deterministic loop logic out of the monolithic plugin.

| Task | Owner | Done when |
|------|-------|-----------|
| M1.1 Extract config + protocol modules | — | Unit-testable without OpenCode |
| M1.2 Extract verify runner | — | Matches v0.1 behavior for same `ralph.json` |
| M1.3 Extract rollover | — | Files match v0.1 layout on fail |
| M1.4 Implement `LoopEngine` with event emitter | — | `start → spawn worker → idle → verify → rollover` in integration test |
| M1.5 Wire `event.subscribe()` for `session.idle` | — | No plugin hooks required |
| M1.6 `LoopRegistry` keyed by session ID | — | Multiple runs isolated |

**Success criteria:**

- [ ] Headless test: engine runs 2 attempts against a fixture repo with failing-then-passing verify
- [ ] `PLAN.md`, `CURRENT_STATE.md`, `AGENT_CONTEXT_FOR_NEXT_RALPH.md` updated correctly
- [ ] `bun run verify` green for `packages/engine`

**Deliverables:** `@ralph-rlm/engine` with tests.

---

### Milestone 2 — Provider supervisor (5–8 days)

**Status (2026-06-15):** Complete. `SupervisorAgent` drives `LoopEngine` via supervisor tools; `/v1/chat/completions` returns real responses (JSON + SSE). `RALPH_TEST_MODE=1` enables scripted supervisor without an API key. Management routes: `GET /api/loops/:sessionId`, pause/resume/stop, `GET .../verify/last`.

**Objective:** Real `/v1/chat/completions` driving the engine.

| Task | Owner | Done when |
|------|-------|-----------|
| M2.1 OpenAI request/response types | — | `chat/completions` parses messages, model |
| M2.2 SSE streaming | — | `stream: true` yields valid OpenAI chunks |
| M2.3 `SupervisorAgent` with tool loop | — | Calls engine methods via tools |
| M2.4 `start_loop` from natural language goal | — | Bootstraps plan, starts attempt 1 |
| M2.5 Async background orchestration | — | HTTP returns < 30s while worker continues |
| M2.6 Management API + OpenAPI | — | `/_scalar` documents `/api/loops/*` |

**Success criteria:**

- [ ] User says “implement X with tests passing” → loop starts, worker runs in background
- [ ] User asks “status?” → accurate attempt/verdict/peek
- [ ] User can `pause` / `resume` / `stop` via chat or `/api/loops/...`
- [ ] No `promptAsync` injection into OpenCode sessions

**Deliverables:** `@ralph-rlm/provider`, `bin/ralph-serve.ts`.

---

### Milestone 3 — Worker plugin slim-down (3–5 days)

**Status (2026-06-15):** Complete. `@ralph-rlm/worker-plugin` exports `RalphWorkerPlugin` with load_context/grep/slice/verify/report/gate tools. Engine injects worker `system` + `agent` on spawn. Legacy plugin moved to `.opencode/plugins-legacy/` (not auto-loaded). Loop toasts via provider SDK on `loop.done` / `max_attempts`.

**Objective:** Replace monolithic plugin with worker-only tools.

| Task | Owner | Done when |
|------|-------|-----------|
| M3.1 Create `packages/worker-plugin` | — | Exports `RalphWorkerPlugin` |
| M3.2 Port grep/slice/load_context/gate | — | Behavior matches v0.1 |
| M3.3 Engine injects worker prompt | — | Worker does not need spawn tool |
| M3.4 Optional toast bridge plugin | — | `loop.done` → `tui.showToast` |
| M3.5 Remove orchestration from old plugin | — | Old file deprecated, not loaded by default |

**Success criteria:**

- [ ] Worker blocked from `edit` until `ralph_load_context()`
- [ ] Worker completes one pass and goes idle; engine runs verify
- [ ] Fresh worker session per attempt (no context bleed)

**Deliverables:** `@ralph-rlm/worker-plugin`, updated `.opencode/plugins/`.

---

### Milestone 4 — End-to-end hardening (5–7 days)

**Status (2026-06-15):** Complete. Engine handles heartbeat warnings, worker session errors, spawn/prompt failures (pause + toast), and pending `ralph_ask` notifications. `answer_worker` merges into `pending_input.json`; `list_worker_questions` exposed to supervisor. `bin/ralph-serve` supports `--port`, `--opencode-url`, `--doctor`, `--autofix`, `--worktree`. CI workflow runs `bin/verify.ts` on push/PR.

**Objective:** Production-quality localhost experience.

| Task | Owner | Done when |
|------|-------|-----------|
| M4.1 Permission prompt flow documented | — | §7.2 resolved |
| M4.2 `maxAttempts` / heartbeat / verify timeout | — | Parity with v0.1 config |
| M4.3 Worker `ralph_ask` → supervisor `answer_worker` | — | Decision unblocks worker |
| M4.4 Error recovery (worker crash, prompt fail) | — | Loop pauses with actionable message |
| M4.5 `ralph-serve` CLI flags | — | `--port`, `--opencode-url`, `--doctor` |
| M4.6 CI update | — | Build all packages, run engine tests |

**Success criteria:**

- [ ] Overnight run: 10+ attempts, restarts survive, logs intact
- [ ] Verify pass terminates loop with clear user message
- [ ] `maxAttempts` stop is visible in chat and `/api/loops/:id`

---

### Milestone 5 — Documentation and release (2–4 days)

**Status (2026-06-15):** Complete. Provider-first `README.md`, rewritten `GETTINGSTARTEDGUIDE.md`, `MIGRATION.md`, `CHANGELOG.md` (v0.2.0), updated `AGENT.md`. Example configs in `.opencode/`. Post-M8 doc pass: protocol files table, default agent instructions, session bridge, worker tools, verification (`verify` + `e2e-smoke`). Tag `v0.2.0` is a manual `git tag` + publish step.

**Objective:** Ship v0.2.0 with clear onboarding.

| Task | Owner | Done when |
|------|-------|-----------|
| M5.1 Rewrite README | — | Provider-first quick start |
| M5.2 Rewrite GETTINGSTARTEDGUIDE | — | Model selection, not `ralph_create_supervisor_session` |
| M5.3 `opencode.provider.example.json` | — | Copy-pasteable |
| M5.4 Migration guide v0.1 → v0.2 | — | In README or MIGRATION.md |
| M5.5 npm publish strategy | — | Scoped packages or meta-package |
| M5.6 Tag v0.2.0 | — | Changelog complete |

**Success criteria:**

- [ ] New user: install → `ralph-serve` → select model → loop runs
- [x] README caveat updated to reflect new architecture
- [ ] AGENT.md points to REVISION_PLAN for contributors

---

### Milestone 6 — Swarm parallelism (v0.3, 5–8 days)

**Status (2026-06-15):** Complete. `SwarmRunner` + `SwarmRegistry` in `@ralph-rlm/engine`; supervisor tools `spawn_swarm`, `swarm_status`, `swarm_cancel`, `swarm_collect`, `swarm_unsafe_runtime_code_eval`; `/api/swarms/*` management routes; swarm config in `ralph.json`; subprocess script runner with opt-in unsafe gate.

**Objective:** Supervisor-launched parallel OpenCode agents without reviving plugin orchestration.

| Task | Owner | Done when |
|------|-------|-----------|
| M6.1 `SwarmRunner` + `SwarmRegistry` | — | Declarative `spawn_swarm` spawns N sessions with concurrency cap |
| M6.2 Event wiring | — | `session.idle` / `session.error` per swarm task updates `SwarmRun` |
| M6.3 Supervisor tools | — | `spawn_swarm`, `swarm_status`, `swarm_cancel`, `swarm_collect` |
| M6.4 Management API | — | `/api/swarms/*` documented in OpenAPI |
| M6.5 Deno script runner | — | Safe prelude + pinned SDK; timeout + spawn caps |
| M6.6 `swarm_unsafe_runtime_code_eval` | — | Opt-in only; audit log under `.opencode/swarm/runs/`; Bun fallback |
| M6.7 Tests | — | Mock SDK multi-spawn; script runner timeout; unsafe gate returns error when disabled |

**Success criteria:**

- [ ] Supervisor: “spawn 3 agents to refactor auth, api, and tests in parallel” → `spawn_swarm` returns `swarmId`, tasks run in background
- [ ] `swarm_status` accurate while main `LoopEngine` loop can still run independently (side swarm)
- [ ] `swarm_unsafe_runtime_code_eval` refused when `unsafeEvalEnabled: false`; succeeds when opt-in with script persisted
- [ ] Overnight: swarm timeout cancels stuck child sessions without killing provider

**Deliverables:** `@ralph-rlm/engine` swarm modules, provider supervisor tools + `/api/swarms/*`, README swarm section.

---

### Milestone 7 — Concurrency, production guards & test depth (2–3 days)

**Status (2026-06-15):** Complete. Follow-up to M4/M6 code review and hardening pass.

**Objective:** Eliminate event-queue races, bound resource growth, and block known production footguns before v0.2.0 tag.

| Task | Owner | Done when |
|------|-------|-----------|
| M7.1 Shared `WorktreeEventBridge` | — | Loop + swarm share one `event.subscribe` per worktree |
| M7.2 `createAsyncEventQueue` | — | Replaces recursive `drainQueue`; concurrent callers serialize correctly |
| M7.3 Loop in-flight guards | — | `spawnInFlight`, `verifyInFlight`, `resumeInFlight` |
| M7.4 Stop / pause semantics | — | `stop_loop` → `done` + `outcome: "stopped"`; `pause_loop` aborts worker |
| M7.5 Session correlation guard | — | `anonymous` blocked in production; `RALPH_ALLOW_ANONYMOUS_SESSION` opt-in |
| M7.6 Worker attempt sync | — | `.opencode/loop_attempt.json` marker; `ralph_ask` uses correct attempt |
| M7.7 Swarm registry hygiene | — | Prune on `swarm.done` / `swarm.cancelled` / start error |
| M7.8 Supervisor API key | — | No silent fallback to test mode when `RALPH_SUPERVISOR_API_KEY` missing |
| M7.9 Test expansion | — | Provider swarm/session tests; async queue; concurrency integration tests |

**Success criteria:**

- [x] `bun run bin/verify.ts` passes (55 automated tests)
- [x] Concurrent `handleEvent` does not double-increment attempt or drop events
- [x] Duplicate concurrent `resume()` does not spawn extra workers
- [ ] Live TUI confirms session key is not `anonymous` under normal OpenCode use (see §7.1)

**Deliverables:** `async-event-queue.ts`, `worktree-event-bridge.ts`, `loop-attempt.ts`; updated `REVISION_PLAN.md` §7.6; provider tests under `server/test/`.

---

### Milestone 8 — Release validation & v0.2.0 ship (1–3 days)

**Status (2026-06-15):** **Code + docs complete** — automated verify + e2e-smoke green; manual TUI checklist + npm publish optional.

**Objective:** Close unchecked success criteria from M0–M6 with real OpenCode TUI runs, then tag `v0.2.0`.

| Task | Owner | Done when |
|------|-------|-----------|
| M8.1 Live session-ID spike | — | [x] §7.1 spike notes + M0.4b bridge plugin; [ ] live TUI confirms `header:x-opencode-session-id` |
| M8.2 E2E smoke checklist | — | [x] `bin/e2e-smoke.ts` HTTP checks; [ ] manual TUI steps (`ralph_ask`, swarm, fail→pass) |
| M8.3 Changelog + commit | — | [x] `CHANGELOG.md`; [x] working tree committed |
| M8.4 Tag `v0.2.0` | — | [x] local tag; [ ] `git push origin v0.2.0` (manual) |
| M8.5 npm publish | — | Scoped packages or meta-package per M5.5 (workflow or manual) |
| M8.6 Human-facing docs | — | [x] README + GETTINGSTARTED + MIGRATION aligned with v0.2; session correlation; default agent instructions |

**E2E smoke script (manual):**

**Automated (HTTP):**

```bash
bun run bin/e2e-smoke.ts --spawn   # or against running ralph-serve
```

Covers: health, session correlation headers, isolated `/api/loops`, status/stop turns in `RALPH_TEST_MODE`.

**Manual (TUI):**

```text
1. RALPH_TEST_MODE=1 bun run ralph-serve
2. OpenCode TUI → model ralph-rlm/supervisor → delegate fixture goal
3. Confirm x-ralph-session-source = header:x-opencode-session-id (bridge loaded)
4. "status?" → attempt + worker + last verify
5. "pause" / "resume" → worker replaced, loop continues
6. "stop" → outcome stopped, done=true
7. Worker ralph_ask in worker session → supervisor answer_worker unblocks
8. spawn_swarm (or tool via chat) → GET /api/swarms?sessionId=...
9. Remove .ralph-pass-marker → fail→pass rollover → loop.done
```

**Success criteria:**

- [ ] Two OpenCode sessions in same repo → isolated `LoopRun`s (§7.1)
- [ ] New user path: install → `ralph-serve` → select model → loop runs (M5)
- [ ] Overnight run: 10+ attempts, restarts survive, logs intact (M4)

---

## 10. Testing strategy

| Layer | Tests (current) |
|-------|-----------------|
| `engine` (37) | config, rollover, verify, loop integration (fail→pass, pause-idle-resume, stop, concurrency), `AsyncEventQueue`, `WorktreeEventBridge`, swarm runner/registry, script spawn cap, `loop-attempt` marker |
| `provider` (12) | `supervisorTurn` test mode, `session-context` anonymous guard, `session-debug`, `spawn_swarm` / `swarm_status` / `swarm_cancel` via `executeSupervisorTool` |
| `worker-plugin` (6) | context gate, attempt marker import |
| `swarm-script-runner` | unsafe gate; spawn-cap prelude in generated script |
| E2E (manual, M8) | OpenCode TUI + fixture repo; session-ID spike; overnight 10+ attempts |

**CI:** `.github/workflows/verify.yml` runs `bun run bin/verify.ts` on push/PR.

**Fixture repo** (add `fixtures/minimal-repo/`):

- `package.json` with `verify` script that fails until a marker file exists
- Exercises multi-attempt loop deterministically without LLM cost (mock supervisor in test mode)

**Test mode flag:** `RALPH_TEST_MODE=1` uses scripted supervisor responses (no external LLM).

---

## 11. Success criteria (release v0.2.0)

### User experience

1. Single OpenCode session with model `ralph-rlm/supervisor`
2. User can delegate a goal in plain language and receive immediate acknowledgment
3. User can check status, pause, resume, stop without opening worker sessions
4. Worker sessions are optional to inspect (session tree), not required

### Technical

1. No `session.idle` orchestration in plugin
2. `LoopEngine` owns verify → rollover → next attempt
3. Protocol files remain source of truth across attempts
4. `bun run verify` passes for all workspace packages
5. OpenAPI docs available at `/_scalar` for management API

### Quality bar

1. Loop completes a fixture task (fail → pass) in CI without human intervention — **[x] engine integration test + `bin/verify.ts`**
2. No regression in `rlm_grep` / `rlm_slice` limits from `ralph.json`
3. Config keys in `.opencode/ralph.json` documented with any renames — **[x] README / GETTINGSTARTEDGUIDE**
4. Event processing is race-free under concurrent OpenCode events — **[x] M7 `createAsyncEventQueue`**
5. Production rejects uncorrelated supervisor sessions — **[x] M7 `assertValidSessionContext`**

---

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| No session ID in provider requests | Broken multi-session | M8.1 live TUI spike; M0.4b bridge plugin; `assertValidSessionContext` blocks `anonymous` in prod |
| Event queue race under concurrent `session.idle` | Duplicate verify/spawn | M7 `createAsyncEventQueue` + in-flight guards |
| Event storm / memory growth | OOM in long runs | M7 queue cap (10k); swarm registry prune on terminal state |
| OpenAI compat edge cases | OpenCode rejects provider | Test against real OpenCode early (M0) |
| Nitro OpenAPI experimental | Docs break on upgrade | Pin Nitro; ops API is non-critical path |
| Supervisor LLM cost/latency | Slow status turns | Default Haiku-class; cache `loop_status` reads |
| Permission prompts block workers | Stuck overnight runs | Document auto-approve patterns; engine timeout |
| Long migration from Effect | Schedule slip | Decision gate M1; port incrementally |
| v0.1 users mid-loop | Confusion | Deprecation banner; keep old plugin loadable |
| Swarm runaway session creation | OpenCode overload, cost | `maxTasksPerRun`, `maxConcurrent`, timeouts; wrapper caps even in unsafe eval |
| Unsafe script eval | Localhost compromise if misused | Off by default; Deno permissions in safe mode; audit log; banner in logs |
| Deno not installed | Script runner unavailable | Bun fallback + doctor hint; document optional Deno install |

---

## 13. Deferred to v0.3+

- ~~Swarm parallelism~~ — **done M6** (`spawn_swarm` + optional `swarm_unsafe_runtime_code_eval`); see §6.1, §7.5
- ~~Shared event bridge~~ — **done M7** (`WorktreeEventBridge`); see §7.6
- ~~Concurrency / infinite-loop guards~~ — **done M7** (`createAsyncEventQueue`, in-flight flags, queue cap); see §7.6
- ~~**M0.4b** session bridge~~ — **done M8.1** (`.opencode/plugins/ralph-session-bridge.ts`); live TUI confirmation still manual
- **`POST /api/swarms`** — HTTP spawn endpoint (today: `spawn_swarm` supervisor tool only)
- **Safe Deno script runner** — tight `--allow-net` / deny fs (today: unsafe path + spawn cap; safe prelude partial)
- Reviewer gate (`ralph_run_reviewer` → supervisor tool)
- Worker **permission** prompts → `pending_input.json` (distinct from `ralph_ask`; see §7.2 option A)
- Full env-var prompt customization port
- Proactive streaming of background events into TUI (§7.3)
- Remote/hosted provider deployment
- Graphite/CI matrix for multi-package publish
- Remove legacy `.opencode/plugins-legacy/ralph-rlm.ts` after M8 E2E parity checklist

---

## 14. Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-15 | Provider-as-model architecture | Plugin orchestration is fragile; README caveat |
| 2026-06-15 | Nitro for provider server | Routing, SSE, OpenAPI for ops APIs |
| 2026-06-15 | Async turn model (no long HTTP hold) | Overnight loops incompatible with blocking completions |
| 2026-06-15 | Supervisor LLM external to OpenCode | Clean separation; workers use SDK + build agent |
| 2026-06-15 | Thin worker plugin retained | RLM grep/slice/gate needs OpenCode tool hooks |
| 2026-06-15 | Session ID: block `anonymous` in production | Prevent silent session collapse; live header spike still required (M8.1) |
| 2026-06-15 | Plain async/await in engine (no Effect) | Lower dependency weight; plugin keeps Effect until v0.3 removal |
| 2026-06-15 | Swarm: declarative `spawn_swarm` + opt-in `swarm_unsafe_runtime_code_eval` | G3/G4 preserved; subprocess isolation; Deno preferred for script sandbox |
| 2026-06-15 | Side swarm model (parallel to main loop) | Avoid coupling verify/rollover to ad-hoc parallelism; supervisor merges outcomes |
| 2026-06-15 | `stop_loop` sets `done` + `outcome: "stopped"` | Clear terminal semantics; distinct from pause and max-attempts |
| 2026-06-15 | `pause_loop` aborts active worker | Avoid stale `currentWorkerSessionId`; resume spawns replacement |
| 2026-06-15 | Promise-chain `createAsyncEventQueue` | Fix concurrent `handleEvent` race; cap queue at 10k events |
| 2026-06-15 | One `event.subscribe` per worktree | `WorktreeEventBridge` shared by loop + swarm |
| 2026-06-15 | No silent supervisor test-mode fallback | Missing `RALPH_SUPERVISOR_API_KEY` fails loudly in production |
| 2026-06-15 | Worker attempt via `loop_attempt.json` | `ralph_ask` attempt numbers match loop engine |
| 2026-06-15 | Session bridge via `auth.loader` fetch | OpenCode has no documented provider header passthrough; helicone-session pattern |

---

## 15. Immediate next steps

### Phase A — Release validation (M8, do first)

1. **Live session-ID spike (§7.1 / M8.1)** — `bun run ralph-serve`, OpenCode TUI → `ralph-rlm/supervisor`, inspect `x-ralph-session-source` response header. If `anonymous`, implement **M0.4b bridge plugin**.
2. **E2E smoke (M8.2)** — Run checklist in Milestone 8 with `RALPH_TEST_MODE=1`, then one real LLM session.
3. **Commit + changelog (M8.3)** — Fold M7 items into `CHANGELOG.md`; commit working tree.
4. **Tag v0.2.0 (M8.4)** — `git tag v0.2.0 && git push origin v0.2.0`.
5. **Publish (M8.5)** — npm scoped packages per M5.5.

### Phase B — v0.3 themes (pick after v0.2.0 ships)

| Priority | Theme | Milestone sketch |
|----------|-------|------------------|
| P1 | **TUI UX** | Proactive background event streaming into supervisor chat (§7.3) |
| P1 | **API parity** | `POST /api/swarms` spawn; Nitro route tests for all `/api/swarms/*` |
| P2 | **Reviewer** | `ralph_run_reviewer` → supervisor tool + engine hook |
| P2 | **Permissions** | `permission.asked` → `pending_input.json` supervisor decision (§7.2 A) |
| P3 | **Scripts** | Safe Deno runner with minimal permissions (replace `--allow-all` default) |
| P3 | **Cleanup** | Remove legacy plugin; publish automation matrix |

### Completed since initial plan (do not re-implement)

- M0–M6 code paths, M5 docs, M7 hardening (§7.6, Milestone 7)
- 52 automated tests; CI `verify.yml`
- Production `anonymous` session block; shared event bridge; concurrency guards

---

## 16. References

- [OpenCode Providers](https://opencode.ai/docs/providers/) — custom `openai-compatible` provider registration
- [OpenCode SDK](https://opencode.ai/docs/sdk/) — session lifecycle, events
- [OpenCode Server](https://opencode.ai/docs/server/) — HTTP API, SSE events
- [OpenCode Plugins](https://opencode.ai/docs/plugins/) — worker tool hooks
- [Nitro OpenAPI](https://nitro.build/docs/openapi) — management API docs
- [opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents) — background delegation pattern
- Current implementation: `.opencode/plugins/ralph-rlm.ts`
- Current config: `.opencode/ralph.json`