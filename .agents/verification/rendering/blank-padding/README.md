# Final bounded-padding controls

Production source9d29c78 includes structural-link reuse, conditional subscription pruning and a small cache of confirmed blank strings. The native parser, invalidation guards and native scrolling/copy/selection/image behavior remain unchanged. Each removed-work contract has a failing-before/passing-after regression. No isolated latency gain is assigned to the three small cold-path fixes: host controls vary too.

## Verification

- Typecheck and all57 non-search cases across11 files passed in shell:8bd00ddd73c4 (259.02s).
- The profile chained after that suite failed all provenance fetches before measurement due to Clanker session authentication. It supplies no timing evidence. Fresh runs succeeded without bypassing Git authorization.
- Large forward: shell:85925bdc344e, four cases passed in226.61s.
- Large reverse: shell:0a90a92c7232, four cases passed in227.65s.
- Normal forward: shell:bed29c91cef8, four cases passed in99.47s.
- Normal reverse: shell:8968b6b97d57, four cases passed in100.43s.

All16 cases load clean current IDE0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550, Pi1.1.0 and the same source9d29c78. Workload:600 synthetic exchanges,80 tool lines,16 warm samples, native auto bars; large274x108, normal120x35. One local scripted setup turn happens outside measurement. No paid model, personal history or saved tool execution. The installed package remains0.0.0-dev.1791636688 during these runs.

Initial/cold CPU sampling is off. Warm phases use the same V8 sampling in each mode. Each scroll sample shows native bars. Single source invalidation, streamed text, tool output, draft and bounded preview assertions pass. Latency ends at synchronized terminal-frame emission, not compositor presentation. With16 samples, empirical p95 is the maximum; cold has one sample and resize six. Sequential controls and two orders expose variation, not causal isolation.

## Results in milliseconds

| Run / mode | Typing median / p95 | Scroll median / p95 | Stream median / p95 | Tool median / p95 | Initial | Cold | Resize median / max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| large-1 / stock | 47.8 / 64.6 | 58.2 / 79.5 | 45.2 / 50.2 | 46.6 / 59.9 | 575.6 | 369.2 | 336.5 / 372.3 |
| large-1 / combined | 63.1 / 71.4 | 70.3 / 100.4 | 60.7 / 77.0 | 61.0 / 78.4 | 574.8 | 356.4 | 305.4 / 328.1 |
| large-1 / columns | 36.9 / 61.3 | 53.4 / 77.9 | 39.7 / 67.4 | 51.3 / 65.5 | 704.1 | 481.1 | 270.1 / 290.8 |
| large-1 / rows | 31.7 / 42.9 | 38.3 / 48.8 | 32.9 / 41.6 | 33.3 / 41.4 | 720.3 | 470.0 | 382.6 / 453.9 |
| large-2 / stock | 44.1 / 49.9 | 54.2 / 66.8 | 43.3 / 80.4 | 45.0 / 55.1 | 551.7 | 342.5 | 286.0 / 316.8 |
| large-2 / combined | 59.9 / 67.7 | 73.9 / 113.4 | 62.0 / 79.9 | 64.1 / 100.2 | 602.1 | 367.6 | 325.6 / 343.8 |
| large-2 / columns | 39.7 / 68.2 | 60.7 / 107.5 | 49.5 / 92.4 | 48.6 / 69.2 | 728.3 | 526.4 | 336.3 / 447.9 |
| large-2 / rows | 31.1 / 40.9 | 35.7 / 52.4 | 34.6 / 76.9 | 35.2 / 49.6 | 773.1 | 570.4 | 355.5 / 437.6 |
| normal-1 / stock | 41.4 / 58.7 | 40.5 / 52.7 | 42.6 / 79.4 | 42.4 / 51.8 | 623.9 | 463.3 | 325.6 / 363.1 |
| normal-1 / combined | 57.6 / 72.2 | 64.4 / 91.4 | 56.6 / 96.8 | 55.4 / 67.8 | 525.9 | 345.1 | 251.6 / 258.8 |
| normal-1 / columns | 28.5 / 41.2 | 31.5 / 54.1 | 31.9 / 46.1 | 34.3 / 41.4 | 647.7 | 436.8 | 224.7 / 233.7 |
| normal-1 / rows | 32.1 / 41.9 | 30.0 / 47.7 | 28.3 / 49.1 | 30.8 / 34.4 | 664.8 | 480.7 | 290.8 / 309.4 |
| normal-2 / stock | 40.0 / 60.9 | 42.8 / 56.5 | 42.8 / 76.5 | 42.4 / 56.7 | 685.6 | 419.7 | 337.7 / 379.1 |
| normal-2 / combined | 57.7 / 67.8 | 56.5 / 75.5 | 56.7 / 85.0 | 58.7 / 74.0 | 536.0 | 322.3 | 251.1 / 265.8 |
| normal-2 / columns | 29.3 / 47.1 | 34.4 / 54.8 | 36.5 / 52.6 | 31.9 / 45.3 | 675.8 | 426.5 | 267.7 / 304.6 |
| normal-2 / rows | 28.0 / 33.2 | 29.3 / 43.4 | 31.5 / 42.8 | 28.6 / 39.4 | 714.5 | 467.4 | 282.8 / 320.0 |

Both layouts have typing medians below their current Stock control in all four matrices. Normal scroll/stream/tool medians also stay below Stock. Large Rows is generally faster during warm interaction; large Columns has slower scroll/output tails and some slower medians. Split initial/cold frames and large Rows resize still add work. Full stock parity is not established.

The original600-exchange normal-window baseline has typing medians Stock64.55ms, Columns366.86ms and Rows454.11ms. Its Pi/IDE/history match, but native bars were always visible then; the user later chose auto bars. Do not attribute the whole improvement to source changes alone. Intermediate always-bar and auto-bar controls, CPU profiles and removed-work regressions support the severe-slowdown diagnosis separately.

The slow d394519 forward Rows case and reverse Combined resize outlier remain in ../subscription-presence/. The whole-case Rows slowdown did not recur in these final repeats; its cause is not isolated. It is not deleted or declared harmless.

## Decision

Retain these bounded, behavior-preserving reductions and finish at the user-approved practical limit after final installation/live verification. Unchanged blocks no longer repeatedly render or copy scrollback. Remaining cold/new-width work needs complete native rows and correctness checks. The public API has no viewport row source, height-only contract or alternate native scrollbar painter; see ../practical-limit.md. A virtualized or replacement renderer is a separate architecture decision, not proof that all future optimization is impossible.

Raw runtime, measurements and warm CPU profiles are retained by run/mode; comparison.json retains exact summaries and method limits. Search acceptance remains paused. Final live verification and merge are still pending at this checkpoint.
