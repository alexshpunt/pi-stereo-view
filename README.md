# Pi Agent Transcript

Separate Pi history into conversation and agent activity without replacing native rendering or changing the input dock.

This is a private, fullscreen-first extension in development. It has not been released.

## Personal installation

Install for every Pi project through the local development registry:

```sh
pi-local-publish
pi install npm:@alexshp/pi-agent-transcript
```

Set `tuiMode` to `fullscreen` in `~/.pi/agent/settings.json` and restart sessions that started in regular mode. This installs a private development build, not a public release. Publish and run `pi update npm:@alexshp/pi-agent-transcript` to load later changes.

The checkout does not load a second source copy alongside the installed package.

## Try source changes

```sh
npm ci
pi -ne --tui-mode fullscreen -e ./src/index.ts
```

This isolated run loads source instead of installed extensions. Run `/reload` after source changes.

For a task session with normal extensions, use the [local development skill](.pi/skills/develop-transcript/SKILL.md). It loads only the current worktree's Transcript using a temporary project override and loader, with startup checks and cleanup.

## Controls

Click the history toolbar to switch layouts, swap panels, or return to combined history:

| Icon | Action |
| --- | --- |
| `▣` / `◫` | Combined history / return to split |
| `▤` / `▥` | Switch to rows / columns |
| `↕` / `↔` | Swap top/bottom or left/right |
| `↗` / `↙` | Expand / restore the panel |
| `≡` | Transcript settings |
| `⌕` | Search this panel |

The toolbar stays visible in combined mode. Expansion hides the other history panel; the native input dock stays full width. Run `/transcript help` for the icon legend.

Drag the double-line divider (`═` or `║`) to change conversation height or width. Restore keeps the split arrangement and sizes.
In Rows, Conversation starts with automatic height. It grows with its content up to half the history area, excluding the toolbar, input and footer. After that it scrolls to new messages without growing. Dragging, a height shortcut or `/transcript height <rows>` saves a manual maximum instead. Use **Conversation height: auto** in `≡` or `/transcript height auto` to restore automatic height. Old saved numeric heights stay manual unless you switch them to auto.

Both panels use only the space their content needs. When history fills up, Activity shrinks first while Conversation keeps its limit. Expanded panels fit their content up to the available screen height. Long histories scroll without pushing the input off screen.

New settings start in Columns: Conversation on the left gets 20% of the width, Activity gets 80%. This ratio follows window resizing, not content growth, while respecting minimum panel widths. Dragging or a width shortcut or command saves a manual width instead. Saved arrangements are not reset, including first-version column settings.

| Action | Command | Shortcut |
| --- | --- | --- |
| Transcript settings | `/transcript settings` | Toolbar |
| Split / combined history | `/transcript` | Ctrl+Alt+T |
| Swap panels | `/transcript swap` | Ctrl+Alt+S |
| Choose layout | `/transcript layout columns` or `/transcript layout rows` | Toolbar |
| Expand / restore a panel | `/transcript zoom chat` or `/transcript zoom activity` | Panel header |
| Conversation width | `/transcript width 40` | Ctrl+Alt+Left / Right in columns |
| Conversation height | `/transcript height 12` or `/transcript height auto` | Ctrl+Alt+Left / Right in rows |
| Scroll a panel | `/transcript scroll chat -10` or `/transcript scroll activity -10` | Native fullscreen scrolling |

Each panel supports native mouse scrolling, selection, and copy. Conversation contains user messages, ordinary assistant text, compaction summaries, and compaction notices. Thinking, tools, notices, and other native entries remain in Activity.

Conversation headers have a soft green fill; Activity headers have a soft blue fill. Both blend with the active theme. Thin lines frame each header, with the double drag divider taking the place of the next header's top line in Rows.

Mode, layout, panel order, both sizes, the expanded panel, and timestamp visibility are saved in `transcript.json` in Pi's agent directory. Existing width and side settings are kept on upgrade. Too little space temporarily shows combined history without losing the requested arrangement. Regular mode keeps native combined history. Unknown fullscreen layouts are left untouched with a warning.

## Search history

Press **Ctrl+F** to search the last clicked or scrolled panel. A dot in its header shows which panel is active; Conversation is the initial choice. The `⌕` button always searches its own panel. Both open the same small search field inside a thin closed frame below that panel's header, including in an expanded panel. The frame occupies three rows.

Typing finds literal substrings or phrases without case sensitivity. There is no fuzzy or automatic regex fallback. Use `regex:` for regular expressions; ripgrep's auto engine supports PCRE2 lookarounds and backreferences when available. Boolean `AND`, `OR`, infix `NOT`, parentheses, `||` and spaced ` | ` follow the IDE search tool's line-level conditions. Quoted terms stay literal even inside a regex query. Only positive matching spans are highlighted. Enter or `[↓]` moves to the next match; Shift+Enter moves to the previous one. The counter shows the current match and total, with no limit on matching history lines. Ctrl+F focuses the existing search row without clearing the query.

Examples: `worker ready`, `worker AND ready NOT failed`, `(worker OR server) AND "ready now"`, `regex:worker(?= ready)`. Regex requires `rg` on PATH, runs outside the TUI thread and has a 1.5-second deadline for the whole query. Editing or closing cancels the old request. Invalid expressions, timeout, missing PCRE2 support or excessive output show an error inside the frame, never partial matches. Queries support Russian and English. Search covers the whole current branch, including off-screen messages, hidden thinking and collapsed tool text. It does not read other branches, sessions, attachments or files.

Matches reveal the native block without moving the other panel. If a custom tool renderer omits the saved matching text, a temporary **Search match:** fragment appears next to that tool instead. Native selection and copy keep the original text, without highlight codes. Image placement rows are not highlighted.

Escape or `[×]` closes the row and restores the panel's pre-search scroll position and follow-latest state. The main draft stays unchanged. Reload, branch changes and small-window fallback discard the open search. Other open interfaces keep their own keyboard focus; close them before starting panel search. Combined history, regular mode and small-window fallback keep Pi's native keyboard behavior.

## Message times

Conversation and Activity show a dim local `HH:mm:ss` clock on the first line of each text block, aligned to the right. A small right gutter keeps text clear of the clock. One blank row separates messages and tool calls; paragraph breaks and tool formatting inside blocks stay intact. Invisible tool blocks do not add spacing. Image blocks keep their native placement rows and use a separate clock row. Combined history uses Pi's original renderer without added clocks or compact spacing. Assistant text and thinking share their original message time. Native content and tool renderers stay unchanged.

New tool blocks show the time observed when execution starts. That time is saved as display-only session metadata and stays fixed through partial output, completion, and restart. Old tools without that metadata show `~HH:mm:ss`, using the owning assistant message time. An unavailable or invalid time is shown as `--:--:--`, never the current time.

Clocks work in split and expanded fullscreen panels. Combined history does not show extension clocks; returning to split restores the saved clock setting. They do not decorate regular scrollback, the input dock, startup headers, or widgets. Tool-start metadata does not enter the model's conversation.

Use `≡` or `/transcript settings` to hide or show clocks. Hiding also removes the clock gutter or extra clock rows. The setting survives restart; tool-start times are still collected and return unchanged when clocks are shown again.

## Rendering contract

Split history reuses unchanged native blocks between frames. Custom renderers must invalidate changed components before requesting a render, as required by Pi's component API. Native text setters, history rebuilds, streaming, tool updates, expansion, width and theme changes refresh the affected output. Image placement blocks are never retained in this cache. Detaching the layout removes its invalidation observers.
## Development

```sh
npm run check
```

The tests launch real Pi with scripted responses, custom tool renderers, native keyboard and mouse input, and isolated session files. Override `PI_COMMAND` to select another Pi executable.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-transcript-777603f978bf)
- [Scope and acceptance: LPT-688](https://linear.app/alexshpunt/issue/LPT-688/separate-conversation-and-agent-activity-in-pi-history)
- [Layout controls: LPT-691](https://linear.app/alexshpunt/issue/LPT-691/control-transcript-panels-with-buttons-and-two-layouts)
- [Message times: LPT-693](https://linear.app/alexshpunt/issue/LPT-693/show-message-and-tool-start-timestamps-in-transcript-history)
- [Panel search: LPT-717](https://linear.app/alexshpunt/issue/LPT-717/find-transcript-history-with-fuzzy-search-in-the-selected-panel)

The Linear task owns the scope and acceptance checks.
