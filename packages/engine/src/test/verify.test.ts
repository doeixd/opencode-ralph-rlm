import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config.js";
import { runAndParseVerify } from "../verify.js";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../../fixtures/minimal-repo");

describe("runAndParseVerify", () => {
  test("fails when pass marker is missing", async () => {
    const cfg = await loadConfig(fixtureRoot);
    const result = await runAndParseVerify(fixtureRoot, cfg);
    expect(result.verdict).toBe("fail");
    expect(result.details).toContain("marker");
  });
});