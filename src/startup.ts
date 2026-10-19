import { InteractiveMode, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, type TUI } from "@earendil-works/pi-tui";

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
