# The shipped defaults are compact tools, streaming and text buttons. Most checks exercise the
# original full-card, icon-button display with Pi's own windows under Activity, so they start from that baseline: a saved preference
# wins, and PI_TRANSCRIPT_TEST_DEFAULTS=1 leaves the shipped defaults untouched. Grouping is left
# out, so like a file saved before it was a separate setting, it follows the saved compactTools.
if [ -n "${PI_CODING_AGENT_DIR:-}" ] && [ -z "${PI_TRANSCRIPT_TEST_DEFAULTS:-}" ]; then
  node -e '
    const fs = require("fs"), path = require("path");
    const file = path.join(process.env.PI_CODING_AGENT_DIR, "transcript.json");
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") process.exit(0); }
    const baseline = { side: "left", chatWidth: null, layout: "columns", chatHeight: null, showTimestamps: true, showCopyButtons: true, compactTools: false, streamTools: false, streamDelay: 5, buttonStyle: "icons", turns: false, turnClock: false, turnStripe: "off", turnBackground: false, turnSeparator: false, turnClockMix: 10, turnStripeMix: 8, turnBackgroundMix: 5, turnHoverMix: 5, turnHoverColor: "turn", turnHover: false, goTo: "off", piWindows: "inline" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...baseline, ...saved }));
  '
fi
