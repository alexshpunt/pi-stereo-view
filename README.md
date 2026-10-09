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

| Action | Command | Shortcut |
| --- | --- | --- |
| Split / combined history | `/transcript` | Ctrl+Alt+T |
| Swap sides | `/transcript swap` | Ctrl+Alt+S |
| Conversation width | `/transcript width 40` | Ctrl+Alt+Left / Right |
| Scroll a panel | `/transcript scroll chat -10` or `/transcript scroll activity -10` | Native fullscreen scrolling |

Drag the divider to change widths. Each panel supports native mouse scrolling, selection, and copy. The conversation panel contains user messages and all ordinary assistant text. Thinking, tools, notices, and other native entries remain in activity.

Settings are saved in `transcript.json` in Pi's agent directory. Narrow terminals temporarily show combined history. Regular mode keeps native combined history. Unknown fullscreen layouts are left untouched with a warning.

## Development

```sh
npm run check
```

The tests launch real Pi with scripted responses, custom tool renderers, native keyboard and mouse input, and isolated session files. Override `PI_COMMAND` to select another Pi executable.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-transcript-777603f978bf)
- [Scope and acceptance: LPT-688](https://linear.app/alexshpunt/issue/LPT-688/separate-conversation-and-agent-activity-in-pi-history)

The Linear task owns the scope and acceptance checks.
