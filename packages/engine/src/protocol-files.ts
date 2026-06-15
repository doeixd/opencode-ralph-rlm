import { spawn } from "node:child_process";
import path from "node:path";
import {
  ensureTextFile,
  PatchError,
  removeFile,
  writeTextFile,
} from "./fs.js";
import { interpolate, nowISO } from "./text.js";
import type { EngineTemplates } from "./templates.js";

export const PROTOCOL_FILES = {
  PLAN: "PLAN.md",
  RLM_INSTR: "RLM_INSTRUCTIONS.md",
  NEXT_RALPH: "AGENT_CONTEXT_FOR_NEXT_RALPH.md",
  RLM_CTX: "CONTEXT_FOR_RLM.md",
  PREV: "PREVIOUS_STATE.md",
  CURR: "CURRENT_STATE.md",
  NOTES: "NOTES_AND_LEARNINGS.md",
  TODOS: "TODOS.md",
  SUPERVISOR_LOG: "SUPERVISOR_LOG.md",
  CONVERSATION: "CONVERSATION.md",
} as const;

export type ProtocolFileName = (typeof PROTOCOL_FILES)[keyof typeof PROTOCOL_FILES];

function joinWorktree(worktree: string, file: string): string {
  return path.join(worktree, file);
}

export async function bootstrapProtocolFiles(
  worktree: string,
  templates: EngineTemplates
): Promise<void> {
  const ts = nowISO();

  await Promise.all([
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.PLAN),
      interpolate(templates.bootstrapPlan, { timestamp: ts })
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.RLM_INSTR),
      interpolate(templates.bootstrapRlmInstructions, { timestamp: ts })
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.NEXT_RALPH),
      `# Next Ralph Context\n\n- ${ts} created\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.RLM_CTX),
      `# Context For RLM\n\n(paste large reference documents here; access via rlm_grep + rlm_slice)\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.PREV),
      `# Previous State\n\n(none yet)\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.CURR),
      templates.bootstrapCurrentState
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.NOTES),
      `# Notes and Learnings (append-only)\n\n- ${ts} created\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.TODOS),
      `# Todos\n\n- [ ] (optional)\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.SUPERVISOR_LOG),
      `# Supervisor Log (append-only)\n\n- ${ts} created\n`
    ),
    ensureTextFile(
      joinWorktree(worktree, PROTOCOL_FILES.CONVERSATION),
      `# Conversation Log (append-only)\n\n- ${ts} created\n`
    ),
  ]);
}

export async function applyPatch(
  worktree: string,
  patchText: string
): Promise<void> {
  const tmp = path.join(worktree, ".opencode", "tmp", `patch-${Date.now()}.diff`);

  try {
    await writeTextFile(tmp, patchText);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "git",
        ["-C", worktree, "apply", "--whitespace=nowarn", tmp],
        { windowsHide: true }
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => reject(new PatchError(String(err))));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new PatchError(stderr.trim() || `git apply exited ${code}`));
      });
    });
  } catch (err) {
    if (err instanceof PatchError) throw err;
    throw new PatchError(String(err));
  } finally {
    await removeFile(tmp);
  }
}