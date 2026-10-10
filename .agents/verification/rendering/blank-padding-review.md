# Read-only review — bounded blank padding

Replica9270b9e3 reviewed source9d29c78 without edits, tests, benchmarks or Pi launches. No concrete correctness regression was found; no extra test/source change was requested.

Only strings classified blank by unchanged native parsing are remembered. Exact keys are independent of theme/width/invalidation. Internal paragraphs are untouched, OSC133 markers are recovered from original edge rows, and image placement bypasses trimming. FIFO retains at most32 strings of4096 UTF-16 units each (131072 units plus Set overhead); oversized strings are not retained. Real-parser tests cover repeated work, eviction, oversized rows, paragraphs and markers.

The reviewer supports a practical architecture boundary after final controls/live verification: Component.render returns full rows, native ScrollView requires full child rows/exact height, no public viewport/height-only or alternate-painter hook. Further substantial gains likely need virtualization, estimated heights, extra history caches or replacement layout/scroll ownership, affecting memory/copy/selection/markers/images. This is not proof further optimization is impossible or stock parity achieved.

Keep slow forward Rows and other outliers. Final acceptance must distinguish removal of the original severe slowdown from remaining initial/cold/resize/tail gaps. Final default-off controls later completed57 non-search and16 profile cases; raw results are in blank-padding/. The installed package was unchanged during measurement. This review is correctness evidence, not proof of isolated latency gain.
