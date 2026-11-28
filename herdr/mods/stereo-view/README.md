# Stereo View for Herdr

This experimental mod shows Pi's Conversation and Activity histories in independently scrolling native panels. Pi's terminal owns the editor and dialogs. Dialogs that replace Pi's editor also appear in this view. Use the input below the dialog to type or paste; navigation keys and supported mouse interactions go to Pi. Use Terminal for overlays and unsupported dialogs. The panels follow new output until you scroll away; scrolling back to the end resumes following. The toolbar controls layout and panel settings. Find searches the corresponding panel.

The mod renders terminal image placements as native images. It fetches their data from the originating Pi in bounded chunks, verifies it locally and keeps decoded images in `data/stereo-view/images` under the Herdr app home. Node.js must be on the app host's PATH and on the Pi terminal machine's PATH. When an image cannot be loaded, its panel shows a placeholder; the terminal remains available.

Install the `stereo-view` mod folder under the Herdr app's `mods` folder. When Pi starts in the focused Herdr terminal and can reach the local `herdr-app` command, Stereo View tries to open the installed app automatically. It does not raise a background agent's tab. Otherwise, open the Stereo View app for a running Pi terminal from Herdr, or put it beside that terminal with `app.beside`.

The mod expects `origin` (or `terminal`) to identify the Pi terminal. Its bridge label carries version 1, the Pi PID and a socket path matching `/tmp/stereo-XXXXXX/s`, where each X is an ASCII letter or digit. The PID must still be the terminal's root or foreground process. The socket protocol uses one UTF-8 JSON request and response, each terminated by a newline. The fixed Node client runs on the terminal's machine; it does not execute a label-provided command or script. Requests are limited to 4 KiB, responses to 4 MiB and connections to three seconds. The mod retains bounded row pages and fetches around each viewport. The terminal remains available if the bridge is missing or fails.

`ansi.js` is copied from pi-agent-paste; its MIT license is in `ANSI-LICENSE`.
