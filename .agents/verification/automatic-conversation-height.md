# Automatic Conversation height and 20/80 defaults

## Agreed behavior

- In Rows (panels above/below each other), Conversation grows with content up to half the history area. The toolbar, input and footer are excluded. Further messages scroll instead of increasing the pane height.
- Drag, a height shortcut or a numeric height command saves a manual maximum. It survives restart. `Conversation height: auto` in `≡` and `/transcript height auto` restore automatic height.
- New users start in Columns (panels side by side), with Conversation on the left at 20% and Activity at 80%. The ratio follows window width, not content growth, subject to minimum panel widths. Manual widths and existing arrangements are preserved.
- One blank row still separates messages and tool calls. Paragraphs, native tool formatting, inline clocks and the full-width input dock stay intact.

## Source and runtime

- Automatic height: `178ec0d`.
- Column defaults: `1af71b652eb3508048b4a3f9d40dfcd24808e583`.
- Installed local registry build: `@alexshp/pi-agent-transcript@0.0.0-dev.1791576991`. `cmp` matched installed `src/index.ts`, `src/layout.ts` and `src/preferences.ts` to source.
- IDE: direct checkout `/root/dev/pi/pi-agent-ide`, version `0.8.0`, HEAD and latest fetched `origin/develop` both `6b16d3765714c57f45b67518ea4f46e31860b822`. Concurrent uncommitted IDE changes were present during final verification and were left untouched. This was not a pristine commit-only runtime.
- All integration runs used `PI_TRANSCRIPT_IDE_PATH=/root/dev/pi/pi-agent-ide` and scripted responses, not paid model runs. Runtime details and native frames were recorded under ignored `tmp/test-runs` during verification.

## Checks

- The automatic-height implementation passed one full `npm run check`: 34 tests across 8 files.
- After changing the new-user default, the full run passed 28 of 34. Six old tests depended on Rows implicitly; some also supplied invalid partial preference records. Fixtures now explicitly select valid Rows or Combined settings. The Combined scrollbar probe finds the user message instead of stopping at the startup header.
- The corrected four-file rerun passed 15 of 16 tests. The remaining default-layout test sent drag input before the restored Columns hit zones had rendered. It now captures the current column frame before locating the divider. The final whole layout-controls file passed all 4 tests. Together these runs cover all 34 current tests; this is not a claim of a single all-green final full run.
- Regression checks cover growth and half-height limits with Conversation above and below Activity, follow-end scrolling, drag persistence after restart, command/menu reset, 20/80 at widths 200 and 400, and a dragged width of 83 remaining unchanged at width 500.
- Final TypeScript check and `git diff --check` passed.

## Live human viewport

Both captures used `inspect_tui`, not model-facing screen text alone.

1. After reloading build `0.0.0-dev.1791575549`, pane `w3SP:p1`, 274 × 108 cells, live bottom, revision 211: stacked Conversation occupied about half the visible history despite long history. The latest two-paragraph reply remained visible. Paragraph and message gaps, inline clocks, the full input dock and footer looked intact.
2. After installing and reloading build `0.0.0-dev.1791576991`, the same pane and dimensions, revision 251: Conversation was back on the left beside Activity. Its saved width of 67 was preserved. Wrapped messages stayed inside their pane; clocks and block gaps remained visible; input and footer were not clipped. The new-user 20/80 ratio was checked separately through real-Pi native frames and divider positions.

The user approved the temporary stacked check. Final personal settings were read back as Columns, left Conversation, width 67, automatic row height (`chatHeight: null`), no expansion and clocks enabled.
