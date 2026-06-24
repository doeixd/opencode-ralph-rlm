import { readTextFile, writeTextFile } from "./fs.js";
import { PROTOCOL_FILES } from "./protocol-files.js";
import { protocolFilePath, type PlanContext } from "./plan-paths.js";
import { clampLines, interpolate, nowISO } from "./text.js";
import type { EngineTemplates } from "./templates.js";

export async function rolloverState(
  ctx: PlanContext,
  templates: EngineTemplates,
  attemptN: number,
  verdict: string,
  details: string
): Promise<void> {
  const ts = nowISO();
  const summary = `Attempt ${attemptN} — verification ${verdict}.\n\n${clampLines(details, 120)}`;
  const curr = await readTextFile(protocolFilePath(ctx, PROTOCOL_FILES.CURR)).catch(() => "");

  await Promise.all([
    writeTextFile(
      protocolFilePath(ctx, PROTOCOL_FILES.PREV),
      `# Previous State (snapshot)\n\nCaptured: ${ts}\n\n${curr}\n`
    ),
    writeTextFile(protocolFilePath(ctx, PROTOCOL_FILES.CURR), templates.bootstrapCurrentState),
    writeTextFile(
      protocolFilePath(ctx, PROTOCOL_FILES.NEXT_RALPH),
      `# Next Ralph Context\n\n- Timestamp: ${ts}\n- Verdict: ${verdict}\n\n## Summary\n${summary}\n\n## Next Step\n${interpolate(templates.continuePrompt, {
        attempt: String(attemptN),
        nextAttempt: String(attemptN + 1),
        verdict,
      })}\n`
    ),
  ]);
}

export async function writeDoneFile(
  ctx: PlanContext,
  templates: EngineTemplates
): Promise<void> {
  await writeTextFile(
    protocolFilePath(ctx, PROTOCOL_FILES.NEXT_RALPH),
    interpolate(templates.doneFileContent, { timestamp: nowISO() })
  );
}