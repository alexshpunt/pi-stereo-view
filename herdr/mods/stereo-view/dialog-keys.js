// Translate Herdr keystrokes into the terminal input Pi's native components consume.
export function dialogKey(event) {
  const key = String(event.key ?? "").toLowerCase().replace(/^arrow(up|down|left|right)$/, "$1");
  const modifiers = event.modifiers ?? {};
  const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.control ? 4 : 0);
  const arrows = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
  if (arrows[key]) return modifier === 1 ? `\x1b[${arrows[key]}` : `\x1b[1;${modifier}${arrows[key]}`;
  const special = { escape: "\x1b", enter: "\r", return: "\r", tab: "\t", backspace: "\x7f", delete: "\x1b[3~", pageup: "\x1b[5~", pagedown: "\x1b[6~" };
  if (key === "tab" && modifiers.shift) return "\x1b[Z";
  if (special[key]) return special[key];
  if (modifiers.control && /^[a-z]$/.test(key)) return String.fromCharCode(key.charCodeAt(0) - 96);
  if (modifiers.control || modifiers.platform) return undefined;
  const text = typeof event.key_char === "string" ? event.key_char : key.length === 1 ? event.key : undefined;
  if (!text) return undefined;
  return (modifiers.alt ? "\x1b" : "") + text;
}
