#!/usr/bin/env python3
"""Run a real Pi with Stereo View in a pty (no model call) so a benchmark client can talk to its bridge.

usage: run-pi.py BENCH_DIR SESSION_FILE EXTENSION_DIR [COLS ROWS]
The bridge's socket label lands in BENCH_DIR/labels.log (see fake-hc.sh). Stops on SIGTERM.
"""
import os, pty, select, signal, struct, sys, fcntl, termios, time

bench, session, extension = sys.argv[1:4]
cols, rows = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (200, 50)
os.makedirs(bench, exist_ok=True)
open(os.path.join(bench, "labels.log"), "w").close()
env = dict(os.environ, BENCH_DIR=bench, HC_BIN=os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake-hc.sh"),
           HC_TERMINAL_ID="bench/t1", STEREO_BENCH="1", PI_OFFLINE="1", TERM="xterm-256color", COLORTERM="truecolor")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("pi", ["pi", "--no-extensions", "-e", extension, "--session", session], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
stop = False
def on_term(*_):
    global stop
    stop = True
signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGINT, on_term)
started = time.time()
open(os.path.join(bench, "pi.pid"), "w").write(str(pid))
while not stop:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try:
            if not os.read(fd, 65536): break
        except OSError:
            break
os.kill(pid, signal.SIGTERM)
