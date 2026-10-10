# Practical limit of the current native-renderer architecture

Final source9d29c78 passed57 non-search cases and16 matched normal/large native-auto profile cases in both mode orders. Full stock parity is not established. The user's later direct instruction allows completion at a justified practical boundary, with remaining costs explicit. Final package0.0.0-dev.1791642798 was installed, source-compared, reloaded and verified in exact human viewport w3SR:p3,274x108,revision371; see final-live-runtime.json.

## What the measurements mean

- Every mode restores the same synthetic current-branch history. One local scripted setup turn happens outside measured actions; no paid model or saved tool execution.
- Initial display includes native history construction and remaining initialization after session_start, but excludes module loading. The separate cold frame expands saved tools and invalidates the root once.
- Warm timings run with V8 sampling enabled in every mode. Initial/cold sampling is off unless explicitly marked as a diagnostic. Diagnostic wall-clock timings cannot replace matched default-off controls.
- Latency ends at synchronized terminal-frame emission, not the terminal compositor or perceived key latency. Process CPU can include scheduled background work.
- Each run has its own unchanged Stock control. Forward/reverse orders help with ordering effects but are not simultaneous host controls or a paired old/new-source experiment.
- Six resize samples alternate two widths. No two-width cache is added to exploit that pattern. There is one cold sample per case. With sixteen warm samples, empirical p95 is the largest sample, not a well-estimated distribution tail.
- Native auto bars must actually be visible during every measured scroll action. Hidden-bar diagnostics are not auto-bar acceptance.
- Correctness assertions cover streamed text before restoration, latest tool output, unsent draft, single source invalidation and absence of full-history pane-preview copying. Passing a case does not assert speed parity.
- Keep outliers, including d394519 forward Rows and reverse Combined resize. Do not remove them by calling them host noise without evidence.

## Current API boundary

Pi TUI1.1.0 Component.render(width) returns a complete string array. Public ScrollViewOptions offer scrolling, follow, overscroll, native scrollbar styles and timing; they do not provide a viewport row source, height-only measurement or alternate scrollbar painting hook.

Read-only inspection of installed pi-tui/dist/layout.js, lines70–90, shows that the native scroll layout renders/layouts its whole child with an unspecified height before deriving content height, then retains scrollContentLines. Copy/selection, semantic markers and images use native history/layout output. On a new width, exact wrapping and total height require the current native rows.

Safe extension fixes remove duplicate work and cache unchanged observable blocks. They cannot avoid all first-render/new-width native wrapping while retaining those exact native contracts. Meaningful remaining gains may be possible with a separately designed virtualized renderer or different scroll/layout APIs. Those would change architecture, height accounting, selection/copy, image and invalidation ownership, or require Pi-core changes. They are not a small behavior-preserving patch in this task, and Pi core is explicitly read-only.

This is a justified boundary of the chosen architecture, not proof that no future optimization exists. Do not promise exact stock parity if initial/cold/resize or output tails still differ. The user's latest instruction allows completion at this evidence-backed practical boundary, with measured gaps and rejected experiments stated plainly.

## Completed delivery gates

- Full57-case non-search run and related29-case rerun verify all58 current contracts; typecheck/diff pass.
- All16 forward/reverse normal120x35 and large274x108 native-auto profile cases pass, with raw controls and method limits retained.
- Bounded blank parsing and watch lifecycle received read-only review; shared-child replacement is covered without a production change.
- Final package installed/source-compared/reloaded; exact real viewport verified and metadata retained.
- Feature f447cd2 merged/pushed to develop. Scenario Result and Workpad saved/read back; the task resolves to Done under the later practical-limit approval, not strict parity. Only owned performance temporary files/worktree/branch are eligible for cleanup. Search acceptance stays paused.
