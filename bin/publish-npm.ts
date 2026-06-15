#!/usr/bin/env bun
/**
 * Publish @ralph-rlm/* and opencode-ralph-rlm to npm (v0.2.0+).
 *
 * Requires NPM_TOKEN in the environment (npm automation token).
 *
 * Usage:
 *   NPM_TOKEN=npm_... bun run bin/publish-npm.ts
 *   NPM_TOKEN=npm_... bun run bin/publish-npm.ts --dry-run
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const token = process.env.NPM_TOKEN?.trim();

if (!token) {
  console.error("[publish] NPM_TOKEN is not set.");
  console.error("[publish] Set an npm automation token, then re-run.");
  process.exit(1);
}

const npmrcPath = join(root, ".npmrc");
writeFileSync(
  npmrcPath,
  `//registry.npmjs.org/:_authToken=${token}\n@ralph-rlm:registry=https://registry.npmjs.org/\n`,
  "utf8"
);

function run(label: string, cmd: string, args: string[], cwd = root): void {
  console.log(`[publish] ${label}: ${cmd} ${args.join(" ")}`);
  const extra = dryRun ? ["--dry-run"] : [];
  const result = spawnSync(cmd, [...args, ...extra], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NPM_TOKEN: token },
  });
  if (result.status !== 0) {
    try {
      unlinkSync(npmrcPath);
    } catch {
      // ignore
    }
    process.exit(result.status ?? 1);
  }
}

try {
  console.log("[publish] Building packages...");
  run("build engine", "bun", ["run", "build"], join(root, "packages", "engine"));
  run("build worker-plugin", "bun", ["run", "build"], join(root, "packages", "worker-plugin"));
  run("build provider", "bun", ["run", "build"], join(root, "packages", "provider"));
  run("build legacy bundle", "bun", [
    "build",
    ".opencode/plugins-legacy/ralph-rlm.ts",
    "--outfile",
    "dist/ralph-rlm.js",
    "--target",
    "bun",
    "--format",
    "esm",
    "--external",
    "@opencode-ai/plugin",
  ]);

  const packages = [
    { name: "@ralph-rlm/engine", workspace: true },
    { name: "@ralph-rlm/worker-plugin", workspace: true },
    { name: "@ralph-rlm/provider", workspace: true },
    { name: "opencode-ralph-rlm", workspace: false },
  ];

  for (const pkg of packages) {
    const args = ["publish", "--access", "public"];
    if (pkg.workspace) {
      args.push("-w", pkg.name);
    }
    run(`publish ${pkg.name}`, "npm", args, root);
  }

  console.log(dryRun ? "[publish] Dry run complete." : "[publish] All packages published.");
} finally {
  try {
    unlinkSync(npmrcPath);
  } catch {
    // ignore
  }
}