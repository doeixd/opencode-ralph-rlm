import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { executeSupervisorTool } from "../lib/supervisor-tools.js";
import { readRawConfig } from "@doeixd/opencode-ralph-rlm-engine";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ralph-verify-"));
}

const ctx = (worktree: string) => ({ sessionKey: "s", worktree });

describe("verify supervisor tools", () => {
  test("set_verify writes ralph.json; get_verify reads it back", async () => {
    const root = await tempRoot();
    try {
      const setRes = await executeSupervisorTool(
        "set_verify",
        { command: ["npm", "test"], cwd: ".", timeoutMinutes: 10 },
        ctx(root)
      );
      expect(setRes).toContain('"ok": true');

      const raw = await readRawConfig(root);
      expect((raw.verify as { command: string[] }).command).toEqual(["npm", "test"]);

      const getRes = await executeSupervisorTool("get_verify", {}, ctx(root));
      expect(getRes).toContain("npm");
      expect(getRes).toContain('"ok": true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("set_verify rejects an empty command", async () => {
    const root = await tempRoot();
    try {
      const res = await executeSupervisorTool("set_verify", { command: [] }, ctx(root));
      expect(res).toContain('"ok": false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_verify reports fail for a failing command (red baseline)", async () => {
    const root = await tempRoot();
    try {
      await executeSupervisorTool(
        "set_verify",
        { command: ["node", "-e", "process.exit(1)"] },
        ctx(root)
      );
      const res = await executeSupervisorTool("run_verify", {}, ctx(root));
      expect(res).toContain('"verdict": "fail"');
      expect(res).toContain("Fails NOW");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_verify reports pass for a passing command (warns it's too weak)", async () => {
    const root = await tempRoot();
    try {
      await executeSupervisorTool(
        "set_verify",
        { command: ["node", "-e", "process.exit(0)"] },
        ctx(root)
      );
      const res = await executeSupervisorTool("run_verify", {}, ctx(root));
      expect(res).toContain('"verdict": "pass"');
      expect(res).toContain("too weak");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_verify errors when no verify.command is set", async () => {
    const root = await tempRoot();
    try {
      const res = await executeSupervisorTool("run_verify", {}, ctx(root));
      expect(res).toContain('"ok": false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
