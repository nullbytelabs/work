# work --web console — consolidated design plan

Synthesis of five impeccable lenses (critique, color/type, layout, a11y, motion) over
`src/web/client.ts`, measured against `PRODUCT.md` (register: product; "precise,
trustworthy, unfussy"; anti-refs: generic-AI-startup + flat-Bootstrap; "state is the
message", "calm by default, loud only on failure"; WCAG AA).

## The one headline

The console was reskinned as a "premium SaaS console, indigo brand gradient" — which is
*precisely* the generic-AI-startup look PRODUCT.md bans — and it spends its emphasis
**backwards**: running/success states get the gradient fill, glow, and pulse while
**failure is quiet** (same-weight red border). The run-id hash is the h1; the run *status*
is a small chip. So the two core principles ("state is the message", "calm by default,
loud only on failure") are both inverted. Every lens found this independently.

## Convergent findings (flagged by ≥2 lenses)

| # | Finding | Lenses | Sev |
|---|---|---|---|
| 1 | Indigo gradient + glow identity = AI-startup anti-reference; self-described "premium SaaS reskin" | critique, color | High |
| 2 | Emphasis inverted — running loud, failure quiet | critique, motion | High |
| 3 | DAG conveys status by color alone (no glyph/text/title in SVG) | color, a11y | High |
| 4 | All steps auto-open (`det.open=true` :1119) → failed step lost in a wall of logs | critique, layout | High |
| 5 | No `prefers-reduced-motion` (3 infinite loops run unconditionally) | motion(P0), a11y | High |
| 6 | Status colors fail AA as text (fail 4.18:1, pending 2.61, skip 2.95, muted 4.15) | color, (a11y) | High |

## Plan — sequenced (one file, so implement in this order)

### Phase A — Design foundation (the shared `<style>` tokens, lines 38–531)
Do this first and once; everything else builds on it.
- Replace the indigo gradient/glow identity with **one solid technical accent** (steel
  azure ~hue 245, OKLCH); delete the hero radial wash, brand-mark glow, gradient-filled
  DAG nodes.
- Convert palette to **OKLCH**; fix status text tokens to clear **AA ≥4.5:1** (esp.
  failure, muted/placeholder, pending).
- Tighten type: **rem-based ~1.2 six-step scale**, 4 weights, body ≥16px-equiv; commit to
  the system stack (Inter is named but never loaded) — or actually load Inter.
- Introduce a **4pt spacing scale** as CSS vars; route gaps/padding through it (kills the
  14/16/18/20/22px jitter + inline margins).
- Add the **`prefers-reduced-motion` contract**; convert `pulse` to opacity-only breath.

### Phase B — State is the message (run view, `viewRun` ~1048)
- Make the **colored status word** ("Running/Failed/Succeeded") the h1; demote the run-id
  hash to a monospace subtitle.
- **Re-balance emphasis**: spend the glow/pulse/contrast budget on **failure & action-
  needed**, keep success quiet.
- **Collapse succeeded steps**; keep running open; **auto-open + scroll to failures**.
- On wide screens, **sticky DAG pane + scroll-scoped logs pane** so you see shape and
  output together (today the DAG scrolls away the moment logs appear).

### Phase C — DAG (`drawDag` ~1201)
- Render the existing **`GLYPH` on each node** (status not by color alone) + role/title/
  aria-label on `<svg>`/nodes; `<title>` tooltips to recover clipped ids.
- Drop fixed pixel width/height, **keep `viewBox`** so it fits its container.
- Optional: directional **edge-flow** animation (reduced-motion aware) to show progress.

### Phase D — Accessibility (WCAG AA)
- **Focus management** on every SPA view swap (move focus to new `<h1>`) — ~5 lines, big win.
- Real **`:focus-visible` outline** (+offset, forced-colors fallback); fix clipping from
  `details.step{overflow:hidden}`.
- Dedicated visually-hidden **`aria-live="polite"`** region fed by the SSE handlers so
  run start/finish/pass/fail is announced.
- **Form errors**: `aria-describedby`/`aria-invalid`, move focus to bad input, text
  equivalent for the required `*`.

### Phase E — Consistency cleanups
- Collapse the **four status-badge systems** (chip/tag/rbadge/bare glyph) into **one
  reused status atom**.
- Deliveries as a **hairline-divided list** (remove nested cards); history as a **dense
  status-rail list** (not a card grid); remove the uppercase eyebrows.
- Add a **~960px breakpoint** (the docked-beside-editor width is currently unhandled).

## What's already good (keep)
Skeleton loaders, teaching empty states, inline boxed errors, typed/present-only form
handling, glyph+label+color status pairing in list/log views, delivery rows as proper
`role=button` + Enter/Space, operator-aware delivery severity mapping, and tasteful short
transitions on nav/tiles/buttons.

Per-lens detail: `01-critique.md`, `02-color-type.md`, `03-layout.md`,
`04-accessibility.md`, `05-motion.md`.
