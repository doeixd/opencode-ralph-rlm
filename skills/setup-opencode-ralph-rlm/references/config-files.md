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

## `.opencode/plugins/ralph-autostart.ts`

Purpose: start the Ralph provider automatically when OpenCode loads, so the user doesn't run `opencode-ralph-rlm serve` by hand.

- It spawns `serve` (detached) at OpenCode startup; idempotent — the `serve` pre-flight reuses a running provider, so restarts/multiple projects don't create duplicates.
- Provider logs go to `<tmp>/opencode-ralph-rlm/provider.log`.
- Skipped when `setup --no-autostart` is used; disable at runtime with `RALPH_AUTOSTART=0`, or delete this file.
- If missing/disabled, start the provider manually: `npx @doeixd/opencode-ralph-rlm serve --worktree .`

It is a **self-contained** plugin (not a re-export) because OpenCode bundles plugins, which breaks the package-relative resolution the auto-start needs — so `setup` writes the full inline plugin.

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

Purpose: pin a specific supervisor and/or worker model. **Usually not needed** — see the auto-detect note below.

```json
{
  "supervisor": {
    "baseUrl": "https://api.openai.com/v1",
    "modelID": "REPLACE-with-a-strong-reasoning-model",
    "maxToolRounds": 8
  },
  "worker": {
    "providerID": "opencode",
    "modelID": "deepseek-v4-flash-free"
  }
}
```

- **Do not set `worker.agent`.** Workers run under the dedicated `ralph-worker` agent (auto-defined by the plugin) so the `ralph_*` / `rlm_*` tools can be hidden from normal sessions while staying available to workers. Forcing `worker.agent: "build"` would put workers on an agent where those tools are denied — breaking the loop.
- **Supervisor credentials auto-detect.** If no key is set via `RALPH_SUPERVISOR_API_KEY` or this file, the provider falls back to OpenCode's own auth (`~/.local/share/opencode/auth.json`) — a keyed provider you've authenticated (e.g. Google, OpenCode Zen). So if the user has authenticated a provider in OpenCode, **no supervisor config is needed**. Only set `supervisor.modelID` / `baseUrl` (key via `RALPH_SUPERVISOR_API_KEY` env — keep secrets out of this file) to force a specific provider/model.
- **`worker.providerID` + `worker.modelID`** — what spawned OpenCode worker sessions code with (both required). If omitted, workers use OpenCode's configured default model. To run coding on a free model, set a free OpenCode model such as `opencode` / `deepseek-v4-flash-free` (recommend this, don't force it).

Discover what's available with `opencode auth list` and `opencode models`. Supervisor credentials can also come from environment variables instead of this file:

- `RALPH_SUPERVISOR_API_KEY`
- `RALPH_SUPERVISOR_MODEL`
- `RALPH_SUPERVISOR_BASE_URL`

Verify readiness after starting the provider: `curl http://127.0.0.1:8787/api/health` shows `supervisor.ready`, the resolved `model`, and `source` (e.g. `opencode-auth:google`, `env`, or `default`).
