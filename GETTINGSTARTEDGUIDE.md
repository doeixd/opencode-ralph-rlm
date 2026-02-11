# Ralph-RLM Getting Started Guide

This guide gets you from zero to a working Ralph + RLM loop quickly.

## 1) Install and verify plugin load

- Put the plugin at `.opencode/plugins/ralph-rlm.ts` (project) or `~/.config/opencode/plugins/` (global).
- Start OpenCode in your repo.
- Ensure `.opencode/ralph.json` exists (or run doctor in step 2).

## 2) Bootstrap setup

Run:

`ralph_doctor(autofix=true)`

This creates missing baseline files/config and checks readiness.

## 3) Create a real plan

Fast path (recommended):

`ralph_quickstart_wizard(goal, requirements, stopping_conditions, features, steps, todos, start_loop=false)`

Manual path:

- `ralph_bootstrap_plan(...)`
- `ralph_validate_plan()`

Tip: put clear stopping conditions in the plan and a strong `verify.command` in `.opencode/ralph.json`.

## 4) Start supervision

Default is manual start (`autoStartOnMainIdle: false`):

`ralph_create_supervisor_session(start_loop=true)`

Check status anytime:

`ralph_supervision_status()`

## 4.5) Use the included agent profiles (recommended)

This repo includes project-local OpenCode agent profiles in `.opencode/agents/`:

- `supervisor` (primary): safe orchestration posture for Ralph loop control
- `ralph-reviewer` (subagent): read-only quality review
- `docs-writer` (subagent): documentation edits without shell access
- `security-auditor` (subagent): read-only security-focused review

Use these to control behavior and delegation while keeping loop execution in the plugin.

## 5) Monitor progress

- Structured feed: `SUPERVISOR_LOG.md`
- Human-readable timeline: `CONVERSATION.md`
- Session questions: use `ralph_respond(id, answer)` when prompted by `ralph_ask()`

## 6) Control loop lifecycle

- Pause without ending: `ralph_pause_supervision(reason?)`
- Resume: `ralph_resume_supervision(start_loop?)`
- Hard stop: `ralph_end_supervision(reason?, clear_binding?)`
- Restart after stop/done: `ralph_create_supervisor_session(restart_if_done=true)`

## 7) Optional reviewer flow (gated)

To avoid running reviewer too often:

1. Worker signals readiness: `ralph_request_review("ready for review")`
2. Supervisor runs reviewer: `ralph_run_reviewer()`
3. Report is written to `.opencode/reviews/review-attempt-N.md`

Reviewer limits are controlled by:

- `reviewerRequireExplicitReady`
- `reviewerMaxRunsPerAttempt`
- `reviewerEnabled`

Reviewer runtime state persists in `.opencode/reviewer_state.json`.

## 8) Recommended baseline config

```json
{
  "enabled": true,
  "autoStartOnMainIdle": false,
  "statusVerbosity": "normal",
  "maxAttempts": 25,
  "heartbeatMinutes": 15,
  "verify": { "command": ["bun", "run", "verify"], "cwd": "." },
  "gateDestructiveToolsUntilContextLoaded": true,
  "maxRlmSliceLines": 200,
  "requireGrepBeforeLargeSlice": true,
  "grepRequiredThresholdLines": 120,
  "subAgentEnabled": true,
  "maxSubAgents": 5,
  "maxConversationLines": 1200,
  "conversationArchiveCount": 3,
  "reviewerEnabled": false,
  "reviewerRequireExplicitReady": true,
  "reviewerMaxRunsPerAttempt": 1,
  "reviewerOutputDir": ".opencode/reviews",
  "reviewerPostToConversation": true,
  "agentMdPath": "AGENT.md"
}
```

## 9) Troubleshooting

- `ralph_spawn_worker() can only be called from a Ralph strategist session`
  - Expected in main session. Start with `ralph_create_supervisor_session()` and let strategist spawn workers.
- Loop not starting
  - Check `ralph_supervision_status()` and run `ralph_doctor(autofix=true)`.
- Verify always failing
  - Fix `verify.command` to match your repo’s actual quality gate.
- Too much log noise
  - Lower `statusVerbosity` or reduce loop chatter by using milestone-level `ralph_report` only.

---

For full reference, see `README.md`.
