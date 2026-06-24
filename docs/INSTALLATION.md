# Installation

Ralph RLM can be installed three ways. Prefer the agent skill when you have an AI coding agent available; it handles project-specific choices like `verify.command`, existing OpenCode config, and whether to add Ralph notes to `AGENT.md` / `AGENTS.md`.

## Option 1 — Agent Skill (Recommended)

Install the setup skill with the skills CLI:

```bash
npx skills add doeixd/opencode-ralph-rlm
```

Then ask your AI agent:

```text
Use the setup-opencode-ralph-rlm skill to install Ralph RLM in this project.
```

The skill guides the agent to:

- inspect existing OpenCode and project config,
- run the Ralph setup CLI safely,
- review generated `.opencode` files,
- choose or adjust `verify.command`,
- ask whether to add Ralph notes to `AGENT.md`, `AGENTS.md`, or the configured `agentMdPath`,
- run diagnostics and explain the next steps.

Skill source:

```text
skills/setup-opencode-ralph-rlm/
├── SKILL.md
└── references/
    ├── agent-guidance.md
    ├── cli.md
    ├── config-files.md
    └── troubleshooting.md
```

## Option 2 — CLI Setup

Use this path when you want direct setup without an agent.

From your target project root:

```bash
npm install -D @doeixd/opencode-ralph-rlm
npx @doeixd/opencode-ralph-rlm setup --dry-run
npx @doeixd/opencode-ralph-rlm setup
```

The setup command creates or updates:

- `.opencode/plugins/ralph-worker.ts`
- `.opencode/plugins/ralph-session-bridge.ts`
- `.opencode/ralph.json`
- `opencode.json`

Existing managed files are skipped unless `--force` is passed.

The package includes optional native search acceleration via `@ff-labs/fff-node`. Normal npm installs include optional dependencies by default. If the native package cannot install or load on a platform, Ralph still works; worker `rlm_grep` falls back to the built-in TypeScript scan.

Review `.opencode/ralph.json` and make sure `verify.command` is the real stop condition for your project:

```json
{
  "verify": {
    "command": ["npm", "test"],
    "cwd": "."
  }
}
```

Run diagnostics:

```bash
npx @doeixd/opencode-ralph-rlm doctor --worktree .
```

Start the provider:

```bash
npx @doeixd/opencode-ralph-rlm serve --worktree .
```

Then open OpenCode and select `ralph-rlm/supervisor`.

## Option 3 — Manual Setup

Use this path when you need to review or vendor every file.

1. Install the package in the target project.

   ```bash
   npm install -D @doeixd/opencode-ralph-rlm
   ```

2. Create `.opencode/plugins/ralph-worker.ts`.

   ```ts
   export { RalphWorkerPlugin, RalphWorkerPlugin as default } from "@doeixd/opencode-ralph-rlm/worker-plugin";
   ```

3. Create `.opencode/plugins/ralph-session-bridge.ts`.

   Copy the implementation from this repository’s `.opencode/plugins/ralph-session-bridge.ts`. It injects `x-opencode-session-id` and `directory` into Ralph provider requests.

4. Create `.opencode/ralph.json`.

   ```json
   {
     "enabled": true,
     "maxAttempts": 20,
     "verifyTimeoutMinutes": 15,
     "verify": {
       "command": ["npm", "test"],
       "cwd": "."
     },
  "gateDestructiveToolsUntilContextLoaded": true,
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

5. Merge the provider into `opencode.json`.

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

6. Optionally add a short Ralph section to `AGENT.md` or `AGENTS.md`.

   Include the fact that `.opencode/ralph.json` owns `verify.command`, protocol files hold loop memory, and legacy v0.1 tools should not be used.

## Requirements

- End users need Node/npm for the CLI path.
- Optional FFF search acceleration is installed through npm optional dependencies. Set `RALPH_FFF_DISABLED=1` to disable it.
- Bun is only required for developing this repository itself.
- OpenCode must be available separately.
- Supervisor LLM credentials are supplied to the provider process:

  ```bash
  export RALPH_SUPERVISOR_API_KEY="..."
  export RALPH_SUPERVISOR_MODEL="gpt-5.4-mini"
  ```
