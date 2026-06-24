# Troubleshooting

## `doctor` says provider is unreachable

This is expected before `serve` is running.

Start the provider:

```bash
npx @doeixd/opencode-ralph-rlm serve --worktree .
```

If using a non-default port, pass the same port to setup, serve, and doctor:

```bash
npx @doeixd/opencode-ralph-rlm setup --port 8788
npx @doeixd/opencode-ralph-rlm serve --port 8788 --worktree .
npx @doeixd/opencode-ralph-rlm doctor --port 8788 --worktree .
```

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
export RALPH_SUPERVISOR_MODEL="gpt-4o-mini"
```

For smoke tests without an external LLM:

```bash
RALPH_TEST_MODE=1 npx @doeixd/opencode-ralph-rlm serve --worktree .
```
