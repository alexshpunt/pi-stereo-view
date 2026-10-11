# Compaction routing and classic Combined history

## Requested behavior

Compaction summaries belong in Conversation, including saved-summary search. Activity must not show a duplicate. Combined history must use Pi's original document and renderer without extension clocks or compact spacing. Expanding a single panel still uses its saved clock setting. Switching modes must not change that setting.

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

Read-only review found no concrete regression in routing, search reveal, native invalidation or mode switching. Review is not a substitute for runtime checks.

## Live verification

Before reload, `inspect_tui` captured pane `w3Q0:pJ`, 274×108 cells, revision 104 at the live bottom. Combined still showed the old added clock rows. Final source reload and visual checks are pending.
