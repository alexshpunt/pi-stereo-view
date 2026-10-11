import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { compileSearchCondition, compileSearchQuery, satisfiesSearchCondition, type SearchCondition } from "./search-query.js";

/** A matched UTF-16 span in the saved line, before native wrapping and decoration. */
export interface SearchRange { start: number; end: number }
/** One selected saved line with its positive matching spans. */
export interface LineMatch { index: number; ranges: SearchRange[] }

function patterns(condition: SearchCondition): string[] {
  if (condition.kind === "term") return [condition.value];
  return [...patterns(condition.left), ...patterns(condition.right)];
}

function literalMatches(lines: string[], pattern: string): LineMatch[] {
  // These expressions contain only escaped literal terms and our own alternation.
  const expression = new RegExp(pattern, "giu");
  return lines.flatMap((line, index) => {
    const ranges = [...line.matchAll(expression)].map(match => ({ start: match.index, end: match.index + match[0].length }));
    return ranges.length ? [{ index, ranges }] : [];
  });
}

function filterConditions(matches: LineMatch[], condition: SearchCondition | undefined,
  present: Map<string, Set<number>>): LineMatch[] {
  return condition ? matches.filter(hit => satisfiesSearchCondition(condition,
    pattern => present.get(pattern)?.has(hit.index) === true)) : matches;
}

/**
 * Search saved pane lines, case-insensitively. Plain queries and Boolean literal
 * terms stay synchronous. Only explicit regex: queries run in cancellable ripgrep
 * processes (auto engine, including PCRE2), with a deadline for the whole query.
 * No files, shell, fuzzy fallback or partial results are used.
 */
export function matchSearchLines(lines: string[], query: string, signal?: AbortSignal,
  timeoutMs = 1500): LineMatch[] | Promise<LineMatch[]> {
  signal?.throwIfAborted();
  const regex = query.startsWith("regex:");
  const value = (regex ? query.slice(6) : query).trim();
  if (!value) {
    if (regex) throw new Error("Enter a regex after regex:");
    return [];
  }
  if (/[\r\n]/u.test(value)) throw new Error("Search supports one-line queries only.");
  const pattern = compileSearchQuery(value, regex);
  const condition = compileSearchCondition(value, regex);
  if (!regex) {
    const present = new Map<string, Set<number>>();
    if (condition) for (const term of new Set(patterns(condition))) {
      present.set(term, new Set(literalMatches(lines, term).map(hit => hit.index)));
    }
    return filterConditions(literalMatches(lines, pattern), condition, present);
  }
  return regexMatches(lines, pattern, condition, signal, timeoutMs);
}

async function regexMatches(lines: string[], pattern: string, condition: SearchCondition | undefined,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<LineMatch[]> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const input = lines.length ? lines.join("\n") + "\n" : "";
  const present = new Map<string, Set<number>>();
  try {
    if (condition) for (const term of new Set(patterns(condition))) {
      present.set(term, new Set((await ripgrep(input, lines, term, cancellation)).map(hit => hit.index)));
    }
    return filterConditions(await ripgrep(input, lines, pattern, cancellation), condition, present);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted) throw new Error("Regex timed out. Narrow or simplify the query.");
    throw error;
  }
}

function ripgrep(input: string, lines: string[], pattern: string, signal: AbortSignal): Promise<LineMatch[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("rg", ["--json", "--no-config", "--color=never", "--ignore-case", "--engine", "auto", "--text", "--", pattern, "-"],
      { stdio: ["pipe", "pipe", "pipe"] });
    const output = createInterface({ input: child.stdout });
    const matches: LineMatch[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    const fail = (error: Error): void => { failure ??= error; child.kill("SIGKILL"); };
    const abort = (): void => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.on("error", () => { /* close/error reports cancellation or a failed process */ });
    child.stdin.end(input);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 8192); });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) fail(new Error("Regex output is too large. Narrow the query."));
    });
    output.on("line", line => {
      if (failure || signal.aborted) return;
      try {
        const event = JSON.parse(line) as { type: string; data: {
          line_number: number; submatches: { start: number; end: number }[];
        } };
        if (event.type !== "match") return;
        const index = event.data.line_number - 1;
        if (!Number.isSafeInteger(index) || lines[index] === undefined) throw new Error("Invalid ripgrep line index.");
        const source = Buffer.from(lines[index]);
        matches.push({ index, ranges: event.data.submatches.map(range => ({
          start: source.subarray(0, range.start).toString().length,
          end: source.subarray(0, range.end).toString().length,
        })) });
      } catch (error) { fail(new Error("Could not read ripgrep matches.", { cause: error })); }
    });
    const cleanup = (): void => { signal.removeEventListener("abort", abort); output.close(); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `ripgrep exited with code ${code}.`));
      else resolve(matches);
    });
  });
}
