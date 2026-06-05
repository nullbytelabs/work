# Accessibility (WCAG 2.1 AA) — work --web console

Scope: `src/web/client.ts` — the single-file served console (`renderShell(token)`).
Lens: WCAG 2.1 AA only. Contrast is owned by another agent and is flagged here only
where egregious; motion depth is owned by another agent and noted only where it
intersects a11y. Analysis only — no source edits were made.

PRODUCT.md a11y contract being measured against: WCAG 2.1 AA, full keyboard nav,
visible focus states, `prefers-reduced-motion` alternative, and the hard rule that
**state is never conveyed by color alone (color + icon/label, color-blind safe).**

Overall: the build is better than typical AI markup — it uses real `<button>`,
`<form>`, `<label htmlFor>`, `<nav aria-label>`, `<details>/<summary>`, a roving
`role="button"` + keydown on delivery rows, and a `GLYPH` icon set paired with most
status colors. But there are several genuine AA failures: a missing top-level `<h1>`
structure interaction, no programmatic focus management across SPA route swaps, an
SSE-driven run status whose live state changes are not reliably announced, an SVG DAG
that is entirely invisible to assistive tech (state-by-color-only inside the SVG), a
required-field error model that is not associated with its input, and `:focus-visible`
that is suppressed on native form controls.

---

## Findings

### F1 — SVG DAG is invisible to assistive tech; job status is color-only inside the graph
- **WCAG**: 1.1.1 (Non-text Content), 1.4.1 (Use of Color), 4.1.2 (Name/Role/Value)
- **Severity**: P1 (this is the product's primary observability surface)
- **Location**: `client.ts:1201` (`drawDag`), nodes `1257`–`1300`; status styling `client.ts:414`–`435`; `setJobStatus` `client.ts:1187`.
- **Problem**: The DAG `<svg class="dag">` has no `role`, no `<title>`/`<desc>`, no
  `aria-label`. Job nodes are `<g class="job" data-job=… data-status=…>` whose status
  is communicated purely through stroke color (`--run`/`--ok`/`--fail`/`--skip`) plus a
  colored `circle.badge`. Inside the SVG there is **no text label of the status** — the
  badge is a colored dot only. So for a screen-reader user the entire run graph reads as
  nothing, and for a color-blind sighted user "running vs success vs failure" on a node
  is conveyed by stroke hue alone (skipped additionally uses a dashed stroke, which is
  the only non-color differentiator and only for one state). This both fails 1.1.1
  (no text alternative for the graphic) and 1.4.1 (color-only status) and 4.1.2 (the
  live status change carries no accessible name/value).
- **Fix**:
  - Give the SVG a role + accessible name: `svg.setAttribute('role','img')` and an
    `aria-label`/`<title>` summarizing the DAG (e.g. "Workflow DAG, 4 jobs").
  - Add a per-node accessible name that includes the status text, and update it in
    `setJobStatus`. Inside each `<g class="job">`:
    ```js
    g.setAttribute('role', 'img');
    g.setAttribute('aria-label', id + ' — pending');
    // in setJobStatus, after g.dataset.status = status:
    g.setAttribute('aria-label', jobId + ' — ' + status);
    ```
  - Better: render an off-SVG, visually-hidden but screen-reader-visible job/status
    list (`<ul>` of "job — status") in parallel with the graph, kept in sync from the
    same SSE events, and tie it into the run live region (see Live-region section). A
    DOM list is far more robustly announced than SVG `aria-label` mutations.
  - Add a non-color status differentiator inside the node (e.g. render the `GLYPH`
    char as `<text>` in the badge position) so the SVG itself isn't color-only.

### F2 — Live run status change is not announced; status text lives outside any live region
- **WCAG**: 4.1.3 (Status Messages), 1.4.1 (Use of Color — mostly OK here, see note)
- **Severity**: P1
- **Location**: status chip `client.ts:1060` (`#run-status` / `#run-status-text`); updated only at `run-end` `client.ts:1168`–`1172`; `<main aria-live="polite">` `client.ts:564`.
- **Problem**: `<main id="app" aria-live="polite">` is the only live region, but it wraps
  the *entire* view and is rebuilt wholesale via `app.innerHTML = …` on every route
  change (`viewRun`, `viewWorkflows`, etc.). A full subtree replacement on an `aria-live`
  container produces unreliable/over-verbose announcements (some screen readers announce
  nothing on full replace, others read the whole page). Meanwhile the meaningful state
  transitions — job-start, step-end, and the final `run-end` status flip from "running"
  to "success/failure" — mutate descendant nodes that are **not** in a scoped live
  region, so they are effectively silent. A blind user cannot tell when the run finished
  or whether it passed. This is the core 4.1.3 failure.
  - Note on 1.4.1 for the chip itself: the chip pairs color with the visible text
    ("running"/"success"/...) via `#run-status-text`, and the `.dot` is decorative — so
    the *visible chip* is NOT color-only. Good. The gap is purely that the change is not
    announced.
- **Fix**:
  - Remove `aria-live` from the big `<main>` container (it does more harm than good on
    full-subtree swaps) and instead add a small dedicated polite live region for run
    state, e.g. a visually-hidden `<div id="run-live" aria-live="polite" aria-atomic="true">`
    inside the run view. On `job-start`/`step-end`/`run-end`, write a short sentence:
    `runLive.textContent = 'Job ' + d.jobId + ' ' + d.status;` and on run-end
    `runLive.textContent = 'Run ' + d.status + (d.error ? ': ' + d.error : '');`.
  - Add `role="status"` (implicit polite) to the `#run-status` chip OR mirror its text
    into the dedicated live region; don't rely on the chip's own mutation being seen.
  - The streaming log `<pre>` should NOT be a live region (it would flood the user); keep
    log streaming silent and announce only step/job/run boundaries.

### F3 — No focus management on SPA view changes (route swaps)
- **WCAG**: 2.4.3 (Focus Order), 4.1.2; supports 2.4.1
- **Severity**: P1
- **Location**: every `app.innerHTML = …` view swap — `viewWorkflows` `client.ts:653`, `viewWebhooks` `723`, `viewTrigger` `896`, `viewRun` `1052`, `viewHistory` `1313`; nav binding `bindNav` `1370`.
- **Problem**: When a user activates a nav link, a workflow tile, a delivery row, or
  submits the trigger form, the whole `<main>` is replaced. Focus is left on a button
  that no longer exists (or resets to `<body>`), and nothing moves focus to the new
  content. Keyboard and screen-reader users get no signal that the view changed and must
  hunt from the top. There is also no programmatic `<h1>` focus target — each view does
  render exactly one `<h1>` (good for heading structure), but it is not focusable or
  focused.
- **Fix**: After each view builds its DOM, move focus to the new view's heading. Make the
  per-view `<h1>` programmatically focusable and focus it (without adding it to the tab
  sequence):
  ```js
  const h1 = app.querySelector('h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: false }); }
  ```
  Centralize this in a `mount()`/router helper so all five views get it. Optionally
  announce the route via the dedicated live region too.

### F4 — Required-field validation error is not associated with its input; relies on JS throw text in a shared box
- **WCAG**: 3.3.1 (Error Identification), 3.3.3 (Error Suggestion), 1.3.1 (Info & Relationships), 4.1.2
- **Severity**: P1
- **Location**: `buildForm` `client.ts:955`–`1022`; `collectInputs` `client.ts:1026`–`1045`; submit + `errBox` `client.ts:926`–`951`.
- **Problem**: The number-parse error (`'input "x" must be a number'`) and the server
  error are written to a single `errBox` (`<p class="err boxed">`) at the bottom of the
  form (`client.ts:936`/`939`/`947`). This box is not linked to any field via
  `aria-describedby`, is not a live region, and does not move focus to the offending
  control, so a screen-reader user submitting the form gets no feedback that an error
  occurred or which field is wrong. Required fields are marked only with a visual
  `*` span (`client.ts:1008`, `client.ts:258`) — there is no `aria-required` exposure
  beyond the native `required` attribute (native `required` is fine for the standard
  controls, but the `*` glyph itself is not announced as "required" and has no text
  equivalent). Native HTML5 `required`/`pattern` validation will fire for empty required
  text/number/select, but the custom NaN path and server-side errors bypass it entirely.
- **Fix**:
  - Make `errBox` a live region and associate it: `errBox.id = 'form-err'`,
    `errBox.setAttribute('role','alert')` (assertive) or `aria-live="assertive"`, and on
    the form `form.setAttribute('aria-describedby','form-err')`.
  - When `collectInputs` throws for a field, set focus to that control and link it:
    catch the field name, `ctrl.setAttribute('aria-invalid','true')`,
    `ctrl.setAttribute('aria-describedby','form-err')`, `ctrl.focus()`.
  - Give the required `*` a text equivalent: add `aria-hidden="true"` to the `*` span and
    set `aria-label`/visually-hidden "(required)" on the label, or rely on the native
    `required` + a `<span class="visually-hidden">required</span>` inside the label so
    the requirement is announced, not just colored red.
  - For `pattern` failures, surface a human message (3.3.3) rather than the browser's
    default, ideally per-field.

### F5 — `:focus-visible` outline is removed and replaced by box-shadow that is clipped/suppressed on native controls
- **WCAG**: 2.4.7 (Focus Visible), 1.4.11 (Non-text Contrast for the focus ring)
- **Severity**: P2 (P1 for any control where the ring is invisible)
- **Location**: global `:focus-visible` `client.ts:139`–`143`; input/select focus `client.ts:264`–`266`; checkbox `client.ts:268`; `<summary>` and `details.step summary` `client.ts:447`–`453`; nav links `client.ts:166`–`173`.
- **Problem**: The global rule sets `outline: none` and substitutes
  `box-shadow: 0 0 0 3px var(--ring)`. Two issues:
  1. `box-shadow` focus rings are clipped by any ancestor with `overflow: hidden`/`auto`.
     `details.step` has `overflow: hidden` (`client.ts:446`) and `.dag-wrap` /
     `.del-list` use `overflow-x:auto`; a focused `<summary>` or scrolled element's
     shadow ring can be cut off, leaving no visible focus. `outline` would not clip.
  2. Replacing `outline` with `box-shadow` removes the Windows High Contrast Mode /
     forced-colors focus indicator (forced-colors strips box-shadow). Under
     forced-colors there is then **no** focus indicator.
  3. The checkbox (`client.ts:268`) sets no explicit focus style and the global
     `:focus-visible` border-radius (`var(--radius-xs)`) may not visibly wrap a native
     checkbox; verify the ring shows on the box itself.
- **Fix**: Keep a real `outline` for focus and use offset instead of box-shadow, or pair
  both: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` and
  add a `@media (forced-colors: active){ :focus-visible{ outline-color: Highlight; } }`.
  Ensure `details.step` doesn't clip the indicator (outline draws outside the box and is
  not clipped by overflow, so switching to outline resolves the clip issue too).

### F6 — Delivery rows: keyboard `role="button"` is good, but the space-key path can scroll and the row has no focus style guarantee
- **WCAG**: 2.1.1 (Keyboard), 2.4.7 (Focus Visible)
- **Severity**: P2 (mostly handled — note for completeness)
- **Location**: `loadDeliveries` `client.ts:849`–`864` (role/tabIndex/keydown at `859`–`862`).
- **Problem**: Clickable delivery rows are correctly made operable: `role="button"`,
  `tabIndex=0`, and `Enter`/`Space` activate with `preventDefault()` (good — this is the
  one place div-as-button was done right). Remaining gaps: (a) the row gets the global
  `:focus-visible` box-shadow ring, which inside `.del-list { overflow-x:auto }` /
  `.deliveries` can clip (same root cause as F5); (b) non-clickable rows (no `runId`)
  correctly stay non-interactive — fine. No functional keyboard trap.
- **Fix**: Resolve via F5 (outline-based focus). Optionally add `aria-label` to the row
  summarizing result + status + time so the button's name is meaningful rather than the
  concatenated cell text.

### F7 — Icon-only / glyph-only controls lack text alternatives
- **WCAG**: 1.1.1, 4.1.2
- **Severity**: P2
- **Location**:
  - Re-run button `client.ts:1057` — label is `'↻ Re-run'`; the `↻` is decorative and
    "Re-run" text is present, so OK, but `title` is the only extra context.
  - Copy button `client.ts:783` — `ICON.copy` SVG + "Copy" text — OK (has text).
  - The DAG status `circle.badge` (`client.ts:1280`) — color-only, no text (covered F1).
  - The brand `ICON`/`ICON.chevron`/`ICON.caret` SVGs are inline `aria-hidden`-less but
    decorative; e.g. `.chev` chevrons in tiles and the caret in step summaries
    (`client.ts:643`/`644`/`673`/`1126`/`1336`) are NOT marked `aria-hidden="true"`, so
    some AT may attempt to expose them as empty graphics.
  - The header brand mark SVG is correctly `aria-hidden="true"` (`client.ts:538`) and the
    link has `aria-label="pi-workflows home"` (`client.ts:536`) — good.
  - `emptyState` decorative SVG (`client.ts:1348`) is not `aria-hidden` and has no title.
- **Problem**: Decorative inline SVGs without `aria-hidden="true"` add noise; meaningful
  glyphs (status) lack text (covered in F1).
- **Fix**: Add `aria-hidden="true"` to all purely-decorative inline SVGs in the `ICON`
  map and `emptyState`. Where a glyph carries meaning (step `GLYPH` in summaries,
  `client.ts:1122`/`1157`; history row glyph, `client.ts:1332`), ensure the adjacent text
  status is present (it is — history row prints `r.status` text at `client.ts:1334`, step
  summaries print job/step labels) so the glyph can be `aria-hidden`.

### F8 — History row and step summary status: glyph + text present (PASS, with one caveat)
- **WCAG**: 1.4.1 (Use of Color)
- **Severity**: P3 (verification / minor)
- **Location**: history tile `client.ts:1330`–`1336`; step summary glyph `client.ts:1122`, `1157`–`1158`.
- **Problem/finding**: This is largely a positive finding. History rows pair the colored
  `GLYPH` with the literal status word (`esc(r.status)` at `1334`). Step summaries pair
  the colored glyph with job/step text and an "exit N" meta. So status here is NOT
  color-only — meets 1.4.1. Caveat: the glyph color (`.glyph.skipped` = `--skip` amber,
  `client.ts:485`) and the small meta text contrast should be checked by the contrast
  agent; the `running` glyph `◌` vs `pending` `○` are visually subtle but both have text.

### F9 — Copy-button success/failure feedback is visual + textual but not announced
- **WCAG**: 4.1.3 (Status Messages)
- **Severity**: P3
- **Location**: copy handler `client.ts:800`–`806`; `copyText` `client.ts:869`.
- **Problem**: On copy, the button text swaps to "✓ Copied" / "Copy failed" for 1.4s
  then reverts. Because the change happens on the focused button itself, some screen
  readers will announce the relabeled button, but this is not guaranteed (the button is
  also `disabled` during the window, `client.ts:804`, which can suppress announcement and
  briefly removes it from the a11y tree while focused). "Copy failed" especially should
  be reliably announced.
- **Fix**: Mirror the result into a polite live region instead of (or in addition to)
  relabeling, and avoid disabling the focused button as the sole feedback — use
  `aria-disabled` or a brief non-disabling lock so focus/announcement is preserved.

### F10 — `<main>` heading per view is single `<h1>`; no skip link; landmark coverage is thin
- **WCAG**: 2.4.1 (Bypass Blocks), 1.3.1, 2.4.6 (Headings/Labels)
- **Severity**: P2
- **Location**: header/nav/main structure `client.ts:534`–`564`; per-view `<h1>` in each view.
- **Problem**:
  - There is no "skip to main content" link. With a sticky header + 3 nav links it is a
    minor bypass burden, but it's the standard 2.4.1 affordance and currently absent.
  - Landmarks: `<header>`, `<nav aria-label="Primary">`, and `<main>` exist (good). There
    is no `<footer>`/`contentinfo`, which is fine. The `<main>` is correctly a single
    landmark.
  - Heading hierarchy: each view renders exactly one `<h1>` and uses `.section-title`
    `<div>`s (not real headings) for "Inputs"/"Step logs"/"Recent deliveries"
    (`client.ts:899`, `1067`, `790`) and `.eyebrow` `<div>`s above the h1. The section
    titles are visually headings but are non-semantic `<div>`s, so screen-reader heading
    navigation skips them (1.3.1 / 2.4.6 weakness). The `.empty` state uses `<h3>`
    (`client.ts:241`/`1357`) with no intervening `<h2>` — a minor heading-order skip.
- **Fix**:
  - Add a visually-hidden skip link as the first focusable element:
    `<a class="skip" href="#app">Skip to main content</a>` and give `<main id="app">` a
    matching target (it already has `id="app"`); ensure it's focusable on activation.
  - Promote `.section-title` to `<h2>` (keep the class for styling) so log/inputs/
    deliveries sections are reachable via heading navigation.
  - Use `<h2>` for the empty-state title instead of `<h3>` to avoid the h1→h3 skip.

### F11 — `env-pill` "127.0.0.1" and run elapsed timer are unlabeled bare values
- **WCAG**: 1.3.1, 4.1.3
- **Severity**: P3
- **Location**: env pill `client.ts:561`; elapsed `client.ts:1061`, ticking `1079`.
- **Problem**: The header shows a bare `127.0.0.1` with no label of what it represents
  (host/bind address). The run-elapsed chip ticks every 100ms (`client.ts:1079`); if it
  were ever inside a live region it would flood announcements (it currently is not, which
  is correct, but it is also never announced, so the elapsed time is unavailable to AT).
- **Fix**: Give the env pill an accessible label (e.g. `title`/`aria-label="Bound host
  127.0.0.1"`). Leave the elapsed timer out of any live region (correct), but consider a
  final elapsed announcement folded into the run-end message (F2).

---

## Keyboard & focus

What already works (keep it):
- All primary actions are real `<button>`/`<a>`: nav links (`client.ts:556`–`558`),
  workflow tiles and history tiles are `<button class="tile">` (`client.ts:667`,
  `1327`), copy/send-test/re-run/run are `<button>`. These are natively focusable and
  operable with Enter/Space.
- Delivery rows use `role="button"` + `tabIndex=0` + Enter/Space keydown with
  `preventDefault` (`client.ts:859`–`862`) — the one div-as-button is done correctly.
- `<details>/<summary>` log groups are natively keyboard-operable.
- No keyboard traps; the single `EventSource` is closed on navigation (`closeActiveEs`),
  so there's no runaway focus stealing.

Gaps to fix (in priority order):
1. **Focus is dropped on every view change** (F3). After `app.innerHTML` swaps, move
   focus to the new `<h1>` (`tabindex="-1"` + `.focus()`). This is the single biggest
   keyboard/AT regression.
2. **Focus indicator can be clipped / disappears under forced-colors** (F5). Replace the
   `outline:none` + `box-shadow` ring with a real `outline` (+ offset) and a
   `forced-colors` fallback. Verify the ring is visible on `<summary>` inside
   `details.step { overflow:hidden }` and on scrolled delivery rows.
3. **Trigger-form error doesn't move focus to the bad field** (F4). On validation
   failure, focus the offending control and mark `aria-invalid`.
4. **No skip link** (F10) — add one as the first focusable element.
5. Confirm tab order is logical: header brand → nav (Workflows/Webhooks/History) →
   env pill (non-interactive, skipped) → main content. With the skip link added it
   becomes skip → brand → nav → main. This is correct as long as focus management (1)
   lands the user in main after activation.

---

## Live-region / SSE status

The run view is driven by `EventSource` frames (`client.ts:1136`–`1184`):
`run-init` → `job-start` → `step-start` → `step-output` (stream) → `step-end` →
`job-end` → `run-end`. None of these currently produce an accessible announcement, and
the only `aria-live` is the page-level `<main>` (`client.ts:564`) that gets wholesale
-replaced on navigation — the wrong granularity (F2). To make streaming run state
announce accessibly:

1. **Remove `aria-live` from `<main id="app">`.** Full `innerHTML` replacement of a live
   region produces inconsistent/over-verbose output; route-change announcement is better
   handled by focus management (F3) plus an explicit route message.

2. **Add one dedicated, visually-hidden polite live region inside the run view**, e.g.
   `<div id="run-live" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>`.
   Announce only milestones (not the streaming log):
   - `job-start` → `runLive.textContent = 'Job ' + d.jobId + ' started';`
   - `step-end` → optional, only on non-success: announce failed/skipped steps.
   - `run-end` (`client.ts:1168`) → `runLive.textContent = 'Run ' + d.status +
     (d.error ? ': ' + d.error : '');` — this is the must-have: the user learns the run
     finished and whether it passed.
   - replay/error path (`client.ts:1179`) → announce the error text too.

3. **Make the run-status chip a status region.** Add `role="status"` to `#run-status`
   (`client.ts:1060`) OR (preferred) mirror its text into `#run-live` so the
   "running → success/failure" flip at `client.ts:1170`–`1171` is spoken.

4. **Keep the streaming `<pre>` log silent** — never an `aria-live` region; it would read
   every chunk. Provide the log to AT as ordinary readable text inside the expandable
   `<details>` (already the case), and announce only step/job/run boundaries.

5. **Sync the DAG into the same announcements** (F1): since the SVG itself is a poor live
   target, the `run-live`/job-status sentences double as the DAG's accessible narration.
   Optionally maintain a visually-hidden `<ol>` job/status list updated alongside
   `setJobStatus` for on-demand review (not a live region — read by navigation).

6. **`aria-atomic="true"`** on the run-live region so partial mutations read as a whole
   sentence rather than a fragment.

---

## Prioritized

### Quick wins (small, localized, high value)
- **F3 focus management** on view swap: ~5 lines in a shared `mount()` helper, focuses
  the new `<h1>`. Biggest single AT/keyboard improvement.
- **F5 focus indicator**: switch `:focus-visible` from `box-shadow` to `outline` +
  `outline-offset` (+ `forced-colors` fallback). One CSS rule; fixes clipping and HCM.
- **F7 `aria-hidden="true"`** on decorative `ICON`/`emptyState` SVGs. Trivial.
- **F10 skip link** + promote `.section-title` `<div>`s to `<h2>` and empty-state
  `<h3>`→`<h2>`. Markup-only.
- **F11 env-pill label**. One attribute.
- **F4 (partial)**: make `errBox` `role="alert"` and focus the offending field on the
  `collectInputs` throw — a handful of lines.

### Larger (design + sync work)
- **F2 / Live-region**: introduce the dedicated `#run-live` region, remove `aria-live`
  from `<main>`, and wire announcements into the SSE handlers (`run-init`…`run-end`).
  Cross-cuts the run view's event plumbing.
- **F1 DAG accessibility**: give the SVG role/name, add per-node `aria-label` updated in
  `setJobStatus`, add a non-color in-node status differentiator (glyph `<text>`), and
  ideally a parallel visually-hidden job/status list. This is the deepest change and the
  highest functional payoff for non-sighted / color-blind users on the product's core
  surface.
- **F4 (full)**: per-field error association (`aria-describedby`, `aria-invalid`),
  human-readable `pattern` messages, and a screen-reader text equivalent for the
  required `*` marker.

### Add to the project to support the above
- A `.visually-hidden` utility class (currently absent) is needed for the skip link, the
  live region, the "(required)" text, and the parallel DAG status list.
