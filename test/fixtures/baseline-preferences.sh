# The shipped defaults are compact tools, streaming and text buttons. Most checks exercise the
# original full-card, icon-button display, so they start from that baseline: a saved preference
# wins, and PI_TRANSCRIPT_TEST_DEFAULTS=1 leaves the shipped defaults untouched.
if [ -n "${PI_CODING_AGENT_DIR:-}" ] && [ -z "${PI_TRANSCRIPT_TEST_DEFAULTS:-}" ]; then
  node -e '
    const fs = require("fs"), path = require("path");
    const file = path.join(process.env.PI_CODING_AGENT_DIR, "transcript.json");
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") process.exit(0); }
    const baseline = { side: "left", chatWidth: null, layout: "columns", chatHeight: null, showTimestamps: true, showCopyButtons: true, compactTools: false, streamTools: false, streamDelay: 5, buttonStyle: "icons" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...baseline, ...saved }));
  '
fi
