/**
 * A machine-readable mirror of `src/styles/tokens.css`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CSS custom properties cannot be computed over in Node, so a contrast check
 * has nowhere to read its inputs from unless the values are also available as
 * data. This file is that data.
 *
 * It is deliberately NOT a second source of truth. `tokens.test.ts` parses
 * `tokens.css` and asserts that every value here matches the CSS byte for byte
 * (after whitespace normalisation). Edit the CSS and the test fails; edit this
 * file alone and the test fails the other way. There is no way to change a
 * colour in one place and have it stay changed.
 *
 * RATIONALE for the values is in ../DESIGN.md.
 */

/** One theme's colour tokens. */
export interface ThemeTokens {
  readonly name: "light" | "dark";
  readonly colors: Readonly<Record<string, string>>;
}

/**
 * Light theme.
 *
 * Contrast-critical pairs, measured, are in DESIGN.md. All of them are
 * re-derived by `tokens.test.ts` on every run rather than trusted to that
 * document.
 */
export const LIGHT_THEME: ThemeTokens = {
  name: "light",
  colors: {
    "--surface-canvas": "#ffffff",
    "--surface-raised": "#ffffff",
    "--surface-sunken": "#f5f6f8",
    "--surface-inverse": "#14161c",
    "--surface-scrim": "rgb(10 12 18 / 62%)",

    "--text-primary": "#10131a",
    "--text-secondary": "#4b5261",
    "--text-tertiary": "#5c6472",
    "--text-inverse": "#ffffff",
    "--text-on-accent": "#ffffff",
    "--text-on-danger": "#ffffff",
    "--text-on-success": "#ffffff",
    "--text-on-warning": "#ffffff",
    "--text-on-info": "#ffffff",

    "--border-hairline": "#e4e6eb",
    "--border-control": "#848a97",
    "--border-strong": "#4b5261",
    "--border-inverse": "#ffffff",

    "--accent-base": "#4338ca",
    "--accent-hover": "#3730a3",
    "--accent-active": "#312a8c",
    "--accent-subtle": "#eef2ff",
    "--accent-border": "#4338ca",

    "--danger-base": "#b42318",
    "--danger-hover": "#8f160c",
    "--danger-subtle": "#fef2f2",
    "--danger-border": "#b42318",

    "--success-base": "#166534",
    "--success-subtle": "#f0fdf4",
    "--success-border": "#166534",

    "--warning-base": "#854d0e",
    "--warning-subtle": "#fffbeb",
    "--warning-border": "#854d0e",

    "--info-base": "#0e7490",
    "--info-subtle": "#f0f9ff",
    "--info-border": "#0e7490",

    "--focus-ring-inner": "#ffffff",
    "--focus-ring-color": "#4338ca",
  },
};

/** Dark theme. */
export const DARK_THEME: ThemeTokens = {
  name: "dark",
  colors: {
    "--surface-canvas": "#0b0e14",
    "--surface-raised": "#12161f",
    "--surface-sunken": "#080a0f",
    "--surface-inverse": "#e8eaf0",
    "--surface-scrim": "rgb(3 5 10 / 72%)",

    "--text-primary": "#e8eaf0",
    "--text-secondary": "#a7aebd",
    "--text-tertiary": "#8b93a3",
    "--text-inverse": "#0b0e14",
    "--text-on-accent": "#0b0e14",
    "--text-on-danger": "#0b0e14",
    "--text-on-success": "#0b0e14",
    "--text-on-warning": "#0b0e14",
    "--text-on-info": "#0b0e14",

    "--border-hairline": "#232936",
    "--border-control": "#5b6373",
    "--border-strong": "#a7aebd",
    "--border-inverse": "#0b0e14",

    "--accent-base": "#a5b4fc",
    "--accent-hover": "#c3cdfd",
    "--accent-active": "#d5dcfe",
    "--accent-subtle": "#1e1b4b",
    "--accent-border": "#a5b4fc",

    "--danger-base": "#f97066",
    "--danger-hover": "#ff9d95",
    "--danger-subtle": "#450a0a",
    "--danger-border": "#f97066",

    "--success-base": "#4ade80",
    "--success-subtle": "#052e16",
    "--success-border": "#4ade80",

    "--warning-base": "#facc15",
    "--warning-subtle": "#422006",
    "--warning-border": "#facc15",

    "--info-base": "#7dd3fc",
    "--info-subtle": "#082f49",
    "--info-border": "#7dd3fc",

    "--focus-ring-inner": "#0b0e14",
    "--focus-ring-color": "#a5b4fc",
  },
};

/** Every theme, in the order the tests report them. */
export const THEMES: readonly ThemeTokens[] = [LIGHT_THEME, DARK_THEME];

/** What kind of WCAG requirement a contrast pair has to satisfy. */
export type RequirementKind =
  /** SC 1.4.3 — text. 4.5:1, or 3:1 if the text is "large". */
  | "text"
  /** SC 1.4.11 — user-interface components and graphical objects. 3:1. */
  | "non-text";

export interface ContrastRequirement {
  /** Stable identifier, used in the failure message. */
  readonly id: string;
  /** Token name of the foreground. */
  readonly foreground: string;
  /** Token name of the background. */
  readonly background: string;
  readonly kind: RequirementKind;
  /** Why this pair exists. Kept so a failure names the surface, not just a ratio. */
  readonly because: string;
}

/**
 * Every foreground/background pair this design system actually renders.
 *
 * Note what is NOT in this list: `--border-hairline` against anything. A
 * hairline is a decorative rule, carries no information, and is explicitly
 * exempt under SC 1.4.11. Listing it here would force the design system to
 * make every divider 3:1 and flatten the hierarchy the tiers exist to create.
 * It is kept strictly separate from `--border-control`, which IS a component
 * boundary and is listed below.
 */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  // --- Body and supporting copy, on every surface text is actually placed on.
  // The sunken surface is included deliberately: a colour verified only against
  // white is not a colour that is verified.
  { id: "body-on-canvas", foreground: "--text-primary", background: "--surface-canvas", kind: "text", because: "body copy on the page" },
  { id: "body-on-raised", foreground: "--text-primary", background: "--surface-raised", kind: "text", because: "body copy inside cards and panels" },
  { id: "body-on-sunken", foreground: "--text-primary", background: "--surface-sunken", kind: "text", because: "body copy inside a table stripe or inset well" },
  { id: "secondary-on-canvas", foreground: "--text-secondary", background: "--surface-canvas", kind: "text", because: "supporting copy on the page" },
  { id: "secondary-on-raised", foreground: "--text-secondary", background: "--surface-raised", kind: "text", because: "supporting copy inside cards" },
  { id: "secondary-on-sunken", foreground: "--text-secondary", background: "--surface-sunken", kind: "text", because: "supporting copy inside a table stripe" },
  { id: "tertiary-on-canvas", foreground: "--text-tertiary", background: "--surface-canvas", kind: "text", because: "metadata, timestamps, table column heads" },
  { id: "tertiary-on-raised", foreground: "--text-tertiary", background: "--surface-raised", kind: "text", because: "metadata inside a card" },
  { id: "tertiary-on-sunken", foreground: "--text-tertiary", background: "--surface-sunken", kind: "text", because: "metadata inside a table stripe" },

  // --- Tinted surfaces.
  { id: "body-on-accent-soft", foreground: "--text-primary", background: "--accent-subtle", kind: "text", because: "selected row / highlighted card" },
  { id: "secondary-on-accent-soft", foreground: "--text-secondary", background: "--accent-subtle", kind: "text", because: "supporting copy in a highlighted card" },
  { id: "body-on-danger-soft", foreground: "--text-primary", background: "--danger-subtle", kind: "text", because: "destructive alert body" },
  { id: "danger-on-danger-soft", foreground: "--danger-base", background: "--danger-subtle", kind: "text", because: "destructive alert label and tinted row" },
  { id: "success-on-success-soft", foreground: "--success-base", background: "--success-subtle", kind: "text", because: "success pill and tinted row" },
  { id: "warning-on-warning-soft", foreground: "--warning-base", background: "--warning-subtle", kind: "text", because: "warning pill and tinted row" },
  { id: "info-on-info-soft", foreground: "--info-base", background: "--info-subtle", kind: "text", because: "info pill and tinted row" },

  // --- Solid buttons: label on fill.
  { id: "accent-button-label", foreground: "--text-on-accent", background: "--accent-base", kind: "text", because: "primary button label" },
  { id: "accent-button-label-hover", foreground: "--text-on-accent", background: "--accent-hover", kind: "text", because: "primary button label on hover" },
  { id: "accent-button-label-active", foreground: "--text-on-accent", background: "--accent-active", kind: "text", because: "primary button label while pressed" },
  { id: "danger-button-label", foreground: "--text-on-danger", background: "--danger-base", kind: "text", because: "destructive button label" },
  { id: "danger-button-label-hover", foreground: "--text-on-danger", background: "--danger-hover", kind: "text", because: "destructive button label on hover" },
  { id: "success-button-label", foreground: "--text-on-success", background: "--success-base", kind: "text", because: "success button label" },
  { id: "warning-button-label", foreground: "--text-on-warning", background: "--warning-base", kind: "text", because: "warning button label" },
  { id: "info-button-label", foreground: "--text-on-info", background: "--info-base", kind: "text", because: "info button label" },
  { id: "accent-on-accent-soft", foreground: "--accent-base", background: "--accent-subtle", kind: "text", because: "the current page in the navigation" },
  { id: "body-on-hairline", foreground: "--text-primary", background: "--border-hairline", kind: "text", because: "secondary button on hover, where the hairline token is used as a fill" },
  { id: "inverse-button-label", foreground: "--text-inverse", background: "--surface-inverse", kind: "text", because: "inverted footer / marketing band" },

  // --- Coloured text on the page surface.
  { id: "link-on-canvas", foreground: "--accent-base", background: "--surface-canvas", kind: "text", because: "inline link" },
  { id: "link-on-raised", foreground: "--accent-base", background: "--surface-raised", kind: "text", because: "inline link inside a card" },
  { id: "danger-text-on-canvas", foreground: "--danger-base", background: "--surface-canvas", kind: "text", because: "inline error message" },
  { id: "success-text-on-canvas", foreground: "--success-base", background: "--surface-canvas", kind: "text", because: "inline success message" },
  { id: "warning-text-on-canvas", foreground: "--warning-base", background: "--surface-canvas", kind: "text", because: "inline warning message" },
  { id: "info-text-on-canvas", foreground: "--info-base", background: "--surface-canvas", kind: "text", because: "inline informational message" },

  // --- SC 1.4.11: control boundaries and graphical objects.
  // `--border-hairline` is deliberately absent; see the note above.
  { id: "control-border-on-canvas", foreground: "--border-control", background: "--surface-canvas", kind: "non-text", because: "input, checkbox and switch outline" },
  { id: "control-border-on-raised", foreground: "--border-control", background: "--surface-raised", kind: "non-text", because: "input outline inside a card" },
  { id: "control-border-on-sunken", foreground: "--border-control", background: "--surface-sunken", kind: "non-text", because: "input outline inside a sunken well" },
  { id: "strong-border-on-canvas", foreground: "--border-strong", background: "--surface-canvas", kind: "non-text", because: "active/selected control outline" },
  { id: "accent-indicator-on-canvas", foreground: "--accent-base", background: "--surface-canvas", kind: "non-text", because: "selected tab underline and active nav marker" },
  { id: "danger-indicator-on-canvas", foreground: "--danger-base", background: "--surface-canvas", kind: "non-text", because: "destructive chart series and error border" },
  { id: "success-indicator-on-canvas", foreground: "--success-base", background: "--surface-canvas", kind: "non-text", because: "positive chart series" },
  { id: "warning-indicator-on-canvas", foreground: "--warning-base", background: "--surface-canvas", kind: "non-text", because: "at-risk chart series" },
  { id: "info-indicator-on-canvas", foreground: "--info-base", background: "--surface-canvas", kind: "non-text", because: "informational chart series" },
];

/**
 * Backgrounds a focus indicator can land on.
 *
 * Every one of these is a real fill used by a real primitive, including the
 * four solid status fills — which is the case a single-colour ring fails.
 */
export const FOCUSABLE_SURFACES: readonly string[] = [
  "--surface-canvas",
  "--surface-raised",
  "--surface-sunken",
  "--surface-inverse",
  "--accent-base",
  "--danger-base",
  "--success-base",
  "--warning-base",
  "--info-base",
];

/** Minimum body text size, in px, enforced by `typography.test.ts`. */
export const MINIMUM_BODY_FONT_SIZE_PX = 16;

/** Minimum interactive target size, in px, at coarse pointers. */
export const MINIMUM_TARGET_SIZE_PX = 44;

/** Raw (non-colour) tokens, mirrored from `tokens.css` for the same reason. */
export const SCALE_TOKENS = {
  type: {
    "--text-2xs": "0.75rem",
    "--text-xs": "0.875rem",
    "--text-sm": "1rem",
    "--text-md": "1.125rem",
    "--text-lg": "1.25rem",
    "--text-xl": "1.5rem",
    "--text-2xl": "1.875rem",
    "--text-3xl": "2.25rem",
    "--text-4xl": "3rem",
  },
  spacing: {
    "--space-1": "0.25rem",
    "--space-2": "0.5rem",
    "--space-3": "0.75rem",
    "--space-4": "1rem",
    "--space-5": "1.25rem",
    "--space-6": "1.5rem",
    "--space-8": "2rem",
    "--space-10": "2.5rem",
    "--space-12": "3rem",
    "--space-16": "4rem",
    "--space-24": "6rem",
  },
  radii: {
    "--radius-xs": "0.25rem",
    "--radius-sm": "0.375rem",
    "--radius-md": "0.5rem",
    "--radius-lg": "0.75rem",
    "--radius-xl": "1rem",
    "--radius-full": "9999px",
  },
  motion: {
    "--duration-instant": "0ms",
    "--duration-fast": "120ms",
    "--duration-normal": "180ms",
    "--duration-slow": "260ms",
  },
} as const;