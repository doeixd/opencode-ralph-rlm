# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-06-15

### Added

- **Session bridge plugin** — `.opencode/plugins/ralph-session-bridge.ts` injects `x-opencode-session-id` on Ralph provider requests via OpenCode `auth.loader` fetch wrapper
- **Session debug logging** — `RALPH_SESSION_DEBUG=1` logs correlation headers on `/v1/chat/completions`
- **E2E smoke helper** — `bun run bin/e2e-smoke.ts` (HTTP checks; `--spawn` for self-contained runs)
- **Provider-as-supervisor architecture** — OpenAI-compatible Nitro server (`ralph-rlm/supervisor` model) at `:8787`
- **`@ralph-rlm/engine`** — `LoopEngine`, verify/rollover, OpenCode SDK integration, `LoopRegistry`
- **`@ralph-rlm/provider`** — `SupervisorAgent`, supervisor tools, SSE `/v1/chat/completions`, management `/api/loops/*`
- **`@ralph-rlm/worker-plugin`** — thin worker tools (`rlm_grep`, `rlm_slice`, context gate, `ralph_ask`)
- **`bin/ralph-serve`** — start provider; `--doctor`, `--autofix`, `--port`, `--opencode-url`, `--worktree`
- **Worker ↔ supervisor questions** — `pending_input.json`, `list_worker_questions`, `answer_worker`
- **Hardening (M4)** — heartbeat warnings, spawn/error recovery, CI `verify.yml`
- **Swarm parallelism (M6)** — `spawn_swarm`, `swarm_status`, `swarm_cancel`, `swarm_collect`, `/api/swarms/*`
- **Opt-in unsafe swarm scripts** — `swarm_unsafe_runtime_code_eval` with audit log under `.opencode/swarm/runs/`
- **Documentation** — provider-first README, GETTINGSTARTEDGUIDE, MIGRATION.md
- **Hardening (M7)** — `WorktreeEventBridge` (one `event.subscribe` per worktree), `createAsyncEventQueue` (serialized events, 10k cap), loop in-flight guards (`spawnInFlight`, `verifyInFlight`, `resumeInFlight`), `stop_loop` → `done` + `outcome: "stopped"`, `pause_loop` aborts worker, production `anonymous` session block, worker attempt sync via `.opencode/loop_attempt.json`, swarm registry prune, no silent supervisor API-key fallback, expanded provider/engine tests (55+)

### Changed

- Loop orchestration is **deterministic code** in `LoopEngine`, not LLM self-discipline in the main session
- Default plugin path: `ralph-worker.ts` (legacy monolith moved to `plugins-legacy/`)
- **Default agent instructions** — comprehensive supervisor + worker prompts; v0.2-accurate bootstrap `PLAN.md` / `RLM_INSTRUCTIONS.md`; removed stale v0.1 `subagent_*` references; worker plugin system prompt sourced from `@ralph-rlm/engine` templates

### Deprecated

- `.opencode/plugins-legacy/ralph-rlm.ts` — v0.1 plugin-as-orchestrator; kept for reference, not auto-loaded

### Removed

- Nothing yet — legacy bundle `dist/ralph-rlm.js` still built for npm compatibility

---

## [0.1.x] - prior

- Experimental OpenCode plugin with `ralph_spawn_worker`, `session.idle` hooks, and in-session orchestration
- See git history and legacy README sections for v0.1 tool reference