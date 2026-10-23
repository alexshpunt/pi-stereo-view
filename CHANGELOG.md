# Changelog

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
