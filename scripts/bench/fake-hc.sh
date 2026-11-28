#!/bin/sh
# Stand-in for `hc` in the benchmark: the bridge publishes its socket as a terminal label; keep it in a file.
echo "$@" >> "${BENCH_DIR:-/tmp}/labels.log"
