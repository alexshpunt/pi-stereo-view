---
name: develop-stereo-view
description: Load and verify pi-stereo-view directly from its current worktree. Use when developing this extension, testing a local change, or reloading Pi for a live check. Keep normal global loading unchanged.
---

# Develop pi-stereo-view locally

This is the worktree-loading procedure from Pi Agent IDE, adapted for pi-stereo-view.

## Load exactly one local copy

1. Read Pi's package and extension docs. Inspect personal and project settings. Resolve the global pi-stereo-view package source; relative paths resolve from the settings file, not the shell directory.
2. Record the contents and Git status of files you will touch. Store backups in the repository's ignored `tmp/` directory. Preserve unrelated settings and concurrent changes.
3. In this worktree's `.pi/settings.json`, add a normal project package entry for that same global source with `extensions: []`. Preserve other resource filters. Do not use `autoload: false` or change personal settings.
4. Create one temporary `.pi/extensions/pi-stereo-view.ts` with:

   ```ts
   export { default } from "../../src/index.js";
   ```

   Check for other pi-stereo-view loaders or project package entries so the extension loads once. Dependencies must be available; publishing or installing a package is not needed.
5. Treat the package override and loader as temporary session setup. Never stage, commit or push them, even when settings are already tracked. Stage feature files by explicit path.

## Verify before reloading

6. Launch a separate Pi process from this worktree with normal configuration, project trust and an in-memory session (`pi --approve --no-session --verbose`). Send no model prompt. Do not use `--no-extensions` or an explicit extension entrypoint: those bypass the configuration being checked.
7. Inspect startup diagnostics and loaded extension paths. Require exactly one pi-stereo-view source, this worktree's loader, no load errors or duplicate registrations, and a clean shutdown. Fix setup failures before reloading the working session.
8. Follow `pi-feature-verification`: reload with `pi_extension_dev_reload_self`, accepting state loss and supplying the exact live-check steps. Exercise the changed behavior immediately. Inspect the actual human pane with `inspect_tui`; tool text and recorded test frames do not prove the live UI.
9. Run focused behavioral checks for the changed paths. Use the real-Pi test skills for loader, session, focus, streaming or terminal contracts. Use scripted synthetic history for performance comparisons. Do not benchmark personal history or invoke paid models just for a smoke check.

## Restore normal loading

10. After verification, remove your temporary loader and package override, or restore their previous contents. Restore only your changes; check for concurrent edits first.
11. Confirm no temporary setup remains in the diff or index. Repeat the normal-configuration startup smoke check, then reload to return to the global pi-stereo-view source before review and Git work.
12. Repeat setup if more changes are needed. Clean up on cancellation or pause too; report a blocker rather than leaving a broken loader behind.
