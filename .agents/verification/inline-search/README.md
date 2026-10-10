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

All cases retain zero intrinsic history text composition/copy, one shared source invalidation on the cold action, visible native auto scrollbars during scrolling, streamed/tool updates and the original draft. At the time of the first series, the installed user package was still `0.0.0-dev.1791642798`. Live acceptance is pending.

## Repeats and current IDE

The post-merge regression pass covered 17/19 related cases. Both old multiple-startup cases subsequently passed with a 150s outer test budget and unchanged assertions (`8281ad30cbe6`). Together with earlier checks, all 89 regression cases have been verified across runs; the first full attempt was not green.

The first reversed large repeat passed both feature layouts and control Columns on IDE `c714fdc`. Control Rows was rejected because IDE changed during its measurement to `be61c669fcf92edb42105298643cdfe6709863a3`. Its numbers are not acceptance evidence and are not archived here as a passing control. The valid Columns pair measured closed typing 83.0 → 58.3ms, resize 485.9 → 483.0ms and tool updates 81.2 → 81.5ms.

On clean current IDE `be61c66`, all seven search integration cases and all four fresh large control/feature cases passed (`2cf1c5f56457`). Both sources include the native edge-selection fix: control `48cc71c`, feature `340abd1`. Median / p95 emitted-frame times in ms:

| Phase | Columns control | Columns inline | Rows control | Rows inline |
| --- | --- | --- | --- | --- |
| Closed typing | 46.1 / 84.7 | 50.6 / 81.1 | 42.3 / 52.4 | 51.0 / 83.0 |
| Scroll | 80.6 / 159.0 | 71.2 / 121.6 | 56.7 / 72.3 | 56.0 / 119.0 |
| Stream | 61.8 / 104.2 | 56.5 / 100.8 | 45.7 / 78.7 | 46.8 / 60.0 |
| Tool update | 67.8 / 101.0 | 58.3 / 79.2 | 40.6 / 55.1 | 46.6 / 57.5 |
| Resize | 400.1 / 418.9 | 397.0 / 429.8 | 536.7 / 704.1 | 666.8 / 751.2 |

Current Conversation query feedback is 70.6 / 131.3ms in Columns and 48.4 / 68.2ms in Rows; next-match is 78.1 / 110.1ms and 50.2 / 77.8ms. Counters still enforce no intrinsic full-history copying and native updates/auto scrollbars. Atomic checks enforce no candidate/highlight work while search is closed.

Conclusion: no return of the severe rendering slowdown; Columns is close to its control and search feedback is bounded in this synthetic workload. Rows retains an approximately 9ms typing median difference and a 130ms resize median difference in the latest pair. These results do not establish zero added latency or stock parity. Host variation is substantial, and the slower tails above remain part of the evidence. Sixteen individual profile cases passed across all series; one changing-IDE case was excluded.

The agent did not install a new package during these runs. At the final loader check, `pi list` instead reported direct `/root/dev/pi/pi-agent-transcript` loading, and the previously verified registry package was absent. The active source configuration changed outside this task's install actions. The user chose local worktree loading using the IDE development procedure (`22e527d2-7ee8-4907-8b3b-df46138385bc`). The procedure is now adapted in `.pi/skills/develop-transcript/SKILL.md`. A project-only package override suppresses the global Transcript extension, and one temporary loader re-exports this worktree's `src/index.js`. Personal settings and installed packages were not changed.

Normal-configuration startup smoke `shell:e6f96b97507d` ran `pi --approve --no-session --offline --verbose` from the worktree without a prompt or explicit extension entrypoint. Startup lists exactly one Transcript extension, `.pi/extensions/pi-agent-transcript.ts`, plus the direct IDE checkout. The new development skill is discovered as a project skill. No startup errors or duplicate registration diagnostics appeared; Ctrl+D shut the process down with exit 0. The clean direct IDE was v0.8.0 at latest fetched develop `be61c66`. Reload and actual user-operated inline search remain the live acceptance gate.