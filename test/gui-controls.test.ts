import { expect, test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TranscriptLayout } from "../src/layout.ts";
import { defaults } from "../src/preferences.ts";
import type { TranscriptTimestamps } from "../src/timestamps.ts";

test("GUI controls change the same layout and preferences used by the terminal", () => {
  let saved = 0;
  let settings = 0;
  const preferences = { ...defaults };
  const layout = new TranscriptLayout(preferences, () => ({} as Theme), () => {}, () => { saved++; },
    {} as TranscriptTimestamps, () => { settings++; });
  expect(layout.guiState()).toMatchObject({ layout: "columns", side: "left", mode: "split", zoom: null });
  layout.guiAction("swap");
  expect(layout.guiState().side).toBe("right");
  layout.guiAction("layout");
  expect(layout.guiState().layout).toBe("rows");
  layout.guiAction("zoom-activity");
  expect(layout.guiState().zoom).toBe("activity");
  layout.guiAction("zoom-activity");
  expect(layout.guiState().zoom).toBeNull();
  layout.guiAction("compact");
  expect(layout.guiState().compactTools).toBe(false);
  layout.guiAction("headers");
  expect(layout.guiState().showHeaders).toBe(false);
  layout.guiSetting({ key: "showPaneHeaders", value: "auto" });
  expect(layout.guiState().preferences.showPaneHeaders).toBe("auto");
  layout.guiSetting({ key: "turnHoverColor", value: "#abcdef" });
  expect(layout.guiState().preferences.turnHoverColor).toBe("#abcdef");
  layout.guiAction("mode");
  expect(layout.guiState().mode).toBe("combined");
  layout.guiAction("settings");
  expect(settings).toBe(1);
  expect(saved).toBeGreaterThan(0);
});
