import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  addPendingAnswer,
  listUnansweredQuestions,
  readPendingInput,
  writePendingInput,
} from "../pending-input.js";

describe("pending-input", () => {
  test("listUnansweredQuestions filters answered ids", () => {
    const unanswered = listUnansweredQuestions({
      questions: [
        {
          id: "ask-1",
          question: "A?",
          askedAt: "2026-06-15T00:00:00.000Z",
          from: "worker",
          attempt: 1,
        },
        {
          id: "ask-2",
          question: "B?",
          askedAt: "2026-06-15T00:00:00.000Z",
          from: "worker",
          attempt: 1,
        },
      ],
      answers: [{ id: "ask-1", answer: "yes" }],
    });

    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]?.id).toBe("ask-2");
  });

  test("addPendingAnswer preserves unanswered questions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-pending-"));
    try {
      await writePendingInput(root, {
        questions: [
          {
            id: "ask-1",
            question: "Rewrite or patch?",
            askedAt: "2026-06-15T00:00:00.000Z",
            from: "worker",
            attempt: 1,
          },
        ],
      });

      await addPendingAnswer(root, "ask-1", "Patch it.");

      const data = await readPendingInput(root);
      expect(data.answers).toEqual([{ id: "ask-1", answer: "Patch it." }]);
      expect(data.questions).toHaveLength(1);
      expect(listUnansweredQuestions(data)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});