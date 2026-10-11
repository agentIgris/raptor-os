/**
 * WCAG 2.2 contrast arithmetic.
 *
 * This module exists because "the contrast looks fine" is not a check. Every
 * colour pair this design system ships is verified by `tokens.test.ts` using
 * these functions, and again in a real browser by axe-core over the rendered
 * routes. The numbers are computed from the shipped token values, so a token
 * edit that drops a pair below its threshold fails the build rather than
 * shipping.
 *
 * The formula is the normative one from WCAG 2.2 §  "relative luminance" and
 * "contrast ratio". It is reproduced here rather than pulled from a dependency
 * because it is fifteen lines, it is the definition of the gate, and a gate
 * whose implementation can be swapped out is not a gate.
 *
 * KNOWN LIMITATION — stated plainly: this module implements the WCAG 2.x
 * (2.4.3 / 1.4.3 / 1.4.11) contrast ratio. WCAG 3 adds APCA, which is not yet a
 * W3C Recommendation and is not what axe-core's `color-contrast` rule
 * implements, so APCA is deliberately not used. Ratios reported here and by
 * axe-core's `color-contrast` rule are therefore directly comparable.
 */

/** A colour as three 8-bit sRGB channels. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The WCAG conformance levels a ratio can satisfy. */
export type WcagLevel = "fail" | "AA-large" | "AA" | "AAA-large" | "AAA";

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Parse a `#rgb` or `#rrggbb` hex string into 8-bit channels.
 *
 * Only hex is accepted. Hex is the format the token layer is authored in, so
 * accepting anything else would mean two sources of truth; `rgb()`/`hsl()`
 * strings in a token file are a design-system bug, not something to be
 * generously interpreted.
 *
 * @throws {TypeError} when the string is not a hex colour.
 */
export function hexToRgb(hex: string): Rgb {
  const trimmed = hex.trim();

  const short = HEX_SHORT.exec(trimmed);
  if (short !== null) {
    return {
      r: Number.parseInt(short[1] as string, 16) * 17,
      g: Number.parseInt(short[2] as string, 16) * 17,
      b: Number.parseInt(short[3] as string, 16) * 17,
    };
  }

  const long = HEX_LONG.exec(trimmed);
  if (long !== null) {
    return {
      r: Number.parseInt(long[1] as string, 16),
      g: Number.parseInt(long[2] as string, 16),
      b: Number.parseInt(long[3] as string, 16),
    };
  }

  throw new TypeError(`Not a #rgb or #rrggbb colour: ${JSON.stringify(hex)}`);
}

/** Linearise one sRGB channel, per WCAG 2.2. */
function linearise(channel8Bit: number): number {
  const channel = channel8Bit / 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * The 0.04045 threshold is the WCAG 2.2 revision of the sRGB piecewise curve.
 * The 2.4 exponent is gamma-linearisation, not a styling choice: comparing
 * gamma-encoded values directly is the single most common way a "contrast
 * calculator" produces a number that is simply wrong.
 */
export function relativeLuminance(colour: Rgb): number {
  return (
    0.2126 * linearise(colour.r) +
    0.7152 * linearise(colour.g) +
    0.0722 * linearise(colour.b)
  );
}

/**
 * WCAG 2.2 contrast ratio between two colours, from 1 (identical) to 21
 * (black on white).
 */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast ratio between two hex strings. Convenience over the primitives. */
export function contrastRatioHex(foregroundHex: string, backgroundHex: string): number {
  return contrastRatio(hexToRgb(foregroundHex), hexToRgb(backgroundHex));
}

/** SC 1.4.3 thresholds. */
export const THRESHOLDS = {
  /** Normal-size body text (SC 1.4.3). */
  aaText: 4.5,
  /** AAA body text (SC 1.4.6). */
  aaaText: 7,
  /** Large text: >=24px, or >=18.66px when bold (SC 1.4.3). */
  aaLargeText: 3,
  /** Icons, focus rings, control borders and graphics (SC 1.4.11). */
  nonText: 3,
} as const;

/**
 * Is `fontSizePx` "large text" per SC 1.4.3?
 *
 * The threshold is deliberately computed rather than hard-coded so the rule
 * and the reason for it stay in one place.
 */
export function isLargeText(fontSizePx: number, bold = false): boolean {
  return bold ? fontSizePx >= 18.66 : fontSizePx >= 24;
}

/** The lowest conformance level a ratio reaches. */
export function wcagLevel(ratio: number, largeText = false): WcagLevel {
  if (largeText) {
    if (ratio >= THRESHOLDS.aaaText) return "AAA";
    if (ratio >= THRESHOLDS.aaLargeText) return "AA-large";
    return "fail";
  }
  if (ratio >= THRESHOLDS.aaaText) return "AAA";
  if (ratio >= THRESHOLDS.aaText) return "AA";
  if (ratio >= THRESHOLDS.aaLargeText) return "AA-large";
  return "fail";
}

/** Round to two decimals for stable, human-readable assertion messages. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}