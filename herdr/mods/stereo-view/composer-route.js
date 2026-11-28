const ACTIONS = new Set(["pageup", "pagedown", "home", "end", "search", "dialog-focus"]);
/** How long a `herdr.composer` label counts as a live composer: it is refreshed every three seconds. */
const COMPOSER_LIVE_MS = 10000;

/** Address the keyboard handover to the composer field of one pane (a mod command reaches every shown copy). */
export function composerFieldCommand(pane) {
  if (typeof pane !== "string" || !pane) return undefined;
  return `paste-composer.field:${encodeURIComponent(pane)}:focus`;
}

/** Whether a composer footer is alive for the terminal whose labels these are. */
export function composerAlive(labels, now = Date.now()) {
  const stamp = Number(labels?.["herdr.composer"]);
  return Number.isFinite(stamp) && now - stamp >= -COMPOSER_LIVE_MS && now - stamp <= COMPOSER_LIVE_MS;
}

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
