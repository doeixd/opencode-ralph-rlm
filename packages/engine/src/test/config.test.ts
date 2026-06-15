import { describe, expect, test } from "bun:test";
import { resolveConfig, CONFIG_DEFAULTS } from "../config.js";

describe("resolveConfig", () => {
  test("applies defaults for empty input", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAttempts).toBe(CONFIG_DEFAULTS.maxAttempts);
    expect(cfg.verify).toBeUndefined();
  });

  test("sanitizes verify command", () => {
    const cfg = resolveConfig({
      verify: { command: ["  bun  ", "", "run", "verify"], cwd: " ./ " },
    });
    expect(cfg.verify?.command).toEqual(["bun", "run", "verify"]);
    expect(cfg.verify?.cwd).toBe("./");
  });

  test("bounds maxAttempts", () => {
    expect(resolveConfig({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(resolveConfig({ maxAttempts: 9999 }).maxAttempts).toBe(500);
  });

  test("resolves swarm defaults", () => {
    const cfg = resolveConfig({});
    expect(cfg.swarm.enabled).toBe(true);
    expect(cfg.swarm.maxConcurrent).toBe(5);
    expect(cfg.swarm.unsafeEvalEnabled).toBe(false);
  });
});