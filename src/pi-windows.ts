import * as pi from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type Matcher = (component: Component) => boolean;

/**
 * Match components by class. Pi's bundle keeps class names, so a name matches even a class Pi does not export and a
 * component built by another copy of Pi's package; `instanceof` against the exported classes also matches subclasses.
 */
function byClass(names: readonly string[]): Matcher {
  const known = new Set(names);
  // A namespace import keeps the extension loading on Pi versions that lack one of these exports.
  const exported = names.map(name => (pi as Record<string, unknown>)[name])
    .filter((value): value is abstract new (...args: never[]) => unknown => typeof value === "function");
  return component => exported.some(type => component instanceof type) || known.has(component.constructor.name);
}

/**
 * Pi's own windows, such as the session tree, model and session pickers, settings and the `/login` menu. Pi opens them
 * only for the user: by command, double Escape or key binding. `TrustSelectorComponent`, `ScopedModelsSelectorComponent`
 * and `RadiusLoginMenuComponent` are not exported and match by name.
 */
const piWindow = byClass([
  "TreeSelectorComponent", "UserMessageSelectorComponent", "SessionSelectorComponent", "ModelSelectorComponent",
  "ScopedModelsSelectorComponent", "SettingsSelectorComponent", "ThemeSelectorComponent", "ThinkingSelectorComponent",
  "ShowImagesSelectorComponent", "TrustSelectorComponent", "OAuthSelectorComponent", "LoginDialogComponent",
  "RadiusLoginMenuComponent",
]);

/**
 * Pi's general dialogs. Pi asks its windows' follow-up questions in them, such as "Summarize branch?" after a tree
 * selection or a login prompt, and extensions open them through `ctx.ui.select`, `input` and `editor`.
 */
const generalDialog = byClass(["ExtensionSelectorComponent", "ExtensionInputComponent", "ExtensionEditorComponent"]);

/**
 * Whether Pi's editor slot shows one of Pi's own windows or a chain of windows that one started. Pi swaps a window for
 * its follow-up question within one tick, so the message editor never reaches a frame in between; `previous` is this
 * result for the previous frame. A general dialog that replaces a Pi window directly continues the chain, even an
 * extension's `select`, which then shows at full width as well. Extension dialogs opened over the message editor,
 * including the agent's questions through `ask_user` and tool confirmations, never count: Stereo cannot tell whether
 * the user or the agent opened them.
 */
export function showsPiWindow(component: Component | undefined, previous: boolean): boolean {
  return !!component && (piWindow(component) || (previous && generalDialog(component)));
}
