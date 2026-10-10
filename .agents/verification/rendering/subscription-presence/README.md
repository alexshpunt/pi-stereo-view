# Subscription presence experiment

Source d394519 skips removal sweeps when the observed native subscription set is unchanged. Its regression changes unchanged-width sweep visits from two to zero. Frozen replacement, removed-child restoration and shared subscriptions remain covered.

Terminal shell:4ab22717e4ff completed exit0: 54 non-search cases across ten files, then two four-mode large native-auto matrices. Both matrices use 600 synthetic exchanges, 80 tool lines, 16 warm samples and 274x108 cells. IDE v0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 is clean and current before/after each case; Pi1.1.0. Startup profiling is off. Native scrollbars are visible during scroll measurements. Output, draft, invalidation and bounded preview work assertions pass. Installed version remains0.0.0-dev.1791636688.

| Order / mode | Typing median / p95 ms | Initial ms | Cold ms | Resize median / max ms |
| --- | --- | --- | --- | --- |
| Reverse / Stock | 48.0 / 59.2 | 622 | 412 | 339 / 378 |
| Reverse / Combined | 64.4 / 97.0 | 630 | 421 | 406 / 1765 |
| Reverse / Columns | 41.2 / 62.0 | 743 | 481 | 285 / 308 |
| Reverse / Rows | 30.0 / 36.5 | 807 | 563 | 391 / 454 |
| Forward / Stock | 47.3 / 61.2 | 597 | 402 | 351 / 376 |
| Forward / Combined | 69.2 / 84.5 | 643 | 372 | 340 / 399 |
| Forward / Columns | 37.0 / 67.2 | 688 | 555 | 277 / 296 |
| Forward / Rows | 69.0 / 90.7 | 1082 | 1259 | 612 / 829 |

Forward Rows has a whole-case slowdown in native and compact work, not just one tail sample. Reverse Combined also has a resize outlier. Preserve both; host variation or a source regression has not been isolated. The earlier structural snapshot controls are source e89d4fc and have faster Stock controls too. The exact removed-work contract passes, but these matrices do not establish a latency gain or parity. More matched controls are needed before promotion. Raw measurements, runtime and warm CPU profiles are retained by run/mode; results.json retains full summaries.
