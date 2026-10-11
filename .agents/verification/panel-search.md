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

### User check and exact-search follow-up

After the local-source reload, the user reported that inline search works and requested a border and exact-first matching. The user's decisions in `ddf0a4ba-1597-4cc0-886c-63ae670bf9e0` are a closed thin frame and case-insensitive substring/phrase matches across the selected panel, with fuzzy fallback only when no exact matches exist. Navigation still counts matching saved lines. Exact highlights cover contiguous occurrences in the selected line, not earlier scattered letters.

Agent viewport capture was unavailable: `inspect_tui` reported that pane `w3SD:p6` belongs to another Pi session. This is not an agent-side visual pass. The user check does not accept the new follow-up before it is reloaded.

Five new meaningful red failures covered exact filtering, the frame, contiguous highlighting, repeated punctuation and case-fold offset expansion. All 34 focused cases across four files pass after the changes (`de58829a099c`), including seven real-Pi search cases in both layouts, native highlight/copy, minimum sizes and overlay focus. Typecheck and diff check pass. The normal-config direct IDE was clean v0.8.0 at latest fetched develop `5f82305a63b225c3596ee31f802e2b3ae4300101` before this run. Closed search still does no indexing or highlighting; the new matching and border work runs only while open. These tests are not a new timing-parity claim.

The three-row frame is included in temporary pane minimum sizes, preserving at least one content row without changing saved dimensions. The short zoom fixture now reserves its two additional border rows. A fresh normal-config startup smoke passed in `6ecf647d272a`: this worktree's single Transcript loader and direct IDE loaded without observed error/duplicate diagnostics; no model prompt was sent and Ctrl+D exited 0. Reload and a user-operated check of the bordered field remain pending.

### Literal, regex and Boolean follow-up

The user tested the bordered field and reported that it works and looks good. They then removed fuzzy entirely and requested regex and Boolean queries like the IDE search tool. Answers `6149593a-3885-47ba-a3d4-004b62f17c1f` and `eae33f3c-985f-4181-b230-853d2929a52d` choose only explicit `regex:` and ripgrep/PCRE2. The Task and Scenario were updated and read back. The unchanged exported answers were appended once to the same Q&A document; a save mismatch was inspected, not replayed.

Plain queries stay case-insensitive literal phrases. The IDE Boolean parser was ported into this repository without its any-word fallback. AND, OR, infix NOT, grouping, `||` and spaced ` | ` apply to one saved line. Regex runs against saved pane text on stdin, with ripgrep's auto engine, a 1.5-second whole-query deadline and an 8 MiB output budget. No shell, files, paid models or personal history are used. Editing, closing, branch changes and dirty history cancel obsolete requests; stale results cannot jump or revive a removed search field. Errors stay inside the existing three-row frame. Matching line counts are not truncated; budget failures report an error instead of partial counts.

Highlighting uses actual positive UTF-16 match spans, not the query's syntax. It preserves native characters, widths, styles, OSC links/markers, clocks, image placement and copied text. Negative Boolean terms are not highlighted. The renderer does not execute regex or parse Boolean queries. Closed search still does no indexing or highlighting.

Five meaningful matcher red failures and six span-highlighting red failures preceded implementation. The first real-Pi run passed five of seven cases but exposed async results arriving before their requested paint. The fix measures the selected native document at its last allocated width when needed, including omitted-renderer excerpts. After this fix, all 48 focused cases across six files passed in `5afa2d23767b`, with typecheck. Tests use clean latest fetched direct IDE v0.8.0 at `1937db11c343174f47586e4286a1bc0ad6694524`; ripgrep is 14.1.0 with PCRE2 10.42 available.

Two later red contracts cover whitespace-only regex spans/combining marks and retaining an unchanged regex highlight while unrelated history streams. Run `1d0d7d54b796` passed 49 of 50 cases; Rows missed its next-button capture and timed out. The fixture had treated two event-loop yields as a painted frame. It now waits for the native synchronized emitted-frame boundary. The targeted Conversation rerun `25e2399bc7a9` passed both layouts with unchanged behavior assertions and typecheck. All 50 focused cases are verified across these runs; the failed full attempt remains recorded as a failure. The earlier normal-config no-prompt startup `0e8dea13298d` exited zero with Ctrl+D and showed working split panels. A fresh normal-config startup follows the final tests before reload. These focused checks are not a fresh timing-parity claim. New matching still requires local-source reload and the user's manual check; LPT-717 remains open.

Literal/regex/Boolean source is committed and pushed as `39d8499`. Fresh normal-configuration startup `905699cc9231` passed and exited zero with Ctrl+D, without a model prompt. Scrolling its startup diagnostics showed the single project Transcript loader and direct IDE. No load errors or duplicate registrations were observed. The IDE advanced before this smoke: clean v0.8.0 at latest fetched develop `bf25866bc8c72870bf25f908f9cecdcf96564a1c`, unchanged after the smoke. Temporary project loading files remain outside Git; no installed version or personal setting changed. Next is local-source reload and the user's manual matching check, not task completion.

### Live acceptance

After reloading the local worktree, the user tried the search and asked for example regex queries. Examples supplied were `regex:поиск|регекс|regex` and `regex:поиск\s+\S+`. The user then confirmed: “все работает”. This is user-operated live acceptance of the new matcher; the earlier user check also accepted the framed TUI. A fresh agent capture attempt still refused because Herdr pane `w3SD:p6` belongs to a different Pi session. There is no agent-side human-viewport visual pass or substituted pane capture. Automated contracts separately cover literal/Boolean/PCRE2 matching, highlights, native copy, errors/cancellation, focus and scroll restoration. Delivery now restores normal source loading and merges to develop; temporary loading setup stays out of Git.

Temporary loader removal and project-settings restoration are complete; neither is in the diff. Normal-configuration startup `a488c95ba2ec` loaded the global `/root/dev/pi/pi-agent-transcript/src` and direct IDE once, without observed load or duplicate-registration errors. It exited zero with Ctrl+D and no model prompt. Latest fetched clean IDE v0.8.0 was `c56629d4a1ecd37e1ad15505c864526e8410e8e2`, unchanged afterward. The working session is returning to that normal global source before Git delivery.

### Develop delivery

The accepted feature was fast-forwarded and pushed to develop at `dc8be3e49da77db729c8608267e6b5b88d300f3b`. A fresh normal-configuration startup from `/root/dev/pi/pi-agent-transcript` passed in `ed73509aaa9b` (Ctrl+D exit 0, no model prompt). Its startup diagnostics show the global merged Transcript source and direct IDE, without observed load errors or duplicate registrations. Latest fetched clean IDE v0.8.0 remained `c56629d4a1ecd37e1ad15505c864526e8410e8e2` throughout. No package installation or personal setting changed. The final session reload returns to this merged source; the feature worktree and branch can then be removed.