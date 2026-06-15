import { describe, expect, test } from "bun:test";
import { validateSpawnSwarmInput } from "../swarm-runner.js";

describe("validateSpawnSwarmInput", () => {
  test("rejects empty tasks", () => {
    expect(validateSpawnSwarmInput({ tasks: [] })).toBe("tasks must be a non-empty array");
  });

  test("rejects duplicate task names", () => {
    expect(
      validateSpawnSwarmInput({
        tasks: [
          { name: "auth", goal: "Fix auth" },
          { name: "auth", goal: "Fix api" },
        ],
      })
    ).toBe("duplicate task name: auth");
  });

  test("rejects invalid waitPolicy", () => {
    expect(
      validateSpawnSwarmInput({
        tasks: [{ name: "only", goal: "Do work" }],
        waitPolicy: "most" as "all",
      })
    ).toContain("invalid waitPolicy");
  });

  test("accepts valid input", () => {
    expect(
      validateSpawnSwarmInput({
        label: "refactor",
        tasks: [
          { name: "auth", goal: "Fix auth" },
          { name: "api", goal: "Fix api" },
        ],
        waitPolicy: "all",
      })
    ).toBeNull();
  });
});