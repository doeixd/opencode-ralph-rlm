import path from "node:path";
import { fileExists, readTextFile, writeTextFile } from "./fs.js";
import { nowISO } from "./text.js";

/** Relative path (under worktree) for worker↔supervisor pending Q&A. */
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

export async function readPendingInput(worktree: string): Promise<PendingInputData> {
  const filePath = path.join(worktree, PENDING_INPUT_REL_PATH);
  if (!(await fileExists(filePath))) return {};
  try {
    return JSON.parse(await readTextFile(filePath)) as PendingInputData;
  } catch {
    return {};
  }
}

export async function writePendingInput(
  worktree: string,
  data: PendingInputData
): Promise<void> {
  await writeTextFile(
    path.join(worktree, PENDING_INPUT_REL_PATH),
    JSON.stringify(data, null, 2)
  );
}

/** Questions that do not yet have a matching answer entry. */
export function listUnansweredQuestions(data: PendingInputData): PendingQuestion[] {
  const answered = new Set((data.answers ?? []).map((entry) => entry.id));
  return (data.questions ?? []).filter((question) => !answered.has(question.id));
}

export async function addPendingAnswer(
  worktree: string,
  questionId: string,
  answer: string
): Promise<PendingInputData> {
  const data = await readPendingInput(worktree);
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
  await writePendingInput(worktree, updated);
  return updated;
}