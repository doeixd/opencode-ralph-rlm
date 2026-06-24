# Config Files

Review these files after `setup`.

## `.opencode/plugins/ralph-worker.ts`

Purpose: make worker sessions load Ralph's RLM tools and context gate.

Expected content shape:

```ts
export { RalphWorkerPlugin, RalphWorkerPlugin as default } from "@doeixd/opencode-ralph-rlm/worker-plugin";
```

If this file is missing, workers will not have `ralph_load_context`, `rlm_file_search`, `rlm_glob`, `rlm_grep`, `rlm_slice`, `ralph_report`, or `ralph_ask`.

## `.opencode/plugins/ralph-session-bridge.ts`

Purpose: correlate each OpenCode TUI session with one Ralph loop.

It should:

- listen for OpenCode session events,
- inject `x-opencode-session-id` for Ralph provider requests,
- add the target `directory` query parameter when missing.

If this file is missing, the provider may reject requests as anonymous outside test mode.

## `.opencode/ralph.json`

Purpose: loop behavior and stop condition.

Minimum useful shape:

```json
{
  "enabled": true,
  "maxAttempts": 20,
  "verifyTimeoutMinutes": 15,
  "verify": { "command": ["npm", "test"], "cwd": "." },
  "gateDestructiveToolsUntilContextLoaded": true,
  "plans": { "dir": ".ralph-rlm/plans", "active": "default" },
  "fff": {
    "enabled": true,
    "scanTimeoutMs": 10000
  },
  "subAgentEnabled": true,
  "swarm": {
    "enabled": true,
    "maxConcurrent": 5,
    "unsafeEvalEnabled": false
  }
}
```

The most important setting is `verify.command`. Ralph stops only when this command passes or `maxAttempts` is exhausted.

`ralph.json` is read from `.ralph-rlm/ralph.json` first, then `.opencode/ralph.json`. `setup` writes it to `.opencode/ralph.json`.

`plans` controls where protocol files (`PLAN.md`, `RLM_INSTRUCTIONS.md`, …) live. With `plans.dir` set (the default `setup` writes), each plan is a directory under it — `.ralph-rlm/plans/<name>/` — so multiple named plans/versions can coexist and be switched (`select_plan` / `new_plan`). Set `plans.dir` to `""` or `"."` for the legacy layout (files at the repo root). Run `opencode-ralph-rlm plan-path` to print the active plan's `PLAN.md` location.

`fff` controls optional native worker search acceleration. Leave it enabled unless `@ff-labs/fff-node` cannot load in the target environment. `rlm_grep` falls back automatically; `rlm_file_search` and `rlm_glob` return a structured unavailable reason when FFF is disabled or unavailable.

## `opencode.json`

Purpose: register the provider model.

Expected provider entry:

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
          "name": "Ralph Supervisor (loop orchestrator)"
        }
      }
    }
  }
}
```

Preserve any existing providers. Do not replace the whole file unless the user asks.

## Optional `.opencode/ralph-provider.json`

Purpose: repo-local supervisor and worker defaults.

Use only when needed. Environment variables are simpler for supervisor credentials:

- `RALPH_SUPERVISOR_API_KEY`
- `RALPH_SUPERVISOR_MODEL`
