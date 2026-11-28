const ACTIONS = new Set(["pageup", "pagedown", "home", "end", "search"]);

/** Accept a broadcast only when it names this exact pane and a known action. */
export function composerRoute(command, pane) {
  if (typeof command !== "string" || typeof pane !== "string") return undefined;
  const parts = command.split(":");
  if (parts.length !== 3 || parts[0] !== "composer" || !ACTIONS.has(parts[2])) return undefined;
  try {
    return decodeURIComponent(parts[1]) === pane ? parts[2] : undefined;
  } catch {
    return undefined;
  }
}
