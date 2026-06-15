export function nowISO(): string {
  return new Date().toISOString();
}

export function clampLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n\n…(truncated to ${maxLines} lines)…\n`;
}

/**
 * Replace {{token}} placeholders in a template string.
 * Unknown tokens are left as-is so partial application is safe.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export function extractHeadings(md: string, max: number): string {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) out.push(line.trim());
    if (out.length >= max) break;
  }
  return out.join("\n");
}

export function regexFromQuery(query: string): RegExp {
  const slashForm = query.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashForm) {
    const [, pattern, flagsRaw] = slashForm;
    const flags = Array.from(new Set((flagsRaw ?? "").split(""))).join("");
    return new RegExp(pattern ?? "", flags.includes("i") ? flags : `${flags}i`);
  }
  try {
    return new RegExp(query, "i");
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
}