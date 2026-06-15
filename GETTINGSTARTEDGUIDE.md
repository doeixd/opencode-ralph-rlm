# Ralph-RLM Getting Started Guide (v0.2)

This guide gets you from zero to a running **provider-as-supervisor** loop. You will use one OpenCode session with model `ralph-rlm/supervisor` — not the legacy `ralph_create_supervisor_session()` flow.

The v0.2 revision (provider model, loop engine, worker plugin, session bridge, swarms, hardening) is **implemented**. This guide reflects the shipped architecture.

| Doc | Purpose |
|-----|---------|
| [`README.md`](README.md) | Full reference (tools, config, API) |
| [`MIGRATION.md`](MIGRATION.md) | Upgrading from v0.1 plugin |
| [`REVISION_PLAN.md`](REVISION_PLAN.md) | Contributor architecture + v0.3 roadmap |

---

## What you are setting up

| Piece | Where | Purpose |
|-------|-------|---------|
| Ralph provider | `bun run ralph-serve` (:8787) | Supervisor LLM + `LoopEngine` |
| OpenCode server | `opencode` (:4096) | Runs worker sessions |
| Worker plugin | `.opencode/plugins/ralph-worker.ts` | RLM tools + context gate |
| Session bridge | `.opencode/plugins/ralph-session-bridge.ts` | Per-session `LoopRun` correlation |
| Loop config | `.opencode/ralph.json` | `verify.command`, `maxAttempts`, swarm caps |
| Provider config | `opencode.json` | Register `ralph-rlm/supervisor` model |
| Protocol files | Repo root (`PLAN.md`, …) | Durable memory (bootstrapped on first loop) |

---

## Step 1 — Install dependencies

In this repo (or your fork):

```bash
git clone https://github.com/doeixd/opencode-ralph-rlm
cd opencode-ralph-rlm
bun install
```

In **your target project**, copy both plugins:

```text
.opencode/plugins/
├── ralph-worker.ts           # re-exports @doeixd/opencode-ralph-rlm/worker-plugin
└── ralph-session-bridge.ts   # injects session ID on provider HTTP requests
```

This repo ships thin wrappers. After `bun run build`, OpenCode loads them from `.opencode/plugins/` automatically.

Optional: add `AGENT.md` at the repo root and set `agentMdPath` in `ralph.json` for static project rules injected via `ralph_load_context()`.

---

## Step 2 — Doctor check

From your project root:

```bash
cd /path/to/your-project
bun run /path/to/opencode-ralph-rlm/bin/ralph-serve.ts -- --doctor --autofix --worktree .
```

Doctor reports:

- Missing `verify.command` or `PLAN.md`
- OpenCode / provider reachability
- Optional autofix for `verify.command` (detects bun/npm/cargo)

Fix any **ISSUE** lines before long runs.

---

## Step 3 — Configure the loop

Create or edit `.opencode/ralph.json`:

```json
{
  "enabled": true,
  "maxAttempts": 20,
  "heartbeatMinutes": 15,
  "verifyTimeoutMinutes": 15,
  "verify": {
    "command": ["bun", "run", "test"],
    "cwd": "."
  },
  "gateDestructiveToolsUntilContextLoaded": true,
  "maxRlmSliceLines": 200,
  "agentMdPath": "AGENT.md",
  "subAgentEnabled": true,
  "swarm": {
    "enabled": true,
    "maxConcurrent": 5,
    "maxTasksPerRun": 12,
    "defaultTimeoutMinutes": 30,
    "unsafeEvalEnabled": false
  }
}
```

**Critical:** `verify.command` must reflect your real quality gate (tests, typecheck, lint). The loop only stops when verify passes or `maxAttempts` is exhausted.

On first `start_loop`, the engine bootstraps protocol files (`PLAN.md`, `RLM_INSTRUCTIONS.md`, …) with sensible defaults. Edit those files to steer workers — they are more important than chat instructions.

---

## Step 4 — Register the provider in OpenCode

Merge into your `opencode.json` (copy from [`.opencode/opencode.provider.example.json`](.opencode/opencode.provider.example.json)):

```json
{
  "provider": {
    "ralph-rlm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ralph RLM",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "supervisor": {
          "name": "Ralph Supervisor"
        }
      }
    }
  }
}
```

Optional: add `?directory=/absolute/path/to/repo` to `baseURL` as a worktree fallback if the session bridge is not loaded.

### Session correlation (required for multi-session)

Each OpenCode TUI session must map to its own `LoopRun`. OpenCode does **not** forward session IDs to custom providers by default, so v0.2 ships **`ralph-session-bridge.ts`** alongside the worker plugin.

The bridge tracks `session.created` / `session.updated` events and injects `x-opencode-session-id` on every `ralph-rlm` provider request (same pattern as `opencode-helicone-session`). It also appends `?directory=` when missing so the provider resolves the correct worktree.

**Verify correlation** after your first supervisor message:

1. Start provider with debug logging (optional):

   ```bash
   RALPH_SESSION_DEBUG=1 bun run ralph-serve
   ```

2. Send a message in the TUI with model `ralph-rlm/supervisor`.

3. Check provider logs or response headers:

   | Header | Expected |
   |--------|----------|
   | `x-ralph-session-source` | `header:x-opencode-session-id` (with bridge) |
   | `x-ralph-session-key` | OpenCode session UUID — **not** `anonymous` |

**Fallback priority** (when bridge is not loaded): `x-session-id` header → `?session_id=` on baseURL → `?directory=` + first-message hash → `anonymous`.

**Production guard:** Outside `RALPH_TEST_MODE=1`, `anonymous` keys return **400**. Opt-in escape hatch: `RALPH_ALLOW_ANONYMOUS_SESSION=1` (single shared loop — avoid for real use).

**HTTP smoke tests** (no TUI required):

```bash
RALPH_TEST_MODE=1 bun run ralph-serve          # terminal 1
bun run e2e-smoke                              # terminal 2
# or self-contained:
bun run e2e-smoke -- --spawn
```

---

## Step 5 — Default agent instructions

v0.2 does not require you to write supervisor or worker prompts from scratch. Defaults are baked into the codebase and injected at runtime:

| Who | What they receive | Source |
|-----|-------------------|--------|
| **Supervisor** (your TUI chat) | System prompt with role boundaries + intent→tool routing | Provider `SupervisorAgent` |
| **Worker** (background session) | System prompt via `experimental.chat.system.transform` | `packages/engine/src/templates.ts` |
| **Worker** (each attempt) | Initial user message with numbered steps | `templates.workerPrompt` |
| **Bootstrap** | First `PLAN.md` + `RLM_INSTRUCTIONS.md` | `templates.bootstrapPlan`, `bootstrapRlmInstructions` |
| **After failed verify** | Next-step block in `AGENT_CONTEXT_FOR_NEXT_RALPH.md` | `templates.continuePrompt` |

### What workers are told to do

1. `ralph_load_context()` first (enforced — edit/bash blocked until then).
2. Read `AGENT_CONTEXT_FOR_NEXT_RALPH.md` for the prior failure verdict.
3. Follow `RLM_INSTRUCTIONS.md` playbooks.
4. `ralph_report()` at start and milestones; update `CURRENT_STATE.md`.
5. `ralph_verify()` **once** at the end → **STOP** (one pass per session).

### What the supervisor is told to do

- Delegate goals → `start_loop`; status questions → `loop_status`; control → pause/resume/stop tools.
- Never edit repo code or mention legacy v0.1 tools (`ralph_spawn_worker`, etc.).
- Answer worker `ralph_ask` via `list_worker_questions` + `answer_worker`.
- Update strategy in `PLAN.md` / `RLM_INSTRUCTIONS.md` so the next worker inherits context.

### Customizing prompts

Set environment variables on the **provider** or **OpenCode** process:

```bash
export RALPH_WORKER_SYSTEM_PROMPT="@/path/to/my-worker-system.txt"
export RALPH_COMPACTION_CONTEXT="## My compaction notes..."
```

For most projects, **editing `RLM_INSTRUCTIONS.md` and `PLAN.md`** after the first loop is the right customization path — those files persist across attempts.

---

## Step 6 — Supervisor LLM credentials

The provider calls an external LLM for supervisor chat turns (separate from your worker model).

**Option A — environment variables**

```bash
export RALPH_SUPERVISOR_API_KEY="sk-..."
export RALPH_SUPERVISOR_MODEL="gpt-4o-mini"
```

**Option B — `.opencode/ralph-provider.json`**

See [`.opencode/ralph-provider.example.json`](.opencode/ralph-provider.example.json) for supervisor + worker agent defaults.

Worker sessions use `worker.agent` / `worker.modelID` from this file when the engine spawns them.

---

## Step 7 — Start provider + OpenCode

Terminal 1:

```bash
bun run ralph-serve
```

Terminal 2 (your project):

```bash
opencode
```

In the TUI:

1. Select model **`ralph-rlm/supervisor`**
2. Send your goal in plain language

Example:

```text
Implement JWT middleware with tests passing. Bootstrap the plan if needed.
```

Expected response (paraphrased):

```text
Started loop — attempt 1 running in background. Ask for status anytime.
```

---

## Step 8 — Monitor and control

### In chat (natural language)

| You say | Supervisor does |
|---------|-----------------|
| `status?` | `loop_status`, summarizes attempt + verify |
| `pause` / `resume` / `stop` | Pauses, resumes, or stops the loop |
| `show me worker state` | `peek_worker` on `CURRENT_STATE.md` |
| Answer a worker question | `list_worker_questions` → `answer_worker` |
| Parallel side work | `spawn_swarm` with named tasks |

### On disk

| File | Contents |
|------|----------|
| `SUPERVISOR_LOG.md` | Structured engine events |
| `CONVERSATION.md` | Human-readable timeline |
| `PLAN.md` / `RLM_INSTRUCTIONS.md` | Strategy + worker operating manual |
| `CURRENT_STATE.md` | Active attempt scratch state |
| `AGENT_CONTEXT_FOR_NEXT_RALPH.md` | Handoff snapshot after failed verify |

### HTTP (optional)

```bash
curl http://127.0.0.1:8787/api/loops
curl http://127.0.0.1:8787/api/health
open http://127.0.0.1:8787/_scalar
```

---

## Step 9 — Swarms (optional)

Side parallel agents do **not** replace the main verify loop.

Example prompt:

```text
Spawn a swarm: one agent fixes auth, one fixes API routes, one fixes tests. concurrency 3.
```

For advanced localhost experiments only, enable unsafe script eval:

```json
{ "swarm": { "unsafeEvalEnabled": true } }
```

See README **Swarm parallelism** for the threat model. Prefer declarative `spawn_swarm` tasks.

---

## Mental model

```text
You (TUI, ralph-rlm/supervisor)
  └─ provider SupervisorAgent (tools only, no repo edits)
       └─ LoopEngine (deterministic)
            └─ Worker session per attempt (ralph-worker plugin)
                 └─ idle → engine runs verify.command
                      ├─ pass → done
                      └─ fail → rollover → next attempt
```

**You do not:**

- Call `ralph_spawn_worker()` (removed from supervisor surface)
- Call `ralph_create_supervisor_session()` (use model selection instead)
- Micromanage worker sessions (optional to inspect in session tree)

**Workers do:**

- `ralph_load_context()` → implement → `ralph_verify()` → idle (engine runs verify)

**Permission prompts** (bash/edit) appear in the **worker session** TUI — answer there.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Provider unreachable | Run `bun run ralph-serve`; check port `8787` |
| OpenCode unhealthy in `/api/health` | Start `opencode` server |
| Loop does not start | `bun run ralph-serve -- --doctor --worktree .` |
| Missing API key error | Set `RALPH_SUPERVISOR_API_KEY` or use `RALPH_TEST_MODE=1` for smoke |
| Verify always fails | Fix `verify.command` to match your repo |
| Worker blocked on edit | Worker must call `ralph_load_context()` first |
| Two tabs share one loop | Load `ralph-session-bridge.ts`; confirm `x-ralph-session-source` ≠ `anonymous` |
| `400 Cannot correlate supervisor session` | Enable session bridge or add `?directory=` to provider baseURL |
| Swarm refused | Set `subAgentEnabled: true` and `swarm.enabled: true` |
| Unsafe eval refused | Set `swarm.unsafeEvalEnabled: true` or `RALPH_SWARM_UNSAFE_EVAL=1` |

---

## Next steps

1. Run `bun run e2e-smoke -- --spawn` to validate provider HTTP behavior.
2. Tune `RLM_INSTRUCTIONS.md` after first verify failures (add repo-specific playbooks).
3. Strengthen `verify.command` — it is the only automatic exit criterion.
4. Add `AGENT.md` with static conventions (`agentMdPath` in `ralph.json`).
5. See [`REVISION_PLAN.md`](REVISION_PLAN.md) §13 for v0.3 themes (TUI streaming, reviewer, permission forwarding).

Legacy v0.1 plugin behavior is documented only under `.opencode/plugins-legacy/`.