import {
  PROTOCOL_FILES,
  appendTextFile,
  clampLines,
  loadPlanContext,
  nowISO,
  protocolFilePath,
} from "@doeixd/opencode-ralph-rlm-engine";
import { supervisorTurn } from "./supervisor-agent.js";
import { getOpencodeRuntime } from "./runtime.js";

export type InjectSupervisorMessageInput = {
  sessionKey: string;
  worktree: string;
  message: string;
  /** Label for where the message came from (e.g. "ci-watcher"). */
  source?: string;
  /** Show a toast in the OpenCode TUI for this session (default true). */
  toast?: boolean;
  /** Run a supervisor turn so it can act (default true). When false, only record. */
  runTurn?: boolean;
  /** Test override for the OpenCode runtime (toast target). */
  runtime?: ReturnType<typeof getOpencodeRuntime>;
};

export type InjectSupervisorMessageResult = {
  recorded: boolean;
  ran: boolean;
  response?: string;
  mode?: "test" | "llm";
};

/**
 * Inject an out-of-band message to a session's supervisor. Used by external
 * watchers/scripts (via POST /api/loops/:sessionId/message or the
 * `send-message` CLI) to notify or steer the supervisor without going through
 * the OpenCode TUI. Records the message to protocol files, optionally toasts the
 * TUI, and — unless runTurn is false — runs a supervisor turn so it can react.
 */
export async function injectSupervisorMessage(
  input: InjectSupervisorMessageInput
): Promise<InjectSupervisorMessageResult> {
  const message = input.message.trim();
  const source = input.source?.trim() || "external";
  const pctx = await loadPlanContext(input.worktree);
  const inbound = `- ${nowISO()} [external:${source}] → supervisor: ${clampLines(message, 40)}\n`;
  await appendTextFile(
    protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION),
    inbound
  ).catch(() => {});
  await appendTextFile(
    protocolFilePath(pctx, PROTOCOL_FILES.SUPERVISOR_LOG),
    inbound
  ).catch(() => {});

  if (input.toast !== false) {
    const runtime = input.runtime ?? getOpencodeRuntime();
    await runtime.client.tui
      .showToast({
        title: `Ralph: message from ${source}`,
        message: clampLines(message, 4),
        variant: "info",
      })
      .catch(() => {});
  }

  if (input.runTurn === false) {
    return { recorded: true, ran: false };
  }

  const turn = await supervisorTurn({
    sessionKey: input.sessionKey,
    worktree: input.worktree,
    messages: [
      {
        role: "user",
        content: `[Automated message from ${source} — not the human operator]\n\n${message}`,
      },
    ],
  });

  await appendTextFile(
    protocolFilePath(pctx, PROTOCOL_FILES.CONVERSATION),
    `- ${nowISO()} supervisor (external:${source}) → ${clampLines(turn.content, 40)}\n`
  ).catch(() => {});

  return { recorded: true, ran: true, response: turn.content, mode: turn.mode };
}
