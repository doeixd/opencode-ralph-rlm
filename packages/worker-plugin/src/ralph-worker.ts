import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import path from "node:path";
import {
  PROTOCOL_FILES,
  appendTextFile,
  applyPatch,
  clampLines,
  extractHeadings,
  formatVerifyJson,
  loadConfig,
  nowISO,
  readLoopAttemptMarker,
  readPendingInput,
  readTextFile,
  regexFromQuery,
  runVerify,
  writePendingInput,
  type ResolvedConfig,
} from "@doeixd/opencode-ralph-rlm-engine";
import { shouldGateDestructiveTool } from "./gate.js";
import { freshWorkerSession, type WorkerSessionState } from "./session-state.js";
import { loadWorkerPluginTemplates } from "./templates.js";

export const RalphWorkerPlugin: Plugin = async ({ client, worktree }) => {
  const templates = await loadWorkerPluginTemplates(worktree);
  const sessionMap = new Map<string, WorkerSessionState>();

  let configCache: { value: ResolvedConfig; expiresAt: number } | null = null;
  async function getConfig(): Promise<ResolvedConfig> {
    const now = Date.now();
    if (configCache && now < configCache.expiresAt) return configCache.value;
    const value = await loadConfig(worktree);
    configCache = { value, expiresAt: now + 10_000 };
    return value;
  }

  function getSession(sessionID: string, attempt = 0): WorkerSessionState {
    if (!sessionMap.has(sessionID)) {
      sessionMap.set(sessionID, freshWorkerSession(attempt));
    }
    return sessionMap.get(sessionID)!;
  }

  async function syncSessionAttempt(sessionID: string, root: string): Promise<void> {
    const fromMarker = await readLoopAttemptMarker(root);
    if (fromMarker !== undefined) {
      getSession(sessionID).attempt = fromMarker;
    }
  }

  async function appendProgress(
    root: string,
    tag: string,
    message: string,
    level: "info" | "warning" | "error"
  ): Promise<void> {
    const line = `- ${nowISO()} [${level}] ${tag}: ${message}\n`;
    await appendTextFile(path.join(root, PROTOCOL_FILES.SUPERVISOR_LOG), line);
    await appendTextFile(path.join(root, PROTOCOL_FILES.CONVERSATION), line);
    const variant = level === "error" ? "error" : level === "warning" ? "warning" : "info";
    await client.tui
      .showToast({
        body: { title: `Ralph ${tag}`, message, variant },
      } as Parameters<typeof client.tui.showToast>[0])
      .catch(() => {});
  }

  const tool_ralph_load_context = tool({
    description:
      "Load authoritative loop context (PLAN, RLM_INSTRUCTIONS, prior attempt verdict, agent rules). MUST be first call every attempt — required before write/edit/bash.",
    args: {
      includeRlmContextHeadings: tool.schema.boolean().optional(),
      rlmHeadingsMax: tool.schema.number().int().min(1).max(200).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      await syncSessionAttempt(sessionID, root);
      const st = getSession(sessionID);
      st.loadedContext = true;

      const cfg = await getConfig();
      const j = (f: string) => path.join(root, f);

      const agentMdAbs = cfg.agentMdPath ? j(cfg.agentMdPath) : null;
      const [
        plan,
        rlmInstr,
        nextRalph,
        curr,
        prev,
        notes,
        todos,
        conversation,
        rlmRaw,
        agentMd,
      ] = await Promise.all([
        readTextFile(j(PROTOCOL_FILES.PLAN)).catch(() => "(missing — create PLAN.md)"),
        readTextFile(j(PROTOCOL_FILES.RLM_INSTR)).catch(
          () => "(missing — create RLM_INSTRUCTIONS.md)"
        ),
        readTextFile(j(PROTOCOL_FILES.NEXT_RALPH)).catch(() => "(none)"),
        readTextFile(j(PROTOCOL_FILES.CURR)).catch(() => "(empty)"),
        readTextFile(j(PROTOCOL_FILES.PREV)).catch(() => "(none yet)"),
        readTextFile(j(PROTOCOL_FILES.NOTES)).catch(() => "(empty)"),
        readTextFile(j(PROTOCOL_FILES.TODOS)).catch(() => "(empty)"),
        readTextFile(j(PROTOCOL_FILES.CONVERSATION)).catch(() => "(empty)"),
        readTextFile(j(PROTOCOL_FILES.RLM_CTX)).catch(() => ""),
        agentMdAbs
          ? readTextFile(agentMdAbs).catch(() => null as string | null)
          : Promise.resolve(null as string | null),
      ]);

      const useHeadings = args.includeRlmContextHeadings ?? true;
      const rlmContext = useHeadings
        ? extractHeadings(rlmRaw, args.rlmHeadingsMax ?? 80)
        : clampLines(rlmRaw, 200);

      const payload: Record<string, unknown> = {
        protocol_files: PROTOCOL_FILES,
        plan,
        rlm_instructions: rlmInstr,
        agent_context_for_next_ralph: nextRalph,
        current_state: curr,
        previous_state: prev,
        notes_and_learnings: clampLines(notes, 200),
        todos: clampLines(todos, 200),
        conversation_log: clampLines(conversation, 200),
        context_for_rlm: {
          path: PROTOCOL_FILES.RLM_CTX,
          headings: rlmContext,
          policy: "Use rlm_grep + rlm_slice to access this file. Never dump it fully.",
        },
        session: {
          attempt: st.attempt,
          loadedContext: st.loadedContext,
          role: "worker",
        },
      };

      if (agentMd !== null) {
        payload["agent_md"] = {
          path: cfg.agentMdPath,
          content: agentMd,
          note: "Static project rules from AGENT.md.",
        };
      }

      return JSON.stringify(payload, null, 2);
    },
  });

  const tool_rlm_grep = tool({
    description:
      "Regex search in CONTEXT_FOR_RLM.md (default) or another file. Use before rlm_slice — never paste large files whole.",
    args: {
      query: tool.schema.string(),
      file: tool.schema.string().optional(),
      maxMatches: tool.schema.number().int().min(1).max(200).optional(),
      contextLines: tool.schema.number().int().min(0).max(10).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const fileRel = args.file ?? PROTOCOL_FILES.RLM_CTX;
      const raw = await readTextFile(path.join(root, fileRel));
      const lines = raw.split(/\r?\n/);
      const re = regexFromQuery(args.query);
      const ctxLines = args.contextLines ?? 0;
      const maxM = args.maxMatches ?? 50;

      const matchedIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] ?? "")) {
          matchedIndices.push(i);
          if (matchedIndices.length >= maxM) break;
        }
      }

      const results = matchedIndices.map((i) => {
        const start = Math.max(0, i - ctxLines);
        const end = Math.min(lines.length - 1, i + ctxLines);
        return {
          matchLine: i + 1,
          matchText: lines[i] ?? "",
          context:
            ctxLines > 0
              ? lines.slice(start, end + 1).map((text, offset) => ({
                  line: start + offset + 1,
                  text,
                }))
              : undefined,
        };
      });

      const st = getSession(sessionID);
      st.lastGrepAt = Date.now();
      st.lastGrepQuery = args.query;

      return JSON.stringify({ file: fileRel, totalMatches: results.length, results }, null, 2);
    },
  });

  const tool_rlm_slice = tool({
    description:
      "Read a line-range slice of a file (1-indexed, inclusive). For large slices, run rlm_grep first.",
    args: {
      file: tool.schema.string().optional(),
      startLine: tool.schema.number().int().min(1),
      endLine: tool.schema.number().int().min(1),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const cfg = await getConfig();
      const st = getSession(sessionID);
      const fileRel = args.file ?? PROTOCOL_FILES.RLM_CTX;

      if (args.endLine < args.startLine) throw new Error("endLine must be >= startLine.");
      const span = args.endLine - args.startLine + 1;
      if (span > cfg.maxRlmSliceLines) {
        throw new Error(
          `Slice too large: ${span} lines. Max allowed: ${cfg.maxRlmSliceLines}.`
        );
      }
      if (cfg.requireGrepBeforeLargeSlice && span >= cfg.grepRequiredThresholdLines) {
        const recentGrep = st.lastGrepAt && Date.now() - st.lastGrepAt < 5 * 60 * 1000;
        if (!recentGrep) {
          throw new Error(
            `Slices >= ${cfg.grepRequiredThresholdLines} lines require a recent rlm_grep call first (within 5 min).`
          );
        }
      }

      const raw = await readTextFile(path.join(root, fileRel));
      const lines = raw.split(/\r?\n/);
      const slice = lines.slice(args.startLine - 1, args.endLine).join("\n");
      return JSON.stringify(
        {
          file: fileRel,
          startLine: args.startLine,
          endLine: args.endLine,
          totalFileLines: lines.length,
          text: slice,
        },
        null,
        2
      );
    },
  });

  const tool_ralph_verify = tool({
    description:
      "Run verify.command once at end of attempt (the loop exit gate). After calling, STOP — engine handles pass/fail and next attempt.",
    args: {},
    async execute(_args, ctx) {
      const root = ctx.worktree ?? worktree;
      const cfg = await getConfig();
      const result = await runVerify(root, cfg);
      return formatVerifyJson(result);
    },
  });

  const tool_ralph_report = tool({
    description:
      "Append supervisor-visible progress to SUPERVISOR_LOG.md and CONVERSATION.md. Call at start, milestones, and before ralph_verify.",
    args: {
      message: tool.schema.string(),
      level: tool.schema.enum(["info", "warning", "error"] as const).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      st.lastProgressAt = Date.now();
      const level = args.level ?? "info";
      const tag = `worker/attempt-${st.attempt}`;
      await appendProgress(root, tag, args.message, level);
      return `Reported: ${args.message}`;
    },
  });

  const tool_ralph_set_status = tool({
    description: "Set explicit attempt status for supervisor visibility.",
    args: {
      status: tool.schema.enum(["running", "blocked", "done", "error"] as const),
      note: tool.schema.string().optional(),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID ?? "default";
      const st = getSession(sessionID);
      st.reportedStatus = args.status;
      if (args.note !== undefined) {
        st.reportedStatusNote = args.note;
      } else {
        delete st.reportedStatusNote;
      }
      st.lastProgressAt = Date.now();
      const msg = args.note
        ? `Status set to ${args.status}: ${args.note}`
        : `Status set to ${args.status}.`;
      const root = ctx.worktree ?? worktree;
      const level: "info" | "warning" | "error" =
        args.status === "error" ? "error" : args.status === "blocked" ? "warning" : "info";
      await appendProgress(root, `worker/attempt-${st.attempt}`, msg, level);
      return JSON.stringify(
        { ok: true, attempt: st.attempt, status: args.status, note: args.note ?? null },
        null,
        2
      );
    },
  });

  const tool_ralph_update_plan = tool({
    description: "Update PLAN.md via unified diff patch.",
    args: {
      patch: tool.schema.string(),
      reason: tool.schema.string().min(3),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      if (!args.patch.includes("PLAN.md")) {
        throw new Error("Patch must target PLAN.md.");
      }
      await applyPatch(root, args.patch);
      await appendTextFile(
        path.join(root, PROTOCOL_FILES.PLAN),
        `\n- ${nowISO()} plan updated: ${args.reason}\n`
      );
      return "PLAN.md updated.";
    },
  });

  const tool_ralph_update_rlm_instructions = tool({
    description: "Update RLM_INSTRUCTIONS.md via unified diff patch.",
    args: {
      patch: tool.schema.string(),
      reason: tool.schema.string().min(3),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      if (!args.patch.includes("RLM_INSTRUCTIONS.md")) {
        throw new Error("Patch must target RLM_INSTRUCTIONS.md.");
      }
      await applyPatch(root, args.patch);
      await appendTextFile(
        path.join(root, PROTOCOL_FILES.RLM_INSTR),
        `\n- ${nowISO()} instructions updated: ${args.reason}\n`
      );
      return "RLM_INSTRUCTIONS.md updated.";
    },
  });

  const tool_ralph_ask = tool({
    description:
      "Blocking question for the supervisor (architecture/product choice). Use sparingly — polls pending_input until answered or timeout.",
    args: {
      question: tool.schema.string(),
      context: tool.schema.string().optional(),
      timeout_minutes: tool.schema.number().int().min(1).max(120).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const sessionID = ctx.sessionID ?? "default";
      await syncSessionAttempt(sessionID, root);
      const st = getSession(sessionID);
      const id = `ask-${Date.now()}`;
      const timeoutMinutes = args.timeout_minutes ?? 15;

      const data = await readPendingInput(root);
      const questions = data.questions ?? [];
      questions.push({
        id,
        from: "worker",
        attempt: st.attempt,
        question: args.question,
        ...(args.context ? { context: args.context } : {}),
        askedAt: nowISO(),
      });
      await writePendingInput(root, { ...data, questions, updatedAt: nowISO() });
      await appendProgress(
        root,
        `worker/attempt-${st.attempt}`,
        `Question (${id}): ${args.question}`,
        "warning"
      );

      const deadline = Date.now() + timeoutMinutes * 60_000;
      const maxPolls = Math.max(1, timeoutMinutes * 30);
      let polls = 0;
      while (Date.now() < deadline && polls < maxPolls) {
        polls += 1;
        const latest = await readPendingInput(root);
        const answer = latest.answers?.find((a) => a.id === id);
        if (answer) {
          return JSON.stringify({ ok: true, id, answer: answer.answer }, null, 2);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      throw new Error(`ralph_ask timeout: no response after ${timeoutMinutes} minutes (ID: ${id})`);
    },
  });

  return {
    tool: {
      ralph_load_context: tool_ralph_load_context,
      rlm_grep: tool_rlm_grep,
      rlm_slice: tool_rlm_slice,
      ralph_verify: tool_ralph_verify,
      ralph_report: tool_ralph_report,
      ralph_set_status: tool_ralph_set_status,
      ralph_update_plan: tool_ralph_update_plan,
      ralph_update_rlm_instructions: tool_ralph_update_rlm_instructions,
      ralph_ask: tool_ralph_ask,
    },

    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system?: string[] }) => {
      output.system = output.system ?? [];
      output.system.push(templates.workerSystemPrompt);
      const sessionID = input.sessionID;
      if (sessionID) {
        await syncSessionAttempt(sessionID, worktree);
      }
    },

    "experimental.session.compacting": async (_input: unknown, output: { context?: string[] }) => {
      output.context = output.context ?? [];
      output.context.push(templates.compactionContext);
    },

    "tool.execute.before": async (input: { sessionID?: string; tool?: string; call?: { name?: string } }) => {
      const cfg = await getConfig();
      const sessionID = input.sessionID;
      if (!sessionID) return;

      await syncSessionAttempt(sessionID, worktree);
      const st = getSession(sessionID);
      const toolName = input.tool ?? input.call?.name ?? "";
      if (
        shouldGateDestructiveTool({
          gateEnabled: cfg.gateDestructiveToolsUntilContextLoaded,
          loadedContext: st.loadedContext,
          toolName,
        })
      ) {
        throw new Error(templates.contextGateError);
      }
    },
  };
};