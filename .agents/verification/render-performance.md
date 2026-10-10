# Split rendering performance (LPT-718)

This is an ongoing investigation, not a passing acceptance report. Search acceptance is paused and LPT-717 stays open.

## Reproduction

The repository contains a separate real-Pi profiler:

```sh
PROFILE_HISTORY=600 PROFILE_SAMPLES=16 PROFILE_OUTPUT=tmp/profiling/baseline-600-complete npm run profile
node --experimental-strip-types scripts/summarize-render-profile.ts tmp/profiling/baseline-600-complete/columns
```

`PROFILE_MODES` selects stock, combined, columns or rows. `PROFILE_WIDTH` and `PROFILE_HEIGHT` set the window. `PROFILE_TOOL_LINES` sets the size of each saved tool result. Every history, tool result and measured update is synthetic. Isolated settings disable automatic compaction. The runner asserts that all saved tool blocks survived before measurement. It never reads personal session history, runs saved tools or calls a paid model. One local scripted setup turn happens before measurement.

Raw samples, initial/final terminal lines, CPU profiles and runtime provenance are saved below `PROFILE_OUTPUT`. Initial runtime records are kept outside the individual case folders so failed cases do not erase them. The profiler wraps the actual loaded document instances, not separately imported classes.

Latency is action to synchronized terminal-frame emission, not compositor presentation. CPU is the process CPU delta and includes work scheduled in the interval. `cold` means an invalidated history frame, not total process startup. Six resize samples and one cold sample are not enough for a robust tail-latency claim. V8 samples cover the measured phase sequence; inclusive totals are not additive and do not isolate each action.

## Baseline findings

Production baseline: develop `aebe6ef`. Profiling infrastructure for the complete-history run: `7055a6d`. Direct IDE checkout `/root/dev/pi/pi-agent-ide`, v0.8.0, source `1922570b9882c023f284b85ac45d3bad4be46550`, clean and matching fetched origin/develop.

100 synthetic exchanges, 80 lines per tool result, 120x35 window, six samples: Stock typing median 15.08ms, Combined 17.31ms, Columns 75.47ms, Rows 70.31ms. All four sanity cases passed. Raw artifacts: `tmp/profiling/baseline-100/`. This small run established reproduction, not acceptance. Its initial imported-class counters were zero because the loader used different module instances; those counters are not usable evidence.

600 exchanges, the same tool size and window, 16 interaction samples:

| Mode | Typing median / p95 (ms) | Typing CPU median (ms) | Scroll median (ms) | Document renders per frame |
| --- | --- | --- | --- | --- |
| Stock | 64.55 / 107.04 | 72.66 | 82.64 | Native stock document, no extension counters |
| Combined | 88.46 / 117.48 | 98.53 | 84.51 | 1 |
| Columns | 366.86 / 459.65 | 422.89 | 378.88 | 6 |

All three cases passed with before/after IDE verification and the full saved tool-block count. Raw artifacts: `tmp/profiling/baseline-600-complete/`.

Rows in that matrix produced samples but failed the post-run Git provenance check: the child command reported unavailable Clanker session authentication. Its numbers are provisional, not a passing control case. A separate Rows baseline rerun is needed. A fresh parent-tool check still found the same clean IDE revision.

An earlier 600-exchange run automatically compacted the history and consumed the scripted setup response. It is discarded as performance evidence.

V8 profiles and actual render counters show that Columns repeatedly prepares the history six times per emitted frame, rebuilding timestamp indexes and compact formatting. Rows provisionally shows eight passes. Large inclusive stacks run through `CompactMessage.renderContent`, native tool rendering, ANSI/background handling and trimming. These findings justify removing repeated work within a frame and reusing formatting only when native output is unchanged. They do not yet prove which optimization achieves stock parity.

## Acceptance still needed

- Implement and measure the fixes against matched controls, including repeated runs and a large window.
- Measure initial history display separately from an invalidated warmed process.
- Verify existing non-search behavior and the real human-visible viewport after reinstall/reload.
- Preserve raw before/after evidence before cleaning ignored temporary artifacts.
- Do not call the performance issue fixed or close it until its approved scenario passes.
