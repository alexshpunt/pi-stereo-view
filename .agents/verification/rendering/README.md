# Rendering evidence

All saved histories and updates in these artifacts are synthetic. They contain no personal sessions, credentials or paid model calls. `measurements.json` holds raw action samples and terminal frames; `runtime.json` records source and workload; `rendering.cpuprofile` is the sampled V8 CPU profile.

`baseline-600` preserves the valid Stock, Combined and Columns cases from `tmp/profiling/baseline-600-complete` and the separately verified Rows case from `tmp/profiling/baseline-600-rows-verified`. The original Rows matrix case failed its post-run authentication check and is not archived as valid evidence. Baseline tool updates target an offscreen tool; use them to diagnose rendering work, not visible ongoing-tool latency.

The ongoing findings and acceptance limits are in `../render-performance.md`. These baseline files do not show that the performance task is complete.
