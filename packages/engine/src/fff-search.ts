type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };

type FffFileItem = {
  relativePath: string;
  fileName?: string;
  size?: number;
  modified?: number;
  gitStatus?: string;
  totalFrecencyScore?: number;
};

type FffSearchResult = {
  items: FffFileItem[];
  scores?: Array<{ total?: number; matchType?: string; exactMatch?: boolean }>;
  totalMatched?: number;
  totalFiles?: number;
};

type FffGrepMatch = {
  relativePath: string;
  lineNumber: number;
  lineContent?: string;
  contextBefore?: Array<{ lineNumber: number; lineContent: string }>;
  contextAfter?: Array<{ lineNumber: number; lineContent: string }>;
  isDefinition?: boolean;
};

type FffGrepResult = {
  items: FffGrepMatch[];
  totalMatched?: number;
  totalFilesSearched?: number;
  totalFiles?: number;
  filteredFileCount?: number;
  nextCursor?: unknown;
  regexFallbackError?: string;
};

type FffFinder = {
  waitForScan(timeoutMs?: number): Promise<FffResult<boolean>>;
  fileSearch(query: string, options?: { pageSize?: number; pageIndex?: number }): FffResult<FffSearchResult>;
  glob(pattern: string, options?: { pageSize?: number; pageIndex?: number }): FffResult<FffSearchResult>;
  grep(
    query: string,
    options?: {
      mode?: "plain" | "regex" | "fuzzy";
      smartCase?: boolean;
      beforeContext?: number;
      afterContext?: number;
      pageSize?: number;
      classifyDefinitions?: boolean;
      timeBudgetMs?: number;
    }
  ): FffResult<FffGrepResult>;
  destroy(): void;
};

type FffModule = {
  FileFinder: {
    create(options: { basePath: string; aiMode?: boolean }): FffResult<FffFinder>;
  };
};

export type FffLoader = () => Promise<FffModule>;

export type FffSearchOptions = {
  worktree: string;
  enabled?: boolean;
  scanTimeoutMs?: number;
  loader?: FffLoader;
};

export type FffUnavailable = {
  ok: false;
  accelerated: false;
  reason: string;
};

export type NormalizedFileSearchItem = {
  path: string;
  fileName?: string;
  size?: number;
  modified?: number;
  gitStatus?: string;
  score?: number;
  matchType?: string;
  exactMatch?: boolean;
};

export type NormalizedFileSearchResult =
  | FffUnavailable
  | {
      ok: true;
      accelerated: true;
      query: string;
      totalMatched: number;
      totalFiles: number;
      results: NormalizedFileSearchItem[];
    };

export type NormalizedGlobResult =
  | FffUnavailable
  | {
      ok: true;
      accelerated: true;
      pattern: string;
      totalMatched: number;
      totalFiles: number;
      files: NormalizedFileSearchItem[];
    };

export type NormalizedGrepResult =
  | FffUnavailable
  | {
      ok: true;
      accelerated: true;
      query: string;
      totalMatches: number;
      totalFilesSearched: number;
      totalFiles: number;
      filteredFileCount: number;
      hasMore: boolean;
      regexFallbackError?: string;
      results: Array<{
        file: string;
        matchLine: number;
        matchText: string;
        isDefinition?: boolean;
        context?: Array<{ line: number; text: string }>;
      }>;
    };

type CacheEntry =
  | { state: "ready"; finder: FffFinder }
  | { state: "unavailable"; reason: string };

const cache = new Map<string, Promise<CacheEntry>>();

const defaultLoader: FffLoader = async () => {
  const importModule = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<FffModule>;
  return importModule("@ff-labs/fff-node");
};

function unavailable(reason: string): FffUnavailable {
  return { ok: false, accelerated: false, reason };
}

async function createEntry(options: Required<FffSearchOptions>): Promise<CacheEntry> {
  if (!options.enabled) {
    return { state: "unavailable", reason: "FFF search is disabled." };
  }

  try {
    const mod = await options.loader();
    const created = mod.FileFinder.create({ basePath: options.worktree, aiMode: true });
    if (!created.ok) {
      return { state: "unavailable", reason: created.error };
    }

    const scanned = await created.value.waitForScan(options.scanTimeoutMs);
    if (!scanned.ok) {
      created.value.destroy();
      return { state: "unavailable", reason: scanned.error };
    }
    if (!scanned.value) {
      created.value.destroy();
      return {
        state: "unavailable",
        reason: `FFF scan timed out after ${options.scanTimeoutMs}ms.`,
      };
    }

    return { state: "ready", finder: created.value };
  } catch (error) {
    return {
      state: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getEntry(options: FffSearchOptions): Promise<CacheEntry> {
  const normalized: Required<FffSearchOptions> = {
    worktree: options.worktree,
    enabled: options.enabled ?? true,
    scanTimeoutMs: options.scanTimeoutMs ?? 10_000,
    loader: options.loader ?? defaultLoader,
  };
  const key = `${normalized.worktree}\0${normalized.enabled}\0${normalized.scanTimeoutMs}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = createEntry(normalized);
    cache.set(key, entry);
  }
  return entry;
}

function normalizeItems(result: FffSearchResult): NormalizedFileSearchItem[] {
  return result.items.map((item, index) => {
    const score = result.scores?.[index];
    const normalized: NormalizedFileSearchItem = {
      path: item.relativePath,
    };
    if (item.fileName !== undefined) normalized.fileName = item.fileName;
    if (item.size !== undefined) normalized.size = item.size;
    if (item.modified !== undefined) normalized.modified = item.modified;
    if (item.gitStatus !== undefined) normalized.gitStatus = item.gitStatus;
    const totalScore = score?.total ?? item.totalFrecencyScore;
    if (totalScore !== undefined) normalized.score = totalScore;
    if (score?.matchType !== undefined) normalized.matchType = score.matchType;
    if (score?.exactMatch !== undefined) normalized.exactMatch = score.exactMatch;
    return normalized;
  });
}

function normalizeContext(match: FffGrepMatch): Array<{ line: number; text: string }> | undefined {
  const before = match.contextBefore ?? [];
  const after = match.contextAfter ?? [];
  if (before.length === 0 && after.length === 0) return undefined;
  return [
    ...before.map((line) => ({ line: line.lineNumber, text: line.lineContent })),
    { line: match.lineNumber, text: match.lineContent ?? "" },
    ...after.map((line) => ({ line: line.lineNumber, text: line.lineContent })),
  ];
}

export async function fffFileSearch(
  options: FffSearchOptions,
  query: string,
  pageSize: number
): Promise<NormalizedFileSearchResult> {
  const entry = await getEntry(options);
  if (entry.state !== "ready") return unavailable(entry.reason);

  const result = entry.finder.fileSearch(query, { pageSize });
  if (!result.ok) return unavailable(result.error);

  return {
    ok: true,
    accelerated: true,
    query,
    totalMatched: result.value.totalMatched ?? result.value.items.length,
    totalFiles: result.value.totalFiles ?? 0,
    results: normalizeItems(result.value),
  };
}

export async function fffGlob(
  options: FffSearchOptions,
  pattern: string,
  pageSize: number
): Promise<NormalizedGlobResult> {
  const entry = await getEntry(options);
  if (entry.state !== "ready") return unavailable(entry.reason);

  const result = entry.finder.glob(pattern, { pageSize });
  if (!result.ok) return unavailable(result.error);

  return {
    ok: true,
    accelerated: true,
    pattern,
    totalMatched: result.value.totalMatched ?? result.value.items.length,
    totalFiles: result.value.totalFiles ?? 0,
    files: normalizeItems(result.value),
  };
}

export async function fffGrep(
  options: FffSearchOptions,
  query: string,
  input?: {
    maxMatches?: number;
    contextLines?: number;
    mode?: "plain" | "regex" | "fuzzy";
  }
): Promise<NormalizedGrepResult> {
  const entry = await getEntry(options);
  if (entry.state !== "ready") return unavailable(entry.reason);

  const contextLines = input?.contextLines ?? 0;
  const result = entry.finder.grep(query, {
    mode: input?.mode ?? "regex",
    smartCase: true,
    beforeContext: contextLines,
    afterContext: contextLines,
    pageSize: input?.maxMatches ?? 50,
    classifyDefinitions: true,
  });
  if (!result.ok) return unavailable(result.error);

  const normalized: Exclude<NormalizedGrepResult, FffUnavailable> = {
    ok: true,
    accelerated: true,
    query,
    totalMatches: result.value.totalMatched ?? result.value.items.length,
    totalFilesSearched: result.value.totalFilesSearched ?? 0,
    totalFiles: result.value.totalFiles ?? 0,
    filteredFileCount: result.value.filteredFileCount ?? 0,
    hasMore: result.value.nextCursor !== null && result.value.nextCursor !== undefined,
    results: result.value.items.map((match) => {
      const normalized: {
        file: string;
        matchLine: number;
        matchText: string;
        isDefinition?: boolean;
        context?: Array<{ line: number; text: string }>;
      } = {
        file: match.relativePath,
        matchLine: match.lineNumber,
        matchText: match.lineContent ?? "",
      };
      if (match.isDefinition !== undefined) normalized.isDefinition = match.isDefinition;
      const context = normalizeContext(match);
      if (context !== undefined) normalized.context = context;
      return normalized;
    }),
  };
  if (result.value.regexFallbackError) {
    normalized.regexFallbackError = result.value.regexFallbackError;
  }
  return normalized;
}

export async function getFffAvailability(options: FffSearchOptions): Promise<{
  available: boolean;
  reason?: string;
}> {
  const entry = await getEntry(options);
  return entry.state === "ready" ? { available: true } : { available: false, reason: entry.reason };
}

export function clearFffSearchCache(): void {
  const entries = Array.from(cache.values());
  cache.clear();
  for (const entryPromise of entries) {
    void entryPromise.then((entry) => {
      if (entry.state === "ready") entry.finder.destroy();
    });
  }
}
