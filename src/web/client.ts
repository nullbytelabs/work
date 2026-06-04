/**
 * CANDIDATE B — the "premium product dashboard" redesign of the served frontend.
 *
 * A single self-contained HTML document (inline CSS + inline ES-module JS, no
 * external assets, no network dependencies, no build step) — same packaging
 * constraint as the current `client.ts`, so it can drop into the running server
 * unchanged via `renderShell(token)`.
 *
 * This file is a pure RESKIN: every server contract from `client.ts` is preserved
 * verbatim — the same endpoint calls, the same SSE `addEventListener` frame
 * handling, the same `<g class="job" data-job="…">` + `data-status` DAG mechanism
 * that the live-restyle relies on, the same input-form mapping rules
 * (options→select, boolean→checkbox, number→valueAsNumber, present-only), re-run,
 * history, and the `<meta name="work-token">` → `X-Work-Token` CSRF handshake.
 * The LOOK is replaced (airy card-forward SaaS console, indigo brand gradient,
 * Inter-first type, light+dark tokens); the LOGIC is ported faithfully.
 *
 * Design language traced from the brand: the docs logo is a DAG of four circular
 * nodes (one source fanning to two parallel jobs that converge) drawn in an indigo
 * gradient #646cff → #9499ff on Inter. We echo that exactly — inline brand mark in
 * the header, gradient-filled DAG nodes, gradient primary actions and hero band.
 */

/** HTML-escape for safe interpolation into the served document (server-side). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderShell(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="work-token" content="${esc(token)}" />
<meta name="theme-color" content="#646cff" />
<title>pi-workflows — local console</title>
<style>
/* ========================================================================
   DESIGN TOKENS
   Brand: indigo gradient #646cff -> #9499ff (matches docs-site logo/favicon).
   Two deliberate themes via prefers-color-scheme; everything below references
   these custom properties so the restyle stays in one block.
   ======================================================================== */
:root {
  /* Brand gradient + accents */
  --brand-1: #646cff;
  --brand-2: #9499ff;
  --grad: linear-gradient(135deg, #646cff 0%, #9499ff 100%);
  --accent: #5b63f5;
  --accent-strong: #4f57ee;
  --ring: rgba(100, 108, 255, 0.45);

  /* Light surfaces — airy neutrals with soft elevation */
  --bg: #f6f7fb;
  --bg-grad: radial-gradient(1200px 480px at 50% -160px, rgba(100,108,255,0.10), transparent 70%);
  --surface: #ffffff;
  --surface-2: #fbfbfe;
  --surface-inset: #f2f3fa;
  --border: #e7e8f2;
  --border-strong: #d6d8e8;
  --fg: #1b1d27;
  --fg-soft: #43475a;
  --muted: #71748a;
  --code-bg: #1a1c28;
  --code-fg: #e6e8f5;

  /* Status palette */
  --ok: #1f9d55;
  --fail: #e0414c;
  --skip: #c98a16;
  --run: #5b63f5;
  --pend: #9aa0b4;

  /* Elevation */
  --shadow-sm: 0 1px 2px rgba(20, 22, 40, 0.05), 0 1px 3px rgba(20, 22, 40, 0.04);
  --shadow-md: 0 6px 16px rgba(28, 30, 56, 0.08), 0 2px 6px rgba(28, 30, 56, 0.05);
  --shadow-lg: 0 18px 48px rgba(28, 30, 56, 0.14);

  /* Type scale */
  --font-ui: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --radius: 14px;
  --radius-sm: 10px;
  --radius-xs: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --grad: linear-gradient(135deg, #646cff 0%, #9499ff 100%);
    --accent: #7c83ff;
    --accent-strong: #8c92ff;
    --ring: rgba(148, 153, 255, 0.5);

    --bg: #0b0d16;
    --bg-grad: radial-gradient(1200px 520px at 50% -200px, rgba(100,108,255,0.16), transparent 72%);
    --surface: #131524;
    --surface-2: #161829;
    --surface-inset: #0e1019;
    --border: #262a40;
    --border-strong: #333859;
    --fg: #eef0fb;
    --fg-soft: #c2c6dd;
    --muted: #8c91ad;
    --code-bg: #0a0b13;
    --code-fg: #e3e6f5;

    --ok: #46c97e;
    --fail: #ff6b73;
    --skip: #e3a93a;
    --run: #9499ff;
    --pend: #5b6075;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-md: 0 8px 22px rgba(0, 0, 0, 0.45);
    --shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.6);
  }
}

/* ========================================================================
   BASE
   ======================================================================== */
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  background-image: var(--bg-grad);
  background-repeat: no-repeat;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent); }
:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
  border-radius: var(--radius-xs);
}

/* ========================================================================
   HEADER — hero band with the inline brand mark
   ======================================================================== */
header.app {
  position: sticky; top: 0; z-index: 20;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
header.app .bar {
  max-width: 1120px; margin: 0 auto;
  padding: 14px 24px;
  display: flex; align-items: center; gap: 18px;
}
.brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
.brand .mark { width: 34px; height: 34px; display: block; flex: none; filter: drop-shadow(0 2px 6px rgba(100,108,255,0.35)); }
.brand .name { display: flex; flex-direction: column; line-height: 1.1; }
.brand .name b { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.brand .name small { font-size: 11px; color: var(--muted); font-weight: 500; letter-spacing: 0.02em; }

nav.app { display: flex; gap: 4px; margin-left: 8px; }
nav.app a {
  appearance: none; border: 0; background: transparent;
  color: var(--muted); font: inherit; font-weight: 600; font-size: 13.5px;
  padding: 7px 14px; border-radius: 999px; cursor: pointer;
  text-decoration: none; transition: background .15s, color .15s;
}
nav.app a:hover { color: var(--fg); background: var(--surface-inset); }
nav.app a.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.spacer { flex: 1; }
.env-pill {
  font-family: var(--font-mono); font-size: 11.5px; color: var(--muted);
  padding: 5px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2);
}

/* ========================================================================
   LAYOUT
   ======================================================================== */
main { max-width: 1120px; margin: 0 auto; padding: 34px 24px 80px; }
.page-head { margin: 0 0 22px; }
.page-head .eyebrow {
  font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 6px;
}
.page-head h1 {
  margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15;
}
.page-head .sub { margin: 6px 0 0; color: var(--muted); font-size: 14.5px; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.grow { flex: 1; }

/* ========================================================================
   CARDS / SURFACES
   ======================================================================== */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-sm);
}
.card.pad { padding: 22px 24px; }
.card + .card { margin-top: 18px; }
.section-title {
  font-size: 12.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 14px;
}

/* Workflow / history list as interactive cards */
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.tile {
  display: flex; align-items: center; gap: 14px;
  text-align: left; width: 100%;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); box-shadow: var(--shadow-sm);
  padding: 16px 18px; cursor: pointer; font: inherit; color: inherit;
  transition: transform .12s ease, box-shadow .15s ease, border-color .15s ease;
}
.tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--border-strong); }
.tile .icon {
  width: 38px; height: 38px; flex: none; border-radius: 11px;
  display: grid; place-items: center; color: #fff; background: var(--grad);
  box-shadow: 0 4px 12px rgba(100,108,255,0.35);
}
.tile .icon svg { width: 20px; height: 20px; }
.tile .body { min-width: 0; flex: 1; }
.tile .body .t { display: block; font-weight: 650; font-size: 15px; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile .body .m { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.tile .chev { color: var(--muted); flex: none; transition: transform .12s, color .12s; }
.tile:hover .chev { transform: translateX(2px); color: var(--accent); }

/* ========================================================================
   EMPTY / LOADING STATES
   ======================================================================== */
.empty {
  text-align: center; padding: 56px 24px; color: var(--muted);
  border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--surface-2);
}
.empty .glyph-lg { opacity: .8; margin-bottom: 12px; }
.empty h3 { margin: 0 0 4px; color: var(--fg-soft); font-size: 16px; font-weight: 700; }
.empty p { margin: 0; font-size: 13.5px; }
.skeleton { position: relative; overflow: hidden; background: var(--surface-inset); border-radius: var(--radius-sm); }
.skeleton::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 7%, transparent), transparent);
  transform: translateX(-100%); animation: shimmer 1.3s infinite;
}
@keyframes shimmer { 100% { transform: translateX(100%); } }
.sk-row { height: 64px; margin-bottom: 12px; }

/* ========================================================================
   FORM
   ======================================================================== */
form .field { margin-bottom: 18px; }
form .field:last-of-type { margin-bottom: 4px; }
label.field-label { display: block; font-weight: 650; font-size: 13.5px; margin-bottom: 7px; color: var(--fg-soft); }
label.field-label .req { color: var(--fail); margin-left: 2px; }
input[type=text], input[type=number], select {
  width: 100%; padding: 10px 12px; font: inherit; color: var(--fg);
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs); transition: border-color .12s, box-shadow .12s;
}
input[type=text]:focus, input[type=number]:focus, select:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring);
}
.check { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.check input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
.helper { color: var(--muted); font-size: 12.5px; margin-top: 6px; }

/* ========================================================================
   BUTTONS
   ======================================================================== */
button {
  appearance: none; font: inherit; font-weight: 650; cursor: pointer;
  border-radius: var(--radius-xs); padding: 10px 18px; border: 1px solid transparent;
  transition: transform .1s, box-shadow .15s, background .15s, opacity .15s;
}
button:active { transform: translateY(1px); }
button:disabled { opacity: .55; cursor: default; transform: none; }
button.primary {
  color: #fff; background: var(--grad); border-color: transparent;
  box-shadow: 0 6px 16px rgba(100,108,255,0.32);
}
button.primary:hover:not(:disabled) { box-shadow: 0 8px 22px rgba(100,108,255,0.42); }
button.ghost {
  background: var(--surface); color: var(--fg-soft); border-color: var(--border-strong);
  box-shadow: var(--shadow-sm); padding: 8px 14px; font-size: 13px;
}
button.ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

/* ========================================================================
   STATUS CHIPS
   ======================================================================== */
.chips { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 650;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg-soft);
}
.chip .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--pend); flex: none; }
.chip.mono { font-family: var(--font-mono); font-weight: 500; }
.chip[data-status=running] { color: var(--run); border-color: color-mix(in srgb, var(--run) 45%, var(--border)); background: color-mix(in srgb, var(--run) 9%, transparent); }
.chip[data-status=running] .dot { background: var(--run); animation: pulse 1.1s ease-in-out infinite; }
.chip[data-status=success] { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); background: color-mix(in srgb, var(--ok) 9%, transparent); }
.chip[data-status=success] .dot { background: var(--ok); }
.chip[data-status=failure] { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 45%, var(--border)); background: color-mix(in srgb, var(--fail) 9%, transparent); }
.chip[data-status=failure] .dot { background: var(--fail); }
@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.75); } }

/* ========================================================================
   WEBHOOKS — hook cards + endpoint URL + deliveries sub-panel
   Built from the same tokens as everything above (surfaces, accent, status).
   ======================================================================== */
.hooks { display: flex; flex-direction: column; gap: 18px; }
.hook-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.hook-title { min-width: 0; flex: 1; }
.hook-title .hname {
  font-size: 17px; font-weight: 750; letter-spacing: -0.01em;
  font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hook-title .hmeta { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.hook-title .hmeta a { font-weight: 650; text-decoration: none; }
.hook-title .hmeta a:hover { text-decoration: underline; }
.hook-badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* Compact pill badges (smaller than .chip; for auth/state). */
.tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 650;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg-soft);
  white-space: nowrap;
}
.tag.mono { font-family: var(--font-mono); font-weight: 600; }
.tag .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--pend); flex: none; }
.tag.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); background: color-mix(in srgb, var(--ok) 9%, transparent); }
.tag.ok .dot { background: var(--ok); }
.tag.warn { color: var(--skip); border-color: color-mix(in srgb, var(--skip) 45%, var(--border)); background: color-mix(in srgb, var(--skip) 10%, transparent); }
.tag.warn .dot { background: var(--skip); }
.tag.bad { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 45%, var(--border)); background: color-mix(in srgb, var(--fail) 9%, transparent); }
.tag.bad .dot { background: var(--fail); }

/* Endpoint URL row — monospace field + copy + send-test. */
.endpoint { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.endpoint .url {
  flex: 1; min-width: 220px;
  font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-soft);
  background: var(--surface-inset); border: 1px solid var(--border);
  border-radius: var(--radius-xs); padding: 9px 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hook-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* Deliveries sub-panel — inset surface inside the hook card. */
.deliveries { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 16px; }
.deliveries .section-title { margin-bottom: 12px; }
.del-list { display: flex; flex-direction: column; gap: 1px; }
.del-row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 12px; border-radius: var(--radius-xs);
  background: var(--surface-2); border: 1px solid var(--border);
  font-size: 12.5px;
}
.del-row + .del-row { margin-top: 6px; }
.del-row.clickable { cursor: pointer; transition: border-color .12s, background .12s, transform .1s; }
.del-row.clickable:hover { border-color: var(--accent); background: var(--surface-inset); }
.del-row .del-result { flex: none; }
.del-row .del-status { font-family: var(--font-mono); color: var(--muted); flex: none; }
.del-row .del-when { color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.del-row .del-ip { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); flex: none; }
.del-row .del-run { font-family: var(--font-mono); font-size: 11.5px; color: var(--accent); flex: none; display: inline-flex; align-items: center; gap: 4px; }
.del-empty { color: var(--muted); font-size: 13px; padding: 14px 2px; }

/* Result badge inside a delivery row (reuses tag palette by result class). */
.rbadge {
  display: inline-flex; align-items: center;
  padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 650;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg-soft);
}
.rbadge.r-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.rbadge.r-muted { color: var(--muted); }
.rbadge.r-warn { color: var(--skip); border-color: color-mix(in srgb, var(--skip) 45%, var(--border)); background: color-mix(in srgb, var(--skip) 11%, transparent); }
.rbadge.r-bad { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 45%, var(--border)); background: color-mix(in srgb, var(--fail) 10%, transparent); }

.err {
  color: var(--fail); white-space: pre-wrap; margin: 12px 0 0; font-size: 13.5px;
  font-family: var(--font-mono);
}
.err:empty { display: none; }
.err.boxed:not(:empty) {
  padding: 12px 14px; border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--fail) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--fail) 35%, var(--border));
}

/* ========================================================================
   DAG — echoes the brand logo (gradient circular/pill nodes, curved edges)
   ======================================================================== */
.dag-wrap {
  border: 1px solid var(--border); border-radius: var(--radius);
  background:
    radial-gradient(520px 220px at 18% -40px, color-mix(in srgb, var(--brand-1) 8%, transparent), transparent 70%),
    var(--surface-2);
  box-shadow: var(--shadow-sm);
  overflow-x: auto; padding: 8px;
}
svg.dag { display: block; min-width: 100%; }
svg.dag path.edge {
  stroke: var(--border-strong); stroke-width: 2; fill: none; stroke-linecap: round;
  transition: stroke .25s;
}
svg.dag path.edge.lit { stroke: url(#dagGrad); stroke-width: 2.5; }
svg.dag g.job .node {
  fill: var(--surface); stroke: var(--pend); stroke-width: 1.75;
  transition: stroke .25s, fill .25s, filter .25s;
}
svg.dag g.job .node-fill { fill: transparent; transition: opacity .25s; opacity: 0; }
svg.dag g.job .title { fill: var(--fg); font: 600 13px var(--font-ui); }
svg.dag g.job .meta { fill: var(--muted); font: 500 10.5px var(--font-mono); }
svg.dag g.job .badge { fill: var(--pend); transition: fill .25s; }

/* Live status — the SAME data-status contract the runtime drives. */
svg.dag g.job[data-status=running] .node { stroke: var(--run); filter: drop-shadow(0 0 6px color-mix(in srgb, var(--run) 55%, transparent)); }
svg.dag g.job[data-status=running] .node-fill { fill: url(#dagGrad); opacity: .14; }
svg.dag g.job[data-status=running] .badge { fill: var(--run); animation: nodePulse 1.2s ease-in-out infinite; }
svg.dag g.job[data-status=running] .title { fill: var(--accent); }
svg.dag g.job[data-status=success] .node { stroke: var(--ok); }
svg.dag g.job[data-status=success] .badge { fill: var(--ok); }
svg.dag g.job[data-status=failure] .node { stroke: var(--fail); }
svg.dag g.job[data-status=failure] .badge { fill: var(--fail); }
svg.dag g.job[data-status=skipped] .node { stroke: var(--skip); stroke-dasharray: 5 4; }
svg.dag g.job[data-status=skipped] .badge { fill: var(--skip); }
svg.dag g.job[data-status=skipped] .title, svg.dag g.job[data-status=skipped] .meta { opacity: .65; }
@keyframes nodePulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

/* ========================================================================
   LOGS — collapsible per-step groups, monospace bodies
   ======================================================================== */
.logs { margin-top: 4px; }
.logs .empty-logs { color: var(--muted); font-size: 13.5px; padding: 18px 2px; }
details.step {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  margin-bottom: 10px; background: var(--surface); box-shadow: var(--shadow-sm);
  overflow: hidden;
}
details.step > summary {
  list-style: none; cursor: pointer; padding: 11px 15px;
  display: flex; align-items: center; gap: 10px; font-size: 13.5px; font-weight: 550;
  user-select: none;
}
details.step > summary::-webkit-details-marker { display: none; }
details.step > summary:hover { background: var(--surface-inset); }
details.step > summary .glyph { flex: none; font-size: 15px; line-height: 1; width: 16px; text-align: center; }
details.step > summary .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.step > summary .label .job-id { color: var(--muted); }
details.step > summary .label .sep { color: var(--muted); margin: 0 5px; }
details.step > summary .meta {
  flex: none; font-family: var(--font-mono); font-size: 11.5px; color: var(--muted);
  display: flex; gap: 9px; align-items: center;
}
details.step > summary .caret { flex: none; color: var(--muted); transition: transform .15s; }
details.step[open] > summary .caret { transform: rotate(90deg); }
details.step pre {
  margin: 0; padding: 12px 15px; overflow-x: auto;
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5;
  background: var(--code-bg); color: var(--code-fg);
  border-top: 1px solid var(--border);
  max-height: 460px; overflow-y: auto;
}
pre .stderr { color: #ff8d8d; }

/* ANSI SGR -> classes (see ansiToHtml). Colors tuned for the dark log surface. */
.a-bold { font-weight: 700; }
.fg-30 { color: #4f5566; } .fg-31 { color: #ff6b6b; } .fg-32 { color: #5be37e; }
.fg-33 { color: #f4c95b; } .fg-34 { color: #7c83ff; } .fg-35 { color: #d08bff; }
.fg-36 { color: #4fd3d8; } .fg-37 { color: #d7dbe6; }
.fg-90 { color: #6b7180; } .fg-91 { color: #ff8d8d; } .fg-92 { color: #87f0a3; }
.fg-93 { color: #ffdb87; } .fg-94 { color: #9aa0ff; } .fg-95 { color: #e0a8ff; }
.fg-96 { color: #82e6ea; } .fg-97 { color: #ffffff; }

/* glyph colors (history rows + step summaries) */
.glyph.success { color: var(--ok); } .glyph.failure { color: var(--fail); }
.glyph.skipped { color: var(--skip); } .glyph.running { color: var(--run); } .glyph.pending { color: var(--pend); }

/* ========================================================================
   RESPONSIVE — phone layout (iPhone-class viewports, ~375–430px portrait)
   The desktop bar can't hold the brand + 3 nav pills + env chip on a phone,
   so the brand keeps row 1 and the nav drops to its own full-width row as an
   equal-thirds tab bar; webhook URL/actions and delivery rows restack; spacing
   and type tighten. One breakpoint (640px) covers phones + small tablets.
   ======================================================================== */
@media (max-width: 640px) {
  /* Header: brand on row 1; nav wraps to a full-width segmented tab row. */
  header.app .bar { padding: 10px 14px; gap: 8px 12px; flex-wrap: wrap; }
  .brand .mark { width: 30px; height: 30px; }
  .brand .name b { font-size: 15px; }
  .spacer, .env-pill { display: none; }
  nav.app { order: 3; width: 100%; margin-left: 0; gap: 6px; }
  nav.app a { flex: 1; min-width: 0; text-align: center; padding: 9px 10px; font-size: 13px; }

  /* Layout: tighter gutters + type. */
  main { padding: 22px 14px 72px; }
  .page-head { margin-bottom: 18px; }
  .page-head h1 { font-size: 22px; }
  .page-head .sub { font-size: 13.5px; }
  .card.pad { padding: 16px 15px; }
  .grid { grid-template-columns: 1fr; }
  .section-title { margin-bottom: 12px; }

  /* Run detail: status chips + Re-run keep wrapping cleanly. */
  .page-head .row { gap: 10px; }

  /* Webhooks: URL takes a full row, Copy/Send-test split the row below it. */
  .hook-title .hname { font-size: 16px; }
  .endpoint { gap: 10px; }
  .endpoint .url { flex-basis: 100%; min-width: 0; }
  .hook-actions { width: 100%; }
  .hook-actions button { flex: 1; }
  /* Source IP is secondary metadata — drop it so the row never overflows. */
  .del-row .del-ip { display: none; }
  .del-row { gap: 9px; padding: 9px 11px; }

  /* Logs: a touch denser; the DAG scrolls horizontally with momentum. */
  details.step > summary { padding: 11px 13px; gap: 8px; }
  details.step > summary .meta { font-size: 11px; gap: 7px; }
  details.step pre { font-size: 12px; padding: 11px 13px; max-height: 360px; }
  .dag-wrap { -webkit-overflow-scrolling: touch; }
}
</style>
</head>
<body>
<header class="app">
  <div class="bar">
    <a class="brand" id="nav-home" href="#" aria-label="pi-workflows home">
      <!-- Inline brand mark — the DAG-of-four-nodes logo, no network fetch -->
      <svg class="mark" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="brandG" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
            <stop stop-color="#646cff"/><stop offset="1" stop-color="#9499ff"/>
          </linearGradient>
        </defs>
        <line x1="30" y1="60" x2="60" y2="30" stroke="url(#brandG)" stroke-width="8" stroke-linecap="round"/>
        <line x1="30" y1="60" x2="60" y2="90" stroke="url(#brandG)" stroke-width="8" stroke-linecap="round"/>
        <line x1="60" y1="30" x2="90" y2="60" stroke="url(#brandG)" stroke-width="8" stroke-linecap="round"/>
        <line x1="60" y1="90" x2="90" y2="60" stroke="url(#brandG)" stroke-width="8" stroke-linecap="round"/>
        <circle cx="30" cy="60" r="13" fill="url(#brandG)"/>
        <circle cx="60" cy="30" r="13" fill="url(#brandG)"/>
        <circle cx="60" cy="90" r="13" fill="url(#brandG)"/>
        <circle cx="90" cy="60" r="13" fill="url(#brandG)"/>
      </svg>
      <span class="name"><b>pi-workflows</b><small>local console</small></span>
    </a>
    <nav class="app" aria-label="Primary">
      <a id="nav-workflows" href="#">Workflows</a>
      <a id="nav-webhooks" href="#">Webhooks</a>
      <a id="nav-history" href="#">History</a>
    </nav>
    <span class="spacer"></span>
    <span class="env-pill">127.0.0.1</span>
  </div>
</header>
<main id="app" aria-live="polite"></main>

<script type="module">
/* ========================================================================
   CONTRACT NOTE
   This script preserves every server interaction from the original client.ts:
   the endpoints, the SSE frame names, the DAG data-job/data-status mechanism,
   the input-form rules, re-run, history, and the X-Work-Token handshake. Only
   the DOM/styling and ANSI handling are upgraded.
   ======================================================================== */
const TOKEN = document.querySelector('meta[name=work-token]').content;
const app = document.getElementById('app');

// The one EventSource for the run currently on screen. Closed (and replaced)
// whenever we open another run or navigate away, so a past-run replay or a stale
// live tail can't keep streaming into a view the user already left.
let activeEs = null;
function closeActiveEs() { if (activeEs) { activeEs.close(); activeEs = null; } }

// ---- helpers -----------------------------------------------------------
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const GLYPH = { success:'✓', failure:'✗', skipped:'⊘', running:'◌', pending:'○' };

/**
 * Upgraded ANSI handling. The original MVP stripped SGR codes; here we
 * HTML-ESCAPE FIRST (untrusted log text), THEN translate the common SGR color
 * codes — bold (1), reset (0), and the 30-37 / 90-97 foreground colors — into
 * <span> elements. Unknown/other codes (background, cursor moves, etc.) are
 * dropped, never emitted raw. Returns SAFE HTML (escaped + our own spans only).
 */
function ansiToHtml(input) {
  const ESC = String.fromCharCode(27);
  const re = new RegExp(ESC + '\\\\[([0-9;]*)m', 'g');
  const text = String(input);
  let out = '';
  let last = 0;
  let openFg = false, openBold = false;
  let m;
  const closeAll = () => {
    let s = '';
    if (openBold) { s += '</span>'; openBold = false; }
    if (openFg) { s += '</span>'; openFg = false; }
    return s;
  };
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    // Empty params == reset.
    const codes = m[1] === '' ? ['0'] : m[1].split(';');
    for (const c of codes) {
      const n = Number(c);
      if (n === 0) { out += closeAll(); }
      else if (n === 1) { if (!openBold) { out += '<span class="a-bold">'; openBold = true; } }
      else if (n === 22) { if (openBold) { out += '</span>'; openBold = false; } }
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        if (openFg) { out += '</span>'; }
        out += '<span class="fg-' + n + '">'; openFg = true;
      } else if (n === 39) { if (openFg) { out += '</span>'; openFg = false; } }
      // else: ignore (background/other) — nothing raw is ever emitted.
    }
  }
  out += esc(text.slice(last));
  out += closeAll();
  return out;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || ('HTTP ' + r.status));
  return r.json();
}

function setActiveNav(id) {
  for (const el of document.querySelectorAll('nav.app a')) el.classList.toggle('active', el.id === id);
}

// Small inline icon set (no network).
const ICON = {
  workflow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7 7l3.5 9M17 7l-3.5 9"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  webhook: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16.5a3 3 0 1 0 0 .01"/><path d="M9 7.5a3 3 0 1 0-2.6 4.5"/><path d="M9 12.5a3 3 0 1 0 2.6 4.5"/><path d="M12 7.5l3 5M9 17h6"/></svg>',
};

// ---- workflows list ----------------------------------------------------
async function viewWorkflows() {
  closeActiveEs();
  setActiveNav('nav-workflows');
  app.innerHTML =
    '<div class="page-head"><div class="eyebrow">Catalog</div><h1>Workflows</h1>' +
    '<p class="sub">Sandboxed workflows discovered in <code>.workflows/</code> — pick one to configure and run.</p></div>' +
    '<div class="grid" id="wf">' + skeletonRows(3) + '</div>';
  const ul = document.getElementById('wf');
  let workflows;
  try { workflows = await getJson('/api/workflows'); }
  catch (e) { app.innerHTML = errorBlock(e.message); return; }
  if (!workflows.length) {
    ul.outerHTML = emptyState('No workflows yet', 'Add a YAML file to <code>.workflows/</code> and it will appear here.');
    return;
  }
  ul.innerHTML = '';
  for (const wf of workflows) {
    const btn = document.createElement('button');
    btn.className = 'tile';
    btn.innerHTML =
      '<span class="icon">' + ICON.workflow + '</span>' +
      '<span class="body"><span class="t">' + esc(wf.name) + '</span>' +
      '<span class="m">Configure &amp; trigger</span></span>' +
      '<span class="chev">' + ICON.chevron + '</span>';
    btn.onclick = () => viewTrigger(wf.name);
    ul.appendChild(btn);
  }
}

// ---- webhooks ----------------------------------------------------------
// Map a delivery result to a result-badge severity class. Mirrors the
// API contract result enum: accepted/test are green; duplicate is muted;
// disabled/not_opted_in are amber (operator-actionable); the rest are
// rejections shown red/amber.
function resultClass(result) {
  switch (result) {
    case 'accepted':
    case 'test':
      return 'r-ok';
    case 'duplicate':
      return 'r-muted';
    case 'disabled':
    case 'not_opted_in':
      return 'r-warn';
    case 'unauthorized':
    case 'forbidden':
    case 'at_capacity':
    case 'too_large':
    case 'bad_request':
      return 'r-bad';
    default:
      return 'r-muted';
  }
}

// Friendly clock + relative time from an ISO/epoch ts (best-effort).
function fmtWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const clock = d.toLocaleTimeString();
  const diff = Date.now() - d.getTime();
  let rel;
  if (diff < 0) rel = 'just now';
  else if (diff < 60000) rel = Math.max(1, Math.round(diff / 1000)) + 's ago';
  else if (diff < 3600000) rel = Math.round(diff / 60000) + 'm ago';
  else if (diff < 86400000) rel = Math.round(diff / 3600000) + 'h ago';
  else rel = Math.round(diff / 86400000) + 'd ago';
  return clock + ' · ' + rel;
}

async function viewWebhooks() {
  closeActiveEs();
  setActiveNav('nav-webhooks');
  app.innerHTML =
    '<div class="page-head"><div class="eyebrow">Integrations</div><h1>Webhooks</h1>' +
    '<p class="sub">Authenticated <code>POST /hooks/&lt;name&gt;</code> triggers — bound to the loopback ' +
    'interface by default, exposed externally via a tunnel. Each accepted delivery dispatches its ' +
    'mapped workflow.</p></div>' +
    '<div class="hooks" id="hooks">' + skeletonRows(2) + '</div>';
  const list = document.getElementById('hooks');
  let hooks;
  try { hooks = await getJson('/api/webhooks'); }
  catch (e) { app.innerHTML = errorBlock(e.message); return; }
  if (!hooks.length) {
    list.outerHTML = emptyState(
      'No webhooks configured',
      'Add a <code>webhooks:</code> block to <code>pi-workflows.config.json</code> mapping a hook ' +
      'name to a workflow, then reload to see it here.');
    return;
  }
  list.innerHTML = '';
  for (const h of hooks) list.appendChild(hookCard(h));
}

// One hook card: header (name + auth/state badges), workflow + datasources,
// the endpoint URL with copy + send-test, and a lazily-loaded deliveries panel.
function hookCard(h) {
  const card = document.createElement('div');
  card.className = 'card pad';

  const enabled = h.enabled && h.configured;
  const stateTag = !h.configured
    ? '<span class="tag bad" title="No usable secret — this hook will reject deliveries"><span class="dot"></span>no secret</span>'
    : h.enabled
      ? '<span class="tag ok"><span class="dot"></span>enabled</span>'
      : '<span class="tag warn"><span class="dot"></span>disabled</span>';
  const authTag = '<span class="tag mono">' + esc(h.auth || 'bearer') + '</span>';

  const dsChips = Array.isArray(h.datasources) && h.datasources.length
    ? '<div class="chips" style="margin-top:14px">' +
        h.datasources.map((d) => '<span class="chip mono">' + esc(d) + '</span>').join('') +
      '</div>'
    : '';

  const origin = window.location.origin;
  const url = origin + '/hooks/' + h.name;

  card.innerHTML =
    '<div class="hook-head">' +
      '<div class="hook-title">' +
        '<div class="hname">' + esc(h.name) + '</div>' +
        '<div class="hmeta">routes to workflow ' +
          (h.workflow
            ? '<a href="#" class="wf-link">' + esc(h.workflow) + '</a>'
            : '<em>unset</em>') +
        '</div>' +
      '</div>' +
      '<div class="hook-badges">' + authTag + stateTag + '</div>' +
    '</div>' +
    dsChips +
    '<div class="endpoint">' +
      '<span class="url" title="' + esc(url) + '">' + esc(url) + '</span>' +
      '<div class="hook-actions">' +
        '<button class="ghost copy-btn" type="button">' + ICON.copy + '&nbsp;Copy</button>' +
        '<button class="primary test-btn" type="button"' + (enabled ? '' : ' disabled') +
          ' title="' + (enabled ? 'Dispatch a synthetic test delivery' : 'Unavailable — hook has no usable secret or is disabled') + '">Send test</button>' +
      '</div>' +
    '</div>' +
    '<p class="err boxed test-err"></p>' +
    '<div class="deliveries">' +
      '<div class="section-title">Recent deliveries</div>' +
      '<div class="del-list" id="del-' + cssId(h.name) + '"><div class="skeleton sk-row"></div></div>' +
    '</div>';

  // Workflow affordance (optional) — jump to that workflow's trigger page.
  const wfLink = card.querySelector('.wf-link');
  if (wfLink) wfLink.onclick = (e) => { e.preventDefault(); viewTrigger(h.workflow); };

  // Copy endpoint URL to clipboard, with a graceful fallback + brief affirmation.
  const copyBtn = card.querySelector('.copy-btn');
  copyBtn.onclick = async () => {
    const ok = await copyText(url);
    const prev = copyBtn.innerHTML;
    copyBtn.innerHTML = ok ? '✓&nbsp;Copied' : 'Copy failed';
    copyBtn.disabled = true;
    setTimeout(() => { copyBtn.innerHTML = prev; copyBtn.disabled = false; }, 1400);
  };

  // Send a synthetic test delivery; on success watch the run live.
  const testBtn = card.querySelector('.test-btn');
  const testErr = card.querySelector('.test-err');
  testBtn.onclick = async () => {
    testErr.textContent = '';
    testBtn.disabled = true;
    try {
      const r = await fetch('/api/webhooks/' + encodeURIComponent(h.name) + '/test', {
        method: 'POST',
        headers: { 'X-Work-Token': TOKEN },
      });
      if (!r.ok) {
        let msg = (await r.text()) || ('HTTP ' + r.status);
        try { msg = JSON.parse(msg).error || msg; } catch {}
        testErr.textContent = msg;
        testBtn.disabled = false;
        return;
      }
      const { runId } = await r.json();
      if (runId) { viewRun(runId); return; }
      testErr.textContent = 'Test accepted but no run id was returned.';
      testBtn.disabled = false;
    } catch (e) { testErr.textContent = e.message; testBtn.disabled = false; }
  };

  // Lazily load deliveries so the page paints immediately.
  loadDeliveries(h.name, card.querySelector('.del-list'));
  return card;
}

// Fetch + render the deliveries sub-panel for one hook into the target node.
async function loadDeliveries(name, target) {
  let rows;
  try { rows = await getJson('/api/webhooks/' + encodeURIComponent(name) + '/deliveries'); }
  catch (e) { target.innerHTML = '<div class="del-empty">' + esc(e.message) + '</div>'; return; }
  if (!rows.length) {
    target.innerHTML = '<div class="del-empty">No deliveries yet — they\\'ll appear here as the hook receives traffic.</div>';
    return;
  }
  target.innerHTML = '';
  for (const d of rows) {
    const row = document.createElement('div');
    row.className = 'del-row' + (d.runId ? ' clickable' : '');
    const status = (d.httpStatus !== undefined && d.httpStatus !== null) ? String(d.httpStatus) : '—';
    row.innerHTML =
      '<span class="del-result"><span class="rbadge ' + resultClass(d.result) + '">' + esc(d.result) + '</span></span>' +
      '<span class="del-status">' + esc(status) + '</span>' +
      '<span class="del-when">' + esc(fmtWhen(d.ts)) + '</span>' +
      (d.sourceIp ? '<span class="del-ip">' + esc(d.sourceIp) + '</span>' : '') +
      (d.runId ? '<span class="del-run">' + ICON.chevron + esc(String(d.runId).slice(0, 8)) + '</span>' : '');
    if (d.runId) {
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.onclick = () => viewRun(d.runId);
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewRun(d.runId); } };
    }
    target.appendChild(row);
  }
}

// Clipboard write with an execCommand fallback for non-secure / older contexts.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// A DOM-id-safe slug of a hook name (only used for an element id, not security).
function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// ---- run / trigger detail ----------------------------------------------
async function viewTrigger(name) {
  closeActiveEs();
  setActiveNav('nav-workflows');
  app.innerHTML =
    '<div class="page-head"><div class="eyebrow">Run workflow</div><h1>' + esc(name) + '</h1>' +
    '<p class="sub">Provide inputs and dispatch a run. Each job executes in its own micro-VM.</p></div>' +
    '<div class="card pad"><div class="section-title">Inputs</div><div id="formwrap"><div class="skeleton sk-row"></div></div></div>';
  let inputs;
  try { inputs = await getJson('/api/workflows/' + encodeURIComponent(name) + '/form'); }
  catch (e) { document.getElementById('formwrap').innerHTML = errorBlock(e.message); return; }

  const form = document.createElement('form');
  const fields = buildForm(inputs);
  if (!fields.childNodes.length) {
    const none = document.createElement('p');
    none.className = 'helper';
    none.style.margin = '0 0 16px';
    none.textContent = 'This workflow takes no inputs.';
    form.appendChild(none);
  } else {
    form.appendChild(fields);
  }

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '20px';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'primary';
  btn.textContent = 'Run workflow';
  actions.appendChild(btn);
  form.appendChild(actions);

  const errBox = document.createElement('p');
  errBox.className = 'err boxed';
  form.appendChild(errBox);

  const wrap = document.getElementById('formwrap');
  wrap.innerHTML = '';
  wrap.appendChild(form);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    errBox.textContent = '';
    let values;
    try { values = collectInputs(form, inputs); }
    catch (e) { errBox.textContent = e.message; return; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Work-Token': TOKEN },
        body: JSON.stringify({ name, inputs: values }),
      });
      if (!r.ok) { errBox.textContent = (await r.text()) || ('HTTP ' + r.status); btn.disabled = false; return; }
      const { runId } = await r.json();
      viewRun(runId);
    } catch (e) { errBox.textContent = e.message; btn.disabled = false; }
  };
}

// Build form controls from the InputSpec map (mirrors the compiler mapping).
function buildForm(inputs) {
  const frag = document.createDocumentFragment();
  for (const [name, spec] of Object.entries(inputs)) {
    const type = spec.type || 'string';
    const field = document.createElement('div');
    field.className = 'field';

    let ctrl;
    if (Array.isArray(spec.options) && spec.options.length) {
      ctrl = document.createElement('select');
      if (!spec.required) ctrl.appendChild(new Option('', ''));
      for (const opt of spec.options) {
        const o = new Option(String(opt), String(opt));
        if (spec.default !== undefined && opt === spec.default) o.selected = true;
        ctrl.appendChild(o);
      }
    } else if (type === 'boolean') {
      ctrl = document.createElement('input');
      ctrl.type = 'checkbox';
      if (spec.default === true) ctrl.checked = true;
    } else if (type === 'number') {
      ctrl = document.createElement('input');
      ctrl.type = 'number';
      if (spec.default !== undefined) ctrl.value = String(spec.default);
    } else {
      ctrl = document.createElement('input');
      ctrl.type = 'text';
      if (spec.default !== undefined) ctrl.value = String(spec.default);
      if (spec.pattern) ctrl.pattern = spec.pattern;
    }
    if (spec.required && type !== 'boolean') ctrl.required = true;
    ctrl.dataset.input = name;
    ctrl.dataset.type = type;
    const ctrlId = 'inp-' + name;
    ctrl.id = ctrlId;

    if (type === 'boolean') {
      // Checkbox sits inline with its label.
      const lab = document.createElement('label');
      lab.className = 'check';
      lab.htmlFor = ctrlId;
      lab.appendChild(ctrl);
      const span = document.createElement('span');
      span.style.fontWeight = '650';
      span.style.fontSize = '13.5px';
      span.style.color = 'var(--fg-soft)';
      span.textContent = name;
      lab.appendChild(span);
      field.appendChild(lab);
    } else {
      const lab = document.createElement('label');
      lab.className = 'field-label';
      lab.htmlFor = ctrlId;
      lab.innerHTML = esc(name) + (spec.required ? ' <span class="req">*</span>' : '');
      field.appendChild(lab);
      field.appendChild(ctrl);
    }

    if (spec.description) {
      const h = document.createElement('div');
      h.className = 'helper';
      h.textContent = spec.description;
      field.appendChild(h);
    }
    frag.appendChild(field);
  }
  return frag;
}

// Collect typed input values, mirroring the compiler: strict types (real JSON
// number/boolean), present-only (omit untouched optional inputs).
function collectInputs(form, specs) {
  const out = {};
  for (const el of form.querySelectorAll('[data-input]')) {
    const name = el.dataset.input;
    const spec = specs[name] || {};
    const type = el.dataset.type;
    if (type === 'boolean') { out[name] = el.checked; continue; }
    const raw = el.value;
    // Present-only: don't emit an empty, unrequired field the user left blank.
    if (raw === '' && !spec.required) continue;
    if (type === 'number') {
      const n = el.valueAsNumber;
      if (Number.isNaN(n)) throw new Error('input "' + name + '" must be a number');
      out[name] = n;
    } else {
      out[name] = raw;
    }
  }
  return out;
}

// ---- live run view -----------------------------------------------------
function viewRun(runId) {
  // Switching runs: drop any prior stream so its frames can't bleed into this view.
  closeActiveEs();
  setActiveNav('nav-history');
  app.innerHTML =
    '<div class="page-head"><div class="row"><div class="grow">' +
      '<div class="eyebrow">Run</div>' +
      '<h1><span style="font-family:var(--font-mono);font-size:24px">' + esc(runId.slice(0, 8)) + '</span></h1>' +
    '</div>' +
    '<button class="ghost" id="rerun" title="Re-run with the same inputs">↻ Re-run</button></div></div>' +
    '<div class="card pad">' +
      '<div class="chips">' +
        '<span class="chip" data-status="running" id="run-status"><span class="dot"></span><span id="run-status-text">running</span></span>' +
        '<span class="chip mono" id="run-elapsed">0.0s</span>' +
      '</div>' +
      '<p class="err boxed" id="run-err"></p>' +
      '<div style="margin-top:16px" id="dag"></div>' +
    '</div>' +
    '<div class="card pad" style="margin-top:18px">' +
      '<div class="section-title">Step logs</div>' +
      '<div class="logs" id="logs"><div class="empty-logs">Waiting for the run to start…</div></div>' +
    '</div>';

  const dagEl = document.getElementById('dag');
  const logsEl = document.getElementById('logs');
  const statusEl = document.getElementById('run-status');
  const statusText = document.getElementById('run-status-text');
  const elapsedEl = document.getElementById('run-elapsed');
  const errEl = document.getElementById('run-err');
  const rerunBtn = document.getElementById('rerun');
  const started = Date.now();
  const tick = setInterval(() => { elapsedEl.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's'; }, 100);

  // Re-run: re-dispatch this workflow with the same stored inputs, then open the
  // new run. The server resolves the workflow + inputs from the run's history.
  rerunBtn.onclick = async () => {
    errEl.textContent = '';
    rerunBtn.disabled = true;
    try {
      const r = await fetch('/api/runs/' + encodeURIComponent(runId) + '/rerun', {
        method: 'POST',
        headers: { 'X-Work-Token': TOKEN },
      });
      if (!r.ok) { errEl.textContent = (await r.text()) || ('HTTP ' + r.status); rerunBtn.disabled = false; return; }
      const { runId: newId } = await r.json();
      viewRun(newId);
    } catch (e) { errEl.textContent = e.message; rerunBtn.disabled = false; }
  };

  // Per-step durations are derived client-side from frame timestamps (ts).
  const stepStart = new Map();

  // step key -> { body, summary, metaEl } so step-output appends to the right block.
  const stepBodies = new Map();
  const stepKey = (jobId, stepName) => jobId + '\\u0000' + stepName;

  // Pin-to-bottom autoscroll unless the user scrolled up in that step's <pre>.
  function isPinned(pre) { return pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24; }

  function ensureStep(jobId, stepName, title, ts) {
    const key = stepKey(jobId, stepName);
    let rec = stepBodies.get(key);
    if (rec) return rec;
    // Clear the placeholder on first real step.
    const placeholder = logsEl.querySelector('.empty-logs');
    if (placeholder) placeholder.remove();

    if (ts !== undefined) stepStart.set(key, ts);

    const det = document.createElement('details');
    det.className = 'step';
    det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML =
      '<span class="glyph running">' + GLYPH.running + '</span>' +
      '<span class="label"><span class="job-id">' + esc(jobId) + '</span>' +
      '<span class="sep">›</span>' + esc(title || stepName) + '</span>' +
      '<span class="meta"></span>' +
      '<span class="caret">' + ICON.caret + '</span>';
    det.appendChild(sum);
    const body = document.createElement('pre');
    det.appendChild(body);
    logsEl.appendChild(det);
    rec = { body, summary: sum, metaEl: sum.querySelector('.meta'), key };
    stepBodies.set(key, rec);
    return rec;
  }

  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/events');
  activeEs = es;

  es.addEventListener('run-init', (e) => { drawDag(dagEl, JSON.parse(e.data)); });
  es.addEventListener('job-start', (e) => setJobStatus(dagEl, JSON.parse(e.data).jobId, 'running'));
  es.addEventListener('step-start', (e) => { const d = JSON.parse(e.data); ensureStep(d.jobId, d.stepName, d.title, d.ts); });
  es.addEventListener('step-output', (e) => {
    const d = JSON.parse(e.data);
    const rec = ensureStep(d.jobId, d.stepName, d.stepName, d.ts);
    const pinned = isPinned(rec.body);
    const span = document.createElement('span');
    if (d.stream === 'stderr') span.className = 'stderr';
    // HTML-escape + ANSI color translation (never raw text).
    span.innerHTML = ansiToHtml(d.text);
    rec.body.appendChild(span);
    if (pinned) rec.body.scrollTop = rec.body.scrollHeight;
  });
  es.addEventListener('step-end', (e) => {
    const d = JSON.parse(e.data);
    const rec = ensureStep(d.jobId, d.stepName, d.stepName, d.ts);
    const cls = d.status;
    rec.summary.querySelector('.glyph').className = 'glyph ' + cls;
    rec.summary.querySelector('.glyph').textContent = GLYPH[cls] || '?';
    // duration (nice-to-have) from ts delta.
    let durTxt = '';
    const startTs = stepStart.get(rec.key);
    if (startTs !== undefined && d.ts !== undefined) {
      durTxt = '<span>' + ((d.ts - startTs) / 1000).toFixed(1) + 's</span>';
    }
    rec.metaEl.innerHTML = durTxt + '<span>exit ' + esc(d.exitCode) + '</span>';
  });
  es.addEventListener('job-end', (e) => { const d = JSON.parse(e.data); setJobStatus(dagEl, d.jobId, d.status); });
  es.addEventListener('run-end', (e) => {
    const d = JSON.parse(e.data);
    statusEl.dataset.status = d.status;
    statusText.textContent = d.status;
    if (d.error) { errEl.textContent = d.error; }
    clearInterval(tick);
    closeActiveEs();
  });
  // The replay path emits this for an unknown id (headers were already sent, so
  // the server can't send a JSON 404). Show it and stop — don't let EventSource
  // reconnect-loop on a run that will never exist.
  es.addEventListener('error', (e) => {
    if (e && e.data) { try { errEl.textContent = JSON.parse(e.data).error || e.data; } catch { errEl.textContent = e.data; } }
    clearInterval(tick);
    closeActiveEs();
  });
  es.onerror = () => { /* keep retrying while the run is live; closed on run-end */ };
}

function setJobStatus(dagEl, jobId, status) {
  const g = dagEl.querySelector('g.job[data-job="' + cssEscape(jobId) + '"]');
  if (g) {
    g.dataset.status = status;
    // Light the incoming edges of this node for a flowing feel.
    if (status === 'running' || status === 'success') {
      for (const p of dagEl.querySelectorAll('path.edge[data-to="' + cssEscape(jobId) + '"]')) p.classList.add('lit');
    }
  }
}
function cssEscape(s) { return String(s).replace(/["\\\\]/g, '\\\\$&'); }

// ---- DAG: echoes the brand logo (gradient circular/pill nodes + curved edges)
// Layered layout: x = level (column), y = index-within-level (row).
function drawDag(container, init) {
  const COLW = 240, ROWH = 96, BW = 188, BH = 62, PADX = 28, PADY = 26;
  const jobs = init.jobs;
  const byLevel = {};
  let maxLevel = 0;
  for (const id of init.jobOrder) {
    const lvl = jobs[id].level || 0;
    (byLevel[lvl] = byLevel[lvl] || []).push(id);
    if (lvl > maxLevel) maxLevel = lvl;
  }
  const pos = {};
  let maxRows = 0;
  for (const lvl of Object.keys(byLevel)) {
    byLevel[lvl].forEach((id, row) => {
      pos[id] = { x: PADX + Number(lvl) * COLW, y: PADY + row * ROWH };
      if (row + 1 > maxRows) maxRows = row + 1;
    });
  }
  const width = PADX * 2 + (maxLevel + 1) * COLW - (COLW - BW);
  const height = PADY * 2 + maxRows * ROWH - (ROWH - BH);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'dag');
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  // Gradient def echoing the logo's indigo fill.
  const defs = document.createElementNS(ns, 'defs');
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.setAttribute('id', 'dagGrad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
  for (const [off, col] of [['0', '#646cff'], ['1', '#9499ff']]) {
    const s = document.createElementNS(ns, 'stop');
    s.setAttribute('offset', off); s.setAttribute('stop-color', col);
    grad.appendChild(s);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Edges first (under the nodes): from each need's right edge to target's left.
  for (const id of init.jobOrder) {
    for (const need of jobs[id].needs || []) {
      if (!pos[need] || !pos[id]) continue;
      const a = pos[need], b = pos[id];
      const x1 = a.x + BW, y1 = a.y + BH / 2, x2 = b.x, y2 = b.y + BH / 2;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', 'edge');
      path.setAttribute('data-to', id);
      path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
      svg.appendChild(path);
    }
  }
  // Nodes — pill shape, gradient running-fill, label = job id + runs-on / step count.
  for (const id of init.jobOrder) {
    const p = pos[id];
    const j = jobs[id];
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'job');
    g.setAttribute('data-job', id);
    g.dataset.status = 'pending';

    const fill = document.createElementNS(ns, 'rect');
    fill.setAttribute('class', 'node-fill');
    fill.setAttribute('x', p.x); fill.setAttribute('y', p.y);
    fill.setAttribute('width', BW); fill.setAttribute('height', BH);
    fill.setAttribute('rx', BH / 2);
    g.appendChild(fill);

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'node');
    rect.setAttribute('x', p.x); rect.setAttribute('y', p.y);
    rect.setAttribute('width', BW); rect.setAttribute('height', BH);
    rect.setAttribute('rx', BH / 2);
    g.appendChild(rect);

    // Status badge dot (left, echoing a node bead).
    const badge = document.createElementNS(ns, 'circle');
    badge.setAttribute('class', 'badge');
    badge.setAttribute('cx', p.x + 22); badge.setAttribute('cy', p.y + BH / 2);
    badge.setAttribute('r', 5);
    g.appendChild(badge);

    const title = document.createElementNS(ns, 'text');
    title.setAttribute('class', 'title');
    title.setAttribute('x', p.x + 38); title.setAttribute('y', p.y + BH / 2 - 4);
    title.textContent = clip(id, 18);
    g.appendChild(title);

    const meta = document.createElementNS(ns, 'text');
    meta.setAttribute('class', 'meta');
    meta.setAttribute('x', p.x + 38); meta.setAttribute('y', p.y + BH / 2 + 13);
    const stepCount = (j.steps && j.steps.length) || 0;
    meta.textContent = clip(j.runsOn || 'job', 14) + ' · ' + stepCount + (stepCount === 1 ? ' step' : ' steps');
    g.appendChild(meta);

    svg.appendChild(g);
  }
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'dag-wrap';
  wrap.appendChild(svg);
  container.appendChild(wrap);
}
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---- history -----------------------------------------------------------
async function viewHistory() {
  closeActiveEs();
  setActiveNav('nav-history');
  app.innerHTML =
    '<div class="page-head"><div class="eyebrow">Activity</div><h1>Run history</h1>' +
    '<p class="sub">Recent runs in this session — open one to replay its stream.</p></div>' +
    '<div class="grid" id="hist">' + skeletonRows(3) + '</div>';
  const ul = document.getElementById('hist');
  let runs;
  try { runs = await getJson('/api/runs'); }
  catch (e) { app.innerHTML = errorBlock(e.message); return; }
  if (!runs.length) {
    ul.outerHTML = emptyState('No runs yet', 'Trigger a workflow and its run will show up here.');
    return;
  }
  ul.innerHTML = '';
  for (const r of runs) {
    const btn = document.createElement('button');
    btn.className = 'tile';
    const when = new Date(r.startedAt).toLocaleTimeString();
    btn.innerHTML =
      '<span class="icon" style="background:none;box-shadow:none;color:var(--' + statusVar(r.status) + ')">' +
        '<span class="glyph ' + esc(r.status) + '" style="font-size:22px">' + (GLYPH[r.status] || '?') + '</span></span>' +
      '<span class="body"><span class="t">' + esc(r.name) + '</span>' +
      '<span class="m">' + esc(r.status) + ' · ' + esc(when) +
        (r.trigger ? ' · ' + esc(r.trigger) : '') + '</span></span>' +
      '<span class="chev">' + ICON.chevron + '</span>';
    btn.onclick = () => viewRun(r.id);
    ul.appendChild(btn);
  }
}
function statusVar(s) {
  return s === 'success' ? 'ok' : s === 'failure' ? 'fail' : s === 'skipped' ? 'skip' : s === 'running' ? 'run' : 'pend';
}

// ---- shared view fragments ---------------------------------------------
function emptyState(title, html) {
  return '<div class="empty">' +
    '<div class="glyph-lg"><svg width="44" height="44" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="emptyG" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#646cff"/><stop offset="1" stop-color="#9499ff"/></linearGradient></defs>' +
      '<line x1="30" y1="60" x2="60" y2="30" stroke="url(#emptyG)" stroke-width="8" stroke-linecap="round" opacity="0.5"/>' +
      '<line x1="30" y1="60" x2="60" y2="90" stroke="url(#emptyG)" stroke-width="8" stroke-linecap="round" opacity="0.5"/>' +
      '<line x1="60" y1="30" x2="90" y2="60" stroke="url(#emptyG)" stroke-width="8" stroke-linecap="round" opacity="0.5"/>' +
      '<line x1="60" y1="90" x2="90" y2="60" stroke="url(#emptyG)" stroke-width="8" stroke-linecap="round" opacity="0.5"/>' +
      '<circle cx="30" cy="60" r="13" fill="url(#emptyG)"/><circle cx="60" cy="30" r="13" fill="url(#emptyG)"/>' +
      '<circle cx="60" cy="90" r="13" fill="url(#emptyG)"/><circle cx="90" cy="60" r="13" fill="url(#emptyG)"/></svg></div>' +
    '<h3>' + esc(title) + '</h3><p>' + html + '</p></div>';
}
function skeletonRows(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '<div class="skeleton sk-row"></div>';
  return s;
}
function errorBlock(msg) {
  return '<div class="page-head"><h1>Something went wrong</h1></div>' +
    '<p class="err boxed">' + esc(msg) + '</p>';
}

// ---- nav ---------------------------------------------------------------
function bindNav(id, fn) {
  document.getElementById(id).addEventListener('click', (e) => { e.preventDefault(); fn(); });
}
bindNav('nav-home', viewWorkflows);
bindNav('nav-workflows', viewWorkflows);
bindNav('nav-webhooks', viewWebhooks);
bindNav('nav-history', viewHistory);
viewWorkflows();
</script>
</body>
</html>
`;
}
