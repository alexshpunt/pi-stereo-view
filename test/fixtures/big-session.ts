import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { deflateSync } from "node:zlib";

/** What the generated session holds. Every number is reproducible from the seed. */
export interface BigSessionOptions {
  /** User turns; each has an assistant answer with thinking, markdown, code and tool calls. */
  exchanges: number;
  /** Tool calls per turn. */
  callsPerTurn: number;
  /** Every n-th tool result is huge (`hugeLines` lines, some very long). 0 = never. */
  hugeEvery: number;
  hugeLines: number;
  /** Every n-th assistant answer carries a long fenced code block of `codeLines` lines. 0 = never. */
  codeEvery: number;
  codeLines: number;
  /** Every n-th tool result carries a PNG image. 0 = never. */
  imageEvery: number;
  seed: number;
}

export const SIZES = {
  /** A few seconds to generate; fast enough for unit-level checks. */
  small: { exchanges: 300, callsPerTurn: 3, hugeEvery: 40, hugeLines: 800, codeEvery: 5, codeLines: 60, imageEvery: 60, seed: 1 },
  /** Thousands of messages and tool calls: the benchmark default. */
  large: { exchanges: 3000, callsPerTurn: 4, hugeEvery: 50, hugeLines: 3000, codeEvery: 4, codeLines: 120, imageEvery: 100, seed: 1 },
  /** A very long real-world session (tens of thousands of rows per panel). */
  huge: { exchanges: 8000, callsPerTurn: 5, hugeEvery: 40, hugeLines: 6000, codeEvery: 3, codeLines: 200, imageEvery: 150, seed: 1 },
} satisfies Record<string, BigSessionOptions>;

export type BigSessionSize = keyof typeof SIZES;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ("render panel history wrap width cursor frame page cache index document native socket bridge viewport scroll " +
  "settle measure block entry row cell line token stream session message tool result output markdown theme color layout " +
  "resize divider toolbar header activity conversation search jump latest follow terminal pane focus input paste image").split(" ");

function sentence(random: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(random() * WORDS.length)]!);
  const text = out.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

function paragraph(random: () => number, sentences: number): string {
  return Array.from({ length: sentences }, () => sentence(random, 6 + Math.floor(random() * 14))).join(" ");
}

function codeBlock(random: () => number, lines: number, tag: string): string {
  const body: string[] = [];
  for (let i = 0; i < lines; i++) {
    const indent = "  ".repeat(Math.floor(random() * 4));
    const kind = Math.floor(random() * 5);
    body.push(kind === 0 ? `${indent}const ${WORDS[i % WORDS.length]}${i} = await load("${tag}/${i}.ts", { width: ${Math.floor(random() * 300)} });`
      : kind === 1 ? `${indent}if (${WORDS[(i * 7) % WORDS.length]}${i} > ${Math.floor(random() * 1000)}) { return render(${WORDS[(i * 3) % WORDS.length]}); }`
      : kind === 2 ? `${indent}// ${sentence(random, 8 + Math.floor(random() * 20))}`
      : kind === 3 ? `${indent}export function ${WORDS[(i * 5) % WORDS.length]}${i}(a: number, b: string): Promise<void> { return Promise.resolve(); }`
      : `${indent}results.push({ id: ${i}, name: "${WORDS[(i * 11) % WORDS.length]}", value: [${Array.from({ length: 6 }, () => Math.floor(random() * 99999)).join(", ")}] });`);
  }
  return "```ts\n" + body.join("\n") + "\n```";
}

function toolOutput(random: () => number, lines: number, tag: string): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    // A few percent of the lines are long enough to wrap several times at typical panel widths.
    const long = random() < 0.04;
    out.push(`${tag} line ${i}: ` + (long ? sentence(random, 60 + Math.floor(random() * 60)) : sentence(random, 3 + Math.floor(random() * 10))));
  }
  return out.join("\n");
}

let cachedPng: string | undefined;
/** A valid PNG (gradient plus noise, ~150-250 KB) so images carry real payload through the bridge. */
export function samplePng(width = 480, height = 320): string {
  if (cachedPng) return cachedPng;
  const random = rng(7);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255 / width) | 0;
      row[2 + x * 3] = (y * 255 / height) | 0;
      row[3 + x * 3] = (random() * 255) | 0;
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer: Buffer): number => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  cachedPng = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 1 })), chunk("IEND", Buffer.alloc(0))]).toString("base64");
  return cachedPng;
}

function savedAssistant(content: AssistantMessage["content"], at: number): AssistantMessage {
  return {
    role: "assistant", content, timestamp: at, api: "openai-responses", provider: "openai", model: "synthetic-bench",
    stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
    usage: { input: 1200, output: 340, cacheRead: 90000, cacheWrite: 800, totalTokens: 92340,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.01, total: 0.07 } },
  };
}

export interface BigSessionStats { messages: number; toolCalls: number; hugeResults: number; codeBlocks: number; images: number; textBytes: number }

/** Append a deterministic large history: markdown, long code blocks, many tool calls, huge outputs and images. */
export function appendBigSession(manager: SessionManager, options: BigSessionOptions): BigSessionStats {
  const random = rng(options.seed);
  const stats: BigSessionStats = { messages: 0, toolCalls: 0, hugeResults: 0, codeBlocks: 0, images: 0, textBytes: 0 };
  const start = Date.parse("2026-01-01T10:00:00Z");
  let clock = start;
  const text = (value: string): string => { stats.textBytes += value.length; return value; };
  for (let index = 0; index < options.exchanges; index++) {
    clock += 20_000 + Math.floor(random() * 90_000);
    manager.appendMessage({ role: "user", timestamp: clock, content: text(`Task ${index}: ${paragraph(random, 1 + Math.floor(random() * 3))}\n\n${
      random() < 0.3 ? `- ${sentence(random, 8)}\n- ${sentence(random, 9)}\n- ${sentence(random, 7)}\n` : sentence(random, 12)}`) });
    stats.messages++;
    const blocks: AssistantMessage["content"] = [
      { type: "thinking", thinking: text(`Plan ${index}.\n${paragraph(random, 2)}\n${paragraph(random, 2)}`) },
    ];
    let answer = `## Step ${index}\n\n${paragraph(random, 2 + Math.floor(random() * 3))}\n\n- **${sentence(random, 4)}** ${sentence(random, 10)}\n- \`${WORDS[index % WORDS.length]}\` ${sentence(random, 9)}\n- [link ${index}](https://example.invalid/${index}) ${sentence(random, 8)}\n\n${paragraph(random, 3)}`;
    if (options.codeEvery && index % options.codeEvery === 0) { answer += "\n\n" + codeBlock(random, options.codeLines, `src/${index}`); stats.codeBlocks++; }
    blocks.push({ type: "text", text: text(answer) });
    const calls = Array.from({ length: options.callsPerTurn }, (_, call) => {
      const kind = ["bash", "read", "codemode", "bash", "write"][(index + call) % 5]!;
      const id = `call-${index}-${call}`;
      const args: Record<string, string> = kind === "codemode" ? { code: text(codeBlock(random, 20 + Math.floor(random() * 60), `cm/${index}/${call}`).replace(/^```ts\n|\n```$/g, "")) }
        : kind === "bash" ? { command: text(`rg -n "${WORDS[(index + call) % WORDS.length]}" src test | head -${20 + call}`) }
        : kind === "write" ? { path: `src/gen/${index}-${call}.ts`, content: text(codeBlock(random, 30, "w").replace(/^```ts\n|\n```$/g, "")) }
        : { path: `src/gen/${index}-${call}.ts` };
      return { id, kind, args };
    });
    for (const call of calls) blocks.push({ type: "toolCall", id: call.id, name: call.kind, arguments: call.args });
    clock += 3000;
    manager.appendMessage(savedAssistant(blocks, clock));
    stats.messages++;
    for (const [number, call] of calls.entries()) {
      stats.toolCalls++;
      const serial = index * options.callsPerTurn + number;
      const huge = options.hugeEvery > 0 && serial % options.hugeEvery === 0;
      if (huge) stats.hugeResults++;
      const lines = huge ? options.hugeLines : 4 + Math.floor(random() * 50);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: text(toolOutput(random, lines, `out ${serial}`)) }];
      if (options.imageEvery > 0 && serial % options.imageEvery === 0) { content.push({ type: "image", data: samplePng(), mimeType: "image/png" }); stats.images++; }
      clock += 400 + Math.floor(random() * 4000);
      manager.appendMessage({ role: "toolResult", toolName: call.kind, toolCallId: call.id, isError: false, content, timestamp: clock });
      stats.messages++;
    }
    clock += 2000;
    manager.appendMessage(savedAssistant([{ type: "text", text: text(`Done ${index}. ${paragraph(random, 1 + Math.floor(random() * 2))}`) }], clock));
    stats.messages++;
  }
  return stats;
}
