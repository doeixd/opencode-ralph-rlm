# ralph-rlm

An [OpenCode](https://opencode.ai) plugin that implements two interlocking AI loop techniques:

- **Ralph** (outer loop) — a supervisor that watches for session idle, runs your verification command, and automatically re-prompts the agent to keep working until the build is green or a max-attempt limit is hit.
- **RLM** (inner loop) — a file-first agent discipline based on [Recursive Language Models](https://arxiv.org/abs/2512.24601), where the agent is forced to load context from files, grep before reading, and write durable state back to files rather than relying on context window memory.

The combination lets you walk away from a task and come back to working code.

## How it works

### The outer loop (Ralph)

1. Agent finishes a turn → session goes idle → plugin fires.
2. Plugin runs your `verify` command (tests, typecheck, lint — whatever you configure).
3. **Pass** → writes a DONE marker to `AGENT_CONTEXT_FOR_NEXT_RALPH.md`, shows a toast, stops.
4. **Fail** → rolls `CURRENT_STATE.md` into `PREVIOUS_STATE.md`, resets scratch, writes a compact failure summary to `AGENT_CONTEXT_FOR_NEXT_RALPH.md`, then injects a continue prompt back into the session.
5. Repeat up to `maxAttempts`.

### The inner loop (RLM)

Each attempt the agent is required to:

1. Call `ralph_load_context()` first — blocked from write/edit/bash until it does.
2. Read `PLAN.md` and `RLM_INSTRUCTIONS.md` as authoritative instructions.
3. Use `rlm_grep` + `rlm_slice` to access large reference documents instead of dumping them whole.
4. Write scratch work to `CURRENT_STATE.md`.
5. Promote durable changes (completed milestones, new constraints) to `PLAN.md`.
6. Append insights to `NOTES_AND_LEARNINGS.md`.
7. Call `ralph_verify()` when ready.

### Sub-agents

For tasks that can be decomposed, the agent can `subagent_spawn` a child session with an isolated goal. Each sub-agent gets its own state directory under `.opencode/agents/<name>/`. The parent polls with `subagent_await` and integrates the result.


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
  "maxAttempts": 25,
  "verify": {
    "command": ["bun", "test"],
    "cwd": "."
  },
  "gateDestructiveToolsUntilContextLoaded": true,
  "maxRlmSliceLines": 200,
  "requireGrepBeforeLargeSlice": true,
  "grepRequiredThresholdLines": 120,
  "subAgentEnabled": true,
  "maxSubAgents": 5,
  "agentMdPath": "AGENT.md"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable the outer loop without removing the plugin. |
| `maxAttempts` | `20` | Hard stop after this many failed verify attempts. |
| `verify.command` | — | Shell command to run as an array, e.g. `["bun", "test"]`. If omitted, verify always returns `unknown`. |
| `verify.cwd` | `"."` | Working directory for the verify command, relative to the repo root. |
| `gateDestructiveToolsUntilContextLoaded` | `true` | Block `write`, `edit`, `bash`, etc. until `ralph_load_context()` has been called in the current attempt. |
| `maxRlmSliceLines` | `200` | Maximum lines a single `rlm_slice` call may return. |
| `requireGrepBeforeLargeSlice` | `true` | Require a recent `rlm_grep` call before slices larger than `grepRequiredThresholdLines`. |
| `grepRequiredThresholdLines` | `120` | Line threshold above which grep-first is required. |
| `subAgentEnabled` | `true` | Allow `subagent_spawn`. |
| `maxSubAgents` | `5` | Maximum concurrently running sub-agents per session. |
| `agentMdPath` | `"AGENT.md"` | Path (relative to repo root) to the project AGENT.md. Read by `ralph_load_context()` and included in the context payload. Set to `""` to disable. |

### verify command examples

```json
{ "command": ["bun", "test"] }
{ "command": ["npm", "test"] }
{ "command": ["cargo", "test"] }
{ "command": ["python", "-m", "pytest"] }
{ "command": ["make", "ci"] }
{ "command": ["./scripts/verify.sh"] }
```


## Protocol files

The plugin bootstraps these files on first run if they do not exist. They are the persistent memory of the loop — commit them to version control.

| File | Purpose |
|---|---|
| `PLAN.md` | Goals, milestones, definition of done, changelog. Updated via `ralph_update_plan()`. |
| `RLM_INSTRUCTIONS.md` | Inner loop operating manual and playbooks. Updated via `ralph_update_rlm_instructions()`. |
| `CURRENT_STATE.md` | Scratch pad for the current Ralph attempt. Reset on each rollover. |
| `PREVIOUS_STATE.md` | Snapshot of the last attempt's scratch. Automatically written by Ralph on rollover. |
| `AGENT_CONTEXT_FOR_NEXT_RALPH.md` | Shim injected at the start of the next attempt: verdict, summary, next step. |
| `CONTEXT_FOR_RLM.md` | Large reference document (API docs, specs, etc.). Always accessed via `rlm_grep` + `rlm_slice`. |
| `NOTES_AND_LEARNINGS.md` | Append-only log of durable insights from across attempts. |
| `TODOS.md` | Optional lightweight task list. |

Sub-agent state lives under `.opencode/agents/<name>/` with the same structure.


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

To disable AGENT.md inclusion, set `agentMdPath` to `""` in `.opencode/ralph.json`:

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

### Sub-agents

#### `subagent_spawn(name, goal, context?)`

Spawn a child OpenCode session to handle an isolated sub-task. Creates `.opencode/agents/<name>/` state files, then sends the initial prompt to the child session.

#### `subagent_await(name, maxLines?)`

Poll a sub-agent's `CURRENT_STATE.md` for completion. Returns `{ status: "done"|"running"|"not_found", current_state }`. The sub-agent signals completion by writing `## Final Result` or outputting `SUB_AGENT_DONE`.

#### `subagent_peek(name, file?, maxLines?)`

Read any protocol file from a sub-agent's state directory without waiting for completion. Useful for monitoring progress mid-run.

#### `subagent_list()`

List all sub-agents registered in the current session with their name, goal, status, and spawn time.


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

Set `maxAttempts` high, write a detailed `PLAN.md`, and close your laptop. Check `NOTES_AND_LEARNINGS.md` and `AGENT_CONTEXT_FOR_NEXT_RALPH.md` in the morning to see what happened.

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


## Hooks installed

| Hook | What it does |
|---|---|
| `event: session.idle` | Fires the outer Ralph loop after each idle. |
| `event: session.created` | Pre-allocates session state. |
| `experimental.chat.system.transform` | Injects the file-first protocol rules into every system prompt. |
| `experimental.session.compacting` | Injects protocol file pointers into compaction context so state survives context compression. |
| `tool.execute.before` | Blocks destructive tools (`write`, `edit`, `bash`, `delete`, `move`, `rename`) until `ralph_load_context()` has been called. |


## Background

The Ralph loop is named after the [Ralph Wiggum technique](https://www.geoffreyhuntley.com/ralph) — a `while` loop that feeds a prompt to an AI agent until it succeeds. The name reflects the philosophy: persistent, not clever.

The RLM inner loop is based on [Recursive Language Models (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601), which shows that keeping large inputs in an external environment and having the model grep/slice/recurse over them significantly outperforms shoving everything into the context window. This plugin approximates that approach with files and custom tools instead of a Python REPL.
