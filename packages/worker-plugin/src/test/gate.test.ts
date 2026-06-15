import { describe, expect, test } from "bun:test";
import { shouldGateDestructiveTool } from "../gate.js";

describe("shouldGateDestructiveTool", () => {
  test("blocks edit before context loaded", () => {
    expect(
      shouldGateDestructiveTool({
        gateEnabled: true,
        loadedContext: false,
        toolName: "edit",
      })
    ).toBe(true);
  });

  test("allows edit after context loaded", () => {
    expect(
      shouldGateDestructiveTool({
        gateEnabled: true,
        loadedContext: true,
        toolName: "edit",
      })
    ).toBe(false);
  });

  test("allows rlm_grep before context loaded", () => {
    expect(
      shouldGateDestructiveTool({
        gateEnabled: true,
        loadedContext: false,
        toolName: "rlm_grep",
      })
    ).toBe(false);
  });

  test("ignores gate when disabled in config", () => {
    expect(
      shouldGateDestructiveTool({
        gateEnabled: false,
        loadedContext: false,
        toolName: "bash",
      })
    ).toBe(false);
  });
});