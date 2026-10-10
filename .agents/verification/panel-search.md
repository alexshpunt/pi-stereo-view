# Panel search verification

Task: [LPT-717](https://linear.app/alexshpunt/issue/LPT-717/find-transcript-history-with-fuzzy-search-in-the-selected-panel).

## Source and runtime

- Implementation: `03e4774`; selection test correction: `60649c38daa53d1e8b356b352ef9696a88f23956`.
- Installed development package: `@alexshp/pi-agent-transcript@0.0.0-dev.1791621440`.
- `cmp` confirms installed `index.ts`, `layout.ts`, `native.ts` and `search.ts` match the checkout.
- IDE: direct source `/root/dev/pi/pi-agent-ide`, version `0.8.0`, clean commit `1922570b9882c023f284b85ac45d3bad4be46550`, matching the latest fetched `origin/develop` before tests and reload. The test runner loads it through `PI_TRANSCRIPT_IDE_PATH`; personal Pi settings and `pi list` confirm the same direct checkout. No npm IDE is used.
- Tests use scripted responses. No paid model run was used.

## Automated checks

The first keyboard regression was red in both layouts because Ctrl+F opened native `Find in transcript`. Five search integration cases now pass in real Pi. They cover:

- Keyboard and header use one fuzzy picker; Escape preserves the draft and viewport.
- Off-screen matches and two identical user messages retain their native block identity; arrows can choose the older occurrence.
- Activity finds collapsed tool text and hidden thinking, including Russian case-insensitive fuzzy queries.
- A custom renderer that omits saved matching text stays unchanged; a temporary adjacent fragment makes the result visible. The native follow-end hint cannot hide its last line.
- Clicking or scrolling selects the panel; a header magnifier selects its own panel. Expanded panels use their visible pane.
- Enter disables follow in only the chosen pane. The other pane's scroll position stays unchanged.
- Actual reload and tree navigation close old pickers and remove old branch results without duplicate controls.
- Searching during streaming works; later deltas do not pull the reader away from the selected older fragment.
- Combined history and small-window fallback keep native search behavior.

Full `npm run check` with the current IDE passed 37 of 39 tests. The two failures compared the whole unchanged panel, including its newly changing active header. The assertions now compare document content separately and also require the correct active header. Both corrected cases pass in the focused rerun. Together these runs verify all 39 cases; this is not a claim that the first full run was green. Typecheck and `git diff --check` pass.

The earlier check without an explicit IDE runner path was interrupted before results. Its exit code is not verification evidence.

## Paused live verification

The user stopped this feature to prioritize a severe split-render performance problem. Search testing and acceptance are paused; LPT-717 must stay open. The user requested preserving and merging the implementation, not accepting the feature as complete.

Pi was reloaded with the installed package. `inspect_tui` captured the actual human pane `w3SQ:p1`, 274×108 cells, live bottom, revision 134. Both panel magnifiers and the Conversation active marker are visible. Inline clocks, block gaps and the full-width input dock are intact. The search picker itself was not opened or visually accepted. This header capture is not evidence that live search works.

Existing personal panel settings were preserved (Columns, width 67, saved height 15). Search remains available as requested, but testing and acceptance must not resume without the user's decision. Performance is tracked separately in LPT-718.
