# Raptor OS — design system

**Owner:** `packages/ui`
**Values:** [`src/styles/tokens.css`](src/styles/tokens.css) — the single source of truth
**Verification:** [`src/tokens.test.ts`](src/tokens.test.ts) recomputes every ratio below on every run

This document is the **rationale**. `tokens.css` is the decision; this is why. A token
file without reasons is a list of magic numbers, and the next person to touch it has no
way to tell which values are load-bearing and which were accidents.

---

## 0. The rules this system is built around

Four rules, in priority order. Everything below follows from them.

1. **A colour is named for what it MEANS, never for what it looks like.** There is no
   `--blue-500` anywhere in this system, and `tokens.test.ts` fails the build if a
   primitive name appears. A primitive palette is the mechanism by which a design
   system decays into forty near-identical blues that nobody can tell apart, and the
   first person to reach for `--indigo-700` instead of `--accent-base` is the moment
   the theme stops being swappable.
2. **Every foreground/background pair the product renders is enumerated and measured.**
   `src/tokens.ts` lists all 41 of them with the reason each exists; the test computes
   each ratio from the shipped values in both themes and fails with the measured number.
   "The contrast looks fine" is not a check.
3. **Accessibility obligations live in the token layer, not in components.** The focus
   ring is applied once, in `@layer base`, to every focusable element. A component that
   could suppress it would be one careless `className` away from shipping a keyboard
   trap, so the components do not declare rings at all.
4. **One source of truth per fact.** `tokens.css` holds the values. `src/tokens.ts` is a
   machine-readable mirror that exists only so Node can compute over them, and a test
   asserts the two agree byte for byte after whitespace normalisation. The mirror cannot
   be edited on its own.

---

## 1. Colour — surfaces

| Token | Light | Dark | Why |
| --- | --- | --- | --- |
| `--surface-canvas` | `#ffffff` | `#0b0e14` | The page. |
| `--surface-raised` | `#ffffff` | `#12161f` | Cards and panels. Light *same as canvas*: a white card on white with a hairline border is the convention that survives print and low-DPI screens; inventing a second white only creates a border that reads as an artefact. |
| `--surface-sunken` | `#f5f6f8` | `#080a0f` | Wells: table stripes, inset code, secondary button fills. |
| `--surface-inverse` | `#14161c` | `#e8eaf0` | Inverted bands. The only place the ramp flips. |
| `--surface-scrim` | `rgb(10 12 18 / 62%)` | `rgb(3 5 10 / 72%)` | Modal backdrop. |

**Three steps, not thirty.** Every additional surface is a decision someone has to make
again in every component, and this is an operations product — dense tables and forms —
where extra surfaces read as noise rather than hierarchy.

**The dark canvas is `#0b0e14`, not `#000000`.** Pure black on an OLED phone produces
halation around light text — the glow that makes small type smear — and it crushes the
difference between a raised card and the page. Two and a half percent of lift keeps the
separation while staying dark.

**Every text token is verified against `--surface-sunken`, not just `--surface-canvas`.**
This is the constraint most systems skip: they check against white, then discover that
the table metadata is unreadable the moment it lands in a striped row. See
`tertiary-on-sunken` — 5.52:1 light, 6.41:1 dark — which is why the tertiary ramp can
be quiet at all.

---

## 2. Colour — text

| Token | Light | Dark | Ratio on canvas (light / dark) |
| --- | --- | --- | --- |
| `--text-primary` | `#10131a` | `#e8eaf0` | 18.58 / 16.06 — AAA |
| `--text-secondary` | `#4b5261` | `#a7aebd` | 7.84 / 8.68 — AAA |
| `--text-tertiary` | `#5c6472` | `#8b93a3` | 5.96 / 6.26 — AA |
| `--text-inverse` | `#ffffff` | `#0b0e14` | — |
| `--text-on-{accent,danger,success,warning,info}` | `#ffffff` | `#0b0e14` | 5.36–9.69 — AA/AAA |

Three levels, no more: primary (you must read this), secondary (supporting copy),
tertiary (metadata, timestamps, column heads). The `--text-on-*` family exists because a
solid status fill needs a label colour, and "white on every status" is wrong in the dark
theme — there the fills are light, so the label goes dark. One token for that would have
produced unreadable buttons in one theme or the other.

**The dark ramp starts higher and stays there.** Mid-greys that read as "quietly
secondary" on white vibrate on near-black at the same luminance. The dark tertiary
(`#8b93a3`, luminance 0.29) is far lighter than the light tertiary (`#5c6472`, luminance
0.13) for exactly this reason, and a test asserts the ordering rather than trusting it.

**Tertiary is at AA, not AAA, and that is a considered ceiling.** Pushing it to 7:1
would make column heads compete with the data they label. 5.96:1 is comfortably clear of
the 4.5:1 floor with margin for the surfaces it actually lands on.

---

## 3. Colour — borders: three tiers, three obligations

| Token | Light | Dark | Obligation |
| --- | --- | --- | --- |
| `--border-hairline` | `#e4e6eb` | `#232936` | **None.** Decorative rule; explicitly exempt from SC 1.4.11 because it carries no information. |
| `--border-control` | `#848a97` | `#5b6373` | **SC 1.4.11, ≥ 3:1.** Input, checkbox and switch outlines. |
| `--border-strong` | `#4b5261` | `#a7aebd` | **SC 1.4.11, ≥ 3:1.** Active and selected state. |

This is the most consequential decision in the file. Collapsing "control" and "hairline"
into one token is how a design system ends up shipping 1.3:1 input borders and then
telling users it passed review — the border looks fine in a design tool and is invisible
on a phone outdoors.

`--border-control` is therefore much darker than most systems' default grey
(`#848a97`, not `#d1d5db`), and it measures **3.46:1 on canvas, 3.20:1 on the sunken
well** in the light theme. The sunken figure is why the value is `#848a97` and not
`#8a8f9c`: the lighter grey was 2.99:1 on `#f5f6f8` — a fail by 0.01 — and the token test
said so.

Note also that `--border-hairline` is *used as a fill* (the secondary button's hover
state), which pulls it into the contrast matrix as a background: `--text-primary` on it
is 14.88:1 light / 12.11:1 dark. The test enumerates that pair explicitly.

---

## 4. Colour — accent and status

**Accent: `#4338ca` (light) / `#a5b4fc` (dark).** Indigo-leaning violet. Chosen over blue
because the product's core screen is a dense data table, and a neutral-cool accent
recedes into it; a violet with a red bias stays separable from the navy family used by
"information" without either reading as the other. 7.90:1 against the canvas and 7.90:1
for a white label on the button fill.

**Status is always three tokens — base / subtle / border — never one.** Status is always
rendered twice: as a solid pill and as text inside a tinted row. A single token forces
one of the two to fail. `--danger-base` on `--danger-subtle` is 6.01:1; `--text-primary`
on `--danger-base` is 6.57:1. Both are checked.

**Hover states are separate tokens, not filters.** `--accent-hover`, `--accent-active`,
`--danger-hover` exist because a `brightness()` filter changes contrast unpredictably in
the direction you cannot sign, and because "the destructive button gets darker on hover
in light mode and lighter in dark mode" is exactly the kind of thing that has to be
measured rather than assumed.

---

## 5. The focus indicator — two rings, always

This is the single most important rule in the base layer, and it is worth reading the
whole section before changing anything.

```css
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
  box-shadow: 0 0 0 var(--focus-ring-offset) var(--focus-ring-inner);
}
```

**One rule, every focusable element.** A per-component ring is a per-component
opportunity to forget it. `styles.test.ts` asserts the selector and the two declarations
are present, and asserts that `outline: none` / `outline: 0` appears nowhere in the sheet.

**Two rings, not one, because one is not enough.** A single-colour ring cannot clear
SC 1.4.11 against every surface in this system. An accent-coloured ring on the accent
coloured primary button is **1:1** — invisible — and that is precisely the moment a
keyboard user most needs to see where they are.

The fix is a two-part indicator:

* an **inner ring** (`box-shadow`, 2px, flush against the element) in the theme's
  text-on-this-surface colour — white in light mode, near-black in dark;
* an **outer ring** (`outline`, 2px, offset by 2px) in the accent colour, separated by
  exactly `--focus-ring-offset`.

At least one of the two clears 3:1 against whatever it lands on, and the ring-to-ring
pair contrasts with itself as well. `tokens.test.ts` proves this for all nine surfaces a
focusable element can have (canvas, raised, sunken, inverse, and all four status fills)
in both themes, and Playwright measures the computed `outline-width` and `box-shadow` on
a link and on a solid accent button in a real browser.

**`:focus-visible`, not `:focus`.** Mouse users do not get a ring on click; keyboard
users always do. The skip link is the documented exception — it uses `:focus` too, so
that browsers without `:focus-visible` still reveal it.

**`forced-colors` fallback.** In Windows High Contrast the author colours are discarded,
which would make both rings the same colour. The rule drops the `box-shadow` and paints
the outline in the system `Highlight` colour, which is guaranteed visible against
everything the OS paints.

**`outline: none` appears nowhere in this repository.** It is the most common way an
"accessible by default" claim is quietly withdrawn, and it is exactly the defect the
legacy project shipped.

---

## 6. Typography

### The scale — minor third, not major third

| Token | Size | Ratio | Use |
| --- | --- | --- | --- |
| `--text-2xs` | 12px | — | Legal text, uppercase metadata. Never anything a user must read to proceed. |
| `--text-xs` | 14px | 1.167 | Table cells, column heads, hints. |
| `--text-sm` | **16px** | 1.143 | **Body. The floor.** |
| `--text-md` | 18px | 1.125 | Card titles. |
| `--text-lg` | 20px | 1.111 | — |
| `--text-xl` | 24px | 1.200 | Section headings. |
| `--text-2xl` | 30px | 1.250 | Page titles. |
| `--text-3xl` | 36px | 1.200 | — |
| `--text-4xl` | 48px | 1.333 | Marketing only. |

The ratio is **minor third (1.2)**, not the major third (1.25) most systems reach for
first. At a tournament the buyer is reading a roster and a payout table on a phone in
bad light; a major third pushes the second step to 20px, the table stops fitting, and
the density that makes an operations tool usable is gone. Minor third keeps every step
legible while leaving density intact. The tail of the scale loosens back toward 1.25
because display sizes need more separation to read as display.

**16px is a floor, not a default.** Nothing renders body copy below 16px anywhere in
this system, and the base layer sets it so a component that forgets a size inherits a
legible one rather than the browser default multiplied by whatever it set. This is also
the WCAG 1.4.4 enabler: below 16px, iOS zooms the viewport out to fit, which is what
makes "resize text to 200%" fail in practice.

### The font stack

```
ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
"Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"
```

`system-ui` first, deliberately. Zero webfont bytes means zero layout shift, zero
third-party request, and text rendered by the platform's own shaper — which is the
text-rendering engine the OS was tuned for. For a product used outdoors on a phone that
is worth more than a brand typeface. The stack falls back deliberately: `Roboto` for
Android, `Segoe UI` for Windows, `Noto Sans` late for Linux coverage, then generic
`sans-serif`. Emoji faces are last so they are only reached when nothing else matches.

`--font-mono` (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
"Liberation Mono", monospace`) is used for rule versions, reference ids and anything
that must be compared character by character.

**Leading is a four-step scale, not a single value.** 1.15 for display, 1.3 for headings,
1.5 for body, 1.7 where the measure is long. Body text at 1.5 is the WCAG-friendly
default; anything tighter fails readability on a low-DPI screen.

---

## 7. Spacing

A **4px base grid**: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96.

16px is the default component padding unit because it is also the body size — a button's
internal padding matching its own line height is what makes a control look deliberate at
16px type.

**The scale stops at 96px.** This is an operations product, not a marketing site. The
deep nesting that motivates 128px and 160px steps is not a failure mode that exists here,
and an unbounded scale is an invitation to reinvent spacing locally.

Every named step is mapped through Tailwind's `--spacing-*` namespace in `globals.css`,
so `p-4` in a component and `--space-4` in this document cannot drift.

---

## 8. Radii

`xs 4px · sm 6px · md 8px · lg 12px · xl 16px · full 9999px`

`md` (8px) is the default for buttons and cards. Slightly softer than a 4px default,
because 8px is the smallest radius that still reads as *deliberately rounded* at 1×;
below that the corners alias badly on the low-DPI phone screens this product is actually
used on. `xs` (4px) exists for inputs and badges, where a tighter corner keeps the
control feeling like an input rather than a chip. `full` is for pills and avatars only.

---

## 9. Shadows

Five elevations: `xs · sm · md · lg`, plus `--shadow-color` (`12 16 27` light, `0 0 0`
dark).

**Shadows are warm-neutral and low-alpha, never pure black.** A pure-black shadow at any
useful opacity reads as a smudge on the light theme and halos on the dark one. `--sm` is
the default for cards: enough to separate a card from a same-white surface (which is the
only reason `Card` has one at all), not enough to look like a dialog.

**The dark theme drops the offset and keeps the opacity.** `--shadow-color: 0 0 0` on a
near-black surface: a shadow that lightens what is beneath it is worse than no shadow,
and elevation in a dark theme is carried by the surface ramp instead.

---

## 10. Motion

`instant 0ms · fast 120ms · normal 180ms · slow 260ms`
`standard cubic-bezier(0.2, 0, 0, 1) · entrance cubic-bezier(0, 0, 0.2, 1) · exit cubic-bezier(0.4, 0, 1, 1)`

**Short.** This UI is used between matches, often one-handed, in a room where a 500ms
cross-fade feels like the app is broken. `--fast` (120ms) covers everything a component
does in response to a click; nothing in this system transitions slower than 260ms.

**`--duration-instant: 0ms` is a real value, not a leftover.** State changes that must
be perceived as instantaneous — a focus ring appearing, a disclosure opening — use it,
so "no animation" is a decision rather than an omission.

**`prefers-reduced-motion` collapses every duration to 0.01ms, with `!important`.** The
`!important` is required and not laziness: without it a component's own `transition-*`
utility wins on order and the preference is silently ignored. 0.01ms rather than 0s so
`transitionend` and `animationend` handlers still fire — a component that depends on the
event does not deadlock. Playwright asserts both directions: durations collapse under the
preference, and are non-zero without it.

---

## 11. Dark mode

Two selectors, deliberately:

```css
@media (prefers-color-scheme: dark) { :root:not(.light) { …dark… } }
:root.dark { …dark… }
```

The block is written **twice** because CSS cannot share a block of declarations between
selectors. The duplication is the only drift risk it creates, so `tokens.test.ts` asserts
the two copies declare an identical set of custom properties with identical values — the
duplication cannot rot.

Source order matters: both selectors have equal specificity, so `:root.dark` is declared
last and wins, which is what makes the explicit class override the OS preference. There
is a test asserting that ordering too, because swapping those two blocks silently breaks
the theme toggle with no error anywhere.

**`@theme inline` is load-bearing.** Without `inline`, Tailwind emits its own `:root`
block containing the *light* value of each mapped token, which wins over `.dark`, and
the dark theme silently never applies while every dark-theme contrast measurement is of
a theme nobody sees.

**`prefers-contrast: more` is honoured**, promoting secondary and tertiary text to the
primary ramp and control borders to the strong tier. WCAG 1.4.6 is AAA, but the setting
is free and the dense table view is where it is most needed.

---

## 12. How the accessibility claims are checked

| Claim | Where it is verified | What is actually measured |
| --- | --- | --- |
| Every token pair meets WCAG 2.2 AA / 1.4.11 | `src/tokens.test.ts` | Ratios computed from the shipped values by the normative formula, in both themes, with the measured number printed on failure. |
| The token mirror has not drifted | `src/tokens.test.ts` | `tokens.css` is parsed and compared to `tokens.ts`. |
| The focus indicator survives every surface | `src/tokens.test.ts` | Both rings computed against all nine focusable surfaces, plus ring-to-ring. |
| The contrast checker is itself correct | `src/tokens.test.ts` | The published WCAG worked examples: 21:1 black-on-white, 4.54:1 for `#767676`, **4.48:1 for `#777777`** — the shade of grey that a visual review waves through every time. |
| No primitive colour names | `src/tokens.test.ts` | The sheet is scanned for `--blue-500`-style names. |
| Base-layer focus rules exist and suppress nothing | `src/styles.test.ts` | The selector and both declarations are matched; `outline: none` is forbidden. |
| Every component is keyboard-operable | `src/components/*.test.tsx` | Real `<button>`/`<input>` elements, Enter and Space, tab order, `aria-expanded`, `aria-controls`, `aria-current`, label/`aria-describedby` wiring. |
| Every component has no axe violations | `src/a11y/components-axe.test.tsx` | axe-core WCAG 2.2 AA over each primitive. |
| Every ROUTE has no axe violations, with real colour contrast | `apps/web/e2e/a11y.spec.ts` | axe-core in Chromium over `/` and `/sign-in` at 360×640, 768×1024 and 1280×800, in light **and** dark, and under `prefers-contrast: more`. |
| Focus ring is painted | `apps/web/e2e/a11y.spec.ts` | Computed `outline-width`, `outline-style` and `box-shadow` on a link and on a solid accent button. |
| Reflow, zoom, target sizes | `apps/web/e2e/a11y.spec.ts` | 320px horizontal overflow; 640px viewport (200% zoom) overflow; every visible control ≥ 44×44 at 360px. |

### The known limit, stated rather than hidden

**Under jsdom, axe-core cannot judge `color-contrast`** — there is no layout engine and no
painted background, so it returns `incomplete`, meaning "I could not determine this",
not "this passes". Pretending otherwise would be the worst kind of green.

So colour contrast is verified in the two places where it can be *measured*:

1. `packages/ui/src/tokens.test.ts` computes every pair's ratio from the shipped values.
2. `apps/web/e2e/a11y.spec.ts` runs the same engine over the rendered routes in Chromium,
   where the colours are real. It also asserts that `color-contrast` was **not** deferred
   — without that assertion, the whole contrast story could pass while measuring nothing.

**One measured blind spot, found and closed.** At 360px the data tables scroll
horizontally inside their own region (that is the WCAG 1.4.10 Reflow behaviour, and it
is why `Table` is a focusable, named region). axe-core cannot determine the painted
background of a cell that is scrolled out of that region and returns `incomplete` for
it — measured: 5 nodes at 360×640, all of them the `<caption>` and `.font-mono` cells
of the allocation table. `incomplete` means "could not measure", not "passed".

`e2e/a11y.spec.ts` closes it: it asserts the deferral happens, then unrolls the scroll
container with a stylesheet injected by the test (same tokens, same cascade, same
computed values — only the layout width changes) and re-runs axe. Every cell is then
measurable, and the assertion is that zero `color-contrast` violations **and** zero
`color-contrast` incompletes remain.

The jsdom suites additionally assert that `color-contrast` is the *only* rule they cannot
answer, so a future axe version that defers more rules fails rather than quietly widening
the gap.

---

## 13. The bug this system shipped, and the rule it produced

During this build, the primary button rendered with **near-black text on a violet fill at
2.35:1**. axe-core in a real browser caught it on its first run.

The cause was not a colour value. It was this class list:

```
bg-[var(--accent-base)] text-[var(--text-on-accent)] px-4 text-[var(--text-sm)]
```

`tailwind-merge` classifies a bare `text-[var(--x)]` as a **colour**, not a font size.
The later size class therefore "won", and the colour was silently deleted from the DOM.
Measured against the installed version:

```
twMerge(["text-on-accent", "text-[var(--text-sm)]"])         -> "text-[var(--text-sm)]"
twMerge(["text-accent",   "text-sm"])                        -> "text-accent text-sm"
twMerge(["text-accent",   "text-[length:var(--text-sm)]"])   -> both survive
```

**The rule, enforced by `src/lib/cn.test.ts`:**

* every **colour** utility is a plain name — `text-on-accent`, `bg-accent`,
  `border-control`;
* every **font-size** utility carries an explicit `[length:...]` type hint —
  `text-[length:var(--text-sm)]`.

The hint is what tells `tailwind-merge` and Tailwind which property is being set. The
regression test asserts both the passing form and the failing one, so neither can return
unnoticed.

The lesson is recorded here because it is the general one: **a component test that
asserts on a class NAME cannot catch a styling bug.** `toContain("min-h-11")` passed
happily while the button was unreadable. Only something that reads the computed style in
a real browser caught it — which is why the axe suite is a release gate and not a
formality.

---

## 14. shadcn/ui

This package is **shadcn/ui in its canonical shape**: CVA variants, `cn()` composition,
Radix primitives where interactivity warrants one, and the source copied into the
repository rather than consumed from a dependency. `apps/web/components.json` describes
that arrangement so `shadcn add <component>` writes into `packages/ui` and the result
inherits the verified palette — `globals.css` maps shadcn's own `--background`,
`--foreground`, `--primary`, `--destructive`, `--border`, `--ring` names onto this
system's tokens, so a dropped-in component does not introduce its own greys.

Two deliberate deviations, both documented because a future reader will assume a mistake:

1. **Components are authored here rather than generated by the CLI**, so that every
   token they reference is one this repository has measured. The CLI would emit the
   components; it would not extend the contrast matrix to cover them.
2. **`iconLibrary: "lucide"` is declared but `lucide-react` is not installed.** Nothing
   in the system uses an icon library — the disclosure button and the brand mark are
   hand-drawn inline `<svg>`s with `aria-hidden="true"` and `focusable="false"`, because
   an icon's accessible name has to come from the control's text, and controlling that is
   easier with two elements than with a library's defaults. The field is left set so that
   a future `shadcn add` that imports icons behaves predictably, and it will pull the
   dependency at that point rather than pretending it is already there.