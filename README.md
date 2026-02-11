# ralph-rlm

An [OpenCode](https://opencode.ai) plugin that turns an AI coding session into a persistent, self-correcting loop. Describe a goal, walk away, and come back to working code.

New here? Start with [`GETTINGSTARTEDGUIDE.md`](GETTINGSTARTEDGUIDE.md).

Two techniques combine to make this work:

- **Ralph** — a strategist session spawned fresh per attempt. It reviews what failed, adjusts the plan and instructions, then delegates coding to a worker. It never writes code itself.
- **RLM** (Recursive Language Model worker) — a file-first coding session based on [arXiv:2512.24601](https://arxiv.org/abs/2512.24601). Each attempt gets a clean context window and loads all state from files rather than inheriting noise from prior turns.


## The problem this solves

Long-running AI coding sessions degrade. By attempt 4 or 5, the context window contains echoes of three failed strategies, retracted plans, contradictory tool outputs, and the model's own hedging. The agent starts reasoning from a corrupted premise. You end up re-explaining what went wrong, manually pruning bad state, or starting over.

The standard response — "just use a bigger context window" — makes things worse. More capacity means more noise survives longer. The problem isn't window size, it's window hygiene.

ralph-rlm solves this by treating each attempt as disposable. State lives in files, not in the context window. Each new session loads exactly what it needs from those files and nothing else. The loop gets smarter with each failure by updating its instructions — not by accumulating turns.


## Philosophy

### Fresh context windows over long conversations

The insight from the RLM paper is that context windows are not free. Every token of prior conversation competes with new information for the model's attention. Failed attempts, debug noise, and superseded plans don't disappear when you move on — they stay in the window and subtly bias future reasoning.

The solution is to make context windows **ephemeral by design**. Each worker session:
- Starts clean, with no memory of prior attempts
- Loads exactly the state it needs from protocol files
- Does one pass, then stops

The protocol files carry forward what matters. Everything else is discarded.

### Files as the memory primitive

Context windows are session-local and finite. Files are persistent, inspectable, diff-able, and shared across sessions. By routing all persistent state through the filesystem, the loop gains properties that in-context memory cannot provide:

- **Durability**: state survives crashes, restarts, and context compression
- **Inspectability**: you can read `AGENT_CONTEXT_FOR_NEXT_RALPH.md` at any time to see exactly what the next attempt will see
- **Shareability**: multiple sessions (Ralph, worker, sub-agents) read and write the same files concurrently
- **Debuggability**: the entire history of an overnight run is in plaintext files you can grep

### Separation of strategy and execution

The Ralph strategist session exists because mixing strategy and execution in the same context is how reasoning degrades. When a session that just wrote failing code is also responsible for diagnosing *why* it failed and planning the next approach, it pattern-matches against its own failed reasoning. It proposes variations on what didn't work rather than stepping back.

Ralph's session gets a fresh window. It reads the failure record cold, without the accumulated baggage of having written the code. This mirrors how experienced engineering teams work: the reviewer of a failing PR is often not the one who writes the fix.

### The verify contract

The loop is only as good as its exit condition. `verify.command` is the single source of truth for "done." A machine-verifiable criterion — tests pass, types check, linter clean — turns the exit question from a judgment call into a boolean. The model cannot talk its way out of a failing test suite.

This contract has a corollary: **the better your verify command, the better the loop performs.** A verify that checks only syntax will produce syntactically valid but logically broken code. A verify that runs the full test suite, typechecks, and lints will produce code that passes all three.

### The grep-first discipline

The RLM paper demonstrates that full-file reads are expensive and often counterproductive. When a model dumps a 2000-line file into its context to answer a question that requires 30 lines, the relevant section is buried in noise and the window fills with irrelevant code.

`rlm_grep` + `rlm_slice` give surgical access: search first to find line numbers, then read only the relevant range. `CONTEXT_FOR_RLM.md` is the designated large-reference file — a place to paste API docs, specs, or large codebases that should never be read in full.

### Persistent learning across attempts

`NOTES_AND_LEARNINGS.md` and `RLM_INSTRUCTIONS.md` are the loop's long-term memory. They survive context resets and accumulate across attempts. The loop doesn't just retry — it gets smarter with each failure.

`RLM_INSTRUCTIONS.md` is the inner loop's operating manual. The Ralph strategist updates it between attempts when a pattern of failures reveals a gap in guidance. By attempt 10, the instructions encode everything learned from attempts 1-9.

This is why the approach scales to overnight runs. A fresh worker in attempt 10 starts with the accumulated knowledge of 9 prior attempts, encoded in protocol files, without the accumulated noise.


## How it works

### Three-level architecture

```
You → main session (thin meta-supervisor — your conversation)
         │
         ├─ attempt 1:
         │    ├─ spawns Ralph strategist session R1  ← fresh context
         │    │    R1: ralph_load_context() → review failures → update PLAN.md
         │    │        → ralph_spawn_worker() → STOP
         │    │
         │    └─ spawns RLM worker session W1  ← fresh context
         │         W1: ralph_load_context() → code → ralph_verify() → STOP
         │
         ├─ plugin verifies on W1 idle
         │    fail → roll state files → spawn attempt 2
         │
         ├─ attempt 2:
         │    ├─ spawns Ralph strategist session R2  ← fresh context again
         │    │    R2: reads AGENT_CONTEXT_FOR_NEXT_RALPH.md → adjusts strategy
         │    │        → ralph_spawn_worker() → STOP
         │    │
         │    └─ spawns RLM worker session W2  ← fresh context
         │         W2: loads compact state from files → code → STOP
         │
         └─ pass → done toast
```

Each session role has a distinct purpose and **fresh context window**:

| Role | Session | Context | Responsibility |
|---|---|---|---|
| **main** | Your conversation | Persistent | Goal → stop. Plugin handles the rest. |
| **ralph** | Per-attempt strategist | Fresh | Review failure, update PLAN.md / RLM_INSTRUCTIONS.md, call `ralph_spawn_worker()`. |
| **worker** | Per-attempt coder | Fresh | `ralph_load_context()` → code → `ralph_verify()` → stop. |

### The state machine

```
main idle
  └─ spawn Ralph(1)
       └─ Ralph(1) calls ralph_spawn_worker()
            └─ spawn Worker(1)
                 └─ Worker(1) calls ralph_verify() and goes idle
                      └─ plugin runs verify
                           ├─ pass → done
                           └─ fail → roll state files
                                └─ spawn Ralph(2)
                                     └─ (repeat)
```

The plugin drives the loop from `session.idle` events. Neither Ralph nor the worker need to know about the outer loop — they just load context, do their job, and stop.

### The RLM worker discipline

Each worker session is required to:

1. Call `ralph_load_context()` first — blocked from `write`/`edit`/`bash` until it does.
2. Read `PLAN.md` and `RLM_INSTRUCTIONS.md` as authoritative instructions.
3. Use `rlm_grep` + `rlm_slice` to access large reference documents — never dump them whole.
4. Write scratch work to `CURRENT_STATE.md` throughout the attempt.
5. Promote durable changes (completed milestones, new constraints) to `PLAN.md`.
6. Append insights to `NOTES_AND_LEARNINGS.md`.
7. Call `ralph_verify()` when ready, then stop.

The one-pass contract is enforced socially (system prompt) and mechanically (context gate on destructive tools). Workers do not re-prompt themselves. Ralph controls iteration.

### Sub-agents

For tasks that can be decomposed, a worker can `subagent_spawn` a child session with an isolated goal. Each sub-agent gets its own state directory under `.opencode/agents/<name>/` and the same protocol file structure. The worker polls with `subagent_await` and integrates the result.

Sub-agents follow the same discipline as workers: one pass, file-first, fresh context.

### Supervisor communication

Spawned sessions (Ralph and workers) can communicate back to the main conversation at runtime:

- `ralph_report()` — fire-and-forget progress updates, appended to `SUPERVISOR_LOG.md` and `CONVERSATION.md`, and posted to the main conversation
- `ralph_ask()` — blocks the session until you respond via `ralph_respond()`, enabling interactive decision points mid-loop (e.g., "should I rewrite auth.ts or patch it?")

This is implemented via file-based IPC (`.opencode/pending_input.json`) so responses survive across any session boundary.


## Install

### Project-level (recommended)

```
your-repo/
└── .opencode/
    ├── package.json        ← add "effect" dependency
    ├── ralph.json          ← verify command + tuning
    └── plugins/
        └── ralph-rlm.ts    ← the plugin
```

Copy `ralph-rlm.ts` into `.opencode/plugins/` and create `.opencode/package.json`:

```json
{
  "dependencies": {
    "effect": "^3.13.0"
  }
}
```

OpenCode runs `bun install` at startup automatically.

### Global

Copy the plugin to `~/.config/opencode/plugins/ralph-rlm.ts` and add the `package.json` to `~/.config/opencode/package.json`.


## Configuration

Create `.opencode/ralph.json`. All fields are optional — the plugin runs with safe defaults if the file is absent.

```json
{
  "enabled": true,
  "autoStartOnMainIdle": false,
  "statusVerbosity": "normal",
  "maxAttempts": 25,
  "heartbeatMinutes": 15,
  "verify": {
    "command": ["bun", "run", "verify"],
    "cwd": "."
  },
  "gateDestructiveToolsUntilContextLoaded": true,
  "maxRlmSliceLines": 200,
  "requireGrepBeforeLargeSlice": true,
  "grepRequiredThresholdLines": 120,
  "subAgentEnabled": true,
  "maxSubAgents": 5,
  "maxConversationLines": 1200,
  "conversationArchiveCount": 3,
  "reviewerEnabled": false,
  "reviewerRequireExplicitReady": true,
  "reviewerMaxRunsPerAttempt": 1,
  "reviewerOutputDir": ".opencode/reviews",
  "reviewerPostToConversation": true,
  "agentMdPath": "AGENT.md"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable the outer loop without removing the plugin. |
| `autoStartOnMainIdle` | `false` | Automatically start attempt 1 when the main session goes idle. Set `true` to enable auto-start, or keep `false` for manual starts via `ralph_create_supervisor_session()`. |
| `statusVerbosity` | `"normal"` | Supervisor status emission level: `minimal` (warnings/errors), `normal`, or `verbose`. |
| `maxAttempts` | `20` | Hard stop after this many failed verify attempts. |
| `heartbeatMinutes` | `15` | Warn if active strategist/worker has no progress for this many minutes. |
| `verify.command` | — | Shell command to run as an array, e.g. `["bun", "run", "verify"]`. If omitted, verify always returns `unknown`. |
| `verify.cwd` | `"."` | Working directory for the verify command, relative to the repo root. |
| `gateDestructiveToolsUntilContextLoaded` | `true` | Block `write`, `edit`, `bash`, etc. until `ralph_load_context()` has been called in the current attempt. |
| `maxRlmSliceLines` | `200` | Maximum lines a single `rlm_slice` call may return. |
| `requireGrepBeforeLargeSlice` | `true` | Require a recent `rlm_grep` call before slices larger than `grepRequiredThresholdLines`. |
| `grepRequiredThresholdLines` | `120` | Line threshold above which grep-first is required. |
| `subAgentEnabled` | `true` | Allow `subagent_spawn`. |
| `maxSubAgents` | `5` | Maximum concurrently running sub-agents per session. |
| `maxConversationLines` | `1200` | Rotate `CONVERSATION.md` when it grows beyond this many lines. |
| `conversationArchiveCount` | `3` | Number of rotated archives to keep (`CONVERSATION.1.md`, etc.). |
| `reviewerEnabled` | `false` | Enable optional reviewer sub-agent tooling. |
| `reviewerRequireExplicitReady` | `true` | Require explicit `ralph_request_review()` before reviewer runs. |
| `reviewerMaxRunsPerAttempt` | `1` | Max reviewer runs per attempt unless forced. |
| `reviewerOutputDir` | `".opencode/reviews"` | Directory for reviewer report files. |
| `reviewerPostToConversation` | `true` | Post reviewer lifecycle updates to main conversation feed. |
| `agentMdPath` | `"AGENT.md"` | Path (relative to repo root) to the project AGENT.md. Read by `ralph_load_context()` and included in the context payload. Set to `""` to disable. |

### verify command examples

```json
{ "command": ["bun", "run", "verify"] }
{ "command": ["bun", "test"] }
{ "command": ["npm", "test"] }
{ "command": ["cargo", "test"] }
{ "command": ["python", "-m", "pytest"] }
{ "command": ["make", "ci"] }
{ "command": ["./scripts/verify.sh"] }
```

If your repo has no test files yet, avoid `bun test` as a verify command because Bun exits non-zero when no tests match. Use a command that reflects your current quality gate (for example `bun run verify` with typecheck + build).

The verify command is the loop's exit condition. It should be as comprehensive as you want the output to be. A verify that runs tests + typecheck + lint will produce code that passes all three; a verify that only checks syntax will produce syntactically valid code that may be logically broken.

## Quick start (recommended)

If you are setting up a repo from scratch, use this sequence:

1. Run `ralph_quickstart_wizard(...)` for one-call setup, or use `ralph_doctor(autofix=true)` + `ralph_bootstrap_plan(...)` manually.
2. Validate plan quality with `ralph_validate_plan()`.
3. Start the loop with `ralph_create_supervisor_session()` (or enable auto-start if desired).
4. Monitor progress in `SUPERVISOR_LOG.md` (structured) and `CONVERSATION.md` (readable timeline).

If setup is incomplete, auto-start is skipped and the plugin emits a warning with next actions.

## Recommended OpenCode agent setup

The plugin already manages the core loop roles (`main` / `ralph` / `worker` / `subagent`).
Use OpenCode agents to control posture and delegation, not to replace loop orchestration.

Recommended split:

- `supervisor` (primary): your default top-level operator for safe orchestration.
- built-in `plan` (primary): dry analysis/planning without edits.
- built-in `build` (primary): full manual implementation when needed.
- project subagents (optional): focused review/docs/security helpers.

This repo now includes project-local agent files under `.opencode/agents/`:

- `.opencode/agents/supervisor.md`
- `.opencode/agents/ralph-reviewer.md`
- `.opencode/agents/docs-writer.md`
- `.opencode/agents/security-auditor.md`

These profiles intentionally keep loop ownership in `ralph-rlm`.
Do not model Ralph strategist/worker as OpenCode primary/subagent replacements.


## Protocol files

The plugin bootstraps these files on first run if they do not exist. They are the persistent memory of the loop — commit them to version control.

| File | Purpose |
|---|---|
| `PLAN.md` | Goals, milestones, definition of done, changelog. Updated via `ralph_update_plan()`. |
| `RLM_INSTRUCTIONS.md` | Inner loop operating manual and playbooks. Updated via `ralph_update_rlm_instructions()`. |
| `CURRENT_STATE.md` | Scratch pad for the current Ralph attempt. Reset on each rollover. |
| `PREVIOUS_STATE.md` | Snapshot of the last attempt's scratch. Automatically written on rollover. |
| `AGENT_CONTEXT_FOR_NEXT_RALPH.md` | Shim passed to the next attempt: verdict, summary, next step. |
| `CONTEXT_FOR_RLM.md` | Large reference document (API docs, specs, etc.). Always accessed via `rlm_grep` + `rlm_slice`. |
| `NOTES_AND_LEARNINGS.md` | Append-only log of durable insights. Survives all context resets. |
| `TODOS.md` | Optional lightweight task list. |
| `SUPERVISOR_LOG.md` | Append-only feed of all `ralph_report()` entries across all attempts and sessions. |
| `CONVERSATION.md` | Append-only human-readable timeline of supervisor updates, loop events, questions, and responses. |

Sub-agent state lives under `.opencode/agents/<name>/` with the same structure.

### How files flow between attempts

```
Attempt N worker writes:
  CURRENT_STATE.md     ← scratch: what I tried, what I found
  NOTES_AND_LEARNINGS.md ← append: durable insight from this attempt

On N→N+1 rollover, plugin writes:
  PREVIOUS_STATE.md    ← copy of CURRENT_STATE.md
  CURRENT_STATE.md     ← reset to blank template
  AGENT_CONTEXT_FOR_NEXT_RALPH.md ← verdict + summary + next step

Ralph(N+1) reads and optionally updates:
  AGENT_CONTEXT_FOR_NEXT_RALPH.md ← why it failed
  PLAN.md                          ← adjusts strategy
  RLM_INSTRUCTIONS.md              ← adjusts worker guidance

Worker(N+1) reads:
  All of the above via ralph_load_context()
```

This is why the loop can run overnight. Each fresh session starts with the accumulated knowledge of all prior attempts, encoded in files — not in a context window that would be reset.


## Working with AGENT.md

OpenCode loads `AGENT.md` from the repo root into every session's system prompt automatically. The plugin coexists with this but the two files serve different roles:

| | `AGENT.md` | `RLM_INSTRUCTIONS.md` |
|---|---|---|
| **Scope** | Static project-wide rules | Dynamic per-loop operating manual |
| **Who writes it** | You (developer) | Agent (via `ralph_update_rlm_instructions()`) |
| **Changes** | Rarely — git-committed conventions | Every loop — playbooks, learnings, constraints |
| **Injected by** | OpenCode automatically (system prompt) | `ralph_load_context()` return payload |

### What the plugin does with AGENT.md

`ralph_load_context()` automatically reads `AGENT.md` (configurable via `agentMdPath`) and includes it in the context payload under `agent_md`. This means:

- Sub-agents, which run in isolated sessions that may not have AGENT.md injected, still see the project rules.
- Every attempt starts with both the static project context and the dynamic loop state in one payload.

To disable AGENT.md inclusion:

```json
{ "agentMdPath": "" }
```

To point to a non-standard location:

```json
{ "agentMdPath": "docs/AGENT.md" }
```

### Recommended AGENT.md structure

Keep AGENT.md focused on facts that never change loop-to-loop: repo layout, build commands, code style. Defer loop-specific guidance to `RLM_INSTRUCTIONS.md`.

```markdown
# Project Agent Rules

## Repo layout
- `src/`      — application source
- `tests/`    — test suite (`bun test`)
- `docs/`     — documentation

## Build and verify
- Install:  `bun install`
- Test:     `bun test`
- Typecheck: `bun run typecheck`

## Code style
- TypeScript strict mode; no `any`
- Prefer Effect-TS over raw Promises for async/error handling

## Loop guidance
This project uses the ralph-rlm plugin.
- Call `ralph_load_context()` at the start of every attempt.
- Task-specific playbooks live in `RLM_INSTRUCTIONS.md` — check there for the current strategy before starting work.
- Do NOT put attempt-specific state in AGENT.md; write it to `CURRENT_STATE.md` or `NOTES_AND_LEARNINGS.md`.
```

### Avoiding conflicts

If your AGENT.md contains instructions that clash with the plugin's file-first rules (e.g. "always read files in full"), add a note that defers to `RLM_INSTRUCTIONS.md`:

```markdown
## Note on file access
When working with the ralph-rlm loop, prefer `rlm_grep` + `rlm_slice` for large files
over full reads. The loop-specific protocol in `RLM_INSTRUCTIONS.md` takes precedence
over general file-access guidance in this document.
```

### Extending the system prompt instead

If you want your AGENT.md content appended to the plugin's system prompt fragment (instead of included in the context payload), use `RALPH_SYSTEM_PROMPT_APPEND`:

```bash
export RALPH_SYSTEM_PROMPT_APPEND="@AGENT.md"
```

This injects the file on every turn rather than only when `ralph_load_context()` is called.


## Tools

### Setup and supervisor bootstrap

#### `ralph_doctor(autofix?)`

Check whether the repository is ready for Ralph/RLM execution. It validates core setup (verify command, baseline files, placeholders) and returns structured diagnostics.

With `autofix: true`, it applies safe bootstrap fixes such as creating `.opencode/ralph.json` defaults and a baseline `AGENT.md` when missing.

#### `ralph_bootstrap_plan(goal, requirements?, stopping_conditions?, features?, steps?, todos?, overwrite_plan?, overwrite_todos?)`

Generate `PLAN.md` and `TODOS.md` from explicit project requirements. This is the fastest way to turn a rough prompt into a concrete execution plan.

#### `ralph_create_supervisor_session(start_loop?, force_rebind?, restart_if_done?)`

Bind the current session as the supervisor and optionally start attempt 1 immediately.

- Use this when `autoStartOnMainIdle` is disabled.
- Use `force_rebind: true` to move supervision to a different session.
- Use `restart_if_done: true` to start a new run after completion or manual stop.

#### `ralph_end_supervision(reason?, clear_binding?)`

Stop supervision for the current process. This prevents further auto-loop orchestration until restarted.

- Use this when you want to pause/stop Ralph from spawning more sessions.
- Use this after verification passes and the user confirms they are done, or when the user asks to stop the loop.
- Resume later with `ralph_create_supervisor_session(restart_if_done=true)`.

#### `ralph_supervision_status()`

Return current supervision state: bound session, attempt number, active strategist/worker session IDs, and done status.

#### `ralph_pause_supervision(reason?)`

Pause automatic loop orchestration without ending supervision state.

#### `ralph_resume_supervision(start_loop?)`

Resume from pause. Optionally start the loop immediately.

#### `ralph_reset_state(scope, confirm, preserve_logs?)`

Reset protocol/runtime state. Requires `confirm: "RESET_RALPH_STATE"`.

- `scope: "attempt"` resets scratch files.
- `scope: "full"` resets scratch + baseline protocol scaffolding.

#### `ralph_validate_plan()`

Validate `PLAN.md` structure (goal, requirements, stopping conditions, milestones/checklists) before long runs.

#### `ralph_quickstart_wizard(...)`

One-call setup helper: applies basic setup, writes `PLAN.md`/`TODOS.md`, validates plan, and can optionally start the loop.

### Context loading

#### `ralph_load_context()`

Reads all protocol files and returns them as a structured JSON payload. Must be called at the start of every attempt. Calling it marks the session as context-loaded, which unblocks destructive tools.

```
args:
  includeRlmContextHeadings  boolean  optional  Return headings-only from CONTEXT_FOR_RLM.md (default true)
  rlmHeadingsMax             number   optional  Max headings to return (default 80)
```

### Reading large files

#### `rlm_grep(query, file?, maxMatches?, contextLines?)`

Search a file by regex and return matching lines with line numbers. Defaults to `CONTEXT_FOR_RLM.md`. Use this to locate the relevant section before slicing.

#### `rlm_slice(startLine, endLine, file?)`

Read a specific line range from a file. Enforces the `maxRlmSliceLines` limit. Requires a recent `rlm_grep` call if the slice exceeds `grepRequiredThresholdLines`.

### Plan and instructions

#### `ralph_update_plan(patch, reason)`

Apply a unified diff patch to `PLAN.md`. Automatically appends a changelog entry. Use for durable changes only: completed milestones, new constraints, clarified acceptance criteria.

#### `ralph_update_rlm_instructions(patch, reason)`

Apply a unified diff patch to `RLM_INSTRUCTIONS.md`. Appends a changelog entry. The Fixed Header section should not be modified.

### Loop management

#### `ralph_rollover(verdict, summary, nextStep, learning?)`

Manually trigger a rollover: copies `CURRENT_STATE.md` to `PREVIOUS_STATE.md`, resets scratch, writes the next-attempt shim. Optionally appends a learning to `NOTES_AND_LEARNINGS.md`. The outer loop calls this automatically on verify failure; the agent can also call it explicitly.

#### `ralph_verify()`

Run the configured verify command. Returns `{ verdict: "pass"|"fail"|"unknown", output, error }`.

#### `ralph_spawn_worker()`

**Ralph strategist sessions only.** Spawn a fresh RLM worker session for this attempt. Call this after reviewing protocol files and optionally updating `PLAN.md` / `RLM_INSTRUCTIONS.md`. Then stop — the plugin handles verification and spawns the next Ralph session if needed.

If you call this from the main conversation you will get: `ralph_spawn_worker() can only be called from a Ralph strategist session.` In normal operation the plugin creates strategist sessions automatically on `session.idle`.

### Sub-agents

#### `subagent_spawn(name, goal, context?)`

Spawn a child OpenCode session to handle an isolated sub-task. Creates `.opencode/agents/<name>/` state files, then sends the initial prompt to the child session.

#### `subagent_await(name, maxLines?)`

Poll a sub-agent's `CURRENT_STATE.md` for completion. Returns `{ status: "done"|"running"|"not_found", current_state }`. The sub-agent signals completion by writing `## Final Result` or outputting `SUB_AGENT_DONE`.

#### `subagent_peek(name, file?, maxLines?)`

Read any protocol file from a sub-agent's state directory without waiting for completion. Useful for monitoring progress mid-run.

#### `subagent_list()`

List all sub-agents registered in the current session with their name, goal, status, and spawn time.

### Supervisor communication

These tools let spawned sessions (Ralph strategist, RLM worker) communicate back to the main conversation at runtime. State is carried in `.opencode/pending_input.json` for question/response pairs, `SUPERVISOR_LOG.md` for structured status entries, and `CONVERSATION.md` for the readable event timeline.

User answers to `ralph_ask()` are persisted too: when you reply via `ralph_respond()`, the response is appended to `CONVERSATION.md`.

#### `ralph_set_status(status, note?, post_to_conversation?)`

Optionally publish explicit attempt status (`running`, `blocked`, `done`, `error`) for the current session. This improves observability and handoffs.

If an inner session does not call `ralph_set_status()`, the loop still works: idle + verify events continue with implicit status handling.

#### `ralph_request_review(note?)`

Mark the current attempt as review-ready. This is the recommended gate before running the reviewer so it does not execute too often.

#### `ralph_run_reviewer(force?, wait?, timeout_minutes?, output_path?)`

Run an optional reviewer sub-agent and write the review report to a file (default: `.opencode/reviews/review-attempt-N.md`).

- Honors `reviewerRequireExplicitReady` and `reviewerMaxRunsPerAttempt` unless `force=true`.
- Use `wait=true` (default) to block until review completion.
- Reviewer gate/runtime state is persisted in `.opencode/reviewer_state.json` so restarts can resume tracking.

#### `ralph_review_status()`

Show reviewer gate state: active reviewer, review requests, and runs per attempt.

#### `ralph_report(message, level?, post_to_conversation?)`

Fire-and-forget progress report. Appends a timestamped entry to `SUPERVISOR_LOG.md` and `CONVERSATION.md`, shows a toast, and optionally posts into the main conversation so you can see what's happening without opening a separate session.

```
args:
  message              string   required  Progress message
  level                string   optional  "info" | "warning" | "error" (default: "info")
  post_to_conversation boolean  optional  Post to main conversation (default: true)
```

#### `ralph_peek_worker(maxLines?, post_to_conversation?)`

Snapshot the active worker's `CURRENT_STATE.md` and optionally post it into the main conversation for quick "peek" access in the TUI.

```
args:
  maxLines            number   optional  Max lines to include (default: 120)
  post_to_conversation boolean optional  Post to main conversation (default: true)
```

#### `ralph_ask(question, context?, timeout_minutes?)`

Ask a question and **block** until you respond via `ralph_respond()`. The question is written to `.opencode/pending_input.json`, a toast appears in the main session, and the main conversation is prompted with the question ID and response instruction. The calling session polls every 5 seconds.

Use this for decisions that can't be inferred from the protocol files — e.g., "should I rewrite `auth.ts` from scratch or patch the existing implementation?"

```
args:
  question         string  required  The question
  context          string  optional  Additional context for the decision
  timeout_minutes  number  optional  Minutes to wait before timing out (default: 15)
```

Returns `{ id, answer }` as JSON once you respond.

#### `ralph_respond(id, answer)`

Respond to a pending question, unblocking the session that called `ralph_ask()`. The `id` is shown in the toast and in the main conversation prompt (format: `ask-NNNN`). If you mistype the ID, the tool returns an error listing all pending unanswered questions with their IDs.

```
args:
  id      string  required  Question ID (e.g. "ask-1234567890")
  answer  string  required  Your answer
```


## Customising prompts via environment variables

Every internal prompt the plugin sends to the model is customisable through environment variables. Values are loaded once at startup.

### Formats

```bash
# Literal text — use \n for newlines
RALPH_CONTINUE_PROMPT="Attempt {{attempt}}: fix the verify.\n\nCall ralph_verify() when done."

# File reference (relative to worktree)
RALPH_SYSTEM_PROMPT="@.opencode/prompts/system.txt"

# Absolute file path
RALPH_BOOTSTRAP_RLM_INSTRUCTIONS="@/home/user/prompts/rlm-instructions.md"
```

### Reference

| Variable | Tokens | Description |
|---|---|---|
| `RALPH_SYSTEM_PROMPT` | — | Full system prompt injected on every turn. Replaces the default. |
| `RALPH_SYSTEM_PROMPT_APPEND` | — | Appended after the system prompt. Useful for adding project-specific rules without replacing the base. |
| `RALPH_COMPACTION_CONTEXT` | — | Context block injected when the session is compacted (context window compressed). |
| `RALPH_CONTINUE_PROMPT` | `{{attempt}}` `{{verdict}}` | Re-prompt sent to the agent after a failed verification attempt. |
| `RALPH_DONE_FILE_CONTENT` | `{{timestamp}}` | Content written to `AGENT_CONTEXT_FOR_NEXT_RALPH.md` when verification passes. |
| `RALPH_SUBAGENT_PROMPT` | `{{name}}` `{{goal}}` `{{context}}` `{{stateDir}}` `{{doneSentinel}}` `{{doneHeading}}` | Initial prompt sent to a spawned sub-agent. |
| `RALPH_SUBAGENT_DONE_SENTINEL` | — | Phrase the sub-agent must output to signal completion. Default: `SUB_AGENT_DONE`. |
| `RALPH_SUBAGENT_DONE_HEADING` | — | Heading in `CURRENT_STATE.md` that marks sub-agent completion. Default: `## Final Result`. |
| `RALPH_BOOTSTRAP_RLM_INSTRUCTIONS` | `{{timestamp}}` | Initial content written to `RLM_INSTRUCTIONS.md` when it does not exist. |
| `RALPH_BOOTSTRAP_CURRENT_STATE` | — | Template written to `CURRENT_STATE.md` on bootstrap and after each rollover. |
| `RALPH_CONTEXT_GATE_ERROR` | — | Error message thrown when the agent tries a destructive tool before loading context. |
| `RALPH_WORKER_SYSTEM_PROMPT` | — | System prompt injected into every RLM worker session. Describes the one-pass contract. |
| `RALPH_WORKER_PROMPT` | `{{attempt}}` | Initial prompt sent to each spawned RLM worker session. |
| `RALPH_SESSION_SYSTEM_PROMPT` | — | System prompt injected into Ralph strategist sessions. |
| `RALPH_SESSION_PROMPT` | `{{attempt}}` | Initial prompt sent to each spawned Ralph strategist session. |

### Example: custom continue prompt from a file

`.opencode/prompts/continue.txt`:
```
Ralph attempt {{attempt}} — last verify: {{verdict}}.

You are working in a TypeScript monorepo. Rules:
1. Call ralph_load_context() first.
2. Check PLAN.md for the current milestone.
3. Run `bun typecheck` before `bun test`.
4. Write all intermediate findings to CURRENT_STATE.md.
5. When the verify passes, stop.
```

`.env` or shell:
```bash
export RALPH_CONTINUE_PROMPT="@.opencode/prompts/continue.txt"
```


## Workflow patterns

### Basic: run until tests pass

Fill in your `verify.command`, write a goal in `PLAN.md`, and start a session. The loop runs automatically.

```
1. Edit PLAN.md — set your goal and definition of done.
2. Open OpenCode and describe the task.
3. Agent calls ralph_load_context(), reads PLAN.md, starts working.
4. Agent calls ralph_verify().
5. If fail → Ralph rolls state, re-prompts. Go to 3.
6. If pass → Ralph shows toast. Done.
```

### Overnight: walk away

Set `maxAttempts` high (25–50), write a detailed `PLAN.md` with a precise definition of done, and close your laptop. The loop will:

1. Make an attempt.
2. Run verify.
3. On failure: roll state, spawn Ralph to diagnose and adjust, spawn the next worker.
4. Repeat until it passes or hits `maxAttempts`.

In the morning, check `SUPERVISOR_LOG.md` and `CONVERSATION.md` for the progress feed, `NOTES_AND_LEARNINGS.md` for what the loop learned, and `AGENT_CONTEXT_FOR_NEXT_RALPH.md` for where it stopped.

### Supervisory check-in

Use `ralph_report` and `ralph_ask` to stay informed and make decisions without micromanaging:

```
Worker:
  ralph_report("Finished refactoring auth module. 3 tests failing — all in legacy JWT path.")
  ralph_ask("The legacy JWT path is only used by the mobile app. Rewrite or remove?")
  ← blocks until you call ralph_respond("ask-...", "Remove it, mobile app is deprecated")
  (continues with the answer)
```

You stay in the loop for decisions that require human judgment. Everything else runs unattended.

### Optional reviewer pass (gated)

To avoid over-running reviews, use explicit readiness:

1. Worker marks readiness with `ralph_request_review("ready for correctness review")`.
2. Supervisor runs `ralph_run_reviewer()`.
3. Review report is written to `.opencode/reviews/review-attempt-N.md` (or configured output path).

Reviewer execution is gated by `reviewerRequireExplicitReady` and `reviewerMaxRunsPerAttempt` unless forced.

### Parallel decomposition with sub-agents

```
Parent agent:
  1. ralph_load_context()
  2. Identify two independent sub-tasks
  3. subagent_spawn("auth", "implement JWT auth", context)
  4. subagent_spawn("api", "implement REST endpoints", context)
  5. subagent_await("auth") — poll until done
  6. subagent_await("api") — poll until done
  7. Integrate results, update PLAN.md
  8. ralph_verify()
```

### Tuning the inner loop

Edit `RLM_INSTRUCTIONS.md` to add project-specific playbooks, register MCP tools, or adjust the debug workflow. Changes persist across attempts. Use `ralph_update_rlm_instructions()` from within a session, or edit the file directly.

The instructions file is the primary lever for improving loop performance. If the loop keeps making the same mistake, add a rule. If it keeps following an inefficient path, add a playbook. The Ralph strategist is responsible for updating these instructions between attempts based on what it observes in the failure record.


## Hooks installed

| Hook | What it does |
|---|---|
| `event: session.idle` | Routes idle events: **worker** → `handleWorkerIdle` (verify + continue loop); **ralph** → `handleRalphSessionIdle` (warn if no worker spawned); **main/other** → `handleMainIdle` (kick off attempt 1). Also emits heartbeat/staleness warnings and supervisor status updates to `SUPERVISOR_LOG.md` and `CONVERSATION.md`. |
| `event: session.created` | Pre-allocates session state for known worker/ralph sessions. |
| `event: session.status` | Refreshes heartbeat/progress timestamps for active sessions and surfaces explicit session error statuses to the supervisor feed. |
| `experimental.chat.system.transform` | Three-way routing: **worker** → RLM file-first prompt; **ralph** → Ralph strategist prompt; **main/other** → supervisor prompt. |
| `experimental.session.compacting` | Injects protocol file pointers into compaction context so state survives context compression. |
| `tool.execute.before` | Blocks destructive tools (`write`, `edit`, `bash`, `delete`, `move`, `rename`) in **worker and sub-agent sessions** until `ralph_load_context()` has been called. Ralph strategist sessions are not gated. |


## Background

### The Ralph loop

The outer loop is named after the [Ralph Wiggum technique](https://www.geoffreyhuntley.com/ralph) — a `while` loop that feeds a prompt to an AI agent until it succeeds. The name reflects the philosophy: persistent, not clever. The loop doesn't try to be smart about when to give up. It tries, records what happened, and tries again with better instructions.

The key addition in this plugin over a naive Ralph implementation is the **separation of the strategist from the worker**. A naive loop re-prompts the same session. This plugin spawns a fresh Ralph strategist to review the failure before spawning the next worker. The strategist's fresh context means it analyses the failure without being anchored to the reasoning that produced it.

### The RLM inner loop

The worker discipline is based on [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). The paper's core finding: keeping large inputs in an external environment and having the model grep/slice/recurse over them significantly outperforms shoving everything into the context window at once. Models reason better when they can retrieve exactly what they need rather than filtering signal from a noisy dump.

This plugin approximates that approach using the filesystem as the external environment and `rlm_grep` + `rlm_slice` as the retrieval primitives. `CONTEXT_FOR_RLM.md` is the designated large-reference file — paste API docs, database schemas, or reference code there and the worker accesses it surgically rather than reading it whole.

### On the verify contract

The loop's correctness guarantee is only as strong as `verify.command`. This is a feature, not a limitation. It forces clarity about what "done" means before the loop starts. Ambiguous acceptance criteria produce ambiguous results regardless of how many attempts you give the loop.

The practical recommendation: make your verify command as strict as you can tolerate. If you would normally merge a PR that passes tests + typecheck + lint, configure that as your verify command. The loop will produce code that meets that bar.
