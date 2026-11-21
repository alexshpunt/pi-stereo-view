# Development

Contributor setup, rendering requirements and release instructions for pi-stereo-view. User-facing installation and controls belong in [README.md](README.md).

## Setup and checks

```sh
npm ci
npm run check
npm run check:package
```

The integration tests run real Pi with scripted responses. The package check installs the exact npm archive in a clean runtime without development dependencies and verifies the loaded split, native tool output and full-width dock.

The shipped display defaults are text buttons, Compact Activity tools, Stream latest tools and turns off. The test launchers (`test/fixtures/pi-host.sh`, `startup-host.sh`) seed missing display preferences with the earlier full-card, icon-button baseline without turn marks, hover or Go to so unrelated checks stay stable; `PI_TRANSCRIPT_TEST_DEFAULTS=1` skips that, and `test/default-display.integration.test.ts` runs a fresh install that way.

The test launcher disables automatic network activity with `PI_OFFLINE=1` so update and model-catalog notifications cannot change the expected terminal layout.

The optional nested IDE rendering test needs a Pi Agent IDE checkout:

```sh
PI_STEREO_VIEW_IDE_PATH=/path/to/pi-agent-ide npm test -- test/nested-ide-rendering.integration.test.ts
```

Without that path, only that cross-extension case is skipped.

CI runs the package suite on Node.js 22.19.0 and checks the archive contents. See [.github/workflows/ci.yml](.github/workflows/ci.yml) for its triggers and steps.

## Try source changes

To load the source without also loading an installed copy:

```sh
pi -ne --tui-mode fullscreen -e ./src/index.ts
```

Run `/reload` after source changes. When using your normal extensions, disable the installed pi-stereo-view before loading a source copy so only one copy is active. Keep worktree-specific loading overrides local and out of Git.

## Rendering contract

The extension uses a guarded runtime layout adapter without changing Pi's source. An unsupported fullscreen layout is left untouched. Native message and tool renderers remain unchanged; the adapter changes history layout, not the input dock.

Errors must never reach Pi's render loop: Pi ends the process on an exception thrown while it lays out or paints a frame. The frame-start hook (the toolbar's `visible` callback), the split sizing pass and `SplitSurface` painting and mouse dispatch catch errors and call `TranscriptLayout.fail`, which turns the split off until the layout is attached again, so Pi shows its own history and dock. `src/report.ts` then shows a widget above the editor with the error and a prefilled GitHub new-issue link (`problemReport`); a layout refused at attach time shows the same panel without an error. The link's body leaves out the home folder and drops the last stack frames to stay within GitHub's URL limit; **Copy report** copies the full text.

The shared content index is verified only while the split is wanted (`mode` is `split`); combined history reads nothing from it. Pi-Bolt 1.1.6+ compacts settled `AssistantMessageComponent`s it has drawn itself about 500 ms after the agent goes idle: `compact()` replaces `contentContainer` with an empty container and keeps only rendered lines, and `compactedCopy()` puts a copy in the history. The index restores such a reply through its own `thaw()` (detected by `isCompacted()`) before it classifies the children, the same way it calls `buildContent()` for Pi-Bolt's deferred streaming content. Without the index pass in combined mode, Pi-Bolt keeps its memory savings there; the first split frame thaws every compacted reply in the history again. Outside a frame, every read of the index (`entries()`, `turn()` and the methods built on them) verifies the whole history again; code that runs per pointer move or per rendered row must use values read once per frame, such as `NativeDocument`'s turn map or a segment's `turn`.

Compact Activity is a display-only projection over the full native content index, controlled by two independent `ToolDisplay` choices that `NativeDocument` reads every frame. `compact` turns each finished call into a row that opens its original card and linked output. `group` merges adjacent calls under a counted header; without `compact`, an open group shows its members' original cards directly, the first one under the header and later ones with their native separation. Only adjacent calls with the same verified tool identity and lifecycle state share a group. Every failed call stays individual; running calls never mix with successful calls. Different tools, reasoning and other visible content, including Conversation entries, break runs before pane filtering. Owned late output follows its call rather than creating a new run. No native history objects or execution data are changed.

A per-frame tool-catalogue snapshot resolves local MCP forwarding aliases by an exact, unique description/schema match against visible IDE namespace tools or provenance-verified builtin Codemode. Hidden, foreign-namespaced, ambiguous and unknown tools retain their raw name and grouping key; suffixes are not identity. Presentation resolution never registers tools or replaces execution or native renderers.

Group and call headers keep a one-cell left gutter, original tool-start clocks inline on the left before the live status and tool name, and no extra timestamp row. Groups show their first call's time, shared state and the total number of image blocks in their members' results; a call row shows its own image count before the argument preview so truncation keeps it; failed calls keep their own time and argument preview. Separate native-source-keyed expansion state reveals compact members, then the selected call's original renderer and linked output. Expanded members have a left guide and a two-cell inset. Original cards and owned output have another guide and inset; their native render width shrinks by the same amount. Pointer coordinates are translated before native dispatch, and search highlights and saved-text positions are computed before the guides are added. Existing renderer invalidation, mouse actions and copy controls remain active. Layout/width changes, appended calls and state-driven splits or merges preserve visible expansion without reopening explicitly collapsed runs; expansion disables follow-end before changing the projection.

Stream latest tools adds a per-call lifecycle on top of that projection while `compact` or `group` is on; with both off, nothing hides a call, so no lifecycle runs. A call first seen running is live: it renders through the native full path, is excluded from grouping and its nested disclosure starts open. When it finishes, a timer for the collapse delay requests a frame; the next frame releases it, so it renders as a compact row, groups with its neighbours, or both. A call first seen already finished, such as one restored from a session, is never live. Scroll position is never adjusted for a release; follow-end handles the bottom.

All calls and results stay in the semantic index for search and copying. Search temporarily opens the owning group/call and maps matches to the original body, excluding compact control and clock rows. Clearing search restores user expansion. Switching compact mode off restores full native rendering; Conversation, combined history, saved messages and tool execution are unchanged.

Custom entries can identify their execution owner with `data.parentToolCallId`; custom messages use `details.parentToolCallId`. When that ID matches a native tool call in the current branch, split history and search place the original output component after that call, in arrival order within its group. Linked panels open through their native expansion API when first linked; later refreshes preserve native expansion state. Missing owners keep the output in Conversation. Grouping never changes the native history tree or saved messages.

Stereo builds nested disclosure structure from `tool_execution_start`/`tool_execution_end` identities and restores it from Pi's `nestedCalls` record. The tracker stores call metadata, never renderer instances or provisional result bodies. Siblings group by tool presentation while retaining individual call headers and deeper descendants. Result bodies are the original history components. Layout-only containers around multiple native tool components expose those original components as independent owned entries. Each independent result opens under its call; a single combined result for several siblings stays whole at the group. Custom-styled and opaque components remain intact. Panels without an unambiguous call or group stay inside the parent's output disclosure. Result components are never split, cloned or replayed. The parent's original output remains available through a separate disclosure. Compact mode starts nested disclosures closed; full mode starts them open. With the `nestedTree` preference off, `NativeContentIndex` keeps each linked panel as one owned entry instead of splitting it into nested parts, and Activity builds no trees, so the parent shows Pi's native panel. Search opens the path to the original matching body, and copying includes native output and nested argument metadata.

Split history reuses unchanged native blocks between frames. Custom renderers must invalidate changed components before requesting a render, as required by Pi's component API. Native text setters, history rebuilds, streaming, tool updates, expansion, width and theme changes refresh the affected output. Image placement blocks are never retained in this cache. Detaching the layout removes its invalidation observers.

Every streamed delta and spinner tick requests a frame, so per-frame work must not grow with history length. `NativeDocument` keeps one cached segment of rows per projected entry. Each frame renders only the entries near its panel's viewport (from the scroll position before layout, or the tail while following the end), plus entries whose native nodes invalidated or whose cheap shell inputs changed; a rotating check reads the shell inputs of 64 offscreen entries per frame. Entries never measured at the current width or settings epoch are measured lazily within a 4 ms budget per frame, with a follow-up frame until they converge. When an entry wholly above the viewport changes height and the panel is not following the end, the document reports the difference through `takeScrollShift()` and the split layout moves the scroll position by it, so the visible rows stay in place. Search with a jump target renders every entry. Compact call and group headers are reused until a displayed input changes: width, name, argument object, state, member count, expansion, clock or theme. Running calls rebuild their header on every frame because streamed arguments may change in place. Hierarchy guides are reused while the wrapped rows are unchanged. Timestamps reread the session only when its leaf entry changes. A streamed answer is classified again on each delta, but its projected entries and child arrays stay the same while its block layout and child components do not change, so their native caches stay valid.

The passes that feed the document run every frame too, so each reuses its result until its inputs change. `NativeContentIndex` keeps one classification per history child and reclassifies only new children, children whose preceding spacers changed, assistants whose content array or message Pi replaced, and linked panels whose owner or parts changed; unchanged entries keep their objects, and the entry arrays keep their identity while no entry changed. Tool grouping reruns when the entries, tool presentation or live calls change, or when a call's status changes; the status is read from the call's `result` and `isPartial` fields every frame, because Pi updates results without invalidating the component. Nested trees reuse their map while the entries, nested calls and the tree preference are unchanged; the index's per-frame pass and its linked-panel check also compare that preference, so toggling it reclassifies panels in the same frame. `ToolStreaming` looks only at live calls while the entry array is the same. Timestamp metadata is checked for new blocks, the last block and a rotating slice of 64 older blocks per frame.

Render results stay immutable: when a segment changes, `NativeDocument.render` returns new row and child arrays instead of rewriting the previous ones, because probes and Pi's layout compare earlier results with later ones.

## Rendering profiles

The profiles run real Pi with scripted responses and write measurements under `tmp/profiling`. Compare a candidate with a baseline checkout through `PROFILE_TRANSCRIPT_PATH`, on an otherwise idle machine, with the Pi version users run (`PI_COMMAND`); `npm run` puts the development dependency's older `pi` first on `PATH`.

```sh
PI_COMMAND=$(command -v pi) PROFILE_MODES=stock,columns PROFILE_COMPACT=1 PROFILE_CALLS=10 PROFILE_ARG_CHARS=3000 \
  PROFILE_HISTORY=100 PROFILE_WIDTH=200 PROFILE_HEIGHT=60 PROFILE_TOOL_LINES=40 npm run profile -- test/rendering.profile.ts
```

`test/rendering.profile.ts` builds a synthetic history of `PROFILE_HISTORY` turns with `PROFILE_CALLS` calls each and measures CPU per frame for repaint, typing, scrolling, resizing, streamed text, tool output and streamed arguments. `PROFILE_ARG_CHARS` gives calls Codemode-sized arguments and enables the streamed-argument action. `PROFILE_FOCUS=<action>` limits the CPU profile to one action. `PROFILE_TURN_MARKS`, a comma list of `clock`, `stripe` or `line`, `background` and `separator` (none by default), turns turns on with those marks. `PROFILE_POINTER=1` adds `move`, the CPU of dispatching ten pointer moves within one turn, which request no frame; `PROFILE_HOVER=1` turns hover on and adds `hover`, a pointer move to another turn, which repaints the highlight. A baseline checkout without turn settings ignores them and still measures `move`. `scripts/summarize-render-profile.ts <artifact>` prints the hottest functions. Compare 10 and 100 turns to see how frame cost grows with history.

On idle ZinPC, per-action P50 varies by 0.1–0.2 ms between runs at these sizes, so compare ratios over the median of several runs.

Reference results (LPT-1652; ZinPC, idle, Pi 1.5.2, 290x91, columns, compact Activity, 10 calls per turn, 3,000-character arguments, auto scrollbars; per-frame CPU P50 in ms):

| action | stock 100 calls | before 100 | after 100 | stock 1,000 calls | before 1,000 | after 1,000 |
|---|---|---|---|---|---|---|
| repaint (spinner) | 0.6 | 9.2 | 1.7 | 3.3 | 18.7 | 2.3 |
| typing | 0.6 | 7.6 | 1.7 | 3.2 | 9.9 | 2.1 |
| scroll | 6.9 | 16.8 | 3.2 | 9.1 | 21.8 | 4.1 |
| streamed text | 4.9 | 11.0 | 2.7 | 7.0 | 18.9 | 4.6 |
| tool output | 2.0 | 13.3 | 2.3 | 4.1 | 16.2 | 2.8 |

Streaming over a copy of a real 2,145-entry session at 290x91 (`test/session.profile.ts`): stock Pi 56% CPU, split before 97% with a 30 ms median event-loop delay, split after 26% with 5 ms.

Incremental history passes (LPT-1671; same setup, columns only, 100 samples per action, median of three runs; per-frame CPU P50 in ms):

| action | before 100 calls | after 100 | before 1,000 calls | after 1,000 | ratio before | ratio after |
|---|---|---|---|---|---|---|
| repaint (spinner) | 1.45 | 1.47 | 2.01 | 1.65 | 1.39 | 1.12 |
| typing | 1.05 | 0.99 | 1.45 | 1.19 | 1.37 | 1.20 |
| scroll | 2.48 | 2.28 | 3.08 | 2.69 | 1.24 | 1.18 |
| streamed text | 2.08 | 1.94 | 3.32 | 2.37 | 1.60 | 1.22 |
| tool output | 1.88 | 1.79 | 2.34 | 2.00 | 1.24 | 1.12 |
| streamed arguments | 1.69 | 1.63 | 2.13 | 1.81 | 1.26 | 1.12 |

The remaining growth is Pi's own layout and painting; the extension's per-frame time stays at about 0.2–0.35 ms at both sizes.

`test/session.profile.ts` streams a scripted answer and command over a copy of a real saved session and reports process CPU and event-loop delay for the agent run. It is skipped unless `PROFILE_SESSION` names a session file; `PROFILE_MODE` is `split` or `stock`, and `PROFILE_CPU_DIR` writes a V8 profile of the Pi process. Keep personal sessions and their profiles out of Git.

Pi paints a component at a column offset through `compositeTuiLine`, which re-parses the whole row, while a full-width component at column 0 is assigned directly. `src/surface.ts` therefore mounts the split area as one full-width leaf component. It lays out the panel tree with a port of Pi's stack and scroll-view rules, pads each panel row to its width and joins the rows. Because Pi no longer sees the panel scroll views, the surface also provides what Pi gives its own scroll views: scrollbars and their hover and drag, the follow-end indicator, wheel routing, mouse dispatch with exact capture targets, and text selection with copy, double/triple click, link opening and auto-scroll. A zero-height proxy scroll view is Pi's primary view; it forwards keyboard scrolling, prompt jumps and follow-end to the active panel. Pi's selection commands (`hasActiveSelection`, `copyActiveSelectionToClipboard`, `resetTextSelection`) are wrapped on the TUI instance while the split is mounted and restored when it is detached.

Timestamp decoration puts a local clock on the first line of each text block, with a small right gutter. One blank row separates messages and tool calls without removing paragraph breaks or tool formatting. Tools whose custom call and result renderers use `renderShell: "self"` and show no content add no output, spacing or clock, even when their model-facing result contains images. Default and visibly rendered image blocks retain their native placement rows and use a separate clock row. Assistant text and thinking share their original message time. Combined history uses Pi's original renderer without these decorations.

## Turns

`NativeContentIndex.turn` numbers turns over the classified history: `UserMessageComponent`, `SkillInvocationMessageComponent` and `CustomMessageComponent` owners start one, unless the current turn has no other entry yet. Entries before the first start are turn 0 and get no color. The numbering and each block's history position are rebuilt only when the entry array changes. `counterpart` finds the Go to target from those positions: the same native message in the other pane, else the nearest other-pane entry before (from Activity) or after (from Conversation), then the other direction.

`src/turns.ts` builds a 16-hue palette per theme, terminal background and mix setting; turn *n* uses hue `(n − 1) × 7 mod 16`, so neighbours are far apart on the hue circle. Colors are mixed into the background the terminal reports to `TUI.queryTerminalColors`, asked once per layout attach; until it answers, or when it never does, a guess from `theme.appearance` is used. Pi's theme does not expose that background.

`turns` switches the feature as a whole: while it is off, `TranscriptLayout` reports every mark, hover and Go to as off to the documents, and the other turn settings keep their values. The four turn marks (`turnClock`, `turnStripe`, `turnBackground`, `turnSeparator`) are independent; hover uses its own strength, in place of the turn background, on the turn under the pointer. Clock colors are an input of the `CompactMessage` and `CompactTool` caches. Backgrounds, hover and stripes decorate each segment child's rows in `NativeDocument.render` through `decorateLines`, which re-applies the turn background after every SGR sequence that resets it and leaves native backgrounds, image rows and shell zone markers alone. Results are cached per child row array and reused while its rows are the same strings, so an unchanged block costs a row comparison and a renderer that mutates its array still gets fresh rows. A `block` or `line` stripe renders native blocks one column narrower and shifts pointer coordinates by that column.

The separator is a `TurnRule` component, a blank row and a rule in the turn's line color, put first in the segment of the first entry with rows of each turn after the first visible block of the panel. Whether a segment starts with a rule is an input of offscreen segment reuse (`ruleIn`), like `visibleIn` and `toolRunIn`. The rule ends a tool run, so the block below keeps its own blank row.

Hover: a pointer move runs through `SplitSurface` between `pointer.start` and `pointer.end`; the document under the pointer reports its turn, and a move outside the panels clears it. The layout requests a frame only when the hovered turn changes, and only visible segments render again, as every frame does. Availability mirrors Pi's mouse mode: Pi enables all-motion tracking only outside tmux, zellij and screen and while its mouse support is on.

`NativeDocument.locate` renders every entry once at the last width, like a search jump, and returns the first non-blank row of the target's segment or of the nearest shown entry above it, such as a closed group's header.

## Search implementation

Regex search uses ripgrep's auto engine, including PCRE2 lookarounds and backreferences when available. It runs outside the TUI thread with a 1.5-second deadline for the whole query. Editing or closing search cancels the old request. Invalid expressions, timeout, missing PCRE2 support and excessive output produce errors, never partial matches.

Boolean expressions use line-level conditions. Only positive matching spans are highlighted; quoted terms remain literal even within regex queries. There is no fuzzy or automatic regex fallback. Native selection and copy retain the original text, and image placement rows are not highlighted.

If a custom tool renderer omits saved matching text, a temporary Search match fragment exposes it without changing that renderer. Reload, branch changes and small-window fallback discard the open search.

## Persisted settings and tool times

`compactTools`, `groupTools` and `nestedTree` are boolean display preferences. Missing `compactTools` and `nestedTree` values default to `true`. A missing `groupTools` takes the saved `compactTools` value, because grouping was part of Compact before it became a separate setting; files saved before that keep their look. Missing turn settings default to `turns: false`, `turnClock: true`, `turnStripe: "block"`, `turnBackground: true`, `turnSeparator: true`, `turnClockMix: 15`, `turnStripeMix: 30`, `turnBackgroundMix: 8`, `turnHoverMix: 15`, `turnHover: true` and `goTo: "both"`; mixes are whole percents from 1 to 100; `turnStripe` accepts `off`, `block` and `line`, and `goTo` accepts `clock`, `button`, `both` and `off`. Unreleased development builds saved these settings under `act…` names; those keys are ignored. A new saved preference also needs its baseline value in `test/fixtures/baseline-preferences.sh` and in the integration tests that compare the whole saved `transcript.json` (`transcript`, `layout-controls` and `streaming-layout`).

Layout, panel order, sizes, compact, grouping and nested-tree choices, turn marks, hover highlighting, Go to, timestamp visibility and copy-button visibility are saved in `transcript.json` in Pi's agent directory. Zoom and split on/off are session-only state and are excluded from that file. Every session starts split and unzoomed; legacy saved `mode` and `zoom` fields are ignored without discarding the saved arrangement. Saved numeric Conversation heights remain manual until the user selects automatic height. Saved arrangements are not reset when defaults change.

Tool-start times are collected as display-only session metadata; they do not become messages in the model's context. New calls keep their recorded start time through streaming, completion and restart. Historical calls without that metadata use the agent message's time as an approximation, marked with `~`. Blocks with unknown times keep their native content without clock or copy-button rows, regardless of timestamp visibility.

## Releases

Publishing a GitHub Release with a `v` tag runs [.github/workflows/release.yml](.github/workflows/release.yml). The tag must match the version in `package.json`. The workflow checks the package on Node.js 24, then publishes to npm with provenance.

For the first publication, add a temporary GitHub Actions repository secret named `NPM_TOCKEN` with npm publish access. It is passed only to the publish step, not to installation or tests.

After the package exists, configure an npm trusted publisher for `alexshpunt/pi-stereo-view`, workflow `release.yml`, GitHub environment `npm`. Remove the temporary secret after trusted publishing is configured; npm then uses GitHub OIDC without a stored npm token.
