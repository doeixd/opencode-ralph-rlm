import { describe, expect, test } from "bun:test";
import {
  clearFffSearchCache,
  fffFileSearch,
  fffGlob,
  fffGrep,
  type FffLoader,
} from "../fff-search.js";

function createLoader(input?: {
  scanOk?: boolean;
  scanDone?: boolean;
  createOk?: boolean;
}): FffLoader {
  return async () => ({
    FileFinder: {
      create() {
        if (input?.createOk === false) return { ok: false, error: "create failed" };
        return {
          ok: true,
          value: {
            async waitForScan() {
              if (input?.scanOk === false) return { ok: false, error: "scan failed" };
              return { ok: true, value: input?.scanDone ?? true };
            },
            fileSearch() {
              return {
                ok: true,
                value: {
                  totalMatched: 1,
                  totalFiles: 10,
                  items: [
                    {
                      relativePath: "src/index.ts",
                      fileName: "index.ts",
                      size: 42,
                      modified: 123,
                      gitStatus: "clean",
                    },
                  ],
                  scores: [{ total: 99, matchType: "exact", exactMatch: true }],
                },
              };
            },
            glob() {
              return {
                ok: true,
                value: {
                  totalMatched: 1,
                  totalFiles: 10,
                  items: [{ relativePath: "src/index.ts", fileName: "index.ts" }],
                  scores: [{ total: 88, matchType: "glob", exactMatch: false }],
                },
              };
            },
            grep() {
              return {
                ok: true,
                value: {
                  totalMatched: 1,
                  totalFilesSearched: 2,
                  totalFiles: 10,
                  filteredFileCount: 8,
                  nextCursor: null,
                  items: [
                    {
                      relativePath: "src/index.ts",
                      lineNumber: 7,
                      lineContent: "const needle = true;",
                      contextBefore: [{ lineNumber: 6, lineContent: "before" }],
                      contextAfter: [{ lineNumber: 8, lineContent: "after" }],
                      isDefinition: false,
                    },
                  ],
                },
              };
            },
            destroy() {},
          },
        };
      },
    },
  });
}

describe("fff search wrapper", () => {
  test("returns unavailable when disabled", async () => {
    clearFffSearchCache();
    const result = await fffFileSearch(
      { worktree: "disabled", enabled: false, loader: createLoader() },
      "index",
      20
    );
    expect(result).toEqual({
      ok: false,
      accelerated: false,
      reason: "FFF search is disabled.",
    });
  });

  test("returns unavailable when scan times out", async () => {
    clearFffSearchCache();
    const result = await fffGlob(
      {
        worktree: "scan-timeout",
        scanTimeoutMs: 250,
        loader: createLoader({ scanDone: false }),
      },
      "**/*.ts",
      20
    );
    expect(result).toEqual({
      ok: false,
      accelerated: false,
      reason: "FFF scan timed out after 250ms.",
    });
  });

  test("normalizes file search results", async () => {
    clearFffSearchCache();
    const result = await fffFileSearch(
      { worktree: "file-search", loader: createLoader() },
      "index",
      20
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accelerated).toBe(true);
    expect(result.results[0]).toMatchObject({
      path: "src/index.ts",
      score: 99,
      matchType: "exact",
      exactMatch: true,
    });
  });

  test("normalizes glob results", async () => {
    clearFffSearchCache();
    const result = await fffGlob({ worktree: "glob", loader: createLoader() }, "**/*.ts", 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files[0]).toMatchObject({ path: "src/index.ts", score: 88 });
  });

  test("normalizes grep results", async () => {
    clearFffSearchCache();
    const result = await fffGrep(
      { worktree: "grep", loader: createLoader() },
      "needle",
      { contextLines: 1 }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toEqual({
      file: "src/index.ts",
      matchLine: 7,
      matchText: "const needle = true;",
      isDefinition: false,
      context: [
        { line: 6, text: "before" },
        { line: 7, text: "const needle = true;" },
        { line: 8, text: "after" },
      ],
    });
  });
});
