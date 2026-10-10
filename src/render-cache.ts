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
// Custom renderer state follows invalidate instead.
const inputs = ["text", "paddingX", "paddingY", "customBgFn", "bgFn", "theme", "cachedText", "cachedWidth", "cachedLines"];
const shellInputs = ["lastMessage", "args", "result", "isPartial", "expanded", "outputPad",
  "hideComponent", "showImages", "imageWidthCells"];
interface NodeState {
  component: Component;
  render: Component["render"];
  box: boolean;
  background: unknown;
  values: unknown[];
  children?: Component[];
  members: Component[];
  child?: Component;
  wrapped?: Component;
}
interface State { nodes: NodeState[]; shell: unknown[] }

function isBox(component: Component): boolean {
  for (let prototype = Object.getPrototypeOf(component); prototype; prototype = Object.getPrototypeOf(prototype)) {
    if (prototype.constructor?.name === "Box") return true;
  }
  return false;
}

function background(component: Component): unknown {
  const color = Reflect.get(component, "bgFn") as ((text: string) => string) | undefined;
  return color?.("test");
}

function snapshot(root: Component): State {
  const seen = new Set<Component>();
  const nodes: NodeState[] = [];
  const visit = (component: Component): void => {
    if (seen.has(component)) return;
    seen.add(component);
    const children = Reflect.get(component, "children") as Component[] | undefined;
    const child = Reflect.get(component, "child") as Component | undefined;
    const wrapped = Reflect.get(component, "component") as Component | undefined;
    const members = Array.isArray(children) ? children.slice() : [];
    const box = isBox(component);
    nodes.push({ component, render: component.render, values: inputs.map(key => Reflect.get(component, key)),
      box, background: box ? background(component) : undefined, children, members, child, wrapped });
    for (const next of [...members, child, wrapped]) if (next && typeof next.render === "function") visit(next);
  };
  visit(root);
  return { nodes, shell: shellInputs.map(key => Reflect.get(root, key)) };
}

function matches(root: Component, state: State): boolean {
  if (shellInputs.some((key, index) => Reflect.get(root, key) !== state.shell[index])) return false;
  for (const node of state.nodes) {
    const { component } = node;
    if (component.render !== node.render || component.invalidate !== subscriptions.get(component)?.wrapped ||
      inputs.some((key, index) => Reflect.get(component, key) !== node.values[index]) ||
      Reflect.get(component, "child") !== node.child || Reflect.get(component, "component") !== node.wrapped ||
      (node.box && background(component) !== node.background)) return false;
    const children = Reflect.get(component, "children") as Component[] | undefined;
    if (children !== node.children || (Array.isArray(children) && (children.length !== node.members.length ||
      children.some((child, index) => child !== node.members[index])))) return false;
  }
  return true;
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
  private cached?: { width: number; theme: object; state: State; lines: string[] };

  constructor(private readonly component: Component) {}

  private watch(nodes: NodeState[]): boolean {
    const present = new Set(nodes.map(node => node.component));
    for (const [component, stop] of this.watched) if (!present.has(component)) {
      stop();
      this.watched.delete(component);
    }
    let observable = true;
    for (const component of present) {
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
    const cached = this.cached;
    if (cached?.width === width && cached.theme === theme && matches(this.component, cached.state)) return cached.lines;
    this.cached = undefined;
    const initial = snapshot(this.component);
    this.watch(initial.nodes);
    const before = this.revision;
    const lines = this.component.render(width);
    const after = snapshot(this.component);
    const stableGraph = initial.nodes.length === after.nodes.length &&
      after.nodes.every((node, index) => node.component === initial.nodes[index].component);
    // A newly created child could invalidate during its first render, before observation.
    if (this.watch(after.nodes) && stableGraph && this.revision === before &&
      !lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) {
      this.cached = { width, theme, state: after, lines };
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
