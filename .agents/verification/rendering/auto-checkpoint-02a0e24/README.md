# Native auto scrollbar checkpoint, not acceptance

Raw evidence from three successful matrices: auto-normal-1, auto-normal-2 and auto-large-1. All twelve cases passed with clean IDE v0.8.0 source 1922570b9882c023f284b85ac45d3bad4be46550 verified against fetched origin/develop before and after each case. Pi version is 1.1.0. Production source is through 02a0e24; later commits named in runtime records change only documentation and profiling.

Workload: 600 synthetic exchanges, 80 lines per saved tool, 16 interaction samples, six resize samples and one expanded invalidated cold frame. Normal windows are 120x35, large 274x108. Normal 1 runs Stock, Combined, Columns, Rows; the other matrices reverse that order. No cases run concurrently. One local scripted setup turn precedes measurements. No paid model calls, saved tool execution or personal history.

Native auto scrollbars are selected identically in all modes. Every scroll sample must show a native bar; visibleScrollbars records that check. Draft, streamed assistant and latest tool update visibility are also checked. Native scrollbar painting and hit geometry are not replaced.

measurements.json retains all samples, counters, synthetic frames and definitions. runtime.json records source and workload provenance. rendering.cpuprofile covers warm interactions and resize, not initial display or cold rendering. CPU includes scheduled process work; latency measures synchronized terminal-frame emission, not compositor presentation. Six resize samples and one cold frame are not robust tail distributions.

Normal-window warm split timings improve Stock in both repeats. Initial display, expanded cold frames, large Rows resize and large Columns tool-update tails still need work. This is not stock-parity acceptance. See ../../render-performance.md for the comparison and remaining gaps. Search acceptance stays paused.
