---
name: interview-and-create-plan
description: Before starting a Ralph RLM loop, interview the user to sharpen the goal, stress-test the design, and write an authored PLAN.md (goal, definition of done, milestones, open questions, invariants) that the loop can follow. Use when a user wants to plan, scope, or stress-test work before delegating it to the supervisor / start_loop, or whenever PLAN.md is still the placeholder bootstrap.
---

# Interview and Create Plan

A strong loop depends on a strong plan. The Ralph RLM loop spends real time and money per attempt, and every worker inherits `PLAN.md` as authority over chat history. This skill produces that plan: a bullet-proof, easily-followed `PLAN.md` the loop can run against — created *with* the user, not guessed.

The output is an **authored `PLAN.md`** in the active plan directory (run `opencode-ralph-rlm plan-path` to get the exact location — it is `.ralph-rlm/plans/<active>/PLAN.md` in the named-plan layout, or the repo root in legacy mode). Once it exists (and no longer contains the bootstrap placeholder), `start_loop` skips re-bootstrapping and launches attempt 1 directly against it.

Do not rush to write. The interview and the design discussion are the point. Reach an agreed goal and an agreed shape *before* writing anything.

## Process

### 1. Understand

Make sure you understand what is going on and what the user actually wants.

- Explore the repo to understand the current state of the codebase, if you haven't already.
- Use the project's domain glossary / vocabulary if present, and keep using it throughout.
- Interview the user relentlessly about the plan or design. The goal is to stress-test the idea before any code is written.

#### Interview tactics

- **Challenge previous uses of terms.** When the user uses a term that conflicts with the existing language, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"
- **Sharpen fuzzy language.** When the user uses a vague or overloaded term, propose a precise canonical one. "You're saying 'account' — do you mean the Customer or the User? Those are different things."
- **Discuss concrete scenarios.** When domain relationships come up, stress-test them with specific scenarios. Invent edge cases that force the user to be precise about the boundaries between concepts.
- **Cross-reference with code.** When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"
- **Discuss the domain itself** — the fundamental meanings of words; the types / primitives relevant to the plan; their interactions, invariants, and implications.
- **Ask about success criteria.** What does success look like? What is the ultimate goal? How will we know it's done? (This becomes the Definition of Done — and should align with the loop's `verify.command`.)

### 2. Sketch

Sketch the seams at which you will test the feature.

- Prefer existing seams to new ones. Use the highest seam possible.
- If new seams are needed, propose them at the highest point you can.
- The fewer seams across the codebase, the better — the ideal number is one.

Present possible solutions to the user for review and guidance — especially around interaction, success, invariants, specific important technical decisions, and API-design taste.

Make sure you can clearly state the goals and the proposed solutions, and that the user agrees with you on them.

Present the general shape — solutions, milestones, decisions — so the user understands and agrees.

**Do NOT include specific file paths or code snippets.** They go stale quickly and the loop will re-discover them. Describe shape and intent, not line numbers.

### 3. Plan

After exploration and discussion, write the plan.

- Lead with the high-level goals and the domain information.
- Follow with a step-by-step plan: milestones, open questions, success criteria, invariants, resources, decisions/quotes from the user, blockers, and important notes/details.
- It should be bullet-proof and easy to follow / implement.

Write the plan to the path the loop reads `PLAN.md` from. **Do not assume the repo root** — with the named-plan layout it lives under `.ralph-rlm/plans/<active>/PLAN.md`. Get the exact path by running:

```bash
opencode-ralph-rlm plan-path
```

Write your `PLAN.md` to that path. Keep the headings the loop expects — at minimum `## Goal`, `## Definition of Done`, and `## Milestones` — and add `## Open Questions`, `## Invariants`, `## Decisions`, and `## Notes` as needed.

### 4. Verify command (the loop's stop condition)

`verify.command` in `ralph.json` is the **single** thing that tells the loop it's done — it runs after every attempt and exit 0 = success. The plan is only as good as this command, so develop it deliberately *with the user*:

- It must actually test the goal — not just `exit 0`, a no-op, or a build that passes regardless of the feature. Tie it to the Definition of Done.
- It must be **deterministic** and reasonably fast (it runs every attempt).
- Crucially, it should **fail right now**, before the work is done — run it and confirm a red baseline. A command that already passes means the loop would "succeed" immediately and do nothing.

Set it in `ralph.json` (e.g. `"verify": { "command": ["npm","test"], "cwd": "." }` — use `["bash","-c","…"]` to chain steps), then run it once to confirm it fails for the right reason. Sharpen until it genuinely captures "done."

### 5. Review

Review the plan with the user: details, specifics, order, success criteria.

Loop until they are satisfied. Treat disagreement as a signal the interview wasn't finished — go back and sharpen.

### 6. Write final plan

Write the final, agreed `PLAN.md` (to the `opencode-ralph-rlm plan-path` location).

- Confirm it no longer contains the bootstrap placeholder text.
- Confirm the Definition of Done is consistent with `ralph.json`'s `verify.command` — that command is the loop's single source of truth for "done."
- Tell the user the plan is ready: switch to the `ralph-rlm/supervisor` model and say "go" (or "start the loop"). The supervisor will detect the authored plan and start attempt 1 without overwriting it.

## Handoff to the loop

| Produced here | Consumed by |
|---------------|-------------|
| `PLAN.md` (goal, definition of done, milestones, invariants) | Every worker attempt — authority over chat history |
| Agreed success criteria | Should match `verify.command` in `ralph.json` |
| Open questions / decisions | The supervisor and workers; update via `update_plan` as they resolve |

`RLM_INSTRUCTIONS.md` (worker playbooks) is created by the loop's bootstrap and is separate from `PLAN.md`. Steer *what* to build in `PLAN.md`; steer *how workers operate* in `RLM_INSTRUCTIONS.md`.
