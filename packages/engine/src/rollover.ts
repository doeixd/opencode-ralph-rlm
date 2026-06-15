import path from "node:path";
import { readTextFile, writeTextFile } from "./fs.js";
import { PROTOCOL_FILES } from "./protocol-files.js";
import { clampLines, interpolate, nowISO } from "./text.js";
import type { EngineTemplates } from "./templates.js";

export async function rolloverState(
  worktree: string,
  templates: EngineTemplates,
  attemptN: number,
  verdict: string,
  details: string
): Promise<void> {
  const ts = nowISO();
  const summary = `Attempt ${attemptN} — verification ${verdict}.\n\n${clampLines(details, 120)}`;
  const currPath = path.join(worktree, PROTOCOL_FILES.CURR);
  const curr = await readTextFile(currPath).catch(() => "");

  await Promise.all([
    writeTextFile(
      path.join(worktree, PROTOCOL_FILES.PREV),
      `# Previous State (snapshot)\n\nCaptured: ${ts}\n\n${curr}\n`
    ),
    writeTextFile(path.join(worktree, PROTOCOL_FILES.CURR), templates.bootstrapCurrentState),
    writeTextFile(
      path.join(worktree, PROTOCOL_FILES.NEXT_RALPH),
      `# Next Ralph Context\n\n- Timestamp: ${ts}\n- Verdict: ${verdict}\n\n## Summary\n${summary}\n\n## Next Step\n${interpolate(templates.continuePrompt, {
        attempt: String(attemptN),
        nextAttempt: String(attemptN + 1),
        verdict,
      })}\n`
    ),
  ]);
}

export async function writeDoneFile(
  worktree: string,
  templates: EngineTemplates
): Promise<void> {
  await writeTextFile(
    path.join(worktree, PROTOCOL_FILES.NEXT_RALPH),
    interpolate(templates.doneFileContent, { timestamp: nowISO() })
  );
}