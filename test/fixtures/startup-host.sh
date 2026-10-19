#!/bin/sh
# The harness normally disables discovery; this case verifies ordinary configured packages.
if [ "$1" = "--no-extensions" ]; then shift; fi
export PI_OFFLINE=1
if [ -n "${PI_TRANSCRIPT_TEST_SESSION:-}" ]; then
  set -- --session "$PI_TRANSCRIPT_TEST_SESSION" "$@"
fi
exec "${PI_COMMAND:-pi}" --tui-mode "${PI_TRANSCRIPT_TEST_MODE:-fullscreen}" "$@"
