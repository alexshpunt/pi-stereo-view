# Large-window checkpoint, not acceptance

Raw artifacts from `tmp/profiling/fill-pane-large-1`. All four cases passed with the latest fetched IDE develop source checked before and after each case: v0.8.0, commit `1922570b9882c023f284b85ac45d3bad4be46550`.

Workload: 600 synthetic exchanges, 80 lines per saved tool, 274x108 window, 16 interaction samples, six resize samples, one expanded invalidated cold frame. Native scrollbars are always visible. One local scripted setup turn occurs before measurement. No personal history, saved tool execution or paid model calls.

Production changes are through `02a0e24`: persistent native cache, render-version compact formatting, row-count pane previews, and numeric ScrollView basis. Runtime files may also name the later documentation-only commit `6146c25`. No production source changed during this matrix.

| Mode | Typing median / p95 | Initial display | Resize median / maximum |
| --- | --- | --- | --- |
| Stock | 74.4 / 103.5 ms | 991 ms | 721.6 / 739.7 ms |
| Combined | 87.7 / 103.7 ms | 954 ms | 415.0 / 545.7 ms |
| Columns | 81.9 / 123.5 ms | 980 ms | 494.8 / 512.8 ms |
| Rows | 69.0 / 88.0 ms | 1247 ms | 939.9 / 1409.6 ms |

These timings do not meet acceptance. Warm Columns still has extra painting costs; Rows initial display and resize are slower. The host controls differ from previous matrices, so do not interpret small between-run changes as a proven optimization.

`measurements.json` retains all samples, counters, synthetic terminal frames and measurement definitions. `rendering.cpuprofile` covers warmed interaction and resize, not initial display or the cold frame. Latency is synchronized terminal-frame emission, not compositor presentation. CPU is the process delta and includes scheduled background work.

The strengthened copy counter covers all pane ScrollView.render calls, including native VStack measurement. Its value is zero after the numeric-basis change. Streamed assistant and latest tool update markers remain visible in emitted frames. The draft is preserved.

Search acceptance is paused. No personal installation or live acceptance has happened for this checkpoint.
