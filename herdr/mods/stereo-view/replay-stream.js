// LPT-1943: a `spawnStream` stand-in for development: it replays a recorded stream (scripts/bench/record-stream.mjs)
// and answers `get` from the recorded bodies. The live app uses it until herdr-app's streaming process API exists;
// tests and the benchmark can use it too. Same interface: { onLine(cb), onExit(cb), write(line), kill() }.

// The mod shell has no setTimeout: replies are delivered on a microtask, after the caller has subscribed.
const defer = fn => { Promise.resolve().then(fn); };

/** @param {string} recording JSON lines: snapshot chunks, then body messages. */
export function createReplayStream(recording) {
  const lineCallbacks = [], exitCallbacks = [];
  /** id -> [start, end) of the recorded `B` line that holds its body; parsed only when asked for. */
  const where = new Map();
  const snaps = [];
  for (let from = 0; from < recording.length;) {
    let to = recording.indexOf("\n", from);
    if (to < 0) to = recording.length;
    if (recording.charCodeAt(from) === 66 && recording.charCodeAt(from + 1) === 9) { // "B\t"
      const idsEnd = recording.indexOf("\t", from + 2);
      for (const id of recording.slice(from + 2, idsEnd).split(",")) where.set(id, [idsEnd + 1, to]);
    } else if (to > from) {
      const line = recording.slice(from, to);
      if (line.startsWith("{\"t\":\"snap\"")) snaps.push(line);
    }
    from = to + 1;
  }
  const bodies = { has: id => where.has(id), get: id => { const [a, b] = where.get(id); return JSON.parse(recording.slice(a, b)).bodies[id]; } };
  const emit = line => { for (const callback of lineCallbacks) callback(line); };
  let killed = false;
  const stream = {
    onLine(callback) {
      lineCallbacks.push(callback);
      // The snapshot arrives after the caller has subscribed, as from a real process.
      if (lineCallbacks.length === 1) defer(() => { for (const line of snaps) if (!killed) emit(line); });
    },
    onExit(callback) { exitCallbacks.push(callback); },
    write(line) {
      if (killed) return;
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (request.op === "get") {
        const found = {};
        const parsed = new Map(); // each recorded line once per request, not once per id
        for (const id of request.ids ?? []) {
          if (!bodies.has(id)) continue;
          const [a, b] = where.get(id);
          let line = parsed.get(a);
          if (!line) { line = JSON.parse(recording.slice(a, b)).bodies; parsed.set(a, line); }
          found[id] = line[id];
        }
        defer(() => emit(JSON.stringify({ t: "bodies", rq: request.rq, bodies: found })));
      } else if (request.op === "rows") defer(() => emit(JSON.stringify({ t: "rows", rq: request.rq, id: request.id, lines: [] })));
      else if (request.op === "resync") defer(() => { for (const line of snaps) emit(line); });
    },
    kill() { killed = true; for (const callback of exitCallbacks) callback(0); },
  };
  return stream;
}
/**
 * `spawnStream` over recordings served at `base` (`<base><pane>.jsonl`, pane = the relay's last argument).
 * @param {string} base @param {(url: string) => Promise<string>} load
 */
export function replaySpawn(base, load) {
  return (_command, args) => {
    const url = `${base}${args[args.length - 1]}.jsonl`;
    let inner = null, killed = false;
    const lineCallbacks = [], exitCallbacks = [], queued = [];
    load(url).then(text => {
      if (killed) return;
      inner = createReplayStream(typeof text === "string" ? text : String(text));
      for (const cb of lineCallbacks) inner.onLine(cb);
      for (const cb of exitCallbacks) inner.onExit(cb);
      for (const line of queued) inner.write(line);
    }).catch(error => { for (const cb of exitCallbacks) cb(1, `replay failed: ${error}`); });
    return {
      onLine(cb) { lineCallbacks.push(cb); inner?.onLine(cb); },
      onExit(cb) { exitCallbacks.push(cb); inner?.onExit(cb); },
      write(line) { if (inner) inner.write(line); else queued.push(line); },
      kill() { killed = true; inner?.kill(); },
    };
  };
}
