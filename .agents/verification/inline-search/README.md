# Inline search measurements

Nine sequential real-Pi cases passed in `shell:157018a9648a`. Each used 600 synthetic exchanges, 80 saved tool-output lines per exchange, auto scrollbars and 16 ordinary-frame samples. No personal history, paid model call or saved tool execution was used. The IDE was the clean direct checkout v0.8.0 at `c714fdcce2261df6c16bf657f885a87af22f7add`, fetched and checked per case. Each directory preserves raw measurements and exact runtime provenance.

## First series

Median emitted-frame time in ms (control → inline feature), with search closed:

| Window | Layout | Typing | Scroll | Stream | Tool update |
| --- | --- | --- | --- | --- | --- |
| 120x35 | Columns | 161.8 → 96.8 | 143.2 → 76.0 | 205.7 → 87.7 | 130.9 → 126.4 |
| 120x35 | Rows | 79.8 → 72.9 | 76.5 → 68.0 | 104.6 → 83.1 | 93.5 → 90.6 |
| 274x108 | Columns | 117.3 → 104.4 | 142.4 → 133.8 | 133.3 → 161.2 | 147.9 → 194.6 |
| 274x108 | Rows | 82.7 → 86.8 | 92.8 → 129.3 | 76.9 → 117.7 | 84.8 → 137.7 |

The normal-window series shows no added ordinary-frame cost. The large series has slower stream/tool tails and a slower Rows cold/resize case; retain these results rather than claiming universal parity or improvement. The host was busy with unrelated work (observed load average about 23), so wall-clock differences need repeated matched controls. CPU medians and counters are also preserved in the raw files.

Control source was `9c2b147` for the normal series and `48cc71c` for the large series. Develop received the independent native selection-edge scrolling fix between these series. Feature source was `0439473` throughout. Each individual case rejected source changes during its measurement, but the large comparison does not include that fix on both sides. It is diagnostic, not the final matched acceptance. The fix has now been merged into the feature branch; targeted mouse/search checks and a large-window repeat are required.

## Search responsiveness

Conversation query feedback median / p95 in ms:

- Normal Columns: 113.6 / 164.7; Rows: 101.5 / 178.1.
- Large Columns: 164.3 / 307.9; Rows: 142.0 / 208.8.
- Activity, large Columns: 163.1 / 190.8, including the long saved tool history.
- Activity next-match median / p95: 93.7 / 115.9.

These timings reach the first synchronized input-feedback frame. They do not claim end-to-end compositor latency or completion of the deferred match scroll. Captured frames and integration assertions separately check visible results, native highlight/copy, close restoration and draft preservation. Search timings are collected after the CPU profiler stops; ordinary rendering phases use the same instrumentation for feature and control.

All cases retain zero intrinsic history text composition/copy, one shared source invalidation on the cold action, visible native auto scrollbars during scrolling, streamed/tool updates and the original draft. The installed user package is still `0.0.0-dev.1791642798`. Live acceptance is pending.
