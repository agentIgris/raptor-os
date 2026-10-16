import { describe, expect, it } from "vitest";

import { divisionArt, playerPortrait } from "./art";

/**
 * Art resolution against the real `public/placeholders` tree: approved files
 * resolve real, everything else (missing slugs, traversal attempts) falls
 * back to the generic placeholder.
 */
describe("public art resolution", () => {
  it("resolves approved per-slug art", () => {
    expect(divisionArt("bgmi")).toEqual({ src: "/placeholders/division-bgmi.png", real: true });
    expect(playerPortrait("RExIGRIS")).toEqual({ src: "/placeholders/player-RExIGRIS.png", real: true });
  });

  it("falls back for missing art", () => {
    expect(divisionArt("valorant")).toEqual({ src: "/placeholders/division.svg", real: false });
    expect(playerPortrait("Jelly")).toEqual({ src: "/placeholders/player-portrait.svg", real: false });
  });

  it("refuses path traversal from database values", () => {
    expect(playerPortrait("../../secret")).toEqual({ src: "/placeholders/player-portrait.svg", real: false });
    expect(divisionArt("")).toEqual({ src: "/placeholders/division.svg", real: false });
  });
});
