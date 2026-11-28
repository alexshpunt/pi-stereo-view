import { createHash } from "node:crypto";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface GuiImagePlacement {
  id: string; row: number; column: number; rows: number; columns: number; mime: string;
}
const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_STORE = 64 * 1024 * 1024;
const kitty = /\x1b_G([^;]*);([A-Za-z0-9+/=]*)\x1b\\/g;
const iterm = /(?:\x1b\[(\d+)A)?\x1b\]1337;File=([^:]*):([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;

/** Extract terminal image placements, keeping binary data out of viewport responses. */
export class GuiImages {
  private readonly data = new Map<string, string>();
  private readonly known = new Map<string, { id: string; mime: string }>();
  private size = 0;

  page(lines: readonly string[], top: number, height: number, onlyId?: string): { lines: string[]; images: GuiImagePlacement[] } {
    const result: GuiImagePlacement[] = [];
    const end = top + height;
    const sanitized = lines.slice(top, end).map(line => line.replace(kitty, "").replace(iterm, ""));
    // Image rows may start above or end below the viewport, so inspect the full native frame.
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row]!;
      if (!line.includes("\x1b_G") && !line.includes("\x1b]1337;File=")) continue;
      kitty.lastIndex = 0;
      const sequences = [...line.matchAll(kitty)];
      for (let i = 0; i < sequences.length; i++) {
        const first = sequences[i]!;
        const controls = first[1]!;
        if (!/(?:^|,)a=T(?:,|$)/.test(controls)) continue;
        const columns = numberControl(controls, "c") ?? 1;
        const rows = numberControl(controls, "r") ?? 1;
        let payload = first[2]!;
        let more = numberControl(controls, "m") === 1;
        while (more && i + 1 < sequences.length) {
          const next = sequences[++i]!;
          payload += next[2]!;
          more = numberControl(next[1]!, "m") === 1;
        }
        if (more || row >= end || row + rows <= top) continue;
        const placement = this.add(payload, row, visibleWidth(line.slice(0, first.index)), rows, columns, onlyId);
        if (placement) result.push(placement);
      }
      iterm.lastIndex = 0;
      for (const match of line.matchAll(iterm)) {
        const rows = Number(match[1] ?? 0) + 1;
        const start = row - rows + 1;
        const columns = Number(/(?:^|;)width=(\d+)/.exec(match[2]!)?.[1] ?? 1);
        if (start >= end || row < top) continue;
        const placement = this.add(match[3]!, start, visibleWidth(line.slice(0, match.index)), rows, columns, onlyId);
        if (placement) result.push(placement);
      }
    }
    return { lines: sanitized, images: result };
  }

  chunk(id: string, offset: number, length: number): { data: string; total: number } | undefined {
    const data = this.data.get(id);
    if (!data || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 524288) return undefined;
    return { data: data.slice(offset, offset + length), total: data.length };
  }

  private add(payload: string, row: number, column: number, rows: number, columns: number, onlyId?: string): GuiImagePlacement | undefined {
    if (payload.length > MAX_IMAGE * 4 / 3 + 4 || rows < 1 || rows > 4096 || columns < 1 || columns > 4096) return;
    const cached = this.known.get(payload);
    if (cached && this.data.has(cached.id)) return !onlyId || cached.id === onlyId ? { ...cached, row, column, rows, columns } : undefined;
    const bytes = Buffer.from(payload, "base64");
    const mime = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp"
      : bytes.subarray(0, 3).toString("ascii") === "GIF" ? "image/gif" : undefined;
    if (!mime) return;
    const id = createHash("sha256").update(bytes).digest("hex");
    if (onlyId && id !== onlyId) return;
    if (!this.data.has(id)) { this.data.set(id, payload); this.known.set(payload, { id, mime }); this.size += payload.length; }
    while (this.size > MAX_STORE && this.data.size > 1) {
      const oldest = this.data.keys().next().value!;
      const removed = this.data.get(oldest)!;
      this.size -= removed.length;
      this.known.delete(removed);
      this.data.delete(oldest);
    }
    return { id, row, column, rows, columns, mime };
  }
}

function numberControl(controls: string, key: string): number | undefined {
  const value = new RegExp(`(?:^|,)${key}=(\\d+)(?:,|$)`).exec(controls)?.[1];
  return value === undefined ? undefined : Number(value);
}
