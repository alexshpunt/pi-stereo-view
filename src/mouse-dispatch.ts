import type { Component, Container, TuiMouseEvent } from "@earendil-works/pi-tui";

export type Dispatched = NonNullable<ReturnType<Container["handleMouse"]>>;

/** Forward a local event to a real component, preserving Pi's capture and focus targets. */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): Dispatched | undefined {
  const result = component.handleMouse?.(event);
  if (!result) return undefined;
  if ("target" in result) {
    const forwarded = result as Dispatched;
    return forwarded.focus && component.handleInput ? { ...forwarded, focusTarget: component } : forwarded;
  }
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return {
    ...result, handled: true, ...(result.focus ? { focusTarget: component } : {}),
    target: {
      component, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height,
    },
  };
}
