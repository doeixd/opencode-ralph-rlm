import { DEFAULT_TEMPLATES, readTextFile } from "@doeixd/opencode-ralph-rlm/engine";
import path from "node:path";

export type WorkerPluginTemplates = {
  contextGateError: string;
  compactionContext: string;
  workerSystemPrompt: string;
};

const DEFAULTS: WorkerPluginTemplates = {
  contextGateError:
    "File-first rule: call ralph_load_context() before write / edit / bash. It loads PLAN.md, RLM_INSTRUCTIONS.md, and attempt context.",

  compactionContext: [
    "## Ralph file-first protocol (reload after compaction)",
    "",
    "### Authority (read via ralph_load_context)",
    "- ralph_load_context returns plan_dir + a protocol_paths map; protocol files may live under .ralph-rlm/plans/<name>/, not the repo root — edit them at those paths.",
    "- PLAN.md — goal, definition of done, milestones",
    "- RLM_INSTRUCTIONS.md — playbooks for this repo",
    "- AGENT_CONTEXT_FOR_NEXT_RALPH.md — prior attempt verdict + next step",
    "- CURRENT_STATE.md — scratch for this attempt only",
    "- PREVIOUS_STATE.md — snapshot of last attempt scratch",
    "- NOTES_AND_LEARNINGS.md — curated durable knowledge (edit/prune freely; link to domain glossary / ADRs / design docs)",
    "- CONVERSATION.md / SUPERVISOR_LOG.md — progress feed",
    "- CONTEXT_FOR_RLM.md — large reference; rlm_grep + rlm_slice only",
    "- Worktree discovery — use rlm_file_search or rlm_glob before broad reads",
    "",
    "### Worker lifecycle (one pass)",
    "ralph_load_context → ralph_report(plan) → implement → ralph_verify() → STOP",
    "",
    "### Role",
    "You are the RLM worker (implementer). Not the supervisor. Orchestration runs in ralph-rlm/supervisor provider.",
  ].join("\n"),

  workerSystemPrompt: DEFAULT_TEMPLATES.workerSystemPrompt,
};

async function resolveEnvVar(raw: string, worktree: string): Promise<string> {
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    const abs = path.isAbsolute(filePath) ? filePath : path.join(worktree, filePath);
    return readTextFile(abs);
  }
  return raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export async function loadWorkerPluginTemplates(
  worktree: string
): Promise<WorkerPluginTemplates> {
  const env = process.env;

  async function pick(key: string, fallback: string): Promise<string> {
    const raw = env[key];
    if (!raw) return fallback;
    try {
      return await resolveEnvVar(raw, worktree);
    } catch {
      return fallback;
    }
  }

  const [contextGateError, compactionContext, workerSystemPrompt] = await Promise.all([
    pick("RALPH_CONTEXT_GATE_ERROR", DEFAULTS.contextGateError),
    pick("RALPH_COMPACTION_CONTEXT", DEFAULTS.compactionContext),
    pick("RALPH_WORKER_SYSTEM_PROMPT", DEFAULTS.workerSystemPrompt),
  ]);

  return { contextGateError, compactionContext, workerSystemPrompt };
}
