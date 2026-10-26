# Development

Contributor setup, rendering requirements and release instructions for pi-stereo-view. User-facing installation and controls belong in [README.md](README.md).

## Setup and checks

```sh
npm ci
npm run check
npm run check:package
```

The integration tests run real Pi with scripted responses. The package check installs the exact npm archive in a clean runtime without development dependencies and verifies the loaded split, native tool output and full-width dock.

The test launcher disables automatic network activity with `PI_OFFLINE=1` so update and model-catalog notifications cannot change the expected terminal layout.

The optional cross-extension selection test needs a Pi Agent IDE checkout:

```sh
PI_STEREO_VIEW_IDE_PATH=/path/to/pi-agent-ide npm test -- test/selection-scroll.integration.test.ts
```

Without that path, only those two cross-extension cases are skipped.

CI runs the package suite on Node.js 22.19.0 and checks the archive contents. See [.github/workflows/ci.yml](.github/workflows/ci.yml) for its triggers and steps.

## Try source changes

To load the source without also loading an installed copy:

```sh
pi -ne --tui-mode fullscreen -e ./src/index.ts
```

Run `/reload` after source changes. When using your normal extensions, disable the installed pi-stereo-view before loading a source copy so only one copy is active. Keep worktree-specific loading overrides local and out of Git.

## Rendering contract

The extension uses a guarded runtime layout adapter without changing Pi's source. An unsupported fullscreen layout is left untouched with a warning. Native message and tool renderers remain unchanged; the adapter changes history layout, not the input dock.

Compact Activity is a display-only projection over the full native content index. Only adjacent calls with the same verified tool identity and lifecycle state share a group. Every failed call stays individual; running calls never mix with successful calls. Different tools, reasoning and other visible content, including Conversation entries, break runs before pane filtering. Owned late output follows its call rather than creating a new run. No native history objects or execution data are changed.

A per-frame tool-catalogue snapshot resolves local MCP forwarding aliases by an exact, unique description/schema match against visible IDE namespace tools or provenance-verified builtin Codemode. Hidden, foreign-namespaced, ambiguous and unknown tools retain their raw name and grouping key; suffixes are not identity. Presentation resolution never registers tools or replaces execution or native renderers.

Group and call headers keep a one-cell left gutter, original tool-start clocks inline on the left before the live status and tool name, and no extra timestamp row. Groups show their first call's time and shared state; failed calls keep their own time and argument preview. Separate native-source-keyed expansion state reveals compact members, then the selected call's original renderer and linked output. Expanded members have a left guide and a two-cell inset. Original cards and owned output have another guide and inset; their native render width shrinks by the same amount. Pointer coordinates are translated before native dispatch, and search highlights and saved-text positions are computed before the guides are added. Existing renderer invalidation, mouse actions and copy controls remain active. Layout/width changes, appended calls and state-driven splits or merges preserve visible expansion without reopening explicitly collapsed runs; expansion disables follow-end before changing the projection.

All calls and results stay in the semantic index for search and copying. Search temporarily opens the owning group/call and maps matches to the original body, excluding compact control and clock rows. Clearing search restores user expansion. Switching compact mode off restores full native rendering; Conversation, combined history, saved messages and tool execution are unchanged.

Custom entries can identify their execution owner with `data.parentToolCallId`; custom messages use `details.parentToolCallId`. When that ID matches a native tool call in the current branch, split history and search place the output after that call, in arrival order within its group. Missing owners keep the output in Conversation. Grouping never changes the native history tree or saved messages.

Split history reuses unchanged native blocks between frames. Custom renderers must invalidate changed components before requesting a render, as required by Pi's component API. Native text setters, history rebuilds, streaming, tool updates, expansion, width and theme changes refresh the affected output. Image placement blocks are never retained in this cache. Detaching the layout removes its invalidation observers.

Timestamp decoration puts a local clock on the first line of each text block, with a small right gutter. One blank row separates messages and tool calls without removing paragraph breaks or tool formatting. Tools whose custom call and result renderers use `renderShell: "self"` and show no content add no output, spacing or clock, even when their model-facing result contains images. Default and visibly rendered image blocks retain their native placement rows and use a separate clock row. Assistant text and thinking share their original message time. Combined history uses Pi's original renderer without these decorations.

## Search implementation

Regex search uses ripgrep's auto engine, including PCRE2 lookarounds and backreferences when available. It runs outside the TUI thread with a 1.5-second deadline for the whole query. Editing or closing search cancels the old request. Invalid expressions, timeout, missing PCRE2 support and excessive output produce errors, never partial matches.

Boolean expressions use line-level conditions. Only positive matching spans are highlighted; quoted terms remain literal even within regex queries. There is no fuzzy or automatic regex fallback. Native selection and copy retain the original text, and image placement rows are not highlighted.

If a custom tool renderer omits saved matching text, a temporary Search match fragment exposes it without changing that renderer. Reload, branch changes and small-window fallback discard the open search.

## Persisted settings and tool times

`compactTools` is a boolean display preference. Missing values default to `false` so existing installations keep full tool rendering.

Layout, panel order, sizes, compact Activity, timestamp visibility and copy-button visibility are saved in `transcript.json` in Pi's agent directory. Zoom and split on/off are session-only state and are excluded from that file. Every session starts split and unzoomed; legacy saved `mode` and `zoom` fields are ignored without discarding the saved arrangement. Saved numeric Conversation heights remain manual until the user selects automatic height. Saved arrangements are not reset when defaults change.

Tool-start times are collected as display-only session metadata; they do not become messages in the model's context. New calls keep their recorded start time through streaming, completion and restart. Historical calls without that metadata use the agent message's time as an approximation, marked with `~`. Blocks with unknown times keep their native content without clock or copy-button rows, regardless of timestamp visibility.

## Releases

Publishing a GitHub Release with a `v` tag runs [.github/workflows/release.yml](.github/workflows/release.yml). The tag must match the version in `package.json`. The workflow checks the package on Node.js 24, then publishes to npm with provenance.

For the first publication, add a temporary GitHub Actions repository secret named `NPM_TOCKEN` with npm publish access. It is passed only to the publish step, not to installation or tests.

After the package exists, configure an npm trusted publisher for `alexshpunt/pi-stereo-view`, workflow `release.yml`, GitHub environment `npm`. Remove the temporary secret after trusted publishing is configured; npm then uses GitHub OIDC without a stored npm token.
