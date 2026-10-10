import type { Component } from "@earendil-works/pi-tui";

interface Subscription {
  original: Component["invalidate"];
  own?: PropertyDescriptor;
  wrapped: Component["invalidate"];
  listeners: Set<() => void>;
}
const subscriptions = new WeakMap<Component, Subscription>();

function subscribe(component: Component, changed: () => void): (() => void) | undefined {
  let entry = subscriptions.get(component);
  if (entry && component.invalidate !== entry.wrapped) return undefined;
  if (!entry) {
    const original = component.invalidate;
    const listeners = new Set<() => void>();
    const wrapped = function (this: Component): void {
      for (const listener of listeners) listener();
      original.call(this);
    };
    const own = Object.getOwnPropertyDescriptor(component, "invalidate");
    try { component.invalidate = wrapped; }
    catch { return undefined; }
    entry = { original, own, wrapped, listeners };
    subscriptions.set(component, entry);
  }
  entry.listeners.add(changed);
  const subscribed = entry;
  return () => {
    subscribed.listeners.delete(changed);
    if (subscribed.listeners.size) return;
    if (component.invalidate === subscribed.wrapped) {
      if (subscribed.own) Object.defineProperty(component, "invalidate", subscribed.own);
      else Reflect.deleteProperty(component, "invalidate");
    }
    subscriptions.delete(component);
  };
}

// Native setters can rebuild children or clear Text/Markdown caches without calling invalidate.
// These inputs describe that native shell; custom renderer state follows invalidate instead.
const inputs = ["text", "paddingX", "paddingY", "customBgFn", "bgFn", "theme", "lastMessage",
  "args", "result", "isPartial", "expanded", "outputPad", "hideComponent", "showImages", "imageWidthCells"];

function snapshot(root: Component): { nodes: Set<Component>; values: unknown[] } {
  const nodes = new Set<Component>();
  const values: unknown[] = [];
  const visit = (component: Component): void => {
    if (nodes.has(component)) return;
    nodes.add(component);
    values.push(component, component.render);
    for (const key of inputs) values.push(Reflect.get(component, key));
    const children = Reflect.get(component, "children") as unknown;
    if (Array.isArray(children)) {
      values.push(children, children.length, ...children);
      for (const child of children) if (child && typeof child.render === "function") visit(child);
    }
    // MouseRegion and native framing wrappers own one child outside Container.children.
    for (const key of ["child", "component"]) {
      const child = Reflect.get(component, key) as Component | undefined;
      values.push(child);
      if (child && typeof child.render === "function") visit(child);
    }
  };
  visit(root);
  return { nodes, values };
}

/**
 * Reuse a native block by width, theme, shell inputs and component invalidation.
 * Native state changes must invalidate before requesting a frame. Images and
 * unobservable components always render. Dispose restores subscribed methods.
 */
export class NativeRenderCache {
  private revision = 0;
  private readonly changed = (): void => { this.revision++; this.cached = undefined; };
  private readonly watched = new Map<Component, () => void>();
  private cached?: { width: number; theme: object; values: unknown[]; lines: string[] };

  constructor(private readonly component: Component) {}

  private watch(nodes: Set<Component>): boolean {
    for (const [component, stop] of this.watched) if (!nodes.has(component)) {
      stop();
      this.watched.delete(component);
    }
    let observable = true;
    for (const component of nodes) {
      if (!this.watched.has(component)) {
        const stop = subscribe(component, this.changed);
        if (stop) this.watched.set(component, stop);
        else observable = false;
      } else if (component.invalidate !== subscriptions.get(component)?.wrapped) observable = false;
    }
    return observable;
  }

  /** Render current native state, or reuse only an unchanged, observable block. */
  render(width: number, theme: object): string[] {
    const state = snapshot(this.component);
    const observable = this.watch(state.nodes);
    const cached = this.cached;
    if (observable && cached?.width === width && cached.theme === theme &&
      cached.values.length === state.values.length && state.values.every((value, index) => value === cached.values[index])) {
      return cached.lines;
    }
    this.cached = undefined;
    const before = this.revision;
    const lines = this.component.render(width);
    const after = snapshot(this.component);
    if (this.watch(after.nodes) && this.revision === before &&
      !lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) {
      this.cached = { width, theme, values: after.values, lines };
    }
    return lines;
  }

  /** Clear output and remove only this cache's native invalidation subscribers. */
  dispose(): void {
    this.cached = undefined;
    for (const stop of this.watched.values()) stop();
    this.watched.clear();
  }
}
