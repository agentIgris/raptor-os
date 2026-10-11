/**
 * Design-token verification.
 *
 * Three claims are made about the token layer. All three are checked here:
 *
 *   1. `src/tokens.ts` has not drifted from `src/styles/tokens.css`.
 *   2. Every contrast pair this system renders meets its WCAG 2.2 threshold,
 *      in BOTH themes, with the ratio COMPUTED — not eyeballed.
 *   3. The two-part focus indicator clears SC 1.4.11 on every surface it can
 *      be drawn on.
 *
 * A failure prints the measured ratio alongside the threshold, so "it fails"
 * is always accompanied by "by how much".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  contrastRatioHex,
  hexToRgb,
  isLargeText,
  relativeLuminance,
  round2,
  THRESHOLDS,
  wcagLevel,
} from "./lib/contrast";
import {
  CONTRAST_REQUIREMENTS,
  DARK_THEME,
  FOCUSABLE_SURFACES,
  LIGHT_THEME,
  MINIMUM_BODY_FONT_SIZE_PX,
  SCALE_TOKENS,
  THEMES,
  type ThemeTokens,
} from "./tokens";

const TOKENS_CSS_PATH = fileURLToPath(new URL("./styles/tokens.css", import.meta.url));

/**
 * Parse `--name: value;` declarations out of one CSS selector block.
 *
 * Deliberately narrow: this reads custom-property declarations only, and skips
 * anything that is not one. A general CSS parser would be a dependency and
 * would also be able to agree with itself about things that are not tokens.
 */
function parseBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Selector ${selector} not found in tokens.css`);

  // Walk to the opening brace, then to its matching close, tracking nesting so
  // an inner block cannot leak into the outer one's declarations.
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Unbalanced braces after ${selector}`);

  const body = css.slice(open + 1, end);
  const out = new Map<string, string>();

  // Only the top level of this block: nested selectors are a different scope.
  const topLevel = body.replace(/\{[^{}]*\}/g, "");
  const declaration = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match = declaration.exec(topLevel);
  while (match !== null) {
    out.set(match[1] as string, (match[2] as string).trim().replace(/\s+/g, " "));
    match = declaration.exec(topLevel);
  }
  return out;
}

describe("tokens.css", () => {
  const css = readFileSync(TOKENS_CSS_PATH, "utf8");

  it("declares the light theme at :root", () => {
    const declared = parseBlock(css, ":root");
    for (const [token, value] of Object.entries(LIGHT_THEME.colors)) {
      expect(declared.get(token), `${token} missing from :root`).toBe(value);
    }
  });

  it("declares the class dark theme identically to the media-query dark theme", () => {
    // The dark block is written twice because CSS cannot share a block of
    // declarations between selectors. This is the check that stops the copy
    // from rotting into two different themes.
    const fromMedia = parseBlock(css, ":root:not(.light)");
    const fromClass = parseBlock(css, ":root.dark");

    expect([...fromClass.keys()].sort()).toEqual([...fromMedia.keys()].sort());
    for (const [token, value] of fromMedia) {
      expect(fromClass.get(token), `${token} differs between the two dark blocks`).toBe(value);
    }
  });

  it("declares the class dark theme to match tokens.ts", () => {
    const declared = parseBlock(css, ":root.dark");
    for (const [token, value] of Object.entries(DARK_THEME.colors)) {
      expect(declared.get(token), `${token} missing from :root.dark`).toBe(value);
    }
  });

  it("mirrors every non-colour scale into tokens.ts", () => {
    for (const [group, entries] of Object.entries(SCALE_TOKENS)) {
      for (const [token, value] of Object.entries(entries)) {
        expect(css, `${token} (${group}) missing from tokens.css`).toContain(`${token}: ${value};`);
      }
    }
  });

  it("never writes an opaque hex value into a token a component can reference by mistake", () => {
    // Not a colour test — a naming test. Primitive palette names in the
    // shipped sheet are what let a system decay into forty near-identical
    // blues. Comments are stripped first: the file's own header names one of
    // these patterns while explaining why it is banned.
    const declarationsOnly = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const primitives = declarationsOnly.match(
      /--(?:blue|red|green|yellow|purple|indigo|gray|grey|slate|zinc|neutral|stone|amber|emerald|cyan|sky|rose|teal|lime|fuchsia|violet)-\d+/gi,
    );
    expect(primitives ?? []).toEqual([]);
  });

  it("defers the dark-mode class rules after the prefers-color-scheme rules", () => {
    // Both selectors have identical specificity, so source order is the only
    // thing that decides whether an explicit `.dark` class beats the OS
    // preference. If these ever swap, the theme toggle silently stops working.
    const mediaIndex = css.indexOf("@media (prefers-color-scheme: dark)");
    const classIndex = css.indexOf(":root.dark {");
    expect(mediaIndex).toBeGreaterThan(-1);
    expect(classIndex).toBeGreaterThan(-1);
    expect(classIndex).toBeGreaterThan(mediaIndex);
  });
});

describe("WCAG 2.2 contrast — light theme", () => {
  for (const theme of THEMES) {
    describe(`${theme.name} theme`, () => {
      for (const requirement of CONTRAST_REQUIREMENTS) {
        it(`${requirement.id}: ${requirement.because} (${requirement.kind})`, () => {
          const foreground = theme.colors[requirement.foreground];
          const background = theme.colors[requirement.background];

          expect(foreground, `${requirement.foreground} not mirrored for ${theme.name}`).toBeTypeOf("string");
          expect(background, `${requirement.background} not mirrored for ${theme.name}`).toBeTypeOf("string");
          if (foreground === undefined || background === undefined) return;

          const minimum =
            requirement.kind === "text" ? THRESHOLDS.aaText : THRESHOLDS.nonText;
          const ratio = contrastRatioHex(foreground, background);
          const level = wcagLevel(ratio, false);

          expect(
            round2(ratio),
            `${requirement.foreground} (${foreground}) on ${requirement.background} (${background}) in the ${theme.name} theme: ${round2(ratio)}:1, needs ${minimum}:1 — ${requirement.because}`,
          ).toBeGreaterThanOrEqual(minimum);

          // For text pairs, additionally assert the pair is not merely
          // "large-text AA". A 3.2:1 body copy technically clears 1.4.3 if it
          // were large, and would then ship as unreadable 16px text — which is
          // the single most common way a contrast check is quietly weakened.
          // `wcagLevel` is text-oriented, so it is only meaningful for `text`.
          if (requirement.kind === "text") {
            expect(level, `${requirement.id} clears 4.5:1 but not as normal-size text`).not.toBe("fail");
            expect(level, `${requirement.id} should not stop at AA-large`).not.toBe("AA-large");
          }
        });
      }
    });
  }
});

describe("focus indicator — SC 1.4.11 on every surface", () => {
  for (const theme of THEMES) {
    it(`${theme.name}: at least one ring clears 3:1 on every surface it lands on`, () => {
      const inner = theme.colors["--focus-ring-inner"];
      const outer = theme.colors["--focus-ring-color"];
      if (inner === undefined || outer === undefined) throw new Error("focus ring tokens not mirrored");

      for (const surfaceToken of FOCUSABLE_SURFACES) {
        const surface = theme.colors[surfaceToken];
        if (surface === undefined) throw new Error(`${surfaceToken} not mirrored for ${theme.name}`);

        const innerRatio = contrastRatioHex(inner, surface);
        const outerRatio = contrastRatioHex(outer, surface);
        const best = Math.max(innerRatio, outerRatio);

        expect(
          round2(best),
          `${theme.name}: focus indicator on ${surfaceToken} (${surface}) is inner ${round2(innerRatio)}:1 / outer ${round2(outerRatio)}:1, best ${round2(best)}:1, needs 3:1`,
        ).toBeGreaterThanOrEqual(THRESHOLDS.nonText);
      }
    });

    it(`${theme.name}: the two rings contrast with each other, not just with the surface`, () => {
      // The outer outline sits directly against the inner ring, so that pair
      // is an adjacent-colour pair in its own right.
      const inner = theme.colors["--focus-ring-inner"];
      const outer = theme.colors["--focus-ring-color"];
      if (inner === undefined || outer === undefined) throw new Error("focus ring tokens not mirrored");
      const ratio = contrastRatioHex(inner, outer);
      expect(
        round2(ratio),
        `${theme.name}: inner ring ${inner} against outer ring ${outer} is ${round2(ratio)}:1, needs 3:1`,
      ).toBeGreaterThanOrEqual(THRESHOLDS.nonText);
    });
  }
});

describe("contrast arithmetic — the checker itself", () => {
  // If the checker is wrong, every other assertion in this file is worthless.
  // These are the published worked examples from WCAG 2.2.

  it("computes 21:1 for black on white", () => {
    expect(round2(contrastRatioHex("#000000", "#ffffff"))).toBe(21);
  });

  it("computes 1:1 for a colour against itself", () => {
    expect(round2(contrastRatioHex("#4338ca", "#4338ca"))).toBe(1);
  });

  it("computes 4.54:1 for the canonical #767676 on white example", () => {
    expect(round2(contrastRatioHex("#767676", "#ffffff"))).toBe(4.54);
  });

  it("computes 4.48:1 for #777777 on white — the famous just-under-4.5 grey", () => {
    // This is the single most useful sanity check there is: it proves the
    // checker rejects the shade of grey that a "looks fine to me" review waves
    // through every time.
    expect(round2(contrastRatioHex("#777777", "#ffffff"))).toBe(4.48);
    expect(wcagLevel(contrastRatioHex("#777777", "#ffffff"))).toBe("AA-large");
    expect(contrastRatioHex("#777777", "#ffffff")).toBeLessThan(THRESHOLDS.aaText);
  });

  it("is symmetric", () => {
    const a = contrastRatioHex("#10131a", "#f5f6f8");
    const b = contrastRatioHex("#f5f6f8", "#10131a");
    expect(a).toBe(b);
  });

  it("rejects anything that is not a hex colour rather than guessing", () => {
    expect(() => hexToRgb("rgb(1 2 3)")).toThrow(TypeError);
    expect(() => hexToRgb("#12345")).toThrow(TypeError);
    expect(() => hexToRgb("rebeccapurple")).toThrow(TypeError);
  });

  it("expands #abc shorthand", () => {
    expect(hexToRgb("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("puts white at luminance 1 and black at 0", () => {
    expect(relativeLuminance(hexToRgb("#ffffff"))).toBeCloseTo(1, 10);
    expect(relativeLuminance(hexToRgb("#000000"))).toBeCloseTo(0, 10);
  });

  it("applies the WCAG large-text threshold at 18.66px bold and 24px regular", () => {
    expect(isLargeText(18.66, true)).toBe(true);
    expect(isLargeText(18.65, true)).toBe(false);
    expect(isLargeText(24, false)).toBe(true);
    expect(isLargeText(23.99, false)).toBe(false);
  });
});

describe("token names", () => {
  it("exposes exactly the two themes the stylesheet declares", () => {
    expect(THEMES.map((theme) => theme.name)).toEqual(["light", "dark"]);
  });

  it("keeps the light theme readable in the dark theme's status palette", () => {
    // A theme that inverts surfaces but keeps a mid-grey text ramp produces
    // "muted grey on near-black", which is legible in a design tool and
    // unreadable on a phone outdoors. Guard the shape of the dark ramp.
    const dark = DARK_THEME as ThemeTokens;
    const primary = dark.colors["--text-primary"];
    const secondary = dark.colors["--text-secondary"];
    const tertiary = dark.colors["--text-tertiary"];
    if (primary === undefined || secondary === undefined || tertiary === undefined) {
      throw new Error("dark text ramp not mirrored");
    }
    const luminance = (hex: string): number => relativeLuminance(hexToRgb(hex));
    expect(luminance(primary)).toBeGreaterThan(luminance(secondary));
    expect(luminance(secondary)).toBeGreaterThan(luminance(tertiary));
    // Every step of the dark ramp stays comfortably above the light theme's
    // darkest step; if this fires, the dark ramp was not re-derived.
    const lightTertiary = LIGHT_THEME.colors["--text-tertiary"];
    if (lightTertiary === undefined) throw new Error("light text ramp not mirrored");
    expect(luminance(tertiary)).toBeGreaterThan(luminance(lightTertiary));
  });

  it("keeps the type scale body floor at 16px", () => {
    const body = SCALE_TOKENS.type["--text-sm"];
    expect(body).toBe("1rem");
    expect(MINIMUM_BODY_FONT_SIZE_PX).toBe(16);
  });
});