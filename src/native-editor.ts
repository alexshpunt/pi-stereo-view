import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type Host = { ui?: unknown; renderer?: unknown; editor?: Component };
type Boundary = "createExtensionUIContext" | "rebuildChatFromMessages";
type Prototype = Partial<Record<Boundary, (this: Host, ...args: unknown[]) => unknown>>;

/**
 * Observe the native editor identity at UI binding or reload's history rebuild.
 * No dialog APIs, factories, components or focus are wrapped. Unknown hosts stay native.
 */
export function observeNativeEditor(): { get(tui: TUI): Component | undefined; dispose(): void } {
  const prototype = InteractiveMode.prototype as unknown as Prototype;
  const restorers: Array<() => void> = [];
  let owner: Host | undefined;
  let active = true;
  const restore = (): void => { for (const release of restorers) release(); };
  for (const name of ["createExtensionUIContext", "rebuildChatFromMessages"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const original = prototype[name];
    if (typeof original !== "function" || !descriptor?.writable) continue;
    function observe(this: Host, ...args: unknown[]): unknown {
      const result = original!.apply(this, args);
      // A later wrapper can retain this trampoline after cancellation.
      if (active && this.editor && typeof this.editor.render === "function" &&
          typeof this.editor.invalidate === "function" && (this.ui || this.renderer)) {
        owner = this;
        restore();
      }
      return result;
    }
    restorers.push(() => {
      if (prototype[name] === observe) Object.defineProperty(prototype, name, descriptor);
    });
    prototype[name] = observe;
  }
  return {
    get: tui => active && owner && (owner.ui === tui || owner.renderer === tui) ? owner.editor : undefined,
    dispose: () => { active = false; owner = undefined; restore(); },
  };
}
