#!/usr/bin/env bun
/**
 * M8.2 — HTTP smoke tests against a running Ralph provider.
 *
 * Usage:
 *   RALPH_TEST_MODE=1 bun run ralph-serve          # terminal 1
 *   bun run bin/e2e-smoke.ts [--port 8787]         # terminal 2
 *
 * Optional: --spawn starts a temporary provider (RALPH_TEST_MODE=1) for CI/local runs.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureWorktree = join(root, "fixtures", "minimal-repo");
const providerDir = join(root, "packages", "provider");

type SmokeResult = { name: string; ok: boolean; detail?: string };

function readFlag(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) {
    const next = args[index + 1];
    if (next && !next.startsWith("-")) return next;
  }
  return undefined;
}

async function waitForHealth(baseUrl: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(250);
  }
  throw new Error(`Provider not healthy at ${baseUrl}`);
}

async function chat(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  query = ""
): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function assertTestModeProvider(baseUrl: string): Promise<void> {
  const probe = await chat(baseUrl, {
    model: "ralph-rlm/supervisor",
    messages: [{ role: "user", content: "hello" }],
  });
  if (probe.status === 400) {
    throw new Error(
      "Provider is not in RALPH_TEST_MODE=1. Restart with: RALPH_TEST_MODE=1 bun run ralph-serve"
    );
  }
}

async function runSmoke(baseUrl: string): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  const model = "ralph-rlm/supervisor";
  const directory = resolve(fixtureWorktree).replace(/\\/g, "/");

  await assertTestModeProvider(baseUrl);

  const health = await fetch(`${baseUrl}/api/health`);
  results.push({
    name: "GET /api/health",
    ok: health.ok,
    detail: health.ok ? undefined : `status ${health.status}`,
  });

  const anon = await chat(baseUrl, {
    model,
    messages: [{ role: "user", content: "hello" }],
  });
  const anonSource = anon.headers.get("x-ralph-session-source");
  if (anon.status === 400) {
    results.push({
      name: "anonymous blocked in production",
      ok: true,
      detail: "400 as expected",
    });
  } else if (anon.ok && anonSource === "anonymous") {
    results.push({
      name: "anonymous allowed (RALPH_TEST_MODE)",
      ok: true,
      detail: "provider in test mode — prod guard not asserted",
    });
  } else {
    results.push({
      name: "anonymous session handling",
      ok: false,
      detail: `status ${anon.status} source=${anonSource}`,
    });
  }

  const dirQuery = `?directory=${encodeURIComponent(directory)}`;
  const sessA = await chat(
    baseUrl,
    { model, messages: [{ role: "user", content: "Implement marker file; tests must pass" }] },
    { "x-opencode-session-id": "smoke-session-a" },
    dirQuery
  );
  const sourceA = sessA.headers.get("x-ralph-session-source");
  results.push({
    name: "session A correlation header",
    ok: sessA.ok && sourceA === "header:x-opencode-session-id",
    detail: `status ${sessA.status} source=${sourceA}`,
  });

  const sessB = await chat(
    baseUrl,
    { model, messages: [{ role: "user", content: "Implement marker file; tests must pass" }] },
    { "x-opencode-session-id": "smoke-session-b" },
    dirQuery
  );
  results.push({
    name: "session B correlation header",
    ok: sessB.ok && sessB.headers.get("x-ralph-session-key") === "smoke-session-b",
    detail: `key=${sessB.headers.get("x-ralph-session-key")}`,
  });

  const loops = await fetch(`${baseUrl}/api/loops`);
  const loopList = (await loops.json()) as { loops?: Array<{ sessionId: string }> };
  const ids = new Set((loopList.loops ?? []).map((run) => run.sessionId));
  results.push({
    name: "isolated loop runs per session",
    ok: ids.has("smoke-session-a") && ids.has("smoke-session-b"),
    detail: `runs=${[...ids].join(",") || "(none)"}`,
  });

  const statusA = await chat(
    baseUrl,
    { model, messages: [{ role: "user", content: "status?" }] },
    { "x-opencode-session-id": "smoke-session-a" },
    dirQuery
  );
  const statusText = statusA.ok ? await statusA.text() : "";
  results.push({
    name: "status turn (session A)",
    ok: statusA.ok && statusText.toLowerCase().includes("attempt"),
    detail: statusA.ok ? undefined : `status ${statusA.status}`,
  });

  const stopB = await chat(
    baseUrl,
    { model, messages: [{ role: "user", content: "stop" }] },
    { "x-opencode-session-id": "smoke-session-b" },
    dirQuery
  );
  const stopBody = stopB.ok ? await stopB.json() : null;
  const stopContent =
    stopBody && typeof stopBody === "object" && stopBody !== null
      ? String((stopBody as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "")
      : "";
  results.push({
    name: "stop turn (session B)",
    ok: stopB.ok && stopContent.toLowerCase().includes("stopped"),
    detail: stopB.ok ? undefined : `status ${stopB.status}`,
  });

  const loopB = await fetch(`${baseUrl}/api/loops/smoke-session-b`);
  const loopBJson = loopB.ok
    ? ((await loopB.json()) as { status?: { done?: boolean; outcome?: string } })
    : {};
  results.push({
    name: "session B stopped state",
    ok: loopBJson.status?.done === true && loopBJson.status?.outcome === "stopped",
    detail: `done=${String(loopBJson.status?.done)} outcome=${String(loopBJson.status?.outcome)}`,
  });

  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const spawnMode = args.includes("--spawn");
  const port =
    readFlag(args, "--port") ??
    (spawnMode ? String(8790 + (process.pid % 50)) : process.env.RALPH_PROVIDER_PORT ?? "8787");
  const baseUrl = `http://127.0.0.1:${port}`;

  let child: ReturnType<typeof spawn> | undefined;

  if (spawnMode) {
    const nitroCli = join(providerDir, "node_modules", "nitro", "dist", "cli", "index.mjs");
    console.log(`[e2e-smoke] Spawning provider on ${baseUrl} (RALPH_TEST_MODE=1)`);
    const nodeExe = process.platform === "win32" ? "node.exe" : "node";
    child = spawn(
      nodeExe,
      [nitroCli, "dev", "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: providerDir,
        env: {
          ...process.env,
          RALPH_TEST_MODE: "1",
          RALPH_PROVIDER_PORT: String(port),
          RALPH_WORKTREE: fixtureWorktree,
        },
        stdio: "ignore",
      }
    );
    await waitForHealth(baseUrl, 120);
    await Bun.sleep(2000);
  } else {
    console.log(`[e2e-smoke] Using provider at ${baseUrl}`);
    await waitForHealth(baseUrl);
  }

  try {
    const results = await runSmoke(baseUrl);
    let failed = 0;

    for (const result of results) {
      const mark = result.ok ? "OK" : "FAIL";
      console.log(`[e2e-smoke] ${mark} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
      if (!result.ok) failed += 1;
    }

    if (failed > 0) {
      console.error(`[e2e-smoke] ${failed} check(s) failed`);
      process.exit(1);
    }

    console.log("[e2e-smoke] All HTTP checks passed");
    console.log("[e2e-smoke] Manual TUI steps: OpenCode → ralph-rlm/supervisor → confirm x-ralph-session-source ≠ anonymous");
  } finally {
    if (child) {
      child.kill();
    }
  }
}

main().catch((err) => {
  console.error("[e2e-smoke] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});