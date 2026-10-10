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

function components(root: Component): Component[] {
  const seen = new Set<Component>();
  const nodes: Component[] = [];
  const visit = (component: Component): void => {
    if (seen.has(component)) return;
    seen.add(component);
    nodes.push(component);
    const children = Reflect.get(component, "children") as Component[] | undefined;
    if (Array.isArray(children)) for (const child of children) if (child && typeof child.render === "function") visit(child);
    for (const key of ["child", "component"]) {
      const child = Reflect.get(component, key) as Component | undefined;
      if (child && typeof child.render === "function") visit(child);
    }
  };
  visit(root);
  return nodes;
}

function snapshot(root: Component, nodes: Component[]): State {
  return {
    nodes: nodes.map(component => {
      const children = Reflect.get(component, "children") as Component[] | undefined;
      const box = isBox(component);
      return { component, render: component.render, values: inputs.map(key => Reflect.get(component, key)),
        box, background: box ? background(component) : undefined, children,
        members: Array.isArray(children) ? children.slice() : [],
        child: Reflect.get(component, "child") as Component | undefined,
        wrapped: Reflect.get(component, "component") as Component | undefined };
    }),
    shell: shellInputs.map(key => Reflect.get(root, key)),
  };
}

function matches(root: Component, state: State): boolean {
  for (let index = 0; index < shellInputs.length; index++) {
    if (Reflect.get(root, shellInputs[index]) !== state.shell[index]) return false;
  }
  for (const node of state.nodes) {
    const { component } = node;
    if (component.render !== node.render || component.invalidate !== subscriptions.get(component)?.wrapped ||
      Reflect.get(component, "child") !== node.child || Reflect.get(component, "component") !== node.wrapped ||
      (node.box && background(component) !== node.background)) return false;
    for (let index = 0; index < inputs.length; index++) {
      if (Reflect.get(component, inputs[index]) !== node.values[index]) return false;
    }
    const children = Reflect.get(component, "children") as Component[] | undefined;
    if (children !== node.children) return false;
    if (Array.isArray(children)) {
      if (children.length !== node.members.length) return false;
      for (let index = 0; index < children.length; index++) {
        if (children[index] !== node.members[index]) return false;
      }
    }
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
  private outputVersion = 0;
  private readonly changed = (): void => { this.revision++; this.cached = undefined; };
  private readonly watched = new Map<Component, () => void>();
  private cached?: { width: number; theme: object; state: State; lines: string[] };

  constructor(private readonly component: Component) {}

  /** Changes after each native render, even when it reuses a mutable row array. */
  get version(): number { return this.outputVersion; }

  private watch(nodes: Component[]): boolean {
    const present = new Set(nodes);
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
    const initial = components(this.component);
    this.watch(initial);
    const before = this.revision;
    const lines = this.component.render(width);
    this.outputVersion++;
    const after = components(this.component);
    const stableGraph = initial.length === after.length &&
      after.every((component, index) => component === initial[index]);
    // A newly created child could invalidate during its first render, before observation.
    if (this.watch(after) && stableGraph && this.revision === before &&
      !lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) {
      this.cached = { width, theme, state: snapshot(this.component, after), lines };
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
