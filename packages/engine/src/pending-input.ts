import { fileExists, readTextFile, writeTextFile } from "./fs.js";
import { stateFilePath, type PlanContext } from "./plan-paths.js";
import { nowISO } from "./text.js";

/** Marker filename, resolved under the plan's state dir. */
export const PENDING_INPUT_FILE = "pending_input.json";
/** Legacy relative path (under worktree) — retained for reference. */
export const PENDING_INPUT_REL_PATH = ".opencode/pending_input.json";

export type PendingQuestion = {
  id: string;
  question: string;
  context?: string;
  askedAt: string;
  from: string;
  attempt: number;
};

export type PendingAnswer = {
  id: string;
  answer: string;
};

export type PendingInputData = {
  updatedAt?: string;
  questions?: PendingQuestion[];
  answers?: PendingAnswer[];
};

export async function readPendingInput(ctx: PlanContext): Promise<PendingInputData> {
  const filePath = stateFilePath(ctx, PENDING_INPUT_FILE);
  if (!(await fileExists(filePath))) return {};
  try {
    return JSON.parse(await readTextFile(filePath)) as PendingInputData;
  } catch {
    return {};
  }
}

export async function writePendingInput(
  ctx: PlanContext,
  data: PendingInputData
): Promise<void> {
  await writeTextFile(
    stateFilePath(ctx, PENDING_INPUT_FILE),
    JSON.stringify(data, null, 2)
  );
}

/** Questions that do not yet have a matching answer entry. */
export function listUnansweredQuestions(data: PendingInputData): PendingQuestion[] {
  const answered = new Set((data.answers ?? []).map((entry) => entry.id));
  return (data.questions ?? []).filter((question) => !answered.has(question.id));
}

export async function addPendingAnswer(
  ctx: PlanContext,
  questionId: string,
  answer: string
): Promise<PendingInputData> {
  const data = await readPendingInput(ctx);
  const answers = [...(data.answers ?? [])];
  const existing = answers.findIndex((entry) => entry.id === questionId);
  const entry: PendingAnswer = { id: questionId, answer };
  if (existing >= 0) {
    answers[existing] = entry;
  } else {
    answers.push(entry);
  }

  const updated: PendingInputData = {
    ...data,
    answers,
    updatedAt: nowISO(),
  };
  await writePendingInput(ctx, updated);
  return updated;
}