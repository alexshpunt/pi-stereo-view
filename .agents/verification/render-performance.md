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

## Behavior verification at the current production checkpoint

The ten-file non-search suite passed all 46 cases against production source through `02a0e24`, with the direct latest IDE checkout verified before launch. Search tests were excluded. It includes automatic/compact sizing, native work contracts, cache correctness, native display, controls and divider persistence, reload, timestamps, selection/copy and independent scrolling. Typecheck and diff checks also pass. Runtime receipt is `tmp/test-runs/non-search-final-runtime.json` and terminal `shell:dfb1ef246ea7` (exit0, 250.87s). This verifies behavior, not stock performance parity or live acceptance.

Raw large-window evidence from `fill-pane-large-1` is archived in `.agents/verification/rendering/checkpoint-02a0e24-large/`. All four cases passed. Columns typing median/p95 is 81.9/123.5 ms against Stock74.4/103.5 ms; Rows69.0/88.0 ms. Rows initial display and resize still trail Stock. There was no hidden-copy counter activity after the numeric pane basis change, but this alone did not eliminate the remaining painting cost.

## Intermediate installation and live observation

The user approved installing the passing checkpoint in ask `7e204620-67c9-4df6-8b12-83bcedd41f8f` / `intermediate_install`, while leaving LPT-718 open. Installed `@alexshp/pi-agent-transcript@0.0.0-dev.1791633675` from `22a319b`; index/layout/native/timestamps/render-cache files match source. The latest direct IDE v0.8.0 checkout was fetched and verified clean at `1922570b9882c023f284b85ac45d3bad4be46550` before reload. No duplicate npm IDE was used.

After explaining that scrollbars are not the divider, the user chose native auto mode in follow-up `53c05873-c5c5-4551-92e3-1cd0b6643658` / `scrollbar_direction_clarified`. Only global Pi `fullscreenScrollbar` changed from always to auto. Existing panel widths, height, order and clock selection were preserved. This changes scrollbar visibility in both Combined and split; it is not a custom scrollbar or removal of native scrolling.

Mandatory reload completed. Real human-pane capture `w3SR:p1`, 158x57 cells, revision448 shows Combined and a full-width input dock without visible rendering errors. After the user switched to split, revision455 shows intact Conversation/Activity columns, the saved width67 Conversation, separated message blocks, and the full-width input dock. Clocks remain off as selected; none were injected for this check. No visible escape codes, overlapping columns or detached padding were seen. The user reported: “кстати теперь ощущается достаточно быстро, яб сказал нативно”. This is valuable live feedback, not a measured latency comparison or formal stock-parity acceptance. No agent-controlled Herdr input or personal-history benchmark was used.

The hidden-scrollbar diagnostic passed three modes at `tmp/profiling/hidden-scrollbar-large-1`: typing median/p95 Stock48.6/65.0ms, Columns44.6/78.7ms, Rows30.3/34.9ms. It informed the visibility choice but is not acceptance for auto mode, especially during scrolling when bars are visible. Matched auto-mode controls remain needed. Runtime and viewport metadata are recorded in `tmp/test-runs/intermediate-live-runtime.json`. Search acceptance remains paused.

## Matched native-auto controls

Profiling-only commit `5d7fc32` records visible scrollbar counts and requires every auto-mode scroll sample to show a native bar. Production source remains through `02a0e24`. All twelve cases passed across `auto-normal-1`, reverse-order `auto-normal-2`, and reverse-order `auto-large-1`. The two latter matrices completed sequentially in `shell:8b2500484b41` (exit0, 348s); no other benchmark or regression suite ran alongside them. Each case verified the same clean, latest fetched IDE v0.8.0 source `1922570b9882c023f284b85ac45d3bad4be46550` before and after the run.

Each case uses 600 synthetic exchanges, 80 lines per saved tool and 16 interaction samples. Normal windows are 120x35; the large window is 274x108. Bars are visible in every measured scroll sample, so the comparison does not rely on hiding them during scrolling. Raw measurements, runtime records and warm CPU profiles are archived in `.agents/verification/rendering/auto-checkpoint-02a0e24/`.

| Run / mode | Typing median / p95 | Scroll median / p95 | Initial display | Expanded cold frame | Resize median / maximum |
| --- | --- | --- | --- | --- | --- |
| Normal 1 / Stock | 42.0 / 51.1 ms | 44.0 / 59.0 ms | 659 ms | 439 ms | 354 / 361 ms |
| Normal 1 / Columns | 35.5 / 48.0 ms | 37.6 / 61.6 ms | 696 ms | 474 ms | 288 / 317 ms |
| Normal 1 / Rows | 30.9 / 39.5 ms | 30.3 / 52.9 ms | 710 ms | 470 ms | 332 / 369 ms |
| Normal 2 / Stock | 43.2 / 56.6 ms | 63.2 / 96.4 ms | 718 ms | 455 ms | 380 / 424 ms |
| Normal 2 / Columns | 31.3 / 44.4 ms | 42.5 / 77.0 ms | 691 ms | 517 ms | 263 / 336 ms |
| Normal 2 / Rows | 35.6 / 44.7 ms | 31.4 / 67.6 ms | 691 ms | 466 ms | 335 / 363 ms |
| Large / Stock | 47.9 / 60.6 ms | 60.5 / 81.5 ms | 597 ms | 421 ms | 313 / 360 ms |
| Large / Columns | 39.7 / 73.5 ms | 59.1 / 84.6 ms | 747 ms | 535 ms | 316 / 341 ms |
| Large / Rows | 34.2 / 45.3 ms | 40.0 / 71.9 ms | 826 ms | 605 ms | 554 / 605 ms |

Ordinary-window typing, ongoing assistant text and tool-update medians are below Stock in both repeats. Warm Rows also improves the large-window medians. However, large Columns tool updates are 59.4/105.1 ms against Stock49.6/56.4 ms, and initial display, expanded cold rendering and large Rows resize still trail Stock. Control variation is visible, especially in scrolling; it does not explain away these remaining costs. These are passing workload checks, not a passing parity scenario. The user's native-feeling live feedback and the installed intermediate fix remain valid, while LPT-718 stays open and search acceptance stays paused.

## Stable-tree subscription follow-up

Read-only review `replica-6382543c` found duplicate subscription maintenance on every cache miss: `watch(initial)` and `watch(after)` visited the same stable graph. A width-change work regression failed with two maintenance passes instead of one (`shell:39d0e4f33b45`). The cache now retains the initial observation result and only checks that its wrappers are still owned after a stable render; changed graphs still update subscriptions and their first output is not cached. A renderer replacing its invalidate method is also explicitly covered.

All19 focused cache, compact-format and native-work cases pass, along with typecheck and diff checks (`shell:596236fa4184`). Existing tests retain render-time invalidation, new-child first-render handling, removed-child restoration, shared subscribers, native background updates, images and unobservable components. This small change is not installed yet and its latency improvement is not proven; matched large-window profiling is next. The installed intermediate version remains unchanged.

The `fc03c38` large auto matrix passed all four cases (`shell:16da9feefc1b`, exit0). Typing median/p95: Stock63.8/77.5 ms, Columns38.1/62.9 ms, Rows30.0/35.0 ms. Initial display: Stock720 ms, Columns711 ms, Rows802 ms. Expanded cold frames: Stock496 ms, Columns507 ms, Rows550 ms. Resize median/maximum: Stock460/609 ms, Columns296/330 ms, Rows380/442 ms. Stock itself is slower than in the prior large matrix, so the whole observed resize improvement cannot be credited to subscription reuse. Raw evidence remains at `tmp/profiling/stable-subscriptions-large-1/`; the exact one-pass work contract is proven, stock parity is not.

The same review identified a duplicate image-placement scan on formatting misses. A work regression failed with two scans (`shell:bb5dae9127b6`) before implementation. NativeRenderCache now shares the latest render's image-placement classification with CompactMessage. The regression covers unchanged text, Kitty and iTerm images, and image-to-text updates without dropping rows or retaining image placement. All20 focused cases, typecheck and diff checks pass (`shell:2b6fec308944`). Full non-search regression and another matched large control are next; neither new cache follow-up is installed yet.

## Verified cache follow-ups, remaining decision

At `3c8b03b`, the complete ten-file non-search suite passed all49 cases. The reverse-order large native-auto matrix then passed all four modes sequentially in the same terminal `shell:b50017179166` (exit0, 496s). No benchmark ran alongside regression tests. IDE v0.8.0 was loaded from the clean direct latest source `1922570b9882c023f284b85ac45d3bad4be46550`; each profile case verifies it before and after. Raw evidence for this matrix and the previous `fc03c38` matrix is archived in `.agents/verification/rendering/cache-followups/`.

| Mode | Typing median / p95 | Scroll median / p95 | Stream median / p95 | Tool update median / p95 | Initial display | Expanded cold frame | Resize median / maximum |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stock | 59.0 / 72.5 ms | 68.7 / 92.1 ms | 50.1 / 76.3 ms | 56.7 / 68.1 ms | 656 ms | 451 ms | 374 / 516 ms |
| Combined | 62.6 / 76.1 ms | 77.7 / 123.5 ms | 66.7 / 98.1 ms | 66.7 / 91.0 ms | 636 ms | 443 ms | 346 / 403 ms |
| Columns | 41.8 / 75.6 ms | 68.5 / 135.6 ms | 50.3 / 80.3 ms | 58.3 / 76.5 ms | 796 ms | 704 ms | 319 / 373 ms |
| Rows | 31.0 / 42.2 ms | 36.1 / 55.7 ms | 33.8 / 44.3 ms | 34.0 / 73.7 ms | 767 ms | 562 ms | 389 / 444 ms |

Warm Rows is faster in this control, and Columns typing median remains improved. Columns scrolling and output tails, initial display and cold rendering still fail the original strict parity criterion. The cold sample and six resizes are limited evidence; they are not robust tail measurements. The code changes prove less duplicate work, not that every phase is now faster than Stock. Both follow-ups are committed and pushed but not installed or live verified yet.

The user chose to continue to full parity in ask `188fbcf2-89a3-4434-9df3-cc4087b31138` / `performance_next_stage`, with the explicit note: “мержим в девелоп, чтобы я мог этим пользоваться, затем продолжаешь работу”. This authorizes merging the verified checkpoint into develop now and continuing the residual work; it is not parity acceptance or permission to close LPT-718. Search acceptance stays paused. The performance branch and worktree remain active after this intermediate merge.

## Merged checkpoint and refreshed live verification

As explicitly requested, checkpoint `c18a154` was fast-forwarded into develop and pushed. The performance branch and worktree remain active for the unfinished parity stage. Published and installed `@alexshp/pi-agent-transcript@0.0.0-dev.1791636688` from that merged commit; installed index/layout/native/timestamps/render-cache match source. The clean direct IDE v0.8.0 source `1922570b9882c023f284b85ac45d3bad4be46550` was fetched and verified against origin/develop before reload.

Mandatory reload completed. Two short native Bash calls emitted MERGED CACHE CHECK ONE and TWO, and assistant commentary contained two paragraphs. Exact human viewport capture `w3SR:p3`, 274x108 cells, live bottom, revision95 shows inline clocks, one blank row between the two native tool blocks, preserved assistant paragraph spacing and the full-width input dock/footer below intact columns. No stray escape codes, overlapping panes or extension clipping were seen. Current user-selected settings are split/columns, width67, height15, sideleft, zoomnull, clocks on and native auto scrollbars; none were reset. Runtime metadata is recorded in `tmp/test-runs/merged-checkpoint-runtime.json`. No personal history benchmark or agent-controlled Herdr input was used; the screenshot itself is not stored in Git.

This verifies the merged behavioral checkpoint, not stock performance parity. LPT-718 remains open, and search acceptance remains paused while residual optimization continues.

## Cache lookup cost experiment

The current warm CPU profiles retain substantial self time in `NativeRenderCache.matches`. This experiment replaces repeated Reflect.get calls in that hot loop with ordinary property access. It keeps the same tracked keys, getter receivers, shell/tree checks and background validation; no missing-field filtering or invalidation checks are removed. All20 related cache/compact/native-work cases, typecheck and diff checks pass (`shell:8fe14bec5f62`). This is not an established speed improvement yet. Matched large native-auto profiling is next; the installed merged checkpoint remains unchanged while this candidate is measured.

## Direct lookup result: do not promote

The requested `direct-cache-lookup-large-1` matrix completed in `shell:47fcca3b9a82`, exit0, all4 modes passed (281.71s profiling). Candidate source6914847, direct clean latest IDE0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550, Pi1.1.0 and all workload settings are recorded and match the preceding3c8b03b large checkpoint. Scroll samples show native bars; no pane-preview copy regression appears. Raw output, profiles, runtime and computed comparison are tracked in `.agents/verification/rendering/direct-cache-lookup-large-1/`.

Current matched Stock/Columns/Rows typing median/p95 is60.1/81.5ms,47.7/76.9ms,40.9/59.0ms. Split typing remains below current Stock, but Columns scroll is71.9/99.9ms against67.0/82.0ms. Initial display is701/872/978ms; expanded cold is516/583/743ms; resize median is379/320/464ms. Initial/cold CPU is also higher in split. These remaining gaps fail the original parity scenario.

The previous checkpoint's Stock/Columns/Rows typing medians were59.0/41.8/31.0ms. Compact typing overhead rises from13.1 to19.5ms in Columns and13.9 to20.7ms in Rows; matches self samples rise from721 to1211ms and659 to1119ms, including a larger share of sampled time. Host variation and reverse versus forward mode order limit causal claims: unchanged Stock and Combined also move. Nevertheless, this run provides no demonstrated benefit for direct property lookup and flags possible regression. Leave the candidate unpromoted; do not install or merge it from this evidence. Installation remains0.0.0-dev.1791636688, checked after the run, with no update/reload.

Read-only replica1243db70 separately found duplicate cold structural reads between post-render graph collection and snapshot creation. Reusing that metadata is an untried follow-up candidate, not an implemented fix or parity evidence. This round makes no additional source change or benchmark. The performance branch and LPT-718 remain open; search acceptance remains paused.

## Post-render structural snapshot experiment

Direct property lookup did not demonstrate a gain, so commit `caf1176` restores the matched production validation loop from `3c8b03b`. The installed package stays unchanged. The next candidate captures children/child/component links during the existing post-render graph walk and reuses them when building the cache snapshot. The pre-render observation, wrapper ownership, graph-change guard, native input checks and subscription cleanup remain intact. Expensive snapshot inputs are still collected only when output can be cached.

A cold-width work regression failed with three reads per structural link instead of two (`shell:7305a449a9ab`). With metadata reuse, all21 cache/compact/native-work cases pass, including render-time invalidation, child creation, removed-child restoration, shared subscribers, backgrounds and images; typecheck and diff checks pass (`shell:16733e3cbd98`). This proves less duplicate structural work, not lower latency or stock parity. Two additional cases cover changed child/component links, restored old subscriptions and subsequent nested invalidation. Full non-search regression and forward/reverse large native-auto matrices are next. No installation, promotion or task closure is implied.

Read-only review `replica-7fd19fa3` found no new correctness defect in the native paths of `e89d4fc`. Traversal order, link/node alignment with shared children and cycles, changed-graph no-cache behavior, wrapper ownership, invalidation, subscription restoration, native backgrounds and image exclusion are retained. Getter/background callbacks that mutate other components during observation remain a custom-renderer risk, not a demonstrated new native defect. The candidate also allocates post-render link records for uncacheable output; fewer getter reads alone do not prove a latency win. Keep measured source unchanged while the sequential runs finish.

The sequential regression and both large matrices completed in `shell:9b6481a51aa4`, exit0 in693s: 52 non-search cases across ten files, then4 forward and4 reverse profile cases. All cases use candidate `e89d4fc` with the same clean latest IDE0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 and default-off startup profiler. Raw runtime/measurements/warm CPU and a computed comparison are saved in `.agents/verification/rendering/structural-snapshot/`.

Forward/reverse Stock typing medians are43.7/42.7ms, Columns35.6/35.5ms and Rows27.6/26.2ms. Cold frames are Stock352/347ms, Columns452/477ms and Rows474/484ms. Rows resize medians362/380ms still exceed Stock284/283ms. Initial display and some Columns scroll/output tails remain slower. Unchanged Stock also improved since the earlier control, so the full observed latency change cannot be attributed to metadata reuse. The two-read work contract is proven; isolated latency gain and original stock parity are not.

Continue with the current source in a separate initial/cold CPU diagnostic: `shell:6112ea10ad1d`, output `tmp/profiling/structural-snapshot-cold-diagnostic`, three modes Stock/Columns/Rows,600 synthetic exchanges,274x108,auto bars,4 warm samples,PROFILE_STARTUP=1. Diagnostic timings include profiler overhead and must not replace the default-off controls. Source and installed package remain unchanged during this diagnostic. It is pending, not evidence of success yet; no installation, promotion or task closure.


The initial/cold diagnostic completed all3 cases in shell:6112ea10ad1d, exit0 (159.10s). Its raw initial/cold/warm CPU, measurements and runtime are archived under the structural snapshot evidence. Cold watch maintenance is sampled at32.5/40.3ms inclusive in Columns/Rows; blank-edge detection at24.0/31.7ms. Snapshot and graph collection are smaller. Native width/background processing remains substantial, and inspector overhead prevents diagnostic latency from serving as acceptance.

The next watch candidate counts currently owned entries while observing the deduplicated graph and only builds a membership Set/sweeps old observers when entries are actually missing. The work regression failed with two removal-sweep visits on an unchanged width miss instead of zero (shell:2bb973acd18c); after the change all25 focused cache/compact/native-work cases, typecheck and diff checks pass (shell:117cb10aa21d). Another case verifies that a frozen replacement with unchanged graph cardinality still removes the old observer and never caches. Full regression, matched default-off controls and read-only lifecycle review remain required before promotion.

## Autonomous completion direction and latest experiments

The user's later direct instruction authorizes autonomous experiments through merge into develop. A justified practical limit of the current architecture may serve as completion, with remaining costs and constraints stated honestly. This supersedes strict-parity-only closure, not the requirement to measure, preserve behavior, verify live or report gaps. The Original Request, Task and Scenario have been updated and read back. Search acceptance remains paused.

Subscription-presence source d394519 completed54 non-search cases and eight large profile cases in shell:4ab22717e4ff. Raw evidence is in rendering/subscription-presence/. An unchanged subscription set now performs no removal sweep, but no latency win is established: forward Rows slows throughout the case, while reverse Rows is faster than Stock on warm actions. Both are retained. Combined has a separate resize outlier. Do not promote based only on passing correctness assertions.

Cold profiles also show repeated blank-edge ANSI classification. A bounded pure-string cache of confirmed blank rows is the next small candidate: at most32 entries, no strings over4096 characters, native parsing unchanged, paragraphs/semantic markers/images preserved. Its test first failed with40 classifications instead of one across20 cold blocks, then all28 focused cases, typecheck and diff checks passed (shell:686d7abc57ab red; shell:5c9d0c9adf84 green). Full non-search regression and repeated normal/large controls are next; installation remains unchanged.

## Final measured practical-limit checkpoint

Production source9d29c78 passes57 non-search cases and16 final profile cases across normal120x35 and large274x108, in both mode orders. All use600 synthetic exchanges/80 tool lines/16 samples/native auto bars, clean current IDE0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 and Pi1.1.0. Raw evidence and full tables are in rendering/blank-padding/. A failed chained provenance check produced no measurements; fresh authorized runs passed. Source and installed version were unchanged during those controls.

Normal typing medians Stock40.0–41.4ms, Columns28.5–29.3ms, Rows28.0–32.1ms. Large Stock44.1–47.8ms, Columns36.9–39.7ms, Rows31.1–31.7ms. The original severe repeated-render slowdown is removed. Cold/initial and large Rows resize still add work, and some large Columns scrolling/output tails exceed Stock. Original strict parity is not passed; no arbitrary tolerance makes it so. Previous slow Rows and Combined resize outliers remain archived, without a proven cause.

The bounded blank cache received read-only review9270b9e3 with no concrete defect. The previous lifecycle/structural correctness cases remain in the57-case suite. Keep exact work reductions, not an unproven isolated wall-clock claim. Direct lookup was rejected rather than promoted. Further substantial reduction of new-width/initial work would require a virtualized/replacement layout or different height/viewport APIs, affecting native selection/copy/markers/images and memory. Public Pi API/source evidence and method limits are in rendering/practical-limit.md. This is a reasonable boundary of this implementation, not a claim that further optimization is impossible.

Under the latest direct approval, proceed to final install/reload/live verification and develop merge, then record the practical-limit Result honestly. Search remains open/paused and untested.

## Final shared-child handoff guard

Read-only review96c1161a found no concrete native defect in the changed watch order. Deduplicated node counting, frozen replacements, shared subscribers and inherited invalidate ownership remain sound. It suggested a missing replacement-while-live regression. That test now replaces a child in one of two caches, verifies both old and replacement invalidations still refresh the correct cache, then checks original-method restoration after the last old subscriber leaves. All29 focused cases, typecheck and diff checks pass (shell:8728d3daeacf). This is an additional passing contract guard, not a red/green defect fix. No production code changed, so the measured and installed source remains identical. Together with the full57-case non-search run, all58 current cases are verified.

## Final live verification and accepted boundary

Published and installed0.0.0-dev.1791642798 from evidence commitb612163, production9d29c78. All five installed source comparisons pass before and after mandatory Pi reload. Latest clean direct IDE0.8.0 source1922570b9882c023f284b85ac45d3bad4be46550 was fetched/verified before the live run. User-selected split/columns67,height15,sideleft,clocksTRUE/nativeauto settings were preserved.

Two short native Bash calls emitted FINAL CACHE CHECK ONE/TWO (shell:7ed887b3a1de andde6b0a61c6e9, both exit0), alongside two assistant paragraphs. Exact human-visible inspect_tui capture w3SR:p3,274x108,live bottom,revision371 shows both current tool outputs, right-aligned inline clocks, one blank row between tool blocks, preserved paragraphs and an intact full-width input dock/footer. No new rendering error, stray escapes, overlap or extension clipping was seen. An older remote-save failure remains honestly visible; it is not a current render defect. Capture metadata/judgment are in rendering/final-live-runtime.json. No personal screenshot/history was stored in Git or benchmarked.

- [x] Matched repeated normal/large controls and raw before/after CPU/runtime evidence retained.
- [x] Initial/cold measurements separated; diagnostic sampling not used as timing acceptance.
- [x] All57 non-search behavior cases, typecheck and diff checks pass at final production source.
- [x] Final installed source and exact real viewport verified after reload.
- [x] Practical-limit decision supported by measured gaps, rejected experiment and public native API constraints.
- [x] Feature commit f447cd22c48e0c35f1ebb2b7501317d23c7c49db was fast-forwarded into develop and pushed (shell:40941f784ed2). Installed production files still match. The final Scenario Result and Workpad were saved/read back; completion comment5c0c9a21-8758-49ed-b40a-3fc87c6cf2d0 was read back, and task status Done/type completed was verified. Search remains Ideas/open/paused; no search acceptance or source change was made.

Completion is under the user's later explicit practical-limit approval, not original strict parity. Remaining initial/cold, large Rows resize and some Columns tails are documented; no claim that all future optimization is impossible.
