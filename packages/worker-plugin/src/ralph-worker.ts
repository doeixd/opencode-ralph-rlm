import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import path from "node:path";
import {
  PROTOCOL_FILES,
  appendTextFile,
  applyProtocolPatch,
  clampLines,
  extractHeadings,
  fffFileSearch,
  fffGlob,
  fffGrep,
  formatVerifyJson,
  loadConfig,
  nowISO,
  protocolFilePath,
  RALPH_WORKER_AGENT,
  readLoopAttemptMarker,
  readPendingInput,
  readTextFile,
  regexFromQuery,
  resolvePlanContext,
  runVerify,
  writePendingInput,
  type NormalizedGrepResult,
  type PlanContext,
  type ResolvedConfig,
} from "@doeixd/opencode-ralph-rlm/engine";
import { SAFE_TOOLS, shouldGateDestructiveTool } from "./gate.js";
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

  /** Resolve the active plan context for a worktree root (active-plan aware). */
  async function getPlanCtx(root: string): Promise<PlanContext> {
    const cfg = await getConfig();
    return resolvePlanContext(root, cfg.plans);
  }

  // This plugin loads for EVERY session in the project. Ralph behavior (worker
  // system prompt, the edit/bash context gate, compaction context, and the
  // ralph_/rlm_ tools) must only apply to Ralph worker sessions — never to a
  // user's normal OpenCode sessions. Worker sessions are titled
  // `rlm-worker-attempt-N` by the engine; we scope by that title.
  const workerSessionCache = new Map<string, boolean>();
  async function isRalphWorkerSession(sessionID: string): Promise<boolean> {
    const cached = workerSessionCache.get(sessionID);
    if (cached !== undefined) return cached;
    try {
      const res = await client.session.get({
        path: { id: sessionID },
        query: { directory: worktree },
      });
      const title = ((res as { data?: { title?: string } })?.data?.title ?? "") as string;
      const isWorker = title.startsWith("rlm-worker-attempt-");
      workerSessionCache.set(sessionID, isWorker); // cache only confirmed results
      return isWorker;
    } catch {
      // Transient failure — don't cache; retry on the next call.
      return false;
    }
  }

  /** Worktree-relative path to CONTEXT_FOR_RLM.md for the active plan. */
  function rlmCtxRel(pctx: PlanContext): string {
    return pctx.protocolRel
      ? `${pctx.protocolRel}/${PROTOCOL_FILES.RLM_CTX}`
      : PROTOCOL_FILES.RLM_CTX;
  }

  function getSession(sessionID: string, attempt = 0): WorkerSessionState {
    if (!sessionMap.has(sessionID)) {
      sessionMap.set(sessionID, freshWorkerSession(attempt));
    }
    return sessionMap.get(sessionID)!;
  }

  async function syncSessionAttempt(sessionID: string, root: string): Promise<void> {
    const fromMarker = await readLoopAttemptMarker(await getPlanCtx(root));
    if (fromMarker !== undefined) {
      getSession(sessionID).attempt = fromMarker;
    }
  }

  async function grepFileFallback(input: {
    root: string;
    fileRel: string;
    query: string;
    maxMatches: number;
    contextLines: number;
  }): Promise<{
    file: string;
    totalMatches: number;
    accelerated: false;
    fallbackReason?: string;
    results: Array<{
      matchLine: number;
      matchText: string;
      context?: Array<{ line: number; text: string }>;
    }>;
  }> {
    const raw = await readTextFile(path.join(input.root, input.fileRel));
    const lines = raw.split(/\r?\n/);
    const re = regexFromQuery(input.query);

    const matchedIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i] ?? "")) {
        matchedIndices.push(i);
        if (matchedIndices.length >= input.maxMatches) break;
      }
    }

    const results = matchedIndices.map((i) => {
      const start = Math.max(0, i - input.contextLines);
      const end = Math.min(lines.length - 1, i + input.contextLines);
      const result: {
        matchLine: number;
        matchText: string;
        context?: Array<{ line: number; text: string }>;
      } = {
        matchLine: i + 1,
        matchText: lines[i] ?? "",
      };
      if (input.contextLines > 0) {
        result.context = lines.slice(start, end + 1).map((text, offset) => ({
          line: start + offset + 1,
          text,
        }));
      }
      return result;
    });

    return { file: input.fileRel, totalMatches: results.length, accelerated: false, results };
  }

  function grepMatchesTargetFile(result: NormalizedGrepResult, fileRel: string): boolean {
    // FFF may return OS-native separators; compare on forward slashes so the
    // accelerated path is used in named-plan mode on Windows too.
    const target = fileRel.split(/[\\/]/).join("/");
    return (
      result.ok &&
      result.results.length > 0 &&
      result.results.every((match) => match.file.split(/[\\/]/).join("/") === target)
    );
  }

  async function appendProgress(
    root: string,
    tag: string,
    message: string,
    level: "info" | "warning" | "error"
  ): Promise<void> {
    const line = `- ${nowISO()} [${level}] ${tag}: ${message}\n`;
    const pctx = await getPlanCtx(root);
    await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.SUPERVISOR_LOG), line);
    await appendTextFile(protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION), line);
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
      const pctx = await getPlanCtx(root);
      const jp = (f: string) => protocolFilePath(pctx, f);
      const agentMdAbs = cfg.agentMdPath ? path.join(root, cfg.agentMdPath) : null;
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
        readTextFile(jp(PROTOCOL_FILES.PLAN)).catch(() => "(missing — create PLAN.md)"),
        readTextFile(jp(PROTOCOL_FILES.RLM_INSTR)).catch(
          () => "(missing — create RLM_INSTRUCTIONS.md)"
        ),
        readTextFile(jp(PROTOCOL_FILES.NEXT_RALPH)).catch(() => "(none)"),
        readTextFile(jp(PROTOCOL_FILES.CURR)).catch(() => "(empty)"),
        readTextFile(jp(PROTOCOL_FILES.PREV)).catch(() => "(none yet)"),
        readTextFile(jp(PROTOCOL_FILES.NOTES)).catch(() => "(empty)"),
        readTextFile(jp(PROTOCOL_FILES.TODOS)).catch(() => "(empty)"),
        readTextFile(jp(PROTOCOL_FILES.CONVERSATION)).catch(() => "(empty)"),
        readTextFile(jp(PROTOCOL_FILES.RLM_CTX)).catch(() => ""),
        agentMdAbs
          ? readTextFile(agentMdAbs).catch(() => null as string | null)
          : Promise.resolve(null as string | null),
      ]);

      const useHeadings = args.includeRlmContextHeadings ?? true;
      const rlmContext = useHeadings
        ? extractHeadings(rlmRaw, args.rlmHeadingsMax ?? 80)
        : clampLines(rlmRaw, 200);

      // Worktree-relative path to each protocol file for the ACTIVE plan. In
      // named-plan mode these live under .ralph-rlm/plans/<name>/, so a worker
      // editing CURRENT_STATE.md / NOTES_AND_LEARNINGS.md / TODOS.md directly
      // must use these paths, not the bare filename (which would hit repo root).
      const protRel = (file: string) =>
        pctx.protocolRel ? `${pctx.protocolRel}/${file}` : file;
      const protocolPaths = Object.fromEntries(
        Object.values(PROTOCOL_FILES).map((file) => [file, protRel(file)])
      );

      const payload: Record<string, unknown> = {
        plan_dir: pctx.protocolRel || ".",
        plan_name: pctx.planName || null,
        protocol_paths: protocolPaths,
        edit_protocol_note:
          "When editing CURRENT_STATE.md, NOTES_AND_LEARNINGS.md, or TODOS.md directly, use the path in protocol_paths (they live in plan_dir, which may not be the repo root). Edit PLAN.md / RLM_INSTRUCTIONS.md via ralph_update_plan / ralph_update_rlm_instructions.",
        plan,
        rlm_instructions: rlmInstr,
        agent_context_for_next_ralph: nextRalph,
        current_state: curr,
        previous_state: prev,
        notes_and_learnings: clampLines(notes, 200),
        todos: clampLines(todos, 200),
        conversation_log: clampLines(conversation, 200),
        context_for_rlm: {
          path: protRel(PROTOCOL_FILES.RLM_CTX),
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
      const cfg = await getConfig();
      const fileRel = args.file ?? rlmCtxRel(await getPlanCtx(root));
      const ctxLines = args.contextLines ?? 0;
      const maxM = args.maxMatches ?? 50;

      const accelerated = await fffGrep(
        {
          worktree: root,
          enabled: cfg.fff.enabled,
          scanTimeoutMs: cfg.fff.scanTimeoutMs,
        },
        args.query,
        { maxMatches: maxM, contextLines: ctxLines, mode: "regex" }
      );

      const payload =
        accelerated.ok && grepMatchesTargetFile(accelerated, fileRel)
          ? {
              file: fileRel,
              totalMatches: accelerated.results.length,
              accelerated: true,
              results: accelerated.results.map((result) => ({
                matchLine: result.matchLine,
                matchText: result.matchText,
                context: result.context,
              })),
            }
          : {
              ...(await grepFileFallback({
                root,
                fileRel,
                query: args.query,
                maxMatches: maxM,
                contextLines: ctxLines,
              })),
              ...(accelerated.ok ? {} : { fallbackReason: accelerated.reason }),
            };

      const st = getSession(sessionID);
      st.lastGrepAt = Date.now();
      st.lastGrepQuery = args.query;

      return JSON.stringify(payload, null, 2);
    },
  });

  const tool_rlm_file_search = tool({
    description:
      "Fast fuzzy file search across the worktree using FFF when available. Use to find likely files before grep or slice.",
    args: {
      query: tool.schema.string(),
      pageSize: tool.schema.number().int().min(1).max(100).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const cfg = await getConfig();
      const result = await fffFileSearch(
        {
          worktree: root,
          enabled: cfg.fff.enabled,
          scanTimeoutMs: cfg.fff.scanTimeoutMs,
        },
        args.query,
        args.pageSize ?? 20
      );
      return JSON.stringify(result, null, 2);
    },
  });

  const tool_rlm_glob = tool({
    description:
      "Fast glob file discovery across the worktree using FFF when available. Use for patterns like **/*.ts or packages/*/src/**/*.ts.",
    args: {
      pattern: tool.schema.string(),
      pageSize: tool.schema.number().int().min(1).max(500).optional(),
    },
    async execute(args, ctx) {
      const root = ctx.worktree ?? worktree;
      const cfg = await getConfig();
      const result = await fffGlob(
        {
          worktree: root,
          enabled: cfg.fff.enabled,
          scanTimeoutMs: cfg.fff.scanTimeoutMs,
        },
        args.pattern,
        args.pageSize ?? 100
      );
      return JSON.stringify(result, null, 2);
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
      const fileRel = args.file ?? rlmCtxRel(await getPlanCtx(root));

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
      const pctx = await getPlanCtx(root);
      await applyProtocolPatch(pctx, PROTOCOL_FILES.PLAN, args.patch);
      await appendTextFile(
        protocolFilePath(pctx, PROTOCOL_FILES.PLAN),
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
      const pctx = await getPlanCtx(root);
      await applyProtocolPatch(pctx, PROTOCOL_FILES.RLM_INSTR, args.patch);
      await appendTextFile(
        protocolFilePath(pctx, PROTOCOL_FILES.RLM_INSTR),
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
      const pctx = await getPlanCtx(root);
      const id = `ask-${Date.now()}`;
      const timeoutMinutes = args.timeout_minutes ?? 15;

      const data = await readPendingInput(pctx);
      const questions = data.questions ?? [];
      questions.push({
        id,
        from: "worker",
        attempt: st.attempt,
        question: args.question,
        ...(args.context ? { context: args.context } : {}),
        askedAt: nowISO(),
      });
      await writePendingInput(pctx, { ...data, questions, updatedAt: nowISO() });
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
        const latest = await readPendingInput(pctx);
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
    // Hide Ralph's tools from normal OpenCode sessions: deny `ralph_*` / `rlm_*`
    // globally, and re-allow them only in the dedicated worker agent (which the
    // engine spawns workers under). Merge-safe: never clobber the user's own
    // permission rules or an existing agent of the same name.
    config: async (config: {
      permission?: Record<string, unknown>;
      agent?: Record<string, unknown>;
    }) => {
      const perm = (config.permission ??= {});
      for (const pattern of ["ralph_*", "rlm_*"]) {
        if (perm[pattern] === undefined) perm[pattern] = "deny";
      }
      const agents = (config.agent ??= {});
      if (agents[RALPH_WORKER_AGENT] === undefined) {
        agents[RALPH_WORKER_AGENT] = {
          description: "Ralph RLM worker — loop implementer (auto-managed).",
          permission: { "ralph_*": "allow", "rlm_*": "allow" },
        };
      }
    },

    tool: {
      ralph_load_context: tool_ralph_load_context,
      rlm_grep: tool_rlm_grep,
      rlm_file_search: tool_rlm_file_search,
      rlm_glob: tool_rlm_glob,
      rlm_slice: tool_rlm_slice,
      ralph_verify: tool_ralph_verify,
      ralph_report: tool_ralph_report,
      ralph_set_status: tool_ralph_set_status,
      ralph_update_plan: tool_ralph_update_plan,
      ralph_update_rlm_instructions: tool_ralph_update_rlm_instructions,
      ralph_ask: tool_ralph_ask,
    },

    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system?: string[] }) => {
      const sessionID = input.sessionID;
      // Only inject the worker system prompt into Ralph worker sessions —
      // never into the user's normal OpenCode sessions.
      if (!sessionID || !(await isRalphWorkerSession(sessionID))) return;
      output.system = output.system ?? [];
      output.system.push(templates.workerSystemPrompt);
      await syncSessionAttempt(sessionID, worktree);
    },

    "experimental.session.compacting": async (
      input: { sessionID?: string },
      output: { context?: string[] }
    ) => {
      if (!input.sessionID || !(await isRalphWorkerSession(input.sessionID))) return;
      output.context = output.context ?? [];
      output.context.push(templates.compactionContext);
    },

    "tool.execute.before": async (input: { sessionID?: string; tool?: string; call?: { name?: string } }) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const toolName = input.tool ?? input.call?.name ?? "";

      // In a normal (non-worker) session, the plugin's tools are present but
      // must stay inert, and we must NOT gate the user's edit/bash.
      if (!(await isRalphWorkerSession(sessionID))) {
        if (SAFE_TOOLS.has(toolName)) {
          throw new Error(
            "This Ralph RLM tool only runs inside a Ralph worker session (created by the loop), not a normal OpenCode session."
          );
        }
        return;
      }

      const cfg = await getConfig();
      await syncSessionAttempt(sessionID, worktree);
      const st = getSession(sessionID);
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
