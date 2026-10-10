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

## Earlier pause before performance work

The user stopped this feature to prioritize a severe split-render performance problem. Search testing and acceptance are paused; LPT-717 must stay open. The user requested preserving and merging the implementation, not accepting the feature as complete.

Pi was reloaded with the installed package. `inspect_tui` captured the actual human pane `w3SQ:p1`, 274×108 cells, live bottom, revision 134. Both panel magnifiers and the Conversation active marker are visible. Inline clocks, block gaps and the full-width input dock are intact. The search picker itself was not opened or visually accepted. This header capture is not evidence that live search works.

Existing personal panel settings were preserved (Columns, width 67, saved height 15). Search remains available as requested, but testing and acceptance must not resume without the user's decision. Performance is tracked separately in LPT-718.

## Resumed inline search

The user resumed LPT-717 after rendering delivery and rejected the popup. Revised Task and Scenario were approved in `pn-0faf70`. Typing now navigates in place; Enter/next advances; Escape/close restores pre-search scroll and follow state. The user also chose all matching history lines, not the old 200-result limit (`f7825eb8-4eec-4f90-b0ea-b2cc696933c8`).

Implementation checkpoint: `cb3467e33efff142659920ba5b451e2414ed976c`. The native Input, counter and two buttons occupy one row below the selected panel header. There is no search popup or result list. Selected native text gets ANSI-only highlighting; copy preserves its original characters.

The new popup-to-inline test first failed in both layouts. Further meaningful red cases found and fixed minimum-height clipping, standalone matches after earlier substring collisions, genuine trailing saved times, and focus restoration after an unrelated overlay closes. The copy fixture initially copied twice: native mouse release already copies, so its explicit duplicate request was removed rather than changing production copy behavior.

All 27 focused cases pass across four files, including real-Pi Conversation/Activity, keyboard/header/button use, live match movement, current-branch scope, hidden/custom text, Russian, reload/streaming, exact scroll/follow restoration, native highlight/copy, overlay focus, minimum manual height, narrow resizing and short zoom. Atomic contracts cover lazy indexing, all-match navigation, selected occurrence mapping, ANSI/Unicode/clock/image preservation and unchanged ordinary-frame search work.

Final focused runner: direct IDE `/root/dev/pi/pi-agent-ide` v0.8.0, clean `d4a67ef16841058429ae5f1742fbaca5df0d19f0`, verified against latest fetched develop; Pi 1.1.0. Earlier red/focused runs used `1922570`; final regression and matched controls use the newer checkout. The installed package is still the performance delivery `0.0.0-dev.1791642798`.

The first full inline regression run passed 85 cases and failed the newly added retained-occurrence regression: an update to earlier text in the same selected block left the old saved text in the anchor. This is a real defect, not an obsolete assertion. A follow-up also checks opening search over an unrelated overlay and focus restoration after layout removal. Final regression, matched synthetic rendering/search timings, installation/reload and actual human-viewport verification remain pending. LPT-717 stays open.

The retained-anchor and reverse-overlay red cases are fixed. All 29 focused cases now pass. A retired Input observes its own public `focused` field only after removal, so late native overlay focus restoration returns to the original editor even without a mounted transcript layout. Active unrelated overlays retain their input; panel search declines opening over them. This removes the ordinary-frame focus check from the earlier draft.

The reusable profile runner now accepts `PROFILE_TRANSCRIPT_PATH` for a matched source control, records that checkout's commit/state and rejects source changes during measurement. `PROFILE_SEARCH=1` adds separate open/query/next/close timings; `PROFILE_SEARCH_PANE=activity` covers long tool history rather than only Conversation. These are synthetic scripted measurements, not benchmarks of the user's history.

### Final regression follow-up

Source `fb1ee8e6bad37c2a15d3e6b2cc333e64bc6e99ea` passed 85/87 cases in the full check. The two failures were the streaming-height sampling assertion and the double-reload trace deadline. An isolated rerun passed one height case, timed out the other two-startup case at the test's 45s limit, and again missed the fresh turn after two reloads. No matched profile started: the shell stopped at the failed regression gate.

Native reload source confirms that `session_start` runs while the reload box still owns focus. The old fixture sent the next command after one event-loop yield, before the editor was restored. The corrected fixture waits for an emitted synchronized frame after focus leaves that box. Height samples also wait for emitted frames and record the actual native content height, including loading rows; several deltas may legitimately share one frame. Preferences are read before waiting, then screen, content and viewport are sampled synchronously. The assertion checks exact content-fit height up to the half-history cap, not a promised frame per threshold. Multiple startups/reloads have a bounded lifecycle budget, separate from performance measurements. These fixture corrections are undergoing targeted verification; they are not a production rendering change.

Provenance correction: IDE advanced to clean `c714fdcce2261df6c16bf657f885a87af22f7add` before the final 29-case focused run and both final regression attempts. Those runs fetched and checked HEAD against origin/develop but the earlier note retained the prior `d4a67ef` hash. The older 27-case focused run did use `d4a67ef`. The installed package remains unchanged.

The synchronized fixture rerun passed double reload and the right-side growth/drag/restart case. Left-side startup reached its scripted provider only after about 27.8s of a 30s process deadline; the harness then interrupted the stream at line 57. Its teardown errors are not split-render evidence. Both two-startup height cases now have 60s per process and 150s overall, while the profile still measures emitted frames separately. This is a bounded lifecycle allowance, not relaxation of growth, cap, drag or reset assertions.

All three corrected height/reload cases pass in shell `82c970dac6ab` on IDE `c714fdc` (typecheck and diff check also pass). Together with the full 85-case pass, this verifies all 87 cases; it does not turn the first full attempt into a green run. The final synchronization correction is test-only. Matched profiles and live acceptance are next, with the installed package still unchanged.

### Current controls and local loading

The native selection-edge scrolling fix from develop `48cc71c` is merged. All 89 regression cases have now been verified across the full and focused runs. Two older multi-startup cases needed a 150s outer lifecycle budget with unchanged assertions; this does not relax any measured latency limit. On current clean IDE `be61c669fcf92edb42105298643cdfe6709863a3`, all seven search cases and four fresh matched large-window control/feature cases passed in `2cf1c5f56457`. Sixteen individual profile cases passed across the series; one changing-IDE Rows case was rejected. See [raw measurements and limitations](inline-search/README.md).

The user requested porting the IDE's local development skill and loading this worktree directly, rather than publishing a package. `.pi/skills/develop-transcript/SKILL.md` documents that setup and cleanup. Temporary project settings suppress the same global `/root/dev/pi/pi-agent-transcript` extension source; a single local loader imports this worktree. Those two setup files must not enter the commit. Personal settings are unchanged.

A normal-configuration in-memory Pi startup with no model prompt passed (`e6f96b97507d`, exit 0). Startup diagnostics show this worktree's single Transcript loader, the new project skill and the direct IDE; no load errors or duplicate registrations were reported. Live reload and the user's search-row check are still pending. LPT-717 stays open.