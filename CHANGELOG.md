# Changelog

## Unreleased

## 0.1.23 - 2026-11-21

### Fixed

- Pi-Bolt no longer closes with "Pi's assistant content layout is not supported" after a reply. Pi-Bolt 1.1.6 and later free the parts of finished replies they have drawn; split view now asks Pi-Bolt to restore them before showing the reply. Thanks to [@Unk-now](https://github.com/Unk-now) for the detailed report ([#99](https://github.com/alexshpunt/pi-stereo-view/issues/99)).
- An error in split view no longer closes Pi. Split view turns off, and Pi shows its own history until the next reload.

### Added

- When split view turns off after an error, or cannot start in a Pi version it does not support, a panel above the editor names the problem. **Open issue** opens a GitHub issue form with the error, its stack and the versions filled in; nothing is sent until you submit it. **Copy report** copies the same text, and **Close** hides the panel.

### Changed

- Combined history no longer reads the split's content index on every frame.

## 0.1.22 - 2026-11-21

### Fixed

- Ctrl+G no longer crashes Pi when opening an external editor from split view. Pi returns to the same layout with the edited draft when the editor closes. Thanks to [@okuuva](https://github.com/okuuva) for the fix ([#120](https://github.com/alexshpunt/pi-stereo-view/pull/120)).

## 0.1.21 - 2026-11-19

### Added

- Compact tool rows show how many images a call returned, such as `read (1 image)`, so a collapsed screenshot or image read is not missed. Groups show the total for their calls (#103).

## 0.1.20 - 2026-11-19

### Added

- **Group Activity tools** and **Nested call tree** settings. Compact rows, `read ×3` groups and the nested call tree of tools such as Codemode now turn on and off independently. With only grouping on, a group opens into full cards; with only compact on, every call keeps its own row; with the tree off, a tool keeps its own output panel. Thanks to Oula Kuuva for the idea and the first implementation (#100).

### Changed

- Stream latest tools also works with grouping alone: a new call stays a full card for the collapse delay before it joins its group.
- Saved settings keep their look: grouping follows your saved Compact Activity tools choice until you change it.

## 0.1.19 - 2026-11-19

### Changed

- Split view uses much less CPU while an agent works: the panels are drawn as one full-width block instead of being merged cell by cell, and only history near each panel's viewport is rendered on every frame.
- Split view's per-frame work no longer grows with session length: content classification, tool grouping and timestamp checks reuse their results for history that did not change.

## 0.1.18 - 2026-11-09

### Added

- Stream latest tools: with Compact Activity tools on, new tool calls show in full, then collapse into the compact history after a configurable delay.

### Changed

- The `[Menu]` button is now `[Settings]`.
- New installs start side by side with Conversation on the left and Activity on the right, text buttons, Compact Activity tools and Stream latest tools on. Saved settings are kept.
- Keep the last text button in a panel header one cell away from the right edge.

## 0.1.17 - 2026-11-09

### Changed

- Pi loads the extension faster.

## 0.1.16 - 2026-11-08

### Changed

- Use descriptive labels for text controls and wrap controls onto additional lines in narrow panels.
- Separate the toolbar from history with a full-width line in combined view.

### Fixed

- Close Stereo View settings when clicking outside the menu.
- Keep the panel header background continuous between controls and across wrapped rows.

## 0.1.15 - 2026-11-08

### Added

- Choose icons or text for toolbar, panel, search and copy controls in Stereo View settings. The choice survives restart.

### Changed

- Use consistent spacing between adjacent buttons. In narrow search panels, hide the match counter when needed to keep the query editable.

### Fixed

- Keep timestamps and copy controls on user messages when an extension replaces a message after it is displayed.

## 0.1.14 - 2026-11-07

### Fixed

- Keep split view responsive while an agent streams in long sessions. Frames no longer rebuild call headers, timestamps and every earlier answer for the whole history.

## 0.1.13 - 2026-11-06

### Changed

- Show native inline extension dialogs below Activity history alongside widgets. Keep message editors full width, explicit overlays unchanged and native placement available when the surface does not fit.
- Preserve an inline dialog's keyboard focus when pressing the panel search shortcut.

## 0.1.12 - 2026-11-04

### Changed

- Keep extension widgets at the bottom of Activity while its history scrolls independently. Widgets return to Pi's normal placement when they cannot fit safely.
- Restore the nested Codemode call tree with independent controls and original native result panels, including shared results and saved sessions.

### Fixed

- Keep committed editor batch results visible under their originating nested calls.

## 0.1.11 - 2026-10-29

### Added

- Show nested tool calls in Activity with their arguments, status and native result views. Recorded calls remain visible after reopening a session.

## 0.1.10 - 2026-10-26

### Changed

- Add a one-cell left inset before panel header content while keeping the colored background full width.
- Use `▸` and `▾` for collapsed and expanded compact tool groups and calls. The Activity header keeps its existing `⊟` / `⊞` controls.

## 0.1.9 - 2026-10-26

### Added

- Optional **Compact tools** mode shows tool calls as single-line status, name and argument previews. Full arguments and results remain searchable and copyable.
- Adjacent calls with the same verified tool identity and execution state form a group. Every failed call stays separate.
- Expand groups into individual calls, then open each original tool card independently. Left guides show both nesting levels, and linked output stays with its tool.
- Verified MCP forwarding calls show their original tool names. Unverified and custom tool names remain unchanged.

### Changed

- Show original tool timestamps inline-left, before the status and tool name. Expanded members retain their own start times.
- Inset compact Activity rows by one cell from the panel border.

### Fixed

- Preserve opened cards and explicit group collapse when streaming calls form, split or merge groups.
- Keep native card wrapping, mouse actions and search positions aligned inside nested guides.

## 0.1.8 - 2026-10-25

### Fixed

- Prevent horizontal squashing of the copy icon in VS Code terminals while preserving its monochrome glyph and two-cell click area.

## 0.1.7 - 2026-10-24

### Fixed

- Keep panel zoom and split on/off temporary to the current session. New sessions always show both panels using the saved layout, order and sizes.
- Ignore zoom and split-state values from older settings files without resetting panel sizes or timestamp and copy-button preferences.

## 0.1.6 - 2026-10-24

### Fixed

- Hide clock placeholders and copy buttons for blocks without a known timestamp, including system notices. Their content remains visible without extra control rows.

## 0.1.5 - 2026-10-23

### Added

- Copy individual user messages, assistant replies and thinking blocks as original text/Markdown. Tool copies include their arguments, full saved results and linked late output, even when collapsed or off screen.
- Use `/stereo-view copy` to choose and copy a block from the active panel with the keyboard.
- Hide copy icons and their rows with **Show copy buttons** without disabling keyboard copying. The setting survives restart.

### Changed

- Show timestamps above blocks on the left and dim copy icons below on the right, without reserving a side column beside the text.

## 0.1.4 - 2026-10-20

### Fixed

- Keep the split layout active while Pi-Bolt streams thinking or text. Later replies no longer require a restart to restore the panels; saved panel sizes and layout settings stay intact.
- Hide empty self-rendered tool blocks without leaving blank spacing or timestamps, even when the tool returns images to the model. Normal tool output and visibly rendered images remain visible.

### Changed

- Show late output linked to a tool call directly below that call in Activity, even when other work has happened since. Activity search follows the same grouping; combined history keeps its original order.

## 0.1.3 - 2026-10-19

- Show the saved split layout from the first visible frame, without briefly displaying the normal layout first.
- Keep dialogue and system information, including startup and runtime warnings, errors and status notices, in Conversation. Activity contains thinking, tools and shell execution.
- Use the same content classification for display and search. Related tool output stays with its tool; unrecognized content stays in Conversation.

## 0.1.2

- PgUp/PgDn and Pi's other keyboard scroll keys now move the active panel (marked with `●`) instead of always Activity. Pi's built-in history search follows the active panel too.
- `Ctrl+Alt+Up` or `Ctrl+Alt+Down` switches the active panel; press again to switch back.

## 0.1.1

- Mouse wheel over Conversation or its header no longer scrolls Activity when Conversation is too short to scroll.

## 0.1.0

First release.

- Separate Conversation and Activity while keeping Pi's native message and tool renderers.
- Arrange panels in columns or rows, swap them, resize them, and zoom either panel.
- Search each panel with literal, Boolean and regular-expression queries.
- Show optional timestamps and save layout preferences between sessions.
- Keep the input dock full width and fall back to combined history in small terminals.
