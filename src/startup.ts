import { InteractiveMode, type ExtensionContext, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, type TUI } from "@earendil-works/pi-tui";

/** Resolve nested tools through the same interactive host that renders ordinary calls. */
export function captureToolRenderers(): { install(): void; resolve(name: string): ToolRenderers | undefined; dispose(): void } {
  const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
  let owner: unknown;
  let original: ((this: unknown, name: string) => ToolRenderers | undefined) | undefined;
  let wrapper: ((this: unknown, name: string) => ToolRenderers | undefined) | undefined;
  let stop = (): void => {};
  return {
    install() {
      if (wrapper) return;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "getRegisteredToolDefinition");
      if (!descriptor?.writable || typeof descriptor.value !== "function") return;
      const previous = descriptor.value as (this: unknown, name: string) => ToolRenderers | undefined;
      original = previous;
      let active = true;
      stop = () => { active = false; };
      wrapper = function (this: unknown, name: string) { if (active) owner = this; return previous.call(this, name); };
      prototype.getRegisteredToolDefinition = wrapper;
    },
    resolve(name) { return owner && original ? original.call(owner, name) : undefined; },
    dispose() {
      stop();
      if (wrapper && prototype.getRegisteredToolDefinition === wrapper) prototype.getRegisteredToolDefinition = original;
      owner = undefined; wrapper = undefined; original = undefined;
    },
  };
}
type Ui = ExtensionContext["ui"];
type Session = ExtensionContext["sessionManager"];
type StartupHost = {
  isInitialized?: boolean;
  renderer?: TUI;
  sessionManager?: Session;
  createExtensionUIContext?: () => Ui;
};

/** Mount once before the first native frame; restore only hooks still owned by this extension. */
export function beforeFirstFrame(mount: (tui: TUI, ui: Ui, session: Session) => () => void): () => void {
  const prototype = InteractiveMode.prototype;
  const original = prototype.init;
  const initDescriptor = Object.getOwnPropertyDescriptor(prototype, "init");
  if (typeof original !== "function" || !initDescriptor?.writable) return () => {};
  let pending: typeof mount | undefined = mount;
  let restoreStart = (): void => {};
  const release = (): void => {
    pending = undefined;
    if (prototype.init === initialize) prototype.init = original;
    restoreStart();
  };
  async function initialize(this: InteractiveMode): Promise<void> {
    const mountLayout = pending;
    release();
    // A later wrapper may retain this trampoline. Cancellation makes it inert without clobbering that wrapper.
    if (!mountLayout) return original.call(this);
    const owner = this as unknown as StartupHost;
    const tui = owner.renderer;
    const session = owner.sessionManager;
    // Unsupported hosts keep native startup. Never patch a regular renderer or invent a context.
    if (owner.isInitialized !== false || !tui || !isViewportTUI(tui) ||
        typeof owner.createExtensionUIContext !== "function" ||
        typeof session?.buildContextEntries !== "function" || typeof session.getBranch !== "function") {
      return original.call(this);
    }
    const ui = owner.createExtensionUIContext();
    if (typeof ui?.theme?.style !== "function" || typeof ui.notify !== "function") return original.call(this);
    const start = tui.start;
    const descriptor = Object.getOwnPropertyDescriptor(tui, "start");
    if (typeof start !== "function" || (descriptor ? !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(tui))) {
      return original.call(this);
    }
    let dispose: (() => void) | undefined;
    restoreStart = (): void => {
      if (tui.start !== startWithLayout) return;
      if (descriptor) Object.defineProperty(tui, "start", descriptor);
      else delete (tui as Partial<TUI>).start;
    };
    function startWithLayout(this: TUI): void {
      restoreStart();
      try { dispose = mountLayout!(tui!, ui, session!); }
      catch (error) { ui.notify("pi-stereo-view early layout is unavailable: " + String(error), "warning"); }
      start.call(this);
    }
    tui.start = startWithLayout;
    try {
      await original.call(this);
    } catch (error) {
      dispose?.();
      throw error;
    } finally {
      restoreStart();
    }
  }
  prototype.init = initialize;
  return release;
}
