# Compact Activity and readable block gaps

The first compact Conversation change removed too much spacing. The user reported that messages merged visually and chose one blank row between messages and separate tool calls. This follow-up applies the same compact clock layout to Activity without removing internal paragraphs or tool formatting.

Verified source: `1732a41`. Installed personal package: `@alexshp/pi-agent-transcript@0.0.0-dev.1791570931`. Installed `layout.ts`, `native.ts` and `timestamps.ts` matched the committed source byte for byte.

## Automated checks

All 32 tests passed across the full run and the focused rerun after updating two old panel coordinate assertions. TypeScript and `git diff --check` passed.

The new checks cover one gap between user and assistant messages, consecutive tool calls with inline clocks and one gap, short Activity sizing, preserved paragraphs, native rendering once per prepared block, invisible tool blocks, image placement rows, and mouse coordinates after the separator. Existing scrolling, selection, settings, saved timestamps and reload checks also passed.

The scripted runner loaded `/root/dev/pi/pi-agent-ide`, version `0.8.0`, at verified latest `origin/develop` commit `6b16d3765714c57f45b67518ea4f46e31860b822`. No paid provider was used.

## Live check after reload

Two separate assistant messages and two Bash calls printing `ACTIVITY CHECK ONE` and `ACTIVITY CHECK TWO` exercised both panels. IDE HEAD still matched freshly fetched `origin/develop` before both calls.

`inspect_tui` captured the real human viewport: Herdr pane `w3SJ:p1`, 274 × 108 cells, live bottom, revision 198. Both tool clocks appeared on their first header row at the right. One blank row separated the tool blocks. Conversation also kept one blank row between distinct messages and the paragraph break inside the first live answer. The full-width input and footer were visible with no clipping or stray escape codes.

Image blocks retain their native placement rows and use a separate clock row. Combined history keeps its existing rendering.
