# Selection edge scrolling

`PanelScrollView` must leave native selection events unhandled after activating its panel. Native fullscreen layout already routes each event to the visible document with the scroll offset. Calling `Container.handleMouse` again routes it into unrelated off-screen rows.

## Regression

The new real-Pi fixture has an interactive Activity block whose off-screen rows consume drag events. Before the fix, Activity did not scroll down at the bottom edge. Returning the pointer inside the panel could also leave upward scrolling running. Both layouts failed.

After the fix, both Columns and Rows pass with timestamps enabled. The tests check both edges in both panels, continued scrolling while held, a growing copied selection, stopping inside the panel, stopping on release, and unchanged scroll position in the other panel. The existing selection, copy and independent wheel-scrolling cases also pass. Their history now arrives in one scripted chunk: streaming is not part of that test's contract.

The runner loads `/root/dev/pi/pi-agent-ide`, version `0.8.0`, clean source commit `c714fdcce2261df6c16bf657f885a87af22f7add`, matching fetched `origin/develop`. Runs use scripted responses, not paid model calls. Each new case records the IDE version and source commit beside its observations.
`npm run typecheck` and `git diff --check` pass.

Commands:

```sh
npx vitest run test/selection-scroll.integration.test.ts
PI_TRANSCRIPT_IDE_PATH=/root/dev/pi/pi-agent-ide npx vitest run test/transcript.integration.test.ts -t 'selection, copy'
```

## Live source check

Pi was reloaded with this checkout, with the installed transcript disabled for that check. A temporary probe sent native mouse input in the actual human pane and restored the previous layout and scroll state without changing the clipboard.

- Activity up: scroll position `3840` to `3675`; release stayed at `3675`; copied selection contained 9,521 characters. Conversation stayed at `167` during the hold.
- Conversation up: `145` to `0`; release stayed at `0`; copied selection contained 7,670 characters.
- Conversation down: `145` to `160`; release stayed at `160`; copied selection contained 1,642 characters.
- Activity down moved, but that live probe produced no copied selection. That run is not evidence of downward selection/copy; the integration tests verify that path.

`inspect_tui` captured pane `w3VA:p1`, 158×57 cells, revisions 246, 260 and 261. Split headers, clocks, native history and the input dock remained readable. New agent output legitimately moved the other panel when it was following the end; the isolated tests separately check panel independence with stable history.
