import { createOpencodeRuntime, type OpencodeRuntime } from "@ralph-rlm/engine";

let cached: OpencodeRuntime | undefined;

export function getOpencodeRuntime(): OpencodeRuntime {
  if (!cached) {
    const baseUrl = process.env.OPENCODE_BASE_URL;
    cached = createOpencodeRuntime(baseUrl ? { baseUrl } : {});
  }
  return cached;
}