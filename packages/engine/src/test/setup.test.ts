import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { setupProject } from "../setup.js";

async function makeTempProject(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "ralph-setup-"));
}

describe("setupProject", () => {
  test("creates OpenCode plugin wrappers, ralph config, and provider registration", async () => {
    const worktree = await makeTempProject();
    try {
      await writeFile(
        path.join(worktree, "package.json"),
        JSON.stringify({
          scripts: { test: "node --test" },
          devDependencies: { "@doeixd/opencode-ralph-rlm": "^0.2.0" },
        }),
        "utf8"
      );

      const result = await setupProject({ worktree, port: 9999 });
      expect(result.actions.map((a) => a.status)).toEqual([
        "created",
        "created",
        "created",
        "created",
        "created",
      ]);

      const worker = await Bun.file(
        path.join(worktree, ".opencode", "plugins", "ralph-worker.ts")
      ).text();
      expect(worker).toContain("@doeixd/opencode-ralph-rlm/worker-plugin");

      const autostart = await Bun.file(
        path.join(worktree, ".opencode", "plugins", "ralph-autostart.ts")
      ).text();
      expect(autostart).toContain("serve");
      expect(autostart).toContain("RALPH_AUTOSTART");

      // --no-autostart skips the auto-start plugin.
      const noAuto = await setupProject({ worktree, port: 9999, autostart: false, force: true });
      expect(noAuto.actions.some((a) => a.file.includes("ralph-autostart"))).toBe(false);

      const ralph = await Bun.file(path.join(worktree, ".opencode", "ralph.json")).json();
      expect(ralph.verify.command).toEqual(["npm", "test"]);

      const opencode = await Bun.file(path.join(worktree, "opencode.json")).json();
      expect(opencode.provider["ralph-rlm"].options.baseURL).toBe("http://127.0.0.1:9999/v1");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("preserves existing opencode providers and skips managed files without force", async () => {
    const worktree = await makeTempProject();
    try {
      await writeFile(
        path.join(worktree, "opencode.json"),
        JSON.stringify({
          provider: {
            other: { name: "Other" },
          },
        }),
        "utf8"
      );
      await writeFile(
        path.join(worktree, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
        "utf8"
      );
      await mkdir(path.join(worktree, ".opencode"), { recursive: true });
      await writeFile(
        path.join(worktree, ".opencode", "ralph.json"),
        JSON.stringify({ verify: { command: ["custom", "verify"] } }),
        "utf8"
      );

      const result = await setupProject({ worktree });
      expect(result.actions.find((a) => a.file === ".opencode/ralph.json")?.status).toBe(
        "skipped"
      );
      expect(result.actions.find((a) => a.file === "package.json")?.message).toContain(
        "not listed"
      );

      const opencode = await Bun.file(path.join(worktree, "opencode.json")).json();
      expect(opencode.provider.other.name).toBe("Other");
      expect(opencode.provider["ralph-rlm"]).toBeDefined();

      const ralph = await Bun.file(path.join(worktree, ".opencode", "ralph.json")).json();
      expect(ralph.verify.command).toEqual(["custom", "verify"]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("dry run reports intended writes without creating files", async () => {
    const worktree = await makeTempProject();
    try {
      const result = await setupProject({ worktree, dryRun: true });
      expect(result.actions.every((a) => a.status.startsWith("would-"))).toBe(true);
      expect(await Bun.file(path.join(worktree, "opencode.json")).exists()).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
