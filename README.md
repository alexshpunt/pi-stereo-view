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

## Controls

Click the history toolbar to switch layouts, swap panels, or return to combined history:

| Icon | Action |
| --- | --- |
| `▣` / `◫` | Combined history / return to split |
| `▤` / `▥` | Switch to rows / columns |
| `↕` / `↔` | Swap top/bottom or left/right |
| `↗` / `↙` | Expand / restore the panel |
| `≡` | Transcript settings |

The toolbar stays visible in combined mode. Expansion hides the other history panel; the native input dock stays full width. Run `/transcript help` for the icon legend.

Drag the double-line divider (`═` or `║`) to change conversation height or width. Restore keeps the split arrangement and sizes.
In Rows, Conversation starts with automatic height. It grows with its content up to half the history area, excluding the toolbar, input and footer. After that it scrolls to new messages without growing. Dragging, a height shortcut or `/transcript height <rows>` saves a manual maximum instead. Use **Conversation height: auto** in `≡` or `/transcript height auto` to restore automatic height. Old saved numeric heights stay manual unless you switch them to auto.

Both panels use only the space their content needs. When history fills up, Activity shrinks first while Conversation keeps its limit. Expanded panels fit their content up to the available screen height. Long histories scroll without pushing the input off screen.

New settings start in Rows with Conversation above Activity. In Columns, Conversation starts on the left. Saved arrangements are not reset, including first-version column settings.

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

Each panel supports native mouse scrolling, selection, and copy. Conversation contains user messages and all ordinary assistant text. Thinking, tools, notices, and other native entries remain in Activity.

Conversation headers have a soft green fill; Activity headers have a soft blue fill. Both blend with the active theme. Thin lines frame each header, with the double drag divider taking the place of the next header's top line in Rows.

Mode, layout, panel order, both sizes, the expanded panel, and timestamp visibility are saved in `transcript.json` in Pi's agent directory. Existing width and side settings are kept on upgrade. Too little space temporarily shows combined history without losing the requested arrangement. Regular mode keeps native combined history. Unknown fullscreen layouts are left untouched with a warning.

## Message times

Conversation and Activity show a dim local `HH:mm:ss` clock on the first line of each text block, aligned to the right. A small right gutter keeps text clear of the clock. One blank row separates messages and tool calls; paragraph breaks and tool formatting inside blocks stay intact. Invisible tool blocks do not add spacing. Image blocks keep their native placement rows and use a separate clock row. Combined history keeps its existing clock rows. Assistant text and thinking share their original message time. Native content and tool renderers stay unchanged.

New tool blocks show the time observed when execution starts. That time is saved as display-only session metadata and stays fixed through partial output, completion, and restart. Old tools without that metadata show `~HH:mm:ss`, using the owning assistant message time. An unavailable or invalid time is shown as `--:--:--`, never the current time.

Clocks work in split, expanded, and combined fullscreen history. They do not decorate regular scrollback, the input dock, startup headers, or widgets. Tool-start metadata does not enter the model's conversation.

Use `≡` or `/transcript settings` to hide or show clocks. Hiding also removes the clock gutter or extra clock rows. The setting survives restart; tool-start times are still collected and return unchanged when clocks are shown again.

## Development

```sh
npm run check
```

The tests launch real Pi with scripted responses, custom tool renderers, native keyboard and mouse input, and isolated session files. Override `PI_COMMAND` to select another Pi executable.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-transcript-777603f978bf)
- [Scope and acceptance: LPT-688](https://linear.app/alexshpunt/issue/LPT-688/separate-conversation-and-agent-activity-in-pi-history)
- [Layout controls: LPT-691](https://linear.app/alexshpunt/issue/LPT-691/control-transcript-panels-with-buttons-and-two-layouts)
- [Message times: LPT-693](https://linear.app/alexshpunt/issue/LPT-693/show-message-and-tool-start-timestamps-in-transcript-history)

The Linear task owns the scope and acceptance checks.
