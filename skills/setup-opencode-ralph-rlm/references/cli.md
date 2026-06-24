# CLI Reference

Use the package through npm/npx unless the user is developing Ralph itself.

## Commands

```bash
npx @doeixd/opencode-ralph-rlm setup --worktree .
npx @doeixd/opencode-ralph-rlm doctor --worktree .
npx @doeixd/opencode-ralph-rlm serve --worktree .
```

Installed binary name:

```bash
opencode-ralph-rlm setup
opencode-ralph-rlm doctor
opencode-ralph-rlm serve
```

## Runtime helpers (provider running)

```bash
opencode-ralph-rlm sessions                     # list active loop sessions (and their ids)
opencode-ralph-rlm send-message -s <id> -m "…"  # inject an out-of-band message to the supervisor
opencode-ralph-rlm plan-path                     # print where the active plan's PLAN.md is read from
```

- `sessions` / `send-message` talk to the provider over HTTP (`--url`, default `http://127.0.0.1:8787`); `send-message` runs a supervisor turn unless `--no-run` is passed.
- `plan-path` reads config locally (no provider needed) and prints the worktree-relative `PLAN.md` path — useful for a planning skill/script that must write the plan where `start_loop` will detect it (named-plan layout puts it under `.ralph-rlm/plans/<name>/`).

## Setup Flags

- `--worktree <path>`: target repo; default is current directory.
- `--port <number>`: provider port for generated `opencode.json`; default `8787`.
- `--dry-run`: print planned file actions without writing files.
- `--force`: overwrite generated Ralph-managed files that already exist.
- `--provider-config`: also create `.opencode/ralph-provider.json`.

Expected setup output lists each file action:

```text
CREATED: .opencode/plugins/ralph-worker.ts
CREATED: .opencode/plugins/ralph-session-bridge.ts
CREATED: .opencode/ralph.json
UPDATED: opencode.json
```

`SKIPPED` is normal for existing managed files. Do not use `--force` unless the user wants generated Ralph files replaced.

## Runtime Requirements

End users should only need Node/npm for the package CLI. Bun is still used by this repository's development scripts unless the project later replaces those scripts.

The published CLI should be JavaScript because Node does not execute TypeScript files under `node_modules`. If a local source checkout is used directly, recent Node versions can execute simple `.ts` files with type stripping, but compiled JavaScript is the safer path for `npx`.
