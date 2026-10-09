#!/bin/sh
if [ -n "${PI_TRANSCRIPT_TEST_SESSION:-}" ]; then
  exec "${PI_COMMAND:-pi}" --tui-mode "${PI_TRANSCRIPT_TEST_MODE:-fullscreen}" --session "$PI_TRANSCRIPT_TEST_SESSION" "$@"
fi
exec "${PI_COMMAND:-pi}" --tui-mode "${PI_TRANSCRIPT_TEST_MODE:-fullscreen}" "$@"
