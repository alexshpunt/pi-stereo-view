# Split rendering performance (LPT-718)

This is an ongoing investigation, not a passing acceptance report. Search acceptance is paused and LPT-717 stays open.

## Reproduction

The repository contains a separate real-Pi profiler:

```sh
PROFILE_HISTORY=600 PROFILE_SAMPLES=16 PROFILE_OUTPUT=tmp/profiling/baseline-600-complete npm run profile
node --experimental-strip-types scripts/summarize-render-profile.ts tmp/profiling/baseline-600-complete/columns
```

`PROFILE_MODES` selects stock, combined, columns or rows. `PROFILE_WIDTH` and `PROFILE_HEIGHT` set the window. `PROFILE_TOOL_LINES` sets the size of each saved tool result. Every history, tool result and measured update is synthetic. Isolated settings disable automatic compaction. The runner asserts that all saved tool blocks survived before measurement. It never reads personal session history, runs saved tools or calls a paid model. One local scripted setup turn happens before measurement.

`PROFILE_STARTUP=1` additionally saves separate `initial.cpuprofile` and `cold.cpuprofile` files. These diagnostic runs add profiler overhead and must not replace the default-off timing controls. Set `PROFILE_PHASE=initial` or `cold` when using the summary script to select one of those files.

`PROFILE_SCROLLBAR` selects `always` (the default), `auto` or `hidden` in the isolated synthetic settings only. Record and match it across modes. Hidden-scrollbar diagnostics are not acceptance for the default always-visible scrollbar.

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
| Rows (separate verified baseline) | 454.11 / 575.09 | 549.03 | 452.64 | 8 |

All three cases passed with before/after IDE verification and the full saved tool-block count. Raw artifacts: `tmp/profiling/baseline-600-complete/`.

Rows in that matrix produced samples but failed the post-run Git provenance check: the child command reported unavailable Clanker session authentication. Its numbers are discarded in favor of a separate successful Rows baseline, with the same verified runtime and workload, at `tmp/profiling/baseline-600-rows-verified/`. A fresh parent-tool check also found the same clean IDE revision.

An earlier 600-exchange run automatically compacted the history and consumed the scripted setup response. It is discarded as performance evidence.

V8 profiles and actual render counters show that Columns repeatedly prepares the history six times per emitted frame, rebuilding timestamp indexes and compact formatting. The successful Rows rerun shows eight passes. Large inclusive stacks run through `CompactMessage.renderContent`, native tool rendering, ANSI/background handling and trimming. These findings justify removing repeated work within a frame and reusing formatting only when native output is unchanged. They do not yet prove which optimization achieves stock parity.

## First optimization checkpoint

Commit `64d1d0d` reuses routing and native block preparation for repeated measurements at the same width within one root layout frame. The next frame always refreshes the native source. Timestamp correlation is shared between panels in that frame. Compact formatting is reused only after reading and comparing current native output, clock, width, gutter and theme; image placement blocks are not retained by that formatting cache. Unknown native renderers still run on each new frame.

Two deterministic work-reuse regressions failed before the change and now pass. Together with the existing compact-message tests, seven unit cases pass. Typecheck and `git diff --check` pass. Its four-mode 600-exchange matrix passed at `tmp/profiling/frame-reuse-600/`: Stock typing median 48.43ms, Columns 126.55ms, Rows 127.65ms. This is a material improvement, not stock parity.

## Further measured checkpoints

`293b8e2` also caches the assembled document array within a frame. All four cases passed at `tmp/profiling/assembled-frame-600/`. Typing medians: Stock 47.34ms, Columns 135.90ms, Rows 102.83ms. This did not establish a Columns improvement.

`3c18500` avoids building wrapped match-position maps during ordinary rendering and checks the shared native history once rather than separately for each panel. Search acceptance is not resumed. All four cases passed at `tmp/profiling/lazy-position-600/`. Typing medians: Stock 61.87ms, Columns 93.43ms, Rows 81.22ms. Both split modes are still consistently above stock in this run; there is no parity claim.

Starting with that latter run, tool updates target the latest saved tool, and the final emitted frames contain updated tool lines in all four modes. Earlier runs updated an offscreen tool and are useful for render-work diagnosis but not sufficient evidence for visible tool-update latency. The changed method is recorded in measurements.

A separate real-Pi regression at `tmp/profiling/repeated-invalidation-red/` showed seven source-history invalidations for one root refresh. After `1f7c136`, `tmp/profiling/single-invalidation-green/` passes the exact-one-invalidation contract and verifies updated tool text is visible. The shared root owns the source refresh; individual projected documents reset their own frame state without refreshing the same source again. Guarded fallback lets the native ScrollView retain that ownership. The four-mode 600-exchange matrix passed at `tmp/profiling/single-invalidation-600/`: typing medians Stock 50.88ms, Columns 93.51ms, Rows 88.45ms. The nine-file non-search regression suite passed all 36 cases at this revision; search tests were excluded.

`005007b` bounds the preview arrays used by ancestor stacks to measure pane height. The native ScrollView still owns the full document for painting, selection and scrolling. A real-Pi work contract failed before the change and now passes in both split modes: intrinsic pane measurement cannot construct more rows than the terminal height. The matched four-mode matrix passed at `tmp/profiling/bounded-pane-600/`, with maximum pane preview length 28 rows in the 35-row window.

| Mode | Typing median / p95 (ms) | Typing CPU median (ms) | Scroll median (ms) |
| --- | --- | --- | --- |
| Stock | 51.11 / 69.73 | 56.59 | 47.97 |
| Combined | 63.51 / 73.08 | 69.16 | 64.90 |
| Columns | 86.52 / 116.81 | 102.96 | 95.41 |
| Rows | 76.34 / 91.13 | 88.24 | 73.17 |

This removes excess measurement copies but still does not meet stock parity. Profiles retain substantial native background formatting and compact-render work. Separate native/compact timing is being added to distinguish the remaining costs. The non-search regression suite must be rerun after this latest layout change.

## Persistent native cache checkpoint

The user approved persistent caching by Pi's documented component invalidation contract in ask `92fa12c3-0cc1-4f14-998d-3d7a7e991e13` (`render_cache_contract`). Changed custom state must invalidate before requesting a render. This replaces the earlier decision to call every native renderer every frame. Native shell inputs, child replacement and Text/Markdown setters are also checked because native setters can clear their own caches without invoking `invalidate`. Observers are shared, removed from abandoned trees, and restored when the layout detaches or falls back. Unobservable components and image placement output always render.

`e8bdb7e` removes the remaining full-scrollback scrollbar padding during intrinsic pane measurement and reuses unchanged separator arrays. The new real-Pi copy contract failed in both split modes before the fix and passes afterward; the separator-reuse regression also failed before implementation and passes now. A 600-case matrix was interrupted by Clanker authentication during provenance checks. Stock passed; Combined, Columns and Rows were rerun separately with successful before/after source checks. These fixes alone did not establish parity.

`b524b9d` adds the persistent cache and initial restored-history display measurement. All four cases passed at `tmp/profiling/native-cache-600/`, with the same verified clean IDE source. Typing medians: Stock 68.07ms, Columns 57.70ms, Rows 54.06ms. Columns typing p95 was 90.29ms versus Stock 85.33ms; Columns scroll p95 was also higher. Initial history display was Stock 767.54ms, Columns 812.64ms, Rows 810.91ms. This is promising, but one matrix is not acceptance and cannot establish equivalent initial display or tails.

Initial display now means the end of the profiling `session_start` handler to the first synchronized frame containing the restored history. It includes native history construction and remaining initialization, excludes module loading, and precedes the scripted setup turn. Default-collapsed tools are retained for this startup measurement; the later invalidated `cold` phase expands tools in all modes. Do not compare the two phases as if they were the same workload.

`b30dc43` validates existing cache snapshots without recreating them on every unchanged frame. Thirteen focused cases pass, including direct/nested invalidation, native text/child changes, shared observers, cleanup, width/theme, render-time invalidation, images and unobservable components. Its full non-search regression suite passed all 42 cases. Repeated normal/large-window performance controls and live verification remain pending.

The valid baseline raw profiles, samples and provenance are archived in `.agents/verification/rendering/baseline-600/`. Later raw checkpoints remain in ignored `tmp/profiling` until the accepted final evidence is archived.

## Cache correctness and repeated controls

Read-only review found two cache gaps: native Box colors can change through a callback closure, and a newly created child can invalidate during its first render before being observed. Native Text can also clear its cache when given the same background callback. Three behavior regressions failed before `ca88815` and passed afterward. The cache now checks native cache validity and Box background output, and does not retain output from a render that changes the observed component graph. Sixteen focused cases and typecheck pass, including these regressions.

The streamed-assistant assertion now checks the emitted frame before restoring the original assistant content (`b5d8381`). The following repeated controls passed with 600 exchanges, 80 lines per tool, 16 interaction samples and the same verified IDE source. Initial display and expanded invalidated history still cost more in split; these are not acceptance results.

| Run | Window | Stock typing median / p95 | Columns typing median / p95 | Rows typing median / p95 | Initial display: Stock / Columns / Rows |
| --- | --- | --- | --- | --- | --- |
| candidate-normal-1 | 120x35 | 47.8 / 55.3 ms | 44.9 / 69.9 ms | 43.5 / 57.7 ms | 525 / 698 / 753 ms |
| candidate-normal-2 (reverse mode order) | 120x35 | 48.9 / 55.4 ms | 44.0 / 79.0 ms | 43.8 / 56.0 ms | 572 / 795 / 1020 ms |
| candidate-large-1 | 274x108 | 76.5 / 90.2 ms | 98.8 / 134.4 ms | 59.8 / 87.7 ms | 847 / 1008 / 1101 ms |

`24c5dd6` makes intrinsic pane previews return row-count placeholders rather than composited native text. Actual native layout and painting still use the original header and ScrollView. A real-Pi contract requiring zero preview text failed before the change and passes afterward in both split modes, with streamed assistant and updated tool text visible. Its normal-window matrix (`intrinsic-count-normal-1`) passed all four cases: typing medians Stock 47.2 ms, Columns 45.0 ms, Rows 38.0 ms. Initial display was still Stock 644 ms, Columns 815 ms, Rows 832 ms; Rows resize median was 330.6 ms versus Stock 274.5 ms. Large-window measurement remains needed.

`1a74939` avoids capturing unused native property snapshots before a cache miss is rendered, and removes per-node comparison callbacks on warm hits. All sixteen focused behavior cases and typecheck pass. Its performance measurement is pending. Neither change is installed in the personal Pi instance yet. Search testing remains paused.

## Wider-window follow-up

The first `intrinsic-count-large-1` matrix passed Stock only. Combined failed its post-run Git source check and the remaining cases could not fetch IDE source; those results are discarded. Separate foreground cases at `intrinsic-count-large-verified` passed Columns and Rows without bypassing authorization. Typing median/p95: Stock 64.7/77.7 ms, Columns 89.5/116.1 ms, Rows 58.3/79.6 ms. Initial display: Stock 806 ms, Columns 1018 ms, Rows 1012 ms. The controls still fail parity.

Separate diagnostic profiles at `startup-profile-600` passed Stock, Columns and Rows. They show native history rendering plus cache setup in initial display, and extra cache observation/invalidation in the expanded cold frame. Inspector overhead is material; use these profiles to locate work, not as default-off timing acceptance. No single cold-path fix is proven by these samples.

`d3b8ae8` reuses compact formatting by the native render version instead of scanning and copying cached rows. A work regression failed with three reread rows before implementation and passes with zero afterward. It also verifies an invalidated renderer that mutates the same array refreshes visible text. All seventeen focused cases and typecheck pass.

Read-only review found another full-scrollback copy: the pane's `basis: "auto"` ScrollView entry was measured by native VStack independently of `TranscriptPane.render`. The old counter missed that path. The counter now covers every pane ScrollView.render call. Both split modes failed this strengthened real-Pi work contract before `02a0e24`, and pass afterward. The view now fills the already allocated pane height with numeric zero basis and grow=1. Native scrollbars, hit geometry, painting and scroll state remain owned by Pi; no custom scrollbar was introduced. Final short-history, zoom, resize and other non-search behavior verification is still required.

## Acceptance still needed

- Implement and measure the fixes against matched controls, including repeated runs and a large window.
- Measure initial history display separately from an invalidated warmed process.
- Verify existing non-search behavior and the real human-visible viewport after reinstall/reload.
- Preserve raw before/after evidence before cleaning ignored temporary artifacts.
- Do not call the performance issue fixed or close it until its approved scenario passes.
