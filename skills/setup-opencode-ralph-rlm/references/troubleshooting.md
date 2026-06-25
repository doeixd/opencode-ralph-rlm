# Troubleshooting

## `doctor` says provider is unreachable

Expected before the provider is running. With the auto-start plugin, opening OpenCode launches it; check `<tmp>/opencode-ralph-rlm/provider.log` and `curl http://127.0.0.1:8787/api/health`.

If it never comes up automatically: the auto-start plugin needs **`node` on PATH** (it silently no-ops otherwise), may be disabled (`RALPH_AUTOSTART=0` or `setup --no-autostart`), or OpenCode hasn't been restarted since setup. Start it manually:

```bash
npx @doeixd/opencode-ralph-rlm serve --worktree .
```

**"Cannot reach the server" in the OpenCode TUI (Windows especially):** Node/undici can time out connecting to the IPv4 literal `127.0.0.1` while `localhost` resolves fine. Setup now registers the provider at `http://localhost:<port>/v1` and the provider reaches OpenCode via `localhost`. If your `opencode.json` still has `http://127.0.0.1:8787/v1` from an older install, refresh it: `npx @doeixd/opencode-ralph-rlm setup --force` (then restart OpenCode).

If using a non-default port, pass the same port to setup, serve, and doctor:

```bash
npx @doeixd/opencode-ralph-rlm setup --port 8788
npx @doeixd/opencode-ralph-rlm serve --port 8788 --worktree .
npx @doeixd/opencode-ralph-rlm doctor --port 8788 --worktree .
```

## `serve` says a provider is already running / behaves like an old version

A long-running provider does **not** pick up new code after an update. `serve` pre-flight-checks the port and refuses to start a duplicate, printing the running version vs. the one you're starting:

```
[ralph] A Ralph provider is already running on port 8787 (version 0.3.0).
[ralph] You are starting version 0.3.4 ... stop the old one first, then re-run serve.
```

Fix: stop the old provider process (or free the port), then re-run `serve`. Confirm the live version with `curl http://127.0.0.1:8787/api/health` (the `version` field). If features added in a newer release (e.g. supervisor credential auto-detect) seem missing, you're almost certainly talking to a stale provider — restart it.

## OpenCode cannot find `ralph-rlm/supervisor`

Check `opencode.json` and confirm `provider["ralph-rlm"]` exists. Re-run:

```bash
npx @doeixd/opencode-ralph-rlm setup --dry-run
```

If the provider entry is missing and the dry run looks right, run setup without `--dry-run`.

## Anonymous session or shared loop

Confirm `.opencode/plugins/ralph-session-bridge.ts` exists and OpenCode loads project plugins.

Start provider with debug logging:

```bash
RALPH_SESSION_DEBUG=1 npx @doeixd/opencode-ralph-rlm serve --worktree .
```

After sending a supervisor message, expected session source is `header:x-opencode-session-id`, not `anonymous`.

## Worker lacks Ralph tools

Confirm `.opencode/plugins/ralph-worker.ts` exists and imports `@doeixd/opencode-ralph-rlm/worker-plugin`.

If the target project does not have the package installed locally, install it as a dev dependency or rely on the published package's setup flow and ensure OpenCode can resolve the package from the project.

Expected worker tools include `ralph_load_context`, `rlm_file_search`, `rlm_glob`, `rlm_grep`, `rlm_slice`, `ralph_report`, `ralph_verify`, and `ralph_ask`.

## Worker doesn't code / writes a plan or stops the loop instead

The worker must run a real coding model. If `worker.providerID` / `worker.modelID` aren't set in `.opencode/ralph-provider.json`, OpenCode may default the worker to the **`ralph-rlm/supervisor`** model — turning the worker session into a second supervisor that orchestrates (calls `write_plan`, `stop_loop`, etc.) instead of writing code. Symptoms: attempts run but nothing changes, a hallucinated plan replaces yours, or the loop stops with an odd reason.

Fix: set a coding model in `.opencode/ralph-provider.json`:

```json
{ "worker": { "providerID": "opencode", "modelID": "deepseek-v4-flash-free" } }
```

Ralph refuses to spawn a worker explicitly pointed at the `ralph-rlm` provider, and logs a warning when no worker model is configured.

## FFF search acceleration is unavailable

This is non-fatal. `rlm_grep` falls back to Ralph's built-in TypeScript scan.

Check whether optional dependencies were installed:

```bash
npm install
npm ls @ff-labs/fff-node
```

If native search causes problems in the target environment, disable it:

```bash
RALPH_FFF_DISABLED=1 npx @doeixd/opencode-ralph-rlm serve --worktree .
```

## Verify always fails or never stops

Inspect `.opencode/ralph.json`.

The `verify.command` should be the real project quality gate. Common examples:

```json
{ "verify": { "command": ["npm", "test"], "cwd": "." } }
{ "verify": { "command": ["pnpm", "test"], "cwd": "." } }
{ "verify": { "command": ["bun", "run", "verify"], "cwd": "." } }
{ "verify": { "command": ["cargo", "test"], "cwd": "." } }
{ "verify": { "command": ["python", "-m", "pytest"], "cwd": "." } }
```

Run the command manually from the same `cwd` before blaming Ralph.

## `doctor` says "Missing PLAN.md" / can't find protocol files

With the named-plan layout, protocol files live under `.ralph-rlm/plans/<name>/`, not the repo root. A fresh install has no `PLAN.md` until you plan (the supervisor's interview or the `interview-and-create-plan` skill) or run `start_loop` (which bootstraps it). Locate the active plan's file with:

```bash
opencode-ralph-rlm plan-path --worktree .
```

## Missing supervisor API key

Set provider-process environment variables:

```bash
export RALPH_SUPERVISOR_API_KEY="..."
export RALPH_SUPERVISOR_MODEL="gpt-5.4-mini"
```

For smoke tests without an external LLM:

```bash
RALPH_TEST_MODE=1 npx @doeixd/opencode-ralph-rlm serve --worktree .
```
