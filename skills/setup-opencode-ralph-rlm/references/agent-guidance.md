# Agent Guidance

Ask the user before editing project-level agent instructions. Do not silently create or modify `AGENT.md`, `AGENTS.md`, or a custom file from `.opencode/ralph.json` `agentMdPath`.

## File Selection

Use this priority:

1. `.opencode/ralph.json` `agentMdPath`, if present.
2. Existing `AGENT.md`.
3. Existing `AGENTS.md`.
4. Ask whether to create `AGENT.md`.

If both `AGENT.md` and `AGENTS.md` exist, ask which one should receive Ralph guidance.

## Suggested Question

Ask:

```text
Do you want me to add a short Ralph RLM section to the project agent instructions so future agents understand the loop files and setup?
```

If the user declines, continue without editing agent instructions.

## Suggested Section

Append or merge a section like this, preserving the existing file's style:

```markdown
## Ralph RLM

- Ralph RLM is configured through `ralph.json` (`.ralph-rlm/ralph.json` or `.opencode/ralph.json`); `verify.command` is the authoritative stop condition for loop completion.
- Use `opencode-ralph-rlm serve --worktree .` to start the local provider, then select `ralph-rlm/supervisor` in OpenCode.
- Loop memory lives in protocol files in the active plan directory — `.ralph-rlm/plans/<name>/` in the named-plan layout (run `opencode-ralph-rlm plan-path` to locate the active plan), or the repo root in the legacy layout: `PLAN.md`, `RLM_INSTRUCTIONS.md`, `CURRENT_STATE.md`, `PREVIOUS_STATE.md`, `AGENT_CONTEXT_FOR_NEXT_RALPH.md`, `NOTES_AND_LEARNINGS.md`, `SUPERVISOR_LOG.md`, and `CONVERSATION.md`.
- Plan with the supervisor (or the `interview-and-create-plan` skill) before starting a loop so `PLAN.md` has a real goal and definition of done, not a placeholder.
- Static project rules belong in this agent instructions file. Attempt strategy belongs in `PLAN.md` and `RLM_INSTRUCTIONS.md` (which workers edit via `ralph_update_plan` / `ralph_update_rlm_instructions`).
- Do not use legacy v0.1 tools such as `ralph_spawn_worker` or `ralph_create_supervisor_session`.
```

## Merge Rules

- If a Ralph/RLM section already exists, update it instead of appending a duplicate.
- Keep project-specific conventions already present in the file.
- Do not paste long README content into agent instructions.
- If the repo uses a custom `agentMdPath`, make sure `.opencode/ralph.json` points at that same file.
