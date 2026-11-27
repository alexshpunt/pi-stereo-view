import { div } from "gpui-kit";
import { h_flex, Input, InputState } from "gpui-base";

const QUERY_DELAY = 150;

/**
 * Create when a pane opens search, outside render. Keep the result until search closes.
 * The caller provides query(text, cx), next(cx), previous(cx), and close(cx).
 * render(state, theme) reads the latest backend state without replacing the input draft.
 */
export function createSearchBar(pane, actions) {
  const input = InputState.new({ placeholder: "Search history" });
  let timer;
  let dirty = false;
  let closed = false;
  let released = false;

  function cancelTimer() {
    timer?.cancel();
    timer = undefined;
  }
  function flush(cx) {
    cancelTimer();
    if (closed || !dirty) return;
    dirty = false;
    actions.query(input.value(), cx);
  }
  function close(cx) {
    if (closed) return;
    closed = true;
    cancelTimer();
    actions.close(cx);
  }
  input.on("change", (_event, cx) => {
    if (closed) return;
    dirty = true;
    cancelTimer();
    timer = cx.timer.after(QUERY_DELAY, next => { timer = undefined; flush(next); });
  });
  input.on("submit", (event, cx) => {
    if (closed) return;
    flush(cx);
    if (event.shift) actions.previous(cx);
    else actions.next(cx);
  });
  input.focus();

  const button = (name, label, activate, theme) => div().id(`stereo-search-${pane}-${name}`)
    .px(6).py(3).rounded(4).cursor_pointer().text_color(theme.foreground)
    .hover(style => style.bg(theme.hover)).on_click((_event, cx) => {
      if (closed) return;
      if (name !== "close") flush(cx);
      activate(cx);
    }).child(label);

  return {
    focus() { if (!closed) input.focus(); },
    dispose() {
      if (released) return;
      cancelTimer();
      closed = true;
      released = true;
      input.release();
    },
    render(state, theme) {
      const count = `${state.current ?? 0}/${state.count ?? 0}`;
      return h_flex().id(`stereo-search-${pane}`).items_center().gap(4).px(8).py(4)
        .on_key_down((event, cx) => {
          if (event.key !== "escape") return;
          close(cx);
          cx.stop_propagation();
        })
        .child(Input.new(input).flex_1().min_w(0).h(28).px(6).rounded(4)
          .border_1().border_color(theme.input).bg(theme.background).text_color(theme.foreground))
        .child(div().text_color(state.error ? theme.error ?? theme.foreground : theme.muted)
          .child(state.error || (state.pending ? "Searching…" : count)))
        .child(button("previous", "↑", actions.previous, theme))
        .child(button("next", "↓", actions.next, theme))
        .child(button("close", "×", close, theme));
    },
  };
}
