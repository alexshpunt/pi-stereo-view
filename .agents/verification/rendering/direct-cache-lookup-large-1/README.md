# Direct cache lookup experiment: no proven gain

Command:

```sh
PROFILE_SCROLLBAR=auto PROFILE_HISTORY=600 PROFILE_SAMPLES=16 \
PROFILE_WIDTH=274 PROFILE_HEIGHT=108 \
PROFILE_MODES=stock,combined,columns,rows \
PROFILE_OUTPUT=tmp/profiling/direct-cache-lookup-large-1 npm run profile
```

Terminal shell:47fcca3b9a82 completed with exit0: all four cases passed, profile duration281.71s. Candidate source is 691484769da6b8291e8c0b4981103011e017dbcc. The clean direct IDE v0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 matches the latest fetched origin/develop before and after each case. Pi is1.1.0.

Every case uses 600 synthetic exchanges, 80 lines per saved tool, 274x108 cells and native auto scrollbars. All scroll samples have a visible native bar and pane preview-copy counts stay zero. Initial display is separate from one expanded invalidated cold frame. Warm actions have16 samples each; resize has6. One local scripted setup turn precedes measurements. No personal history, paid models or saved tool execution.

| Mode | Typing median / p95 | Scroll median / p95 | Stream median / p95 | Tool median / p95 | Initial display | Cold frame | Resize median / maximum |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stock | 60.1 / 81.5 ms | 67.0 / 82.0 ms | 68.4 / 118.9 ms | 75.8 / 113.9 ms | 701 ms | 516 ms | 379 / 436 ms |
| Combined | 85.0 / 146.0 ms | 95.8 / 162.4 ms | 73.8 / 117.2 ms | 96.2 / 113.6 ms | 734 ms | 604 ms | 374 / 392 ms |
| Columns | 47.7 / 76.9 ms | 71.9 / 99.9 ms | 62.6 / 90.4 ms | 66.7 / 93.5 ms | 872 ms | 583 ms | 320 / 359 ms |
| Rows | 40.9 / 59.0 ms | 47.0 / 68.3 ms | 39.2 / 59.9 ms | 43.3 / 66.4 ms | 978 ms | 743 ms | 464 / 507 ms |

| Mode | Typing CPU median / p95 | Scroll CPU median / p95 | Stream CPU median / p95 | Tool CPU median / p95 | Initial CPU | Cold CPU | Resize CPU median / maximum |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stock | 66.2 / 131.8 ms | 73.9 / 97.2 ms | 71.7 / 95.7 ms | 83.7 / 121.1 ms | 1159 ms | 591 ms | 504 / 699 ms |
| Combined | 96.0 / 197.8 ms | 105.3 / 273.4 ms | 82.4 / 272.8 ms | 109.1 / 132.7 ms | 1126 ms | 740 ms | 472 / 537 ms |
| Columns | 62.8 / 81.2 ms | 73.0 / 167.2 ms | 66.1 / 269.5 ms | 73.0 / 103.7 ms | 1482 ms | 779 ms | 400 / 462 ms |
| Rows | 43.6 / 68.8 ms | 52.5 / 118.1 ms | 43.5 / 64.6 ms | 42.2 / 65.7 ms | 1658 ms | 945 ms | 613 / 843 ms |

## Matched comparison

comparison.json checks workload, IDE provenance, Pi version and startup-profiler setting against the preceding shared-image-scan-large-1 checkpoint3c8b03b. It records all phase metrics, ratios and profile evidence. That earlier matrix ran reverse mode order; this one runs forward order. Both run modes sequentially, but they are not simultaneous host controls.

Relative to its current Stock control, split still has lower typing medians and warm Rows is faster. Initial/cold rendering, Columns scroll tails and Rows resize fail the original parity criterion.

The previous checkpoint had typing medians Stock59.0ms, Columns41.8ms, Rows31.0ms; this run has60.1/47.7/40.9ms. Compact typing overhead rises from13.1 to19.5ms in Columns and13.9 to20.7ms in Rows. matches self samples rise from721 to1211ms and659 to1119ms, respectively; its share of sampled time also rises. These profiles mix phases and are diagnostic, not an isolated microbenchmark.

Stock and unchanged Combined also vary materially between matrices. One run does not prove that every slowdown was caused by the code change. However, these results do not support adopting direct lookup as an optimization; there is regression risk, not a demonstrated win. Do not install or merge this candidate based on this evidence.

Raw measurements retain samples, counters and synthetic frames. CPU includes scheduled process work; latency is terminal-frame emission, not compositor presentation. One cold sample and six resizes cannot establish robust tails. rendering.cpuprofile covers warm interactions and resize, not initial display/cold rendering.

Installed version remains0.0.0-dev.1791636688 from merged developc18a154. No update, reinstall or reload happened during this experiment. The performance branch and task remain open; search acceptance stays paused.
