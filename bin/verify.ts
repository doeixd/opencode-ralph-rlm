#!/usr/bin/env bun
/**
 * Cross-platform verify script (avoids Bun workspace script remap issues on Windows).
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bunExe = process.execPath;

function run(cmd: string, args: string[], cwd = root): void {
  const label = cwd === root ? cmd : `${cmd} (${cwd})`;
  console.log(`[verify] ${label} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("tsc", ["-p", "tsconfig.json", "--noEmit"], join(root, "packages", "engine"));
run("tsc", ["-p", "tsconfig.json"], join(root, "packages", "engine"));
run("tsc", ["-p", "tsconfig.json", "--noEmit"], join(root, "packages", "provider"));
run("tsc", ["-p", "tsconfig.json", "--noEmit"], join(root, "packages", "worker-plugin"));
run("tsc", ["-p", "tsconfig.json"], join(root, "packages", "worker-plugin"));
run("tsc", ["-p", "tsconfig.plugin.json", "--noEmit"]);
run("tsc", ["-p", "tsconfig.legacy-plugin.json", "--noEmit"]);
run(bunExe, ["test", "src/test"], join(root, "packages", "engine"));
run(bunExe, ["test", "src/test"], join(root, "packages", "worker-plugin"));
run(bunExe, ["test", "server/test"], join(root, "packages", "provider"));
const nitroCli = join(
  root,
  "packages",
  "provider",
  "node_modules",
  "nitro",
  "dist",
  "cli",
  "index.mjs"
);
run("node", [nitroCli, "build"], join(root, "packages", "provider"));
run(bunExe, [
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
run(bunExe, [
  "build",
  "bin/opencode-ralph-rlm.ts",
  "--outfile",
  "dist/opencode-ralph-rlm.js",
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "nitro",
]);

console.log("[verify] OK");
