# Layout, Spacing & Responsive — work --web console

Scope: `src/web/client.ts` only. Lens = layout, spacing rhythm, density, the DAG/run-view
structure, and responsive behavior. Color/contrast values, raw keyboard a11y, and motion
are owned by other agents and are intentionally not covered here.

Headline: the spacing system is more consistent than most hand-built consoles, and the DAG
renderer is a real layered layout, not a fake. But the file's own banner calls itself "airy
card-forward SaaS console" — that register is in direct tension with PRODUCT.md's
"legible under density / earn every element / don't pad it into oversized cards." The
biggest layout problems are (1) the run view is a single non-scrolling column that does not
scale to a real run with many jobs and many open steps, (2) the DAG's fixed pixel grid
silently overflows or stalls on wide/tall graphs with no fit control, and (3) there is no
intermediate (tablet/laptop-narrow) breakpoint between the 1120px desktop and the 640px
phone, so the 280px auto-fill grid and the hard-coded DAG columns are the only things
adapting between ~641px and ~1120px.

## Findings

### 1. Spacing scale is ad hoc, not a token set
**Severity: P2 (systemic)**
**Location:** `:root` (client.ts:45–87), and every view's inline `style="margin-top:..."`.

There are radius tokens (`--radius`, `--radius-sm`, `--radius-xs`) and shadow tokens, but
**no spacing tokens at all.** Spacing is hand-typed throughout and the values do not come
from one scale. Sampling: `14px 24px`, `34px 24px 80px`, `22px 24px`, `16px 18px`, `18px`,
`14px`, `12px`, `10px`, `7px`, `6px`, `margin-top:14px`, `margin-top:16px`,
`margin-top:18px`, `margin-top:20px`, `0 0 22px`, `0 0 14px`. That is at least 7 distinct
"section gap" values (14/16/18/20/22) doing the same job. PRODUCT.md asks for rhythm earned
through hierarchy; right now the rhythm is jittery because the steps aren't quantized.

Recommended change: introduce a 4pt scale as custom properties and route every gap/padding
through it. The values barely move, but they become a system:

```css
:root {
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
}
```

Then `main { padding: var(--space-6) var(--space-5) var(--space-8); }`,
`.card.pad { padding: var(--space-5); }`, `.card + .card { margin-top: var(--space-4); }`,
and replace every inline `margin-top:14/16/18/20` with `var(--space-4)`. The inline
`style="margin-top:..."` on `#dag`, the second run-view card, and the trigger actions row
(client.ts:1064, 1066, 918) should move into classes so the values are auditable in one
place.

### 2. Run view is one tall non-scrolling column — does not scale with job/step count
**Severity: P1**
**Location:** `viewRun` markup (client.ts:1052–1069); `.logs` (client.ts:440); `details.step`
(client.ts:442–471).

The run page is the product's core surface ("watch runs execute"), and structurally it is
just two stacked full-width `.card.pad` blocks: DAG on top, an unbounded vertical list of
`details.step` below. Every step opens `det.open = true` (client.ts:1119), each `<pre>` is
capped at `max-height: 460px`, and there is no cap on the number of steps. A realistic run
(say 6 jobs × 5 steps) renders 30 expanded panels stacked vertically, each up to 460px tall
— the page becomes thousands of pixels long and the DAG scrolls out of view the instant the
first job emits output. There is no way to see the graph and a step's logs at the same time,
which is exactly the "see the shape AND the progress" job-to-be-done in PRODUCT.md.

This is the single biggest "legible under density" miss. Recommended changes, in order of
impact:

- **Don't auto-open every step.** Open only the running/failed step; collapse succeeded
  steps to their summary row. Failure is what the developer must act on (PRODUCT.md "loud
  only on failure"). Cheap win: in `ensureStep`, set `det.open = false` by default and open
  on `step-start` of the active step / on `step-end` with `status==='failure'`.
- **Give the run view a 2-pane layout on wide screens** so the DAG stays visible while logs
  scroll. The two cards are a natural `grid-template-columns: minmax(0, 360px) minmax(0,
  1fr)` (DAG left/sticky, logs right) above ~960px, collapsing to stacked below. The DAG
  card can be `position: sticky; top: <header+gap>` so it pins as logs scroll.
- **Scope scrolling to the logs region, not the whole document**, so the header + DAG stay
  put. Today the body scrolls; the logs list should own its overflow.

### 3. Nested cards in the webhook view (explicit anti-pattern)
**Severity: P2**
**Location:** `hookCard` → `.deliveries` (client.ts:355–373, 789–792).

`hookCard` is a `.card pad`. Inside it, every delivery is a `.del-row` with its own
`background: var(--surface-2); border: 1px solid var(--border)` — i.e. a bordered card,
stacked with `+ .del-row { margin-top: 6px }`, inside a card. Both SKILL.md and
layout.md call nested cards "always wrong." A list of deliveries is tabular data, not a set
of distinct actionable cards.

Recommended change: render deliveries as borderless rows separated by hairline dividers
(the `.del-list` already uses `gap: 1px`, so it was clearly heading toward a divided list).
Drop the per-row border/background and use `.del-row + .del-row { border-top: 1px solid
var(--border); }`, padding only. This also reads more like the precise systems-tool register
the brief wants and less like generic SaaS cards. The same critique applies more mildly to
`.endpoint .url` + buttons living inside the hook card, but that grouping is fine as a row.

### 4. The workflow/history "tile" grid uses cards where a list is the better affordance
**Severity: P2**
**Location:** `.grid` + `.tile` (client.ts:211–231); used by `viewWorkflows` (656) and
`viewHistory` (1316).

`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))` turns the workflow catalog
and run history into an identical-card grid with a hover-lift (`translateY(-2px)` +
`--shadow-md`). layout.md explicitly flags "identical card grids (icon + heading + text,
repeated endlessly)" as the lazy answer, and the tiles are exactly that shape (gradient
icon + title + one meta line + chevron). For run history especially, a dense single-column
list is more legible-under-density and lets you scan status glyphs down a left rail — far
better for "what ran, what broke" at a glance than a reflowing card grid where row order is
ambiguous across columns.

Recommended change: make history a single-column list (`.grid` → `display:flex;
flex-direction:column; gap: var(--space-1)`), rows with a status glyph rail, name, and a
right-aligned timestamp; reserve the multi-column auto-fill grid (if anywhere) for the
workflow catalog only. At minimum, drop the hover-lift transform on history rows — a
translate on a data row is decoration that doesn't carry information ("earn every element").

### 5. `auto-fill` (not `auto-fit`) leaves dangling empty tracks
**Severity: P3**
**Location:** `.grid` (client.ts:211).

`repeat(auto-fill, minmax(280px, 1fr))` keeps empty phantom columns when there are fewer
items than fit (e.g. two workflows on a 1120px main = two 280px tiles hugging the left with
empty space to the right, rather than stretching). layout.md's recommended pattern is
`auto-fit`, which collapses empty tracks and lets the present items grow. Swap `auto-fill`
→ `auto-fit` if this stays a grid (but see finding 4 — history wants a list).

### 6. z-index has only two values but they're arbitrary, not a scale
**Severity: P3**
**Location:** `header.app` `z-index: 20` (client.ts:149); skeleton/shimmer (no z); chips
(no z).

Only the sticky header sets a z-index (`20`). There are currently no modals, dropdowns,
toasts, or tooltips, so there is no collision today — but the value `20` is a magic number
with nothing else on the scale, and the run-view "sticky DAG" recommendation (finding 2)
plus any future copy-confirmation toast will need layering. Establish the semantic scale now
so additions slot in:

```css
:root { --z-sticky: 100; --z-dropdown: 200; --z-modal: 300; --z-toast: 400; --z-tooltip: 500; }
```

and set `header.app { z-index: var(--z-sticky); }`. Note the sticky header (z 20) and a
sticky DAG card would both need to be on this scale and ordered (header above DAG).

### 7. Flex-vs-grid choices are mostly right; one place defaults to grid unnecessarily
**Severity: P3**
**Location:** `.grid` (client.ts:211) vs the rest.

Credit where due: nav, header bar, tiles, chips, hook-head, endpoint, del-row, and step
summaries are all correctly 1D flex. The only grid is the tile list, and as noted it's a 1D
list masquerading as a 2D grid for history. No misuse of grid for component internals.
Recommendation folds into finding 4.

### 8. Trigger form has no max measure / column structure
**Severity: P3**
**Location:** `viewTrigger` form inside `.card pad` (client.ts:899); `form .field`
(client.ts:255).

The form is a single full-width stack of fields inside a card that spans the full 1120px
main. Text inputs stretch edge-to-edge to ~1070px, which is an uncomfortably long target
field and breaks the "predictable, consistent densities" product register. layout.md caps
line/measure; inputs should too.

Recommended change: constrain the form column (`form { max-width: 560px; }`) or, when a
workflow has many inputs, lay fields out in a 2-up grid above a breakpoint
(`grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))` on the field container) so a
10-input workflow isn't a 10-row skyscraper. Booleans can sit inline. The `.field`
`margin-bottom` rhythm (18px, then 4px on last) is fine once it's tokenized (finding 1).

## DAG / run view

The DAG renderer (`drawDag`, client.ts:1201–1306) is a genuine layered layout: `x = level *
COLW`, `y = row-within-level * ROWH`, cubic-bezier edges from each `need`'s right edge to
the target's left edge, SVG sized to the computed `width`/`height`. That's the right model
and it faithfully reflects the `needs` DAG (PRODUCT.md "render the DAG faithfully"). The
problems are all about how it scales and fits.

- **Fixed pixel grid, no fit-to-container.** `COLW=240, ROWH=96, BW=188, BH=62`
  (client.ts:1202) are hard constants and the SVG gets an absolute `width`/`height` plus a
  matching `viewBox`. `.dag-wrap` is `overflow-x: auto` and `svg.dag { min-width: 100% }`,
  so a wide graph (5+ levels → width > 1120px) becomes a horizontal scrollbar with **no
  zoom-to-fit and no overview.** A long pipeline is exactly a real workload; the user can't
  see the whole shape at once, which defeats "see the shape." Recommended: keep the
  computed `viewBox`, but drop the fixed `width`/`height` attributes and let the SVG scale to
  its container width (`svg.dag { width: 100%; height: auto; }`), with a `max-width` so a
  tiny 2-node graph doesn't balloon. Add an explicit "fit / 1:1" toggle if horizontal scroll
  is still needed for very wide graphs.

- **Tall levels overflow vertically with no cap.** A fan-out level (matrix expansion → many
  jobs at one level) stacks rows at `ROWH=96` each with `overflow-x: auto` only — vertical
  overflow on `.dag-wrap` is unmanaged, so 12 parallel matrix jobs produce a ~1150px-tall
  SVG that pushes all logs far below the fold. Consider a `max-height` with `overflow-y:
  auto` on `.dag-wrap`, or (better, paired with finding 2) the sticky side-pane so the DAG
  has its own bounded scroll region.

- **Node label truncation is aggressive and lossy.** `clip(id, 18)` (title) and
  `clip(runsOn, 14)` (meta) at client.ts:1289/1296 hard-truncate to character counts because
  the pill is a fixed 188px. Real job ids (`build-and-test-matrix`,
  `deploy-staging-useast1`) get cut to `build-and-test-m…`, and there is no `<title>`/tooltip
  on the node to recover the full name (the truncated text is the only source). For a tool
  whose whole pitch is precision, a node you can't fully read is a real gap. Recommended: add
  a `<title>` child to each `g.job` with the full id + runs-on + step count so hover reveals
  the exact value, and consider widening the pill or wrapping to two lines for longer ids.

- **Edge routing is naive for crossing levels.** Edges are drawn need→target as a single
  S-curve regardless of how many levels they span. A `needs` that jumps two levels (A at L0
  → C at L2) draws a long flat-ish bezier that passes straight under the L1 nodes, visually
  colliding with them. Not a blocker at small N, but at real density the edges and nodes
  overlap with no routing/offset. A minor fix: nudge control-point curvature by span, or
  route long edges with a slight vertical offset; a larger fix is a proper edge-routing pass.

- **The "lit edge" flow only lights incoming edges of running/success nodes**
  (`setJobStatus`, client.ts:1192–1194). That's a nice touch and on-brand, but on a failure
  the failed node's incoming edges may already be lit (the upstream succeeded), so a failed
  branch still shows a fully "lit" path into it. State-is-the-message would want the edge
  into a failed node to read as failed/dead, not lit. Low priority, but it's a place where
  the layout's status signal slightly lies.

- **Run header is fine; the two stacked cards are the structural problem** already covered in
  finding 2. The elapsed timer (`#run-elapsed`, 100ms tick) and status chip layout are good
  and compact.

## Responsive

There is exactly **one breakpoint, `max-width: 640px`** (client.ts:494–530). It is
thoughtfully done for phones (nav wraps to a full-width thirds tab bar, grid collapses to
one column, hook URL/actions restack, source IP drops, DAG keeps momentum scroll). But the
single breakpoint leaves real gaps:

- **No tablet / narrow-laptop range (641px–1120px).** Between the phone breakpoint and the
  1120px `max-width` everything is "desktop." On a 768px iPad portrait or a half-width
  laptop window, `main` keeps `padding: 34px 24px`, the form inputs stretch to ~720px, the
  tile grid shows 2 columns, and the **DAG immediately horizontal-scrolls** because 3 levels
  (PADX*2 + 3*240 - 52 ≈ 716px) already approaches/exceeds the content width once padding is
  counted. This is the most-used developer window size (a console docked beside an editor)
  and it gets no specific treatment. Add an intermediate breakpoint (~960px) that tightens
  `main` padding, caps the form, and ideally switches the run view to the stacked (non-2-pane)
  layout.

- **Fixed `max-width: 1120px` with no fluidity above it.** On a 27" display the console is a
  centered 1120px column in a sea of background. That's acceptable for a form-heavy tool, but
  the run view in particular wastes the width that a 2-pane DAG+logs layout (finding 2) would
  use well. Consider letting the run view go wider (`max-width: 1400px`) than the catalog
  pages.

- **DAG is the main horizontal-overflow risk at every width.** Because node geometry is in
  fixed pixels, the DAG is the one element that reliably causes horizontal scroll on narrow
  viewports. `.dag-wrap { overflow-x: auto }` contains it (no page-level overflow — good),
  but the experience on a phone is "tiny pills you must scroll a 2-finger canvas to read."
  The fit-to-width recommendation in the DAG section is also the responsive fix: a scaled
  `viewBox` lets the whole graph shrink to fit the phone, with pinch/scroll for detail.

- **Touch targets:** nav pills at `padding: 9px 10px` on phone are ~36px tall (under 44px);
  `.ghost` buttons (`padding: 8px 14px`) and the copy/test buttons are borderline; the
  `del-row` clickable rows are fine (full row). Flagged for completeness — sizing fix is a
  one-liner (`min-height: 44px` on `nav.app a` and `button.ghost` at the phone breakpoint).
  (Raw keyboard a11y is another agent's lens; this is the layout/sizing facet only.)

- **Long log lines:** `details.step pre` uses `white-space: pre-wrap; word-break:
  break-word` plus `overflow-x: auto` — good, no horizontal blowout from log content. The
  `max-height: 460px`/`360px` caps are correct in principle; the problem is the *count* of
  open panes (finding 2), not any single pane.

## Prioritized

**Quick wins (small CSS / few-line JS, high payoff)**
- Don't auto-open every step; open only running/failed (finding 2, first bullet). One line
  in `ensureStep` + one in the `step-end` handler. Biggest density payoff for least effort.
- Add `<title>` elements to DAG nodes so truncated ids are recoverable (DAG section). A few
  lines in `drawDag`.
- Make the DAG SVG scale to its container (drop fixed `width`/`height`, keep `viewBox`)
  (DAG section + Responsive). Removes horizontal-scroll pain at every width.
- De-card the deliveries list: drop per-row border/bg, use hairline dividers (finding 3).
- `auto-fill` → `auto-fit` (finding 5); drop hover-lift on history rows (finding 4).
- Add `min-height: 44px` to phone nav pills / ghost buttons (Responsive, touch targets).
- Constrain the trigger form measure (`max-width: 560px`) (finding 8).

**Larger (structural)**
- Tokenize spacing onto a 4pt scale and retire all inline `margin-top` values (finding 1).
  Touches many lines but is mechanical and makes everything else auditable.
- Re-architect the run view into a DAG + logs 2-pane layout with a sticky/bounded DAG and a
  scroll-scoped logs region (finding 2). This is the highest-value structural change for the
  product's core surface.
- Add an intermediate (~960px) breakpoint and give the run view its own wider max-width
  (Responsive). Closes the tablet/narrow-laptop gap.
- Establish a semantic z-index scale before adding sticky panes / toasts (finding 6).
- Convert run history from a card grid to a dense status-rail list (finding 4).
- DAG edge routing for multi-level spans + failed-branch edge state (DAG section). Lowest
  priority; only bites at high density.
