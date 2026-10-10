# Post-render structural snapshot experiment

Candidate e89d4fc reuses post-render structural links during cache snapshot creation. caf1176 first restores the production matches loop after the unproven direct-lookup experiment. The installed package remains 0.0.0-dev.1791636688 from develop c18a154; neither candidate is installed or promoted.

The cold-width regression failed with three reads of each structural link instead of two, then passed after this change. All23 focused cases, typecheck and diff checks pass. Read-only review found no new native correctness defect; records allocated for uncacheable output remain a possible cost.

## Completed verification

Terminal shell:9b6481a51aa4 completed with exit0 in693s:
- 52 non-search cases across ten files passed in252.64s.
- All4 forward-order profile cases passed in222.45s.
- All4 reverse-order profile cases passed in216.16s.

The clean direct IDE v0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 matches latest fetched origin/develop before and after each profile. Pi is1.1.0. Each run has600 synthetic exchanges,80 lines per saved tool,274x108 cells,native auto scrollbars,16 warm samples and6 resizes. Startup/cold CPU profiling is disabled for these timings. All scroll samples show a native bar; pane preview copies and composed preview characters stay zero. Visible streamed text, latest tool updates, a single source invalidation on the cold frame and the unsent draft are checked. No personal history, paid model calls or saved tool execution.

Commands, after the non-search suite, run sequentially:

```sh
PROFILE_SCROLLBAR=auto PROFILE_HISTORY=600 PROFILE_SAMPLES=16 \
PROFILE_WIDTH=274 PROFILE_HEIGHT=108 PROFILE_MODES=stock,combined,columns,rows \
PROFILE_OUTPUT=tmp/profiling/structural-snapshot-large-1 npm run profile

PROFILE_SCROLLBAR=auto PROFILE_HISTORY=600 PROFILE_SAMPLES=16 \
PROFILE_WIDTH=274 PROFILE_HEIGHT=108 PROFILE_MODES=rows,columns,combined,stock \
PROFILE_OUTPUT=tmp/profiling/structural-snapshot-large-2 npm run profile
```

## Results

All values below are milliseconds. Raw measurements also retain CPU, per-stage timings, counters and samples.

| Run / mode | Typing median / p95 | Scroll median / p95 | Stream median / p95 | Tool median / p95 | Initial | Cold | Resize median / max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Forward / stock | 43.7 / 48.8 | 57.6 / 71.7 | 43.1 / 44.8 | 45.1 / 55.9 | 542.2 | 352.1 | 284.1 / 333.6 |
| Forward / combined | 63.8 / 72.8 | 71.9 / 94.4 | 65.3 / 90.0 | 64.3 / 93.2 | 610.3 | 395.1 | 338.1 / 421.2 |
| Forward / columns | 35.6 / 61.1 | 51.3 / 74.7 | 41.8 / 72.1 | 47.5 / 63.1 | 674.1 | 451.7 | 274.1 / 279.8 |
| Forward / rows | 27.6 / 34.5 | 32.6 / 44.4 | 29.9 / 41.7 | 29.2 / 39.4 | 793.7 | 474.0 | 362.1 / 417.8 |
| Reverse / stock | 42.7 / 55.8 | 51.9 / 64.5 | 42.4 / 66.6 | 45.1 / 52.4 | 573.0 | 346.7 | 283.4 / 308.0 |
| Reverse / combined | 60.8 / 67.6 | 74.5 / 85.3 | 61.8 / 88.3 | 64.3 / 76.2 | 569.8 | 372.4 | 311.7 / 357.1 |
| Reverse / columns | 35.5 / 55.1 | 54.0 / 87.7 | 39.9 / 62.7 | 47.7 / 87.2 | 667.6 | 477.0 | 269.9 / 314.5 |
| Reverse / rows | 26.2 / 34.6 | 32.6 / 63.4 | 34.4 / 49.1 | 32.7 / 48.6 | 719.6 | 483.6 | 380.5 / 413.6 |

Typing medians improve relative to each current Stock control in both split layouts. Warm Rows generally stays below Stock. Columns scrolling/output tails still exceed Stock in some phases. Initial display remains slower in split; expanded cold frames add approximately100–137ms. Rows resize medians add78–97ms. The original strict stock-parity scenario is not passed.

The preceding3c8b03b control uses the same workload, Pi and IDE, but was collected earlier. Stock typing also falls from59.0ms to43.7/42.7ms, and Stock cold from450.7ms to352.1/346.7ms. The whole observed improvement cannot be credited to structural metadata reuse. The exact removed-read contract is proven; its isolated latency benefit is not. Both mode orders reduce one ordering concern but are not a paired previous-source comparison or simultaneous host controls.

One cold sample and six resizes per case are limited evidence. CPU deltas include scheduled process work; latency is synchronized terminal-frame emission, not compositor presentation. rendering.cpuprofile combines warm phases and resize, not initial/cold work. A separate startup/cold diagnostic is now running; its timings will not replace default-off acceptance controls.

comparison.json retains current and previous measurements, exact provenance, matched Stock ratios and limits. Raw runtime/measurements/warm profiles are stored under each run/mode. Source remains unpromoted; task and branch stay open, and search acceptance stays paused. Continue measured cold-path work rather than treating this matrix as completion.

## Initial/cold diagnostic

Terminal shell:6112ea10ad1d completed with exit0: all3 Stock/Columns/Rows cases passed in159.10s. Same source e89d4fc, workload and current clean IDE; PROFILE_STARTUP=1 and4 warm samples. Raw startup/cold/warm profiles, runtime and measurements are archived in cold-diagnostic/. Timings include inspector overhead and are not acceptance controls.

Cold profiles attribute watch subscription maintenance about32.5ms inclusive in Columns and40.3ms in Rows. Edge blank detection costs about24.0/31.7ms inclusive; snapshot13.2–18.4ms and graph collection8.7–10.9ms. Native rendering and line-width/background work still dominate. Wrapper inclusive time includes the original native invalidate call; do not count all of it as extension overhead.

The next source-proven redundancy is unconditional removal sweeping in watch(), even when every watched component remains present. Graph collection already deduplicates nodes, so observation can count present owned entries; only a size mismatch needs a membership Set and removal scan. The changed-set path still restores old methods, and unobservable replacements must remain uncached. This is the next candidate, not an established latency gain or parity result.
