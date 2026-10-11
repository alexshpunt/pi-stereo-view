# Compaction routing and classic Combined history

## Requested behavior

Compaction summaries and native compaction notices belong in Conversation, including saved-text search. Activity must not show a duplicate. Combined history must use Pi's original document and renderer without extension clocks or compact spacing. Expanding a single panel still uses its saved clock setting. Switching modes must not change that setting.

Work stays in `/root/dev/pi/pi-agent-transcript`; no Teleport or extra worktree is used. No personal settings are changed and no paid compaction is invoked.

## Changes

- Painting and search share the same compaction pane routing.
- Search reveals the original native compaction component and its saved summary.
- Combined keeps the original native ScrollView child. The extension no longer substitutes a projected document there.
- Removed the unused Combined timestamp wrapper and its restoration code. Native invalidation still visits the original history through its ScrollView.
- Split and expanded panels retain their existing clocks, spacing, scrollbars and rendering cache.

## Automated checks

Runtime: direct Pi Agent IDE checkout `/root/dev/pi/pi-agent-ide`, version `0.8.0`, source `c56629d4a1ecd37e1ad15505c864526e8410e8e2`, clean and equal to the freshly fetched `origin/develop` before each run.

Meaningful red: `shell:05891cf274ab` failed three contracts before production changes: compaction routing/search, native compaction placement and Combined clocks.

First focused run: `shell:4849bdaf1a92` passed 12 of 13 cases across native mapping, native render work and timestamps. Its only failure was an old scrollbar test still expecting clocks in Combined. That test now exercises the expanded Conversation panel, where clocks are still required.

A follow-up also exercises mouse expansion and collapse of the real native compaction component, both split layouts, expanded panels and Combined → split restoration. It checks that Combined's native child is still a `Container` and the saved clock preference remains enabled.

The expanded-panel scrollbar check passed in `shell:72aa869c8d77`. The extra mouse-expansion check initially failed because Pi had already expanded the native compaction component: clicking it collapsed it. Mouse receipts confirmed native click delivery. The fixture now explicitly starts collapsed, then checks expansion and collapse. Captures wait for a synchronized emitted frame.

Final focused run: `shell:464d93b5310d` passed all 23 cases across six files; typecheck and diff check passed. It also covers search, selection/copy and reload. Pi Agent IDE had advanced to clean latest `0b3830d26b9287d255c1ebaccf2cf62c3cf8f50b` before this run; its version remains `0.8.0`.

The recorded compaction run was replayed offline into 38 synchronized frames. Replay's final screen matched `tui-rendered.log` byte-for-byte. An extra focused check now explicitly verifies mouse expansion followed by Pi's native Ctrl+O collapse, avoiding a rapid second mouse click being interpreted as word selection; `shell:b4fc56478238` passed this check with typecheck and diff check.
Read-only review found no concrete regression in routing, search reveal, native invalidation or mode switching. Review is not a substitute for runtime checks.

## Live verification

Before reload, `inspect_tui` captured pane `w3Q0:pJ`, 274×108 cells, revision 104 at the live bottom. Combined still showed the old added clock rows. Normal-configuration startup smoke `shell:7c972eb84050` passed with a clean Ctrl+D exit (code 0), no model prompt, one configured Transcript source `/root/dev/pi/pi-agent-transcript/src`, and no load or duplicate-registration errors observed. It used clean latest direct IDE `b0ae4c124eb909ba7527b531178520b53f9eb469`, version `0.8.0`. The direct source was reloaded at `d2b94b1`. A fresh `inspect_tui` attempt refused because `w3Q0:pJ` belonged to a different Pi session. No other pane was substituted and no post-reload human-viewport visual pass is claimed. At reload, IDE HEAD still matched latest fetched `b0ae4c124eb909ba7527b531178520b53f9eb469`; concurrent changes were limited to its README and configuration skill, and were preserved.

Fallback inspection used the final synthetic real-Pi run, replayed into 37 synchronized frames. Its final screen matched `tui-rendered.log`. Frame 27 shows the compaction block in Conversation, separate from Activity, with retained panel clocks and the native input dock. Frame 30 shows Combined with native spacing and no extension clocks. The corresponding replay viewports were inspected through `shell:73076bd6bf4c` and `shell:4a25c861b35d`. These are recorded-layout checks, not a capture of the user's live pane; the plain replay viewer does not preserve all colors and font glyphs.

The replay also exposed a separate native `Session compacted …` notice in Activity. The user explicitly chose to move both the summary and this notice in `compaction_notice_scope` (request `37964444-3b08-4fc5-93bb-1b7df6d04359`). Notice painting and search now route to Conversation too; other native status messages remain in Activity. Classification refreshes Pi's lazy ThemedText only after invalidation and caches the decision by exact native text, without another native render on warm frames.

The notice regression failed meaningfully before the follow-up, then all six atomic mapping/render-work cases passed (`shell:b70e74fcd727`); typecheck and diff check passed. The earlier verification launch stopped because the shared IDE checkout had changed. It was not switched or reset. The user then removed IDE verification from this task and asked to reread the main agent instructions; the current `/root/.pi/agent/AGENTS.md` no longer contains that requirement. Final Transcript checks run without the optional IDE extension override.

## Final notice verification

At production commit `74e42f5`, `shell:da2348b46ba0` passed all 15 real-Pi timestamp and search cases without `PI_TRANSCRIPT_IDE_PATH`; typecheck and diff check passed. The native compaction case verifies both summary and notice in Conversation, native mouse expansion and Ctrl+O collapse, classic Combined without clocks, and retained split clock preferences.

Normal configured startup `shell:a976d561771a` passed with a clean Ctrl+D exit (code 0), no model prompt, one configured Transcript source at `/root/dev/pi/pi-agent-transcript/src`, and no observed load or duplicate-registration errors. No optional IDE verification was performed.

The current synthetic compaction recording replayed into 31 synchronized frames and its final screen matched `tui-rendered.log` byte-for-byte. Native scenario snapshots and runtime metadata are archived under `.agents/verification/compaction-classic/` as `frames.json` and `runtime.json`. The replay inspection selected expanded summary (18), Rows (22), Combined (25), and restored Rows (27). The final source was reloaded at `74e42f5`. `inspect_tui` again refused because pane `w3Q0:pJ` belonged to another Pi session; no other human pane was substituted. Recorded-layout pixel checks used `shell:ca9336c86f5f` (Rows) and `shell:58f414f9430d` (Combined), both 120×85 cells. Rows shows the native summary and compaction notices only in Conversation, with right-aligned panel clocks and preserved input dock. Combined shows the original native spacing with no added clocks. No message clipping or escape-code overlap was observed. The plain replay viewer has missing icon/divider glyphs and does not preserve the original colors; no post-reload human-pane visual pass is claimed.