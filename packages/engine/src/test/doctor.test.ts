import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { checkSetup, detectProjectDefaults } from "../doctor.js";
import { CONFIG_DEFAULTS } from "../config.js";
import { writeTextFile } from "../fs.js";
import { PROTOCOL_FILES } from "../protocol-files.js";

describe("doctor", () => {
  test("detectProjectDefaults prefers bun lockfiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-doctor-"));
    try {
      await writeTextFile(path.join(root, "bun.lock"), "lock\n");
      const defaults = await detectProjectDefaults(root);
      expect(defaults.verify).toEqual(["bun", "run", "verify"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("checkSetup flags missing verify and plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-doctor-"));
    try {
      const diagnostics = await checkSetup(root, CONFIG_DEFAULTS);
      expect(diagnostics.ready).toBe(false);
      expect(diagnostics.issues.some((issue) => issue.includes("verify.command"))).toBe(true);
      expect(diagnostics.issues.some((issue) => issue.includes("PLAN.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("checkSetup passes minimal fixture layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ralph-doctor-"));
    try {
      await writeTextFile(path.join(root, ".opencode", "ralph.json"), JSON.stringify({
        verify: { command: ["bun", "run", "verify"] },
      }));
      await writeTextFile(path.join(root, PROTOCOL_FILES.PLAN), "# Plan\n\n## Goal\nShip it\n");
      const diagnostics = await checkSetup(root, {
        ...CONFIG_DEFAULTS,
        verify: { command: ["bun", "run", "verify"] },
      });
      expect(diagnostics.ready).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});