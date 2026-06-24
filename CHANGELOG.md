# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] - 2026-06-24

### Added

- **Streaming supervisor responses.** The chat-completions endpoint now streams progressively: as the turn runs its tool rounds (the slow part), live markers (`→ start_loop`, `→ loop_status`, …) appear, then the final answer streams — instead of hanging silently until the whole turn finishes and dumping it at once. Verified live: SSE `chat.completion.chunk`s arrive incrementally.

### Changed

- Supervisor **tool calls within a round run concurrently** now (was sequential), and the default **`maxToolRounds` is raised 8 → 12**. Hitting the round limit no longer reads as an error — it's a calm "I've taken several steps … ask me to continue" status. (Surfaced by the end-to-end smoke loop, where the prior limit/error was easy to hit.)

### Notes

- The end-to-end smoke loop validated the full stack live (auto-start, credential auto-detect, orchestration, the `ralph-worker` agent, and a real worker creating a file until `verify` passed). It also surfaced a footgun to address next: when no worker model is set, the worker can fall back to the `ralph-rlm/supervisor` model — set `worker.providerID`/`worker.modelID` in `ralph-provider.json`.

## [0.3.10] - 2026-06-24

### Changed

- Setup-skill references now fully document provider auto-start: the `--no-autostart` flag and expected output (`cli.md`), a `.opencode/plugins/ralph-autostart.ts` section (`config-files.md`), and auto-start-aware "provider unreachable" guidance — including the `node`-on-PATH requirement (`troubleshooting.md`).

## [0.3.9] - 2026-06-24

### Added

- **Provider auto-start** — `setup` installs `.opencode/plugins/ralph-autostart.ts`, which launches the Ralph provider when OpenCode loads, so you no longer run `opencode-ralph-rlm serve` by hand. It's idempotent (the `serve` pre-flight reuses a running provider), starts eagerly at OpenCode launch, and logs to `<tmp>/opencode-ralph-rlm/provider.log`. Disable with `setup --no-autostart` or `RALPH_AUTOSTART=0`. (Verified live: OpenCode runs the plugin at launch; the provider comes up and is reused across restarts.)
- Interview skill + planning playbook: a step on **assumptions** — state them explicitly to the user, record them in a `## Assumptions` section of `PLAN.md`, and add an early milestone to test any load-bearing unverified assumption.

## [0.3.8] - 2026-06-24

### Added

- **The supervisor now develops the `verify.command` with you** — it's the loop's only stop condition, so this matters. New tools `get_verify` / `set_verify` / `run_verify` let the supervisor read, write (`ralph.json`, merge-safe), and dry-run the command out-of-loop to validate it (a good command **fails** before the work is done). Crafting it is now part of the planning phase (supervisor + `interview-and-create-plan` skill), and `start_loop` warns when `verify.command` is missing.

### Changed

- Supervisor system prompt gained a **"Verification is the contract"** section and a richer **Swarms** section (when/why to use them, that they never run verify or end the loop, and how to collect/merge results).

## [0.3.7] - 2026-06-24

### Changed

- **`ralph_*` / `rlm_*` tools are now hidden from normal OpenCode sessions** (not just inert). The worker plugin's `config` hook denies them globally and re-allows them only in a dedicated **`ralph-worker`** agent that workers run under (the new default `worker.agent`). Verified live: a normal session reports the tools as unavailable; a worker session can use them and still has full coding tools. The 0.3.6 session-scoped gate/prompt remain as defense-in-depth.
- Do not set `worker.agent` (e.g. to `build`) — that agent has the Ralph tools denied; workers must use `ralph-worker`. The example/scaffold configs no longer set it.

## [0.3.6] - 2026-06-24

### Fixed

- **Worker plugin no longer pollutes normal OpenCode sessions.** The plugin loads for every session in a project, but its worker system prompt, the edit/bash **context gate**, and compaction context were being applied to *all* sessions — which injected worker instructions into normal chats and blocked `edit`/`bash` until `ralph_load_context()` (a call a normal session never makes). These now apply **only to Ralph worker sessions** (identified by the `rlm-worker-attempt-*` session title). In normal sessions the `ralph_*` / `rlm_*` tools are inert (they error if invoked) and `edit`/`bash` are never gated.

## [0.3.5] - 2026-06-24

### Changed

- Setup skill + troubleshooting now cover the `serve` pre-flight check: stop a stale/already-running provider before starting a new version, and recognize that an "already running" message explains wrong-version / missing-feature symptoms.

## [0.3.4] - 2026-06-24

### Added

- **`serve` pre-flight check** — before starting, the CLI probes the target port and, if a Ralph provider is already running, reports its version vs. the one being started and tells you to stop the old one (a running provider does not pick up new code). Also detects when the port is held by a non-Ralph service. (Probes both `localhost` and `127.0.0.1` to dodge a Node fetch/IPv6 timeout quirk.)

## [0.3.3] - 2026-06-24

### Changed

- The "no supervisor API key" error now explains the full lookup order (env → `ralph-provider.json` → OpenCode auth) and how to fix it (`opencode auth login` + restart, or set the key), and reports the resolved `source`.

## [0.3.2] - 2026-06-24

### Fixed

- **Confirmed supervisor auto-detect endpoints + model ids** against the live OpenCode provider registry (`/config/providers`): OpenCode Zen (`opencode` / `opencode-go`) → `https://opencode.ai/zen/v1` with the free `deepseek-v4-flash-free` model; Google → `gemini-2.5-flash`. Prefer the free Zen model first.
- Updated the stale OpenAI default model (`gpt-4o-mini` → `gpt-5.4-mini`) in the supervisor default and all docs/examples.

## [0.3.1] - 2026-06-24

### Added

- **Supervisor credential auto-detect** — when no `RALPH_SUPERVISOR_API_KEY` (or `ralph-provider.json` key) is set, the provider falls back to OpenCode's own auth (`~/.local/share/opencode/auth.json`), using a keyed provider you've already authenticated (e.g. Google, OpenCode Zen). So an OpenCode user usually needs no separate supervisor key. Precedence: env → `ralph-provider.json` → OpenCode auth → built-in default.
- **`GET /api/health` reports supervisor readiness** — `supervisor.ready`, the resolved `model`, and `source` (`env` / `opencode-auth:<provider>` / `default`), with a `hint` when no credential is found. The setup skill uses this to verify before launching.

### Changed

- Setup skill is now discovery-driven: it inspects `opencode auth list` / `opencode models`, relies on auto-detect for the supervisor, recommends (does not force) a free OpenCode model for workers, and directs the user to authenticate (`opencode auth login`) if nothing usable is found — before starting the provider. Added a re-open-OpenCode step.

## [0.3.0] - 2026-06-24

### Added

- **Planning phase before the loop** — `interview-and-create-plan` skill (Understand → Sketch → Plan → Review → Write). Two paths: the supervisor runs the interview itself (new `repo_search` / `repo_grep` / `write_plan` tools) or you run the skill in a TUI session. `start_loop` launches against an authored `PLAN.md` instead of a placeholder, and weaves the goal into a freshly bootstrapped plan.
- **Named plans (versions)** — protocol files live in `.ralph-rlm/plans/<name>/` with per-plan `.state/` markers, so multiple plans can coexist and be switched. New supervisor tools `list_plans` / `select_plan` / `new_plan`. Configurable via `plans.dir` / `plans.active` in `ralph.json` (default `.ralph-rlm/plans`; `""`/`"."` keeps the legacy root layout, which is also auto-detected for existing repos).
- **Config location** — `ralph.json` is now read from `.ralph-rlm/ralph.json` first, then `.opencode/ralph.json`.
- **External messages to the supervisor** — `POST /api/loops/:sessionId/message` (and `opencode-ralph-rlm send-message` / `sessions` CLI) let watchers/scripts notify or steer the supervisor out-of-band. Records to protocol files, toasts the TUI, and runs a supervisor turn so it can act autonomously (`runTurn:false` to only record). Supervisor turns are now serialized per session.
- **`opencode-ralph-rlm plan-path` CLI** — prints the active plan's `PLAN.md` location (layout-aware), so a planning skill/script writes the plan where `start_loop` detects it.
- `ralph_load_context()` now returns `plan_dir` and a `protocol_paths` map so workers edit protocol files at the correct location in named-plan mode.

### Changed

- **`NOTES_AND_LEARNINGS.md` is now a curated, editable knowledge base** (no longer framed as append-only). Workers are encouraged to edit/reorganize/prune it and to link out to the domain glossary, ADRs, and design docs rather than restating them.
- Removed the supervisor `read_file` tool — planning uses `repo_grep`; Path B uses OpenCode's built-in `read`.
- Rewrote the README to lead with a plain-language explanation (and credit [ralph-wiggum.ai](https://ralph-wiggum.ai/)); deep architecture moved to an "under the hood" section. Getting-started guide updated for planning, named plans, and the new commands.

### Fixed

- **Plan-name path traversal** — `normalizePlanName` now rejects `.`/`..`/dot-only names so a plan name (via `select_plan`/`new_plan` or the `.active` pointer) can't resolve to or escape the plans directory. Version-like names with internal dots (e.g. `v1.2`) are preserved.
- Protocol-patch rewriting now only adjusts `a/`/`b/` diff prefixes (the form `git apply -p1` needs), avoiding a mis-strip on bare path headers.
- Accelerated `rlm_grep` target-file matching is separator-insensitive, so it stays accelerated in named-plan mode on Windows.
- `ralph.json`-related error messages no longer hard-code `.opencode/` now that config can also live in `.ralph-rlm/`.

## [0.2.0] - 2026-06-15

### Added

- **Packaged setup CLI** — Node-compatible `opencode-ralph-rlm setup|serve|doctor` for `npx @doeixd/opencode-ralph-rlm ...` project initialization, provider startup, and diagnostics
- **Setup skill** — `skills/setup-opencode-ralph-rlm/SKILL.md` plus references for agents installing Ralph RLM into target repositories
- **Installation guide** — `INSTALLATION.md` leads with the agent skill, then CLI setup, then manual setup
- **FFF worker search acceleration** — optional `@ff-labs/fff-node` integration for `rlm_grep`, plus new `rlm_file_search` and `rlm_glob` worker tools with graceful fallback when native search is unavailable
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
