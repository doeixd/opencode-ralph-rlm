# Project Agent Rules

## Scope
- v0.2 monorepo: `packages/engine`, `packages/provider`, `packages/worker-plugin`
- Worker plugin entry: `.opencode/plugins/ralph-worker.ts`
- Legacy v0.1 plugin (deprecated): `.opencode/plugins-legacy/ralph-rlm.ts`

## Source of truth
- Loop + swarm logic: `packages/engine/src/`
- Provider + supervisor tools: `packages/provider/server/`
- Worker plugin: `packages/worker-plugin/src/`
- User-facing docs: `README.md`, `docs/GETTINGSTARTEDGUIDE.md`, `docs/MIGRATION.md`
- Architecture / milestones: `docs/REVISION_PLAN.md`
- Publish metadata/scripts: `package.json` (root + `packages/*`)
- Loop config example: `.opencode/ralph.json`

## Build and verify
- Install dependencies with `bun install` (Bun workspaces: `packages/*`).
- Typecheck with `bun run typecheck`.
- Build all packages with `bun run build` (`engine` + `provider` + `worker-plugin` + legacy plugin bundle).
- Start supervisor provider: `bun run ralph-serve` (Nitro on `:8787`).
- Preferred verification for this repo: `bun run bin/verify.ts` (or `bun run verify` where supported).

## Coding guidelines
- Use strict TypeScript patterns (narrow types, explicit unions, safe defaults).
- Keep loop/swarm behavior deterministic and file-first; avoid hidden state outside protocol files.
- Preserve backward compatibility for `.opencode/ralph.json` config keys unless a breaking change is explicitly requested.
- Prefer small, targeted edits over broad refactors.
- Supervisor tools mutate state via engine/registry — not raw SDK calls in the Nitro process for swarm scripts except via subprocess runner.

## Docs guidelines
- If behavior changes, update `README.md` and `docs/GETTINGSTARTEDGUIDE.md` in the same change.
- Breaking UX changes require `docs/MIGRATION.md` and `CHANGELOG.md` entries.
- Keep examples copy-pasteable and aligned with actual scripts/config.

## Ralph / RLM workflow note
- In this repository, AGENTS.md contains static project guidance.
- Loop-specific and attempt-specific strategy belongs in `RLM_INSTRUCTIONS.md`, `PLAN.md`, `CURRENT_STATE.md`, and `NOTES_AND_LEARNINGS.md`.