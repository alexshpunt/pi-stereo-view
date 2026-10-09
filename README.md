# Pi Agent Transcript

Separate Pi history into conversation and agent activity without replacing native rendering or changing the input dock.

This is a private, fullscreen-first extension in development. It has not been released.

## Try it

```sh
npm ci
pi --tui-mode fullscreen -e ./src/index.ts
```

The trusted checkout loads the extension and starts Pi in fullscreen through `.pi/settings.json`. Restart Pi if the current session started in regular mode. Run `/reload` after extension code changes.

## Controls

Click the history toolbar to switch layouts, swap panels, or return to combined history:

| Icon | Action |
| --- | --- |
| `▣` / `◫` | Combined history / return to split |
| `▤` / `▥` | Switch to rows / columns |
| `↕` / `↔` | Swap top/bottom or left/right |
| `↗` / `↙` | Expand / restore the panel |

The toolbar stays visible in combined mode. Expansion fills only history; the native input dock stays full width. Run `/transcript help` for the icon legend.

Drag the double-line divider (`═` or `║`) to change conversation height or width. Restore keeps the split arrangement and sizes.

New settings start in Rows with Conversation above Activity. In Columns, Conversation starts on the left. Saved arrangements are not reset, including first-version column settings.

| Action | Command | Shortcut |
| --- | --- | --- |
| Split / combined history | `/transcript` | Ctrl+Alt+T |
| Swap panels | `/transcript swap` | Ctrl+Alt+S |
| Choose layout | `/transcript layout columns` or `/transcript layout rows` | Toolbar |
| Expand / restore a panel | `/transcript zoom chat` or `/transcript zoom activity` | Panel header |
| Conversation width | `/transcript width 40` | Ctrl+Alt+Left / Right in columns |
| Conversation height | `/transcript height 12` | Ctrl+Alt+Left / Right in rows |
| Scroll a panel | `/transcript scroll chat -10` or `/transcript scroll activity -10` | Native fullscreen scrolling |

Each panel supports native mouse scrolling, selection, and copy. Conversation contains user messages and all ordinary assistant text. Thinking, tools, notices, and other native entries remain in Activity.

Mode, layout, panel order, both sizes, and the expanded panel are saved in `transcript.json` in Pi's agent directory. Existing width and side settings are kept on upgrade. Too little space temporarily shows combined history without losing the requested arrangement. Regular mode keeps native combined history. Unknown fullscreen layouts are left untouched with a warning.

## Message times

Fullscreen history shows a dim, right-aligned local `HH:mm:ss` row above each message. Assistant text and thinking share their original message time. Native content and tool renderers stay unchanged.

New tool blocks show the time observed when execution starts. That time is saved as display-only session metadata and stays fixed through partial output, completion, and restart. Old tools without that metadata show `~HH:mm:ss`, using the owning assistant message time. An unavailable or invalid time is shown as `--:--:--`, never the current time.

The rows work in split, expanded, and combined fullscreen history. They do not decorate regular scrollback, the input dock, startup headers, or widgets. Tool-start metadata does not enter the model's conversation.

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
