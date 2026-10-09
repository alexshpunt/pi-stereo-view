#!/bin/sh
if [ -n "${PI_TRANSCRIPT_IDE_PATH:-}" ]; then
  set -- -e "$PI_TRANSCRIPT_IDE_PATH/src/pi-agent-ide.ts" "$@"
fi
if [ -n "${PI_TRANSCRIPT_TEST_SESSION:-}" ]; then
  exec "${PI_COMMAND:-pi}" --tui-mode "${PI_TRANSCRIPT_TEST_MODE:-fullscreen}" --session "$PI_TRANSCRIPT_TEST_SESSION" "$@"
fi
exec "${PI_COMMAND:-pi}" --tui-mode "${PI_TRANSCRIPT_TEST_MODE:-fullscreen}" "$@"
