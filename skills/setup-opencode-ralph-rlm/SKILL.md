---
name: setup-opencode-ralph-rlm
description: Set up Ralph RLM in an existing OpenCode project by installing the package, running the opencode-ralph-rlm setup command, checking generated .opencode config, and verifying the provider/worker loop wiring. Use when a user asks to install, configure, initialize, troubleshoot setup for, or add opencode-ralph-rlm / Ralph RLM to a repository.
---

# Setup OpenCode Ralph RLM

Use this skill to install Ralph RLM into a target repository and make it usable from OpenCode as the `ralph-rlm/supervisor` model.

## Workflow

1. Inspect the target repository.
   - Confirm the working directory is the project root.
   - Identify the package manager and test command from lockfiles and `package.json` scripts.
   - Check for existing `opencode.json`, `.opencode/ralph.json`, and `.opencode/plugins/`.
   - If the repo already has OpenCode or Ralph config, read [references/config-files.md](references/config-files.md) before editing.

2. Install the Ralph package if the project can accept a dev dependency.
   - Prefer the package manager already used by the repo.
   - Package name: `@doeixd/opencode-ralph-rlm`.
   - If the user only wants a one-time setup, use `npx @doeixd/opencode-ralph-rlm setup` instead.
   - Do not require Bun for end users; the published CLI is a Node binary.

3. Run setup from the project root.
   ```bash
   npx @doeixd/opencode-ralph-rlm setup --worktree .
   ```
   Use `--dry-run` first when the repo already has OpenCode config. Use `--force` only when the user explicitly wants generated Ralph files overwritten.
   See [references/cli.md](references/cli.md) for command flags and expected output.

4. Review generated files.
   - `.opencode/plugins/ralph-worker.ts` should re-export `@doeixd/opencode-ralph-rlm/worker-plugin`.
   - `.opencode/plugins/ralph-session-bridge.ts` should inject `x-opencode-session-id` and `directory`.
   - `.opencode/ralph.json` should have a realistic `verify.command`.
   - `.opencode/ralph.json` includes `plans: { dir: ".ralph-rlm/plans", active: "default" }` — the named-plan layout. Protocol files (`PLAN.md`, `RLM_INSTRUCTIONS.md`, …) will live under `.ralph-rlm/plans/<name>/`, not the repo root. `opencode-ralph-rlm plan-path` prints the active plan's `PLAN.md` location.
   - `.opencode/ralph.json` may include `fff.enabled` and `fff.scanTimeoutMs`; leave the defaults unless the project cannot load optional native dependencies.
   - `opencode.json` should preserve existing providers and include `provider["ralph-rlm"]`.

5. Adjust `verify.command` if auto-detection guessed poorly.
   - Bun projects usually use `["bun", "run", "test"]` or `["bun", "run", "verify"]`.
   - npm projects usually use `["npm", "test"]`.
   - Rust projects usually use `["cargo", "test"]`.
   - Python projects usually use `["python", "-m", "pytest"]`.

6. Ask whether to add Ralph guidance to the project agent instructions.
   - Look for `.opencode/ralph.json` `agentMdPath`, then `AGENT.md`, then `AGENTS.md`.
   - Ask the user before creating or editing the guidance file.
   - If they agree, append a short Ralph section; use [references/agent-guidance.md](references/agent-guidance.md) for wording.

7. Run diagnostics.
   ```bash
   npx @doeixd/opencode-ralph-rlm doctor --worktree .
   ```
   A provider warning is expected until the provider is running.
   For failures, read [references/troubleshooting.md](references/troubleshooting.md).

8. Choose models for the supervisor and the workers — **ask the user; do not silently accept the `gpt-4o-mini` default.**

   There are two separate model decisions:
   - **Supervisor** — the LLM the provider calls for orchestration turns (planning interview, tool routing, status summaries). Set on the **provider process** via `RALPH_SUPERVISOR_API_KEY` / `RALPH_SUPERVISOR_MODEL` / `RALPH_SUPERVISOR_BASE_URL`, or in `.opencode/ralph-provider.json` under `supervisor`. Any OpenAI-compatible endpoint works. Prefer a strong reasoning model — it plans and steers.
   - **Worker** — the model the spawned OpenCode worker sessions use to actually write code. Set in `.opencode/ralph-provider.json` under `worker.agent` / `worker.modelID`; if unset, workers use OpenCode's configured default. Prefer a capable coding model.

   Pick from what the user already has in OpenCode rather than guessing:
   - List authenticated providers/models: `opencode auth list`.
   - Inspect the project `opencode.json` and the global OpenCode config for configured `provider` / `model` entries.
   - Propose a sensible pair (strong model for supervisor, capable coding model for worker) and **confirm with the user**. If it is ambiguous which provider/model they want, ask.

   Then record the choices: export the supervisor env vars, and/or write `.opencode/ralph-provider.json` (`npx @doeixd/opencode-ralph-rlm setup --provider-config` scaffolds it — edit the placeholder model ids). See [references/config-files.md](references/config-files.md).

9. Start the provider, then **re-open OpenCode**.
   ```bash
   npx @doeixd/opencode-ralph-rlm serve --worktree .
   ```
   - OpenCode loads providers and plugins **at startup**, so the `ralph-rlm/supervisor` model and the `ralph-worker` / `ralph-session-bridge` plugins only become available after the OpenCode TUI is restarted. If OpenCode was already open during setup, tell the user to quit and re-open it.
   - Then select the **`ralph-rlm/supervisor`** model.

10. Suggest planning before the first loop.
   - A loop is only as good as its `PLAN.md`. Recommend planning the goal with the supervisor (it runs an interview before `start_loop`) or via the `interview-and-create-plan` skill, rather than delegating a one-line goal cold.

## Notes

- The setup command is intentionally conservative: it skips existing managed files unless `--force` is passed.
- `npx @doeixd/opencode-ralph-rlm ...` is the portable command. The binary installed by the package is named `opencode-ralph-rlm`.
- Worker search uses optional `@ff-labs/fff-node` acceleration when available. If it is unavailable, `rlm_grep` falls back automatically; set `RALPH_FFF_DISABLED=1` only when native search causes local issues.
- Node can run some `.ts` files directly in recent versions, but Node refuses TypeScript files under `node_modules`; the npm package should ship compiled JavaScript for the CLI.
- Do not hand-copy the legacy v0.1 plugin or tell users to call `ralph_spawn_worker`.
- For supervisor LLM credentials, prefer environment variables first:
  - `RALPH_SUPERVISOR_API_KEY`
  - `RALPH_SUPERVISOR_MODEL`
- Use `.opencode/ralph-provider.json` only when repo-local supervisor/worker defaults are needed.
