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

  test("resolves fff defaults and env disable override", () => {
    const previous = process.env.RALPH_FFF_DISABLED;
    try {
      delete process.env.RALPH_FFF_DISABLED;
      expect(resolveConfig({}).fff).toEqual({ enabled: true, scanTimeoutMs: 10_000 });
      expect(resolveConfig({ fff: { enabled: false, scanTimeoutMs: 5 } }).fff).toEqual({
        enabled: false,
        scanTimeoutMs: 100,
      });

      process.env.RALPH_FFF_DISABLED = "1";
      expect(resolveConfig({ fff: { enabled: true } }).fff.enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RALPH_FFF_DISABLED;
      else process.env.RALPH_FFF_DISABLED = previous;
    }
  });
});
