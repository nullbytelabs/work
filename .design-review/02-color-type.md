# Color & Typography — work --web console

Lens: color system + typography only. Source under review: `src/web/client.ts`
(`renderShell(token)`, `<style>` block lines 38–531; glyphs line 585; `statusVar`
line 1341). Analysis only — no source edited.

Contrast numbers below are computed WCAG 2.1 ratios (sRGB relative luminance).
`color-mix(... X% over transparent)` chip backgrounds are composited over the
relevant theme surface before measuring.

---

## Current system

### The framing problem (read this first)

The file's own header comment (lines 1–22) describes the design as:

> "the *premium product dashboard* redesign… airy card-forward **SaaS console**,
> **indigo brand gradient**, **Inter-first** type… gradient-filled DAG nodes,
> gradient primary actions and hero band."

That is a near-verbatim description of the **generic AI-startup look** PRODUCT.md
lists as anti-reference #1 (no purple/indigo gradients, no glassmorphism, no
glowing orbs) and brushes the second (Inter-first, card-forward = generic
framework default). Indigo `#646cff → #9499ff` sits at OKLCH hue ~273–280
(blue-violet) — the exact "purple gradient" hue band. It is applied as: a hero
radial wash (`--bg-grad`), gradient primary buttons with colored glow shadows
(line 283), gradient tile icons with glow (line 224), gradient DAG node fills +
`drop-shadow` glow on running nodes (line 424), gradient brand mark with
`drop-shadow` (line 160). The personality target is "precise, trustworthy,
unfussy / systems tool"; the current palette reads "AI SaaS starter."

### Color — is it OKLCH?

**No.** Every color token is hex or `rgba()` (lines 46–117). The skills require
OKLCH throughout (SKILL.md "Use OKLCH"; colorize.md). Status, brand, neutrals,
shadows — all sRGB hex. This blocks perceptually-even ramps and makes the
contrast failures below hard to tune by eye.

### Light-theme palette (`:root`, lines 45–87)

| Token | Value (hex) | ≈ OKLCH | Role |
|---|---|---|---|
| `--brand-1` | `#646cff` | L.58 C.20 H276 | gradient start (indigo) |
| `--brand-2` | `#9499ff` | L.70 C.14 H280 | gradient end (violet) |
| `--accent` | `#5b63f5` | L.55 C.20 H276 | links, focus, active, run |
| `--accent-strong` | `#4f57ee` | L.51 C.21 H276 | (declared, lightly used) |
| `--bg` | `#f6f7fb` | L.97 C.005 H280 | page bg (cool-tinted near-white) |
| `--surface` | `#ffffff` | L1.0 C0 | cards |
| `--surface-2` | `#fbfbfe` | L.99 C.004 | insets |
| `--surface-inset` | `#f2f3fa` | L.96 C.008 | field/url bg |
| `--border` | `#e7e8f2` | L.93 C.008 | hairlines |
| `--border-strong` | `#d6d8e8` | L.87 C.012 | input borders |
| `--fg` | `#1b1d27` | L.24 C.02 H280 | primary text |
| `--fg-soft` | `#43475a` | L.41 C.02 | labels/secondary |
| `--muted` | `#71748a` | L.55 C.02 | meta, placeholders, captions |
| `--code-bg` | `#1a1c28` | L.24 | log surface (dark island) |
| `--code-fg` | `#e6e8f5` | L.92 | log text |
| `--ok` | `#1f9d55` | L.60 C.16 H150 | success |
| `--fail` | `#e0414c` | L.59 C.20 H22 | failure |
| `--skip` | `#c98a16` | L.66 C.13 H75 | skipped |
| `--run` | `#5b63f5` | L.55 C.20 H276 | running (== accent) |
| `--pend` | `#9aa0b4` | L.69 C.02 | pending |

### Dark-theme palette (`@media prefers-color-scheme: dark`, lines 89–119)

| Token | Value | Role |
|---|---|---|
| `--accent` | `#7c83ff` | links/focus |
| `--bg` | `#0b0d16` | page |
| `--surface` | `#131524` | cards |
| `--surface-2` | `#161829` | insets |
| `--surface-inset` | `#0e1019` | fields |
| `--fg` | `#eef0fb` | text |
| `--fg-soft` | `#c2c6dd` | secondary |
| `--muted` | `#8c91ad` | meta |
| `--ok / --fail / --skip / --run` | `#46c97e / #ff6b73 / #e3a93a / #9499ff` | status |
| `--pend` | `#5b6075` | pending |
| `--code-bg / --code-fg` | `#0a0b13 / #e3e6f5` | logs |

### Type system (lines 81–82, plus per-element)

| Aspect | Current |
|---|---|
| Families | 2: `--font-ui` = **'Inter', system-ui…**; `--font-mono` = `ui-monospace…`. (≤3 ✓, but Inter is the named "invisible default" the skill warns against, and it is a *webfont name with no `@font-face`/load* — it silently falls back to system-ui on most machines, so the "Inter-first" intent is mostly fictional. See finding T4.) |
| Base body size | **`14.5px`** (line 129) — below the 16px floor, and in `px` not `rem` |
| Scale steps (px) | 11, 11.5, 12, 12.5, 13, 13.5, 14.5, 15, 16, 17, 22, 28 — ~12 sizes clustered in a 11–17 muddle |
| Scale ratio | h1 28 / body 14.5 ≈ 1.93 top jump, but the working band (11→17) steps by ~1.04–1.08 — **far below the ≥1.25 floor**; "muddy hierarchy" by the skill's own definition |
| Weights | 500, 550, 600, 650, 700, 750, 800 — **7 weights**, several non-standard (550/650/750) and barely distinguishable; skill caps at ~4 with clear roles |
| Line length cap | **None.** Only container `max-width: 1120px` (line 183). Log `<pre>` and prose have no `ch` cap |
| Letter-spacing | h1 −0.02em (ok); display fine. Several all-caps labels at +0.06–0.08em (ok). No floor violations |
| All-caps | Eyebrow (185), `.section-title` (206), `.brand small`-ish — short labels, acceptable per rule; BUT the eyebrow itself is a flagged AI trope (see T5) |
| Mono usage | Logs, env-pill, hook name, endpoint URL, delivery meta, step meta — appropriate ✓ |
| `tabular-nums` | **Absent** — timestamps/durations/status counts don't align |

### Status colors + glyph pairing (line 585, 484–485, 1341)

Glyphs exist and are paired everywhere status is shown: `GLYPH = {success:'✓',
failure:'✗', skipped:'⊘', running:'◌', pending:'○'}`, and the run-list/step rows
print glyph + the status **word** (lines 1332–1334). So status is **not**
color-alone in the list and log views — good, satisfies PRODUCT.md. The gap is
the **DAG nodes** (see C5): there the only status signal is stroke color (+ a
dashed stroke for skipped); no glyph/label inside or beside the node.

---

## Findings

Ordered by severity.

### C1 — Brand palette is the forbidden AI-startup indigo gradient
**Severity: High (brand-critical).** Location: `client.ts:41–52, 89–94`, applied
at `:160, 224, 283, 402–404, 424`.
Problem: `--brand-1/2` = `#646cff → #9499ff` (OKLCH hue ~273–280, blue-violet) is
the textbook "purple gradient," and it's used with glow `drop-shadow` and a hero
radial wash — purple gradient + glowing orbs, two of the three named
anti-references in one stroke. The file header even self-describes it as a
"premium SaaS console." This is the single biggest deviation from "precise,
trustworthy, unfussy systems tool."
Recommended change: drop the gradient as identity. Pick one committed, technical
hue carried by *typography and a single solid accent*, not a gradient surface.
Recommendation (terminal-native, not blue-by-reflex): a deep slate/ink brand with
a single restrained accent. Replace both brand stops + accent with one solid:
```css
--accent:        oklch(0.55 0.12 245);   /* steel azure — one solid, no gradient */
--accent-strong: oklch(0.48 0.13 245);
/* delete --grad entirely; primary button = solid --accent, no glow shadow */
--ring: oklch(0.55 0.12 245 / 0.40);
```
Remove `--bg-grad` radial wash (line 56/97), the DAG radial wash (402–404), and
every colored glow `box-shadow`/`drop-shadow` (160, 224, 283, 285, 424). Keep
elevation as a neutral hairline + at most an 8px neutral shadow.

### C2 — Body text below 16px and in `px`
**Severity: High (a11y/readability).** Location: `client.ts:129`.
Problem: `font-size: 14.5px`. Below the 16px WCAG/readability floor for body, and
`px` ignores user zoom preferences (skill: "never px for body"). A
density-tool can run a touch tight, but 14.5px hard-coded is the wrong default.
Recommended change:
```css
html { font-size: 100%; }            /* respect user setting */
body { font-size: 0.9375rem; }       /* 15px min; prefer 1rem */
```
Then express the whole scale in `rem` (see Proposed token set).

### C3 — Muted text fails AA on every non-white surface (light theme)
**Severity: High (a11y).** Location: `client.ts:64` (`--muted #71748a`), consumed
at `:163, 192, 229, 269, 323, 369–373, 382, 441` etc.
Problem (computed): `--muted` on `--surface #fff` = **4.60:1** (barely passes for
the rare case it sits on pure white), but on the surfaces it actually appears on:
- on `--surface-2 #fbfbfe` = **4.45:1** (FAIL, body)
- on `--surface-inset #f2f3fa` = **4.15:1** (FAIL)
Placeholders, helper text (`.helper` 269), delivery meta, captions all use
`--muted` and most sit on tinted surfaces → sub-AA. Placeholder text specifically
needs the full 4.5:1 (skill).
Recommended change: darken muted one step so it clears 4.5:1 on the *darkest*
surface it lands on (`surface-inset`):
```css
--muted: oklch(0.48 0.02 260);  /* ≈#5f6275 → ~5.6:1 on #f2f3fa */
```

### C4 — Status colors fail AA as text on light surfaces (success, skip, pending; chips worse)
**Severity: High (a11y + "loud only on failure").** Location: `client.ts:69–73`,
chips `:303–308`, tags `:337–342`, glyph colors `:484–485`, run-list icon `:1331`.
Problem (computed, as foreground text/glyph on `#fff`):
| Status | on `#fff` | as chip text on its 9–10% tint | Verdict |
|---|---|---|---|
| `--ok #1f9d55` | **3.49:1** | **3.16:1** | FAIL body |
| `--fail #e0414c` | 4.18:1 | **3.70:1** | FAIL (the one color that must shout) |
| `--skip #c98a16` | **2.95:1** | **2.67:1** | FAIL badly |
| `--run #5b63f5` | 4.62:1 | **4.12:1** | borderline / chip fails |
| `--pend #9aa0b4` | **2.61:1** | — | FAIL |
The colored *glyphs* (✓✗⊘◌○) are ≥16px so 3:1 large-text applies and most just
scrape it; but the **chip/tag/badge label text** is 11–12.5px → needs 4.5:1 and
all four fail. Worst: failure (the surface that must be loudest) renders below AA.
Recommended change: darken status text tokens for light theme so each clears
4.5:1 on white (use a separate lighter token for the dot/border fill if you want
the chip to stay airy — text and fill don't have to be the same value):
```css
--ok:   oklch(0.50 0.13 150);  /* ≈#1c7a45 → ~5.2:1 */
--fail: oklch(0.52 0.20 25);   /* ≈#c8303a → ~5.0:1 */
--skip: oklch(0.52 0.11 70);   /* ≈#8a6410 → ~5.0:1 (amber goes muddy; that's the cost of AA on white) */
--run:  oklch(0.50 0.16 245);  /* aligns with new accent, ~5:1 */
--pend: oklch(0.50 0.02 260);  /* ~5:1, glyph + the word "pending" still carry it */
```
Dark theme status (computed) is fine — `--ok` 8.55, `--fail` 6.55, `--skip` 8.62,
`--run` 7.12 — except `--pend #5b6075` = **2.91:1** (FAIL); bump to
`oklch(0.62 0.02 260)`.

### C5 — DAG nodes convey status by color (and one dash) alone
**Severity: Medium-High (a11y, color-blind).** Location: `client.ts:414–434`.
Problem: node status = stroke color only (running/success/failure all differ only
by hue: run-indigo / ok-green / fail-red — the red/green pair 8% of men can't
separate). Only `skipped` adds a non-color cue (`stroke-dasharray`, line 432).
PRODUCT.md: "status must never be conveyed by color alone." The list/log views
pair a glyph; the DAG does not.
Recommended change: render the same `GLYPH` inside or adjacent to each node
(`.badge` already exists at line 421 as an SVG element — put the glyph char there
per `data-status`), so node state is glyph + color, matching the rest of the app.
(Mechanism/placement is layout's call; the *requirement* — a non-color status
token on the node — is in this lens.)

### C6 — White-on-gradient primary button below AA
**Severity: Medium.** Location: `client.ts:281–285`.
Problem: `button.primary` is white text on the indigo gradient. At the lighter end
(`#9499ff`) white = **~2.4:1**; at the gradient midpoint (~`#7c84ff`) =
**3.18:1** — fails the 4.5:1 needed for the 14.5px button label (it's not large
text). The primary action is unreadable at the bright end of its own gradient.
Recommended change: solid `--accent` at `oklch(0.55 0.12 245)` gives white
~4.9:1; a slightly darker `oklch(0.50 …)` gives ~6:1. Dropping the gradient (C1)
fixes this for free.

### C7 — Log ANSI dim/black colors fail on the log surface
**Severity: Medium (legibility-under-density).** Location: `client.ts:476`
(`.fg-30 #4f5566`, `.fg-90 #6b7180`) on `--code-bg #1a1c28`.
Problem (computed on `#1a1c28`): `fg-30` (ANSI black) = **2.28:1**, `fg-90`
(bright black / the "dim" color tools use for timestamps & secondary log lines) =
**3.47:1** — both below 4.5:1. The rest of the ANSI ramp is fine (5.3–10.8:1) and
`stderr #ff8d8d` = 7.6:1 ✓. Logs are core to the product job ("read per-step
output"); the dim color is exactly what CLIs use for the least-but-still-needed
text.
Recommended change: lift the two dark ANSI slots:
```css
.fg-30 { color: #8a91a3; }  /* ~4.6:1 */
.fg-90 { color: #9aa1b3; }  /* ~5.6:1 */
```

### C8 — Pure-gray neutrals tinted toward the (wrong) brand hue
**Severity: Low.** Location: `client.ts:54–66`.
Problem: neutrals are lightly tinted toward indigo/violet (e.g. `--bg #f6f7fb`,
`--fg #1b1d27` carry hue ~280). That's the right *technique* (tinted neutrals,
skill-approved) but tied to the brand color C1 recommends removing. When the
brand hue changes, re-tint the neutrals toward the new accent hue (245) so
cohesion follows the new identity, not the old indigo.

### T1 — Working type scale is flat (ratio well below 1.25)
**Severity: High (hierarchy).** Location: throughout; sizes at `:129, 162, 163,
168, 176, 177, 186, 189, 192, 206, 228, 229, 241, 242, 257, 269, 298, 319, 331,
348, 363, 419, 420, 449, 459, 467` etc.
Problem: ~12 sizes between 11px and 17px stepping by ~1.04–1.08; e.g.
12 / 12.5 / 13 / 13.5 — the "14px, 15px, 16px = muddy hierarchy" failure named in
the skill. Heading→body jump exists (28→14.5) but the dense middle (where the
product lives) has almost no contrast.
Recommended change: collapse to a 6-step `rem` scale at ratio ~1.2 (see Proposed
token set). Map every current size to the nearest step; delete the half-px sizes.

### T2 — Seven font weights, several non-standard
**Severity: Medium.** Location: weights 500/550/600/650/700/750/800 at `:162, 163,
168, 186, 189, 206, 228, 241, 257, 275, 298, 319, 331, 449, 484` etc.
Problem: 550, 650, 750 are not real Inter static weights (and Inter isn't loaded
— see T4), so they round to the nearest available weight and add nothing but
inconsistency. Skill caps at ~4 weights with defined roles.
Recommended change: Regular 400 (body), Medium 500 (labels/UI), Semibold 600
(emphasis/buttons), Bold 700 (headings). Replace 550→500, 650/750→600, 800→700.

### T3 — No line-length cap on prose or logs
**Severity: Medium.** Location: container `:183`; logs `:464–471`.
Problem: only a 1120px container; the `.sub` description, `.empty p`, `.helper`,
and especially log `<pre>` run the full width on a wide monitor → >120ch lines,
past the 65–75ch comfort cap (skill).
Recommended change: cap prose blocks `max-width: 70ch`; for logs, a `ch` cap
isn't always desired (operators want full width for wide output) but at minimum
cap helper/sub/empty copy:
```css
.page-head .sub, .empty p, .helper { max-width: 65ch; }
```

### T4 — "Inter" named but never loaded; type is silently system-ui
**Severity: Low-Medium (intent vs reality).** Location: `client.ts:81`.
Problem: `--font-ui: 'Inter', system-ui, …` but there is no `@font-face` and no
`<link>`/preload (and the file is explicitly self-contained, no network). On any
machine without Inter installed (most), the UI renders in system-ui. So the
declared identity ("Inter-first") doesn't ship — the 550/650/750 weights and the
Inter-specific metrics assumptions are moot. Either own it (embed a subset, which
fights the no-asset constraint) or commit to a tuned system stack.
Recommended change (on-brand + zero-asset, the right call here): drop Inter,
commit to the system stack and tune it. System fonts are skill-endorsed for
perf-first app UI:
```css
--font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```
This also removes the "Inter = generic AI default" tell.

### T5 — Uppercase tracked eyebrow on the page head
**Severity: Low.** Location: `client.ts:185–188` (`.page-head .eyebrow`,
uppercase, +0.08em, accent-colored).
Problem: the tiny all-caps tracked eyebrow above the heading is a flagged AI trope
(SKILL.md absolute bans). One deliberate kicker can be voice; as a per-page scaffold
it reads as AI grammar, and it spends the accent color on decoration rather than
state ("earn every element").
Recommended change: drop the eyebrow, or replace with inline contextual metadata
that carries information (e.g. workflow path / trigger), not a category label.

### T6 — No `tabular-nums` on aligning data
**Severity: Low.** Location: timestamps `:1329`, delivery status/meta `:369–371`,
DAG meta `:420`, step meta `:459`.
Problem: durations, HTTP statuses, timestamps, counts render with proportional
figures → columns jitter, fighting "legible under density."
Recommended change: `font-variant-numeric: tabular-nums;` on `.meta`,
`.del-status`, `.del-when`, `.env-pill`, and the run-list timestamp.

---

## Proposed token set

A tightened, OKLCH, AA-clean set. Strategy: **Restrained** — neutral surfaces +
one solid technical accent (steel azure, hue 245, *not* indigo/violet, *not*
gradient), status colors that pass as text on white, glyphs always paired.
Identity carried by type + a single accent, per "precise, trustworthy, unfussy."

```css
:root {
  /* ---- Accent: one solid technical hue, no gradient, no glow ---- */
  --accent:        oklch(0.55 0.12 245);          /* links, focus, active, run */
  --accent-strong: oklch(0.48 0.13 245);          /* hover/pressed */
  --ring:          oklch(0.55 0.12 245 / 0.40);   /* focus ring (alpha ok here) */

  /* ---- Neutrals: tinted toward accent hue (245), AA-verified ---- */
  --bg:            oklch(0.98 0.004 245);
  --surface:       oklch(1.00 0     0);
  --surface-2:     oklch(0.985 0.004 245);
  --surface-inset: oklch(0.96 0.006 245);
  --border:        oklch(0.92 0.006 245);
  --border-strong: oklch(0.86 0.010 245);
  --fg:            oklch(0.25 0.015 245);          /* ~16:1 */
  --fg-soft:       oklch(0.42 0.015 245);          /* ~8:1  */
  --muted:         oklch(0.48 0.015 245);          /* ≥4.5:1 on surface-inset */

  --code-bg:       oklch(0.24 0.015 260);
  --code-fg:       oklch(0.93 0.008 245);

  /* ---- Status: text-safe on white (≥4.5:1); pair with GLYPH always ---- */
  --ok:    oklch(0.50 0.13 150);
  --fail:  oklch(0.52 0.20 25);
  --skip:  oklch(0.52 0.11 70);
  --run:   oklch(0.50 0.16 245);
  --pend:  oklch(0.50 0.015 260);

  /* ---- Elevation: neutral, no colored glow, ≤8px ---- */
  --shadow-sm: 0 1px 2px oklch(0.25 0.01 245 / 0.06);
  --shadow-md: 0 4px 12px oklch(0.25 0.01 245 / 0.08);

  /* ---- Type: 2 families, ≥1.2 ratio, rem, body ≥15px ---- */
  --font-ui:   system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --text-xs:   0.75rem;    /* 12px  caption/meta            */
  --text-sm:   0.875rem;   /* 14px  secondary UI            */
  --text-base: 0.9375rem;  /* 15px  body (min)              */
  --text-lg:   1.125rem;   /* 18px  subheading / tile title */
  --text-xl:   1.5rem;     /* 24px  section heading         */
  --text-2xl:  1.875rem;   /* 30px  page h1                 */
  /* ratio ≈ 1.2; jump xs→2xl is intentional and large */

  --weight-regular: 400;
  --weight-medium:  500;
  --weight-semi:    600;
  --weight-bold:    700;

  --leading-tight: 1.2;    /* headings */
  --leading-body:  1.55;   /* body     */
  --tracking-caps: 0.06em; /* short all-caps labels only */
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent:        oklch(0.70 0.13 245);
    --accent-strong: oklch(0.76 0.13 245);
    --ring:          oklch(0.70 0.13 245 / 0.45);

    --bg:            oklch(0.16 0.015 260);
    --surface:       oklch(0.20 0.018 260);
    --surface-2:     oklch(0.22 0.018 260);
    --surface-inset: oklch(0.15 0.015 260);
    --border:        oklch(0.30 0.02 260);
    --border-strong: oklch(0.37 0.02 260);
    --fg:            oklch(0.95 0.01 245);
    --fg-soft:       oklch(0.82 0.02 245);
    --muted:         oklch(0.66 0.02 260);   /* body weight ~350 advised on dark */

    --ok:   oklch(0.78 0.15 150);
    --fail: oklch(0.72 0.18 25);
    --skip: oklch(0.78 0.13 75);
    --run:  oklch(0.72 0.13 245);
    --pend: oklch(0.62 0.02 260);            /* lifted from failing 2.91:1 */

    --code-bg: oklch(0.13 0.012 260);
    --code-fg: oklch(0.93 0.008 245);
  }
}
```

Usage rules to enforce alongside the tokens:
- **No gradient as identity.** Primary button = solid `--accent`; remove `--grad`,
  `--bg-grad`, the DAG radial wash, and every colored `drop-shadow`/glow.
- **Status = color + glyph + word, always**, including DAG nodes (C5).
- **Accent ≤10% of surface** (Restrained): primary action, current selection,
  focus, links, running state — nothing decorative.
- Body in `rem`, ≥15px; collapse to the 6 sizes and 4 weights above; cap prose at
  ~65–70ch; `tabular-nums` on numeric/meta columns.
