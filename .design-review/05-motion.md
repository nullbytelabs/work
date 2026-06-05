# Motion & Micro-interactions — work --web console

Scope: motion and micro-interactions only, with the live run view as the primary
subject. Static color / type / layout / keyboard-a11y depth are out of scope (other
agents own those). All references are to `src/web/client.ts`.

## Current state

There IS motion today, and most of it is on-brand and tasteful. It is not a
motion-less page. What exists:

**Transitions (state changes, all short and reasonable durations):**
- `nav.app a` — `transition: background .15s, color .15s` (`client.ts:170`).
- `.tile` — `transform .12s ease, box-shadow .15s ease, border-color .15s ease`, with
  a `-2px` translateY lift on hover and a `+2px` chevron nudge (`client.ts:218,220,230,231`).
- inputs/select focus — `border-color .12s, box-shadow .12s` (`client.ts:262`).
- `button` — `transform .1s, box-shadow .15s, background .15s, opacity .15s`; press is
  `translateY(1px)` (`client.ts:277,279`).
- `.del-row.clickable` — `border-color .12s, background .12s, transform .1s` (`client.ts:366`).
- `details.step > summary .caret` — `transform .15s`, rotates 90deg on open (`client.ts:462,463`).
- DAG edges — `transition: stroke .25s` (`client.ts:411`).
- DAG node `.node` — `stroke .25s, fill .25s, filter .25s` (`client.ts:416`).
- DAG `.node-fill` — `opacity .25s` (`client.ts:418`).
- DAG `.badge` — `fill .25s` (`client.ts:421`).

**Keyframe animations (3 total, all `infinite`):**
- `@keyframes shimmer` — skeleton sweep, `1.3s infinite` (`client.ts:244-249`).
- `@keyframes pulse` — running status-chip dot, `1.1s ease-in-out infinite`, opacity 1→.4
  + scale 1→.75 (`client.ts:304,309`).
- `@keyframes nodePulse` — running DAG node badge, `1.2s ease-in-out infinite`,
  opacity 1→.35 (`client.ts:426,435`).

**Live-run JS that drives the above (no motion of its own, just class/attr flips):**
- `setJobStatus` flips `g.dataset.status` and adds `.lit` to incoming edges
  (`client.ts:1187-1196`); the `.25s` stroke transition smooths it.
- `step-end` swaps the glyph class/text from `running ◌` to `success ✓` / `failure ✗`
  with no transition — instant text swap (`client.ts:1153-1166`).
- New `<details.step>` blocks are appended via `ensureStep` with no entrance
  (`client.ts:1107-1134`).
- `step-output` appends `<span>` log text with no arrival cue (`client.ts:1142-1152`).
- `run-end` flips the run status chip's `data-status`; the chip's color set transitions
  but the running pulse just stops (`client.ts:1168-1175`).

**The one critical gap:** there is NO `prefers-reduced-motion` block anywhere in the
file (grep-confirmed). Three infinite animations and ~10 transitions run unconditionally.

Overall the existing motion is restrained and matches "calm by default" reasonably well.
The work is (1) the missing reduced-motion contract, (2) a couple of curve/value fixes,
and (3) a small set of intentional cues for the live run, which is where comprehension
of progress is currently under-served (state changes are mostly instant snaps).

## Findings

### 1. No `prefers-reduced-motion` alternative anywhere — REQUIRED, missing
- Severity: **P0 (blocker)** — PRODUCT.md Accessibility makes a reduced-motion
  alternative mandatory for "any run/status animation"; the skill calls it non-optional.
- Location: whole `<style>` block; the two infinite *iteration* animations that matter
  most are `pulse` (`client.ts:304,309`) and `nodePulse` (`client.ts:426,435`), plus
  `shimmer` (`client.ts:247,249`).
- Problem: a motion-sensitive user watching a live run gets two perpetually-pulsing
  elements (chip dot + every running DAG badge) and a sweeping skeleton, with no way to
  reduce them. This is a hard WCAG / brand-principle violation.
- Recommended change: add one block at the end of the `<style>`. Do NOT use the global
  `* { animation-duration: .01ms !important }` sledgehammer alone — for the *running*
  state specifically you must keep a non-animated "this is live" signal so state is still
  legible (state is the message). Kill the looping motion but preserve a static
  distinguishing treatment.

```css
@media (prefers-reduced-motion: reduce) {
  /* Collapse transitions to near-instant crossfades / snaps. */
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  /* Running state must still READ as running without looping motion:
     swap the lost pulse for a steady, full-opacity emphasis. */
  .chip[data-status=running] .dot { opacity: 1; transform: none; }
  svg.dag g.job[data-status=running] .badge { opacity: 1; }
  /* Skeleton: a flat tinted block instead of a sweep. */
  .skeleton::after { display: none; }
}
```

### 2. `pulse` keyframe animates `transform: scale()` AND drives a layout-ish shrink
- Severity: P2.
- Location: `client.ts:309` (`@keyframes pulse`).
- Problem: the running chip dot scales to `.75` while fading to `.4`. Simultaneous
  shrink+fade reads as "disappearing / stalling," the opposite of "actively working."
  For a *progress* signal you want a steady heartbeat, not a vanishing dot. Scale on an
  8px dot is also imprecise visually.
- Recommended change: make it a calm opacity-only breath (keep the dot at full size so it
  never reads as receding), and slow it slightly so it feels like a steady pulse, not a
  flicker:

```css
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
.chip[data-status=running] .dot {
  background: var(--run);
  animation: pulse 1.6s ease-in-out infinite;
}
```

### 3. Step completion (`◌` → `✓`/`✗`) is an instant glyph swap — no feedback
- Severity: P1 (this is the single most important live-run moment and currently the
  flattest).
- Location: `client.ts:1157-1158` (glyph class+text swap) and the `.glyph` rules
  (`client.ts:484-485`). The running glyph `◌` is also completely static — it is NOT
  spinning despite being a spinner character.
- Problem: a step finishing is the core "what just happened" event. Right now the glyph
  character is replaced with zero transition, so a completed step lands with no
  acknowledgment; on a fast run the user can miss which step just resolved. The PRODUCT
  principle "calm by default, loud only on failure" wants success to be quiet-but-felt
  and failure to be noticed.
- Recommended change, two parts:
  - (a) Animate the running glyph so `◌` actually conveys ongoing work (it currently
    looks identical to a static ring). Spin it slowly:

    ```css
    .glyph.running { color: var(--run); display: inline-block; animation: glyphSpin 1.4s linear infinite; }
    @keyframes glyphSpin { to { transform: rotate(360deg); } }
    ```
  - (b) Give the resolved glyph a one-shot settle on swap. Add a class in JS
    (`client.ts:1157`, set `glyph.className = 'glyph ' + cls + ' just-settled'`) and:

    ```css
    .glyph.just-settled { animation: settle .22s cubic-bezier(0.16,1,0.3,1); }
    @keyframes settle { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
    /* Loud only on failure: a brief, single attention flash on the failed summary. */
    details.step > summary:has(.glyph.failure.just-settled) { animation: failFlash .5s ease-out; }
    @keyframes failFlash {
      0% { background: color-mix(in srgb, var(--fail) 16%, transparent); }
      100% { background: transparent; }
    }
    ```
    Ease-out-expo curve, no bounce. Both covered by the Finding 1 reduced-motion block
    (`animation-iteration-count:1` + near-zero duration neutralizes them).

### 4. New step blocks pop in with no entrance during a live run
- Severity: P2.
- Location: `ensureStep` appends `<details.step>` to `#logs` (`client.ts:1130`).
- Problem: as jobs start, step panels appear abruptly. During a live tail this is a
  small jolt and obscures *which* block is new. A short, downward fade-in clarifies
  arrival order and reads as "the run is progressing."
- Recommended change: one-shot entrance on the element. Use transform+opacity only
  (never animate height/margins). Apply when freshly created (it is — `ensureStep`
  builds it):

```css
details.step { animation: stepIn .26s cubic-bezier(0.16,1,0.3,1); }
@keyframes stepIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
```
  Note: this is a reveal that enhances an already-visible default (the block ships
  visible; the animation only plays on insertion), so it is safe on hidden tabs /
  headless renders. Reduced-motion neutralizes it via Finding 1.

### 5. Edge "lighting" has no directional flow — misses a cheap, high-value cue
- Severity: P2 (opportunity).
- Location: `.lit` edge rule (`client.ts:413`) + `setJobStatus` adding `.lit`
  (`client.ts:1192-1194`). Today `.lit` just swaps stroke color via the `.25s`
  transition.
- Problem: the edge color change is a static recolor; it does not convey *flow* from a
  completed job into the next running one. A subtle directional pulse on the just-lit
  edge would make the DAG visibly "advance," which is exactly the comprehension win the
  console is for ("see the shape, the progress").
- Recommended change: animate `stroke-dashoffset` once when the edge lights, so a dash
  travels along the connector in the direction of execution. This animates a
  paint property, not layout:

```css
svg.dag path.edge.lit {
  stroke: url(#dagGrad); stroke-width: 2.5;
  stroke-dasharray: 7 7;
  animation: edgeFlow .55s linear 1 forwards;
}
@keyframes edgeFlow { from { stroke-dashoffset: 14; } to { stroke-dashoffset: 0; } }
```
  Keep it a single play (`1 forwards`), not infinite, so settled edges are calm solid
  lines. Reduced-motion: the Finding 1 block forces iteration-count 1 + near-zero
  duration, leaving a solid lit edge (acceptable static end state). If you want the dash
  gone entirely under reduced motion, add `svg.dag path.edge.lit { stroke-dasharray:
  none; }` inside the reduced block.

### 6. `run-end` stops the pulse abruptly with no resolution cue
- Severity: P3.
- Location: `client.ts:1168-1175` (`run-end` flips `statusEl.dataset.status`).
- Problem: the chip recolors (transition covers it) but the perpetual pulse just halts
  mid-cycle, and there is no whole-run "done" beat. For a tool where the headline
  question is "is it done and did it pass," a single settle on the run-status chip is
  worth it.
- Recommended change: reuse the `.just-settled` settle (Finding 3) on the run-status chip
  when `run-end` fires — add the class in JS at `client.ts:1170`. No new keyframe needed.

### 7. Log output appends with no arrival cue (acceptable, noted)
- Severity: P3 / informational — likely leave as-is.
- Location: `step-output` span append (`client.ts:1150`).
- Problem/decision: streaming log lines should NOT animate per-line — that would be
  animation fatigue and would fight the autoscroll pin logic (`isPinned`,
  `client.ts:1105,1151`). The current instant append is correct. Flagging only to record
  that it was considered and intentionally left untouched. Do not add per-line motion.

## Proposed motion for live run state

The 2-4 highest-value, on-brand motions for conveying run progress (in priority order):

1. **Step-completion settle + spinning running glyph (Finding 3).** Highest value: the
   `◌` should actually spin while running, and `✓`/`✗` should land with a 220ms ease-out
   settle. This is the moment the console exists to communicate. Failure gets a single
   brief row flash (loud only on failure); success stays quiet. ~12 lines of CSS + 1 JS
   class toggle.

2. **Directional edge flow on `.lit` (Finding 5).** A one-shot dash travelling along the
   connector when a job completes/starts makes the DAG visibly advance left-to-right.
   Pure paint animation, single play, settles to a solid gradient line. This is the
   "watch the run move through the graph" payoff, and it is nearly free.

3. **Step-block entrance (Finding 4).** A 6px rise + fade as each step panel is appended
   clarifies arrival order during a live tail without being noisy. Transform/opacity only.

4. **Calmer running pulse on chip + DAG badge (Finding 2).** Convert the shrink+fade
   "pulse" to a steady opacity breath so running reads as a heartbeat, not a vanishing
   element. The DAG `nodePulse` is already opacity-only and fine; just align timings
   (~1.6s) so the chip dot and node badge breathe in sync.

All four are transform/opacity/paint only, ease-out (no bounce/elastic), one-shot where
they should settle and slow-breath where they should persist. None tips into the
AI-startup aesthetic: no glow bloom, no spring, no gratuitous entrance choreography on
static content. The existing indigo gradient and drop-shadow on running nodes
(`client.ts:424`) is already at the edge of "calm"; do not add more glow.

## Prioritized

**Quick wins (small, high-confidence, ship first):**
- Add the `@media (prefers-reduced-motion: reduce)` block (Finding 1). REQUIRED; ~12
  lines; unblocks every other motion below.
- Spin the running glyph + settle on resolve (Finding 3a/3b). ~12 CSS lines + 1 JS line.
- Calm the running pulse curve/values (Finding 2). 2-line edit.
- Step-block entrance (Finding 4). 2-line CSS.
- Run-end chip settle (Finding 6). Reuses Finding 3's keyframe; 1 JS line.

**Larger (still modest, but more design judgment / in-browser verification):**
- Directional edge-flow animation (Finding 5). Needs a quick visual check that the dash
  direction reads correctly on a real multi-level DAG and that `forwards` leaves a clean
  solid line; verify against `demo.sh` with a live run, not just static markup.

**Explicitly do NOT do:**
- No per-log-line animation (Finding 7).
- No bounce/elastic, no glow bloom, no page-load choreography, no entrance animation on
  the static list tiles beyond the existing hover lift.
