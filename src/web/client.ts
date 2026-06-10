/**
 * The served frontend for `work --web` — a single self-contained HTML document
 * (inline CSS + inline ES-module JS, no external assets, no network dependencies,
 * no build step) returned by `renderShell(token)` and handed straight to the
 * running server.
 *
 * Design register: a precise, trustworthy, unfussy systems tool — not a SaaS
 * dashboard. State is the message: a run's status is the loudest thing on its
 * surface, success stays calm, and failure (the thing a developer must act on) is
 * where contrast, weight, and the single attention cue are spent. Identity is
 * carried by typography and ONE solid technical accent (steel azure, OKLCH), never
 * by gradients, glow, or decoration.
 *
 * Server contract preserved verbatim: the same endpoint calls, the same SSE
 * `addEventListener` frame handling, the same `<g class="job" data-job="…">` +
 * `data-status` DAG mechanism the live updates rely on, the same input-form mapping
 * rules (options→select, boolean→checkbox, number→valueAsNumber, present-only),
 * re-run, history, and the `<meta name="work-token">` → `X-Work-Token` handshake.
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
<meta name="theme-color" content="#16243a" />
<title>work — local console</title>
<style>
/* ========================================================================
   DESIGN TOKENS
   Identity: ONE solid technical accent (steel azure, OKLCH hue ~245). No
   gradient, no glow, no decorative color. Neutrals tinted toward the accent
   hue. Two themes via prefers-color-scheme; everything references these custom
   properties so the system lives in one block. Status colors clear AA (≥4.5:1)
   as text and are ALWAYS paired with a glyph + word, never color alone.
   ======================================================================== */
:root {
  /* ---- Accent: one solid technical hue ---- */
  --accent:        oklch(0.55 0.12 245);          /* links, focus, active, run */
  --accent-strong: oklch(0.48 0.13 245);          /* hover / pressed */
  --on-accent:     oklch(0.99 0 0);               /* text on the accent fill */
  --ring:          oklch(0.55 0.12 245 / 0.55);   /* focus ring */

  /* ---- Neutrals: tinted toward accent hue (245), AA-verified ---- */
  --bg:            oklch(0.98 0.004 245);
  --surface:       oklch(1.00 0 0);
  --surface-2:     oklch(0.985 0.004 245);
  --surface-inset: oklch(0.96 0.006 245);
  --border:        oklch(0.92 0.006 245);
  --border-strong: oklch(0.86 0.010 245);
  --fg:            oklch(0.25 0.015 245);          /* primary text ~16:1 */
  --fg-soft:       oklch(0.42 0.015 245);          /* secondary ~8:1 */
  --muted:         oklch(0.48 0.015 245);          /* meta/placeholder ≥4.5:1 on insets */
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
  --shadow-md: 0 4px 12px oklch(0.25 0.01 245 / 0.10);

  /* ---- Type: 2 families, ~1.2 ratio rem scale, body ≥15px, 4 weights ---- */
  --font-ui:   system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --text-xs:   0.75rem;    /* 12px  caption / meta            */
  --text-sm:   0.875rem;   /* 14px  secondary UI              */
  --text-base: 0.9375rem;  /* 15px  body (min)                */
  --text-lg:   1.125rem;   /* 18px  subheading / tile title   */
  --text-xl:   1.5rem;     /* 24px  section heading           */
  --text-2xl:  1.875rem;   /* 30px  page h1                   */

  --weight-regular: 400;
  --weight-medium:  500;
  --weight-semi:    600;
  --weight-bold:    700;

  --leading-tight: 1.2;
  --leading-body:  1.55;
  --tracking-caps: 0.06em;

  /* ---- Spacing: 4pt scale ---- */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

  /* ---- Radius ---- */
  --radius: 12px;
  --radius-sm: 10px;
  --radius-xs: 8px;

  /* ---- z-index scale ---- */
  --z-sticky: 100; --z-dropdown: 200; --z-modal: 300; --z-toast: 400; --z-tooltip: 500;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent:        oklch(0.70 0.13 245);
    --accent-strong: oklch(0.76 0.13 245);
    --on-accent:     oklch(0.16 0.02 260);
    --ring:          oklch(0.70 0.13 245 / 0.60);

    --bg:            oklch(0.16 0.015 260);
    --surface:       oklch(0.20 0.018 260);
    --surface-2:     oklch(0.22 0.018 260);
    --surface-inset: oklch(0.15 0.015 260);
    --border:        oklch(0.30 0.02 260);
    --border-strong: oklch(0.37 0.02 260);
    --fg:            oklch(0.95 0.01 245);
    --fg-soft:       oklch(0.82 0.02 245);
    --muted:         oklch(0.66 0.02 260);
    --code-bg:       oklch(0.13 0.012 260);
    --code-fg:       oklch(0.93 0.008 245);

    --ok:   oklch(0.78 0.15 150);
    --fail: oklch(0.72 0.18 25);
    --skip: oklch(0.78 0.13 75);
    --run:  oklch(0.72 0.13 245);
    --pend: oklch(0.62 0.02 260);

    --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.4);
    --shadow-md: 0 6px 18px oklch(0 0 0 / 0.5);
  }
}

/* ========================================================================
   BASE
   ======================================================================== */
* { box-sizing: border-box; }
html { font-size: 100%; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-body);
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent); }
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}
@media (forced-colors: active) {
  :focus-visible { outline-color: Highlight; }
}

/* Screen-reader-only utility: skip link, live region, "(required)" text. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
/* Skip link reveals itself when focused. */
a.skip {
  position: fixed; top: var(--space-2); left: var(--space-2); z-index: var(--z-toast);
  background: var(--surface); color: var(--accent);
  border: 1px solid var(--border-strong); border-radius: var(--radius-xs);
  padding: var(--space-2) var(--space-3); font-weight: var(--weight-semi);
  text-decoration: none; transform: translateY(-150%); transition: transform .12s;
}
a.skip:focus { transform: translateY(0); }

/* ========================================================================
   HEADER
   ======================================================================== */
header.app {
  position: sticky; top: 0; z-index: var(--z-sticky);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
header.app .bar {
  max-width: 1120px; margin: 0 auto;
  padding: var(--space-3) var(--space-5);
  display: flex; align-items: center; gap: var(--space-4);
}
.brand { display: flex; align-items: center; gap: var(--space-3); text-decoration: none; color: inherit; }
.brand .mark { width: 30px; height: 30px; display: block; flex: none; color: var(--accent); }
.brand .name { display: flex; flex-direction: column; line-height: 1.1; }
.brand .name b { font-size: var(--text-base); font-weight: var(--weight-bold); letter-spacing: -0.01em; }
.brand .name small { font-size: var(--text-xs); color: var(--muted); font-weight: var(--weight-medium); }

nav.app { display: flex; gap: var(--space-1); margin-left: var(--space-2); }
nav.app a {
  appearance: none; border: 0; background: transparent;
  color: var(--muted); font: inherit; font-weight: var(--weight-semi); font-size: var(--text-sm);
  padding: var(--space-2) var(--space-3); border-radius: 999px; cursor: pointer;
  text-decoration: none; transition: background .15s, color .15s;
}
nav.app a:hover { color: var(--fg); background: var(--surface-inset); }
nav.app a.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.spacer { flex: 1; }
.env-pill {
  font-family: var(--font-mono); font-size: var(--text-xs); color: var(--muted);
  font-variant-numeric: tabular-nums;
  padding: var(--space-1) var(--space-3); border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2);
}

/* ========================================================================
   LAYOUT
   ======================================================================== */
main { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-5) var(--space-8); }
.page-head { margin: 0 0 var(--space-5); }
.page-head h1 {
  margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-bold);
  letter-spacing: -0.02em; line-height: var(--leading-tight); text-wrap: balance;
}
.page-head h1:focus-visible { outline-offset: 4px; }
.page-head .sub { margin: var(--space-2) 0 0; color: var(--muted); font-size: var(--text-sm); max-width: 70ch; text-wrap: pretty; }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.grow { flex: 1; }

/* ========================================================================
   CARDS / SURFACES
   ======================================================================== */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius);
}
.card.pad { padding: var(--space-5); }
.card + .card { margin-top: var(--space-4); }
.stack-4 { margin-top: var(--space-4); }
h2.section-title {
  font-size: var(--text-xs); font-weight: var(--weight-bold); letter-spacing: var(--tracking-caps);
  text-transform: uppercase; color: var(--muted); margin: 0 0 var(--space-3);
}

/* Workflow catalog as a single-column list of interactive rows. */
.list { display: flex; flex-direction: column; gap: var(--space-1); }
.tile {
  display: flex; align-items: center; gap: var(--space-3);
  text-align: left; width: 100%;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4); cursor: pointer; font: inherit; color: inherit;
  transition: border-color .15s ease, background .12s ease;
}
.tile:hover { border-color: var(--border-strong); background: var(--surface-2); }
.tile .icon {
  width: 32px; height: 32px; flex: none; border-radius: var(--radius-xs);
  display: grid; place-items: center; color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.tile .icon svg { width: 18px; height: 18px; }
.tile .body { min-width: 0; flex: 1; }
.tile .body .t { display: block; font-weight: var(--weight-semi); font-size: var(--text-base); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile .body .m { display: block; color: var(--muted); font-size: var(--text-xs); margin-top: 2px; }
.tile .chev { color: var(--muted); flex: none; transition: transform .12s, color .12s; }
.tile:hover .chev { transform: translateX(2px); color: var(--accent); }

/* History as a dense status-rail list: leading status pill, name, right meta. */
.hist-summary { color: var(--muted); font-size: var(--text-sm); margin: 0 0 var(--space-3); font-variant-numeric: tabular-nums; }
.hist-list { display: flex; flex-direction: column; }
.hrow {
  display: flex; align-items: center; gap: var(--space-3);
  width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer;
  background: transparent; border: 0; border-top: 1px solid var(--border);
  padding: var(--space-3) var(--space-2);
  transition: background .12s ease;
}
.hrow:first-child { border-top: 0; }
.hrow:hover { background: var(--surface-2); }
.hrow[data-status=failure] { background: color-mix(in srgb, var(--fail) 6%, transparent); }
.hrow[data-status=failure]:hover { background: color-mix(in srgb, var(--fail) 11%, transparent); }
.hrow .hbody { min-width: 0; flex: 1; }
.hrow .hbody .t { display: block; font-weight: var(--weight-semi); font-size: var(--text-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hrow .hbody .m { display: block; color: var(--muted); font-size: var(--text-xs); margin-top: 1px; font-variant-numeric: tabular-nums; }
.hrow .chev { color: var(--muted); flex: none; transition: transform .12s, color .12s; }
.hrow:hover .chev { transform: translateX(2px); color: var(--accent); }

/* ========================================================================
   STATUS ATOM — the one status badge, reused for run/job/step/delivery state.
   Shape, size, and color map all keyed by data-status. Glyph is rendered as a
   .st-glyph span (set in JS), label as text, so status is never color-alone.
   ======================================================================== */
.st {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) var(--space-3); border-radius: 999px;
  font-size: var(--text-xs); font-weight: var(--weight-semi); line-height: 1.2;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg-soft);
  white-space: nowrap;
}
.st .st-glyph { font-size: var(--text-sm); line-height: 1; }
.st.mono { font-family: var(--font-mono); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.st[data-status=running] { color: var(--run); border-color: color-mix(in srgb, var(--run) 45%, var(--border)); background: color-mix(in srgb, var(--run) 10%, transparent); }
.st[data-status=success] { color: var(--ok);  border-color: color-mix(in srgb, var(--ok) 45%, var(--border));  background: color-mix(in srgb, var(--ok) 10%, transparent); }
.st[data-status=failure] { color: var(--fail);border-color: color-mix(in srgb, var(--fail) 50%, var(--border));background: color-mix(in srgb, var(--fail) 12%, transparent); }
.st[data-status=skipped] { color: var(--skip);border-color: color-mix(in srgb, var(--skip) 45%, var(--border));background: color-mix(in srgb, var(--skip) 11%, transparent); }
.st[data-status=pending] { color: var(--pend);}
.st[data-status=running] .st-glyph { display: inline-block; animation: glyphSpin 1.4s linear infinite; }

/* ========================================================================
   EMPTY / LOADING STATES
   ======================================================================== */
.empty {
  text-align: center; padding: var(--space-7) var(--space-5); color: var(--muted);
  border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--surface-2);
}
.empty .glyph-lg { color: var(--border-strong); margin-bottom: var(--space-3); }
.empty h2 { margin: 0 0 var(--space-1); color: var(--fg-soft); font-size: var(--text-lg); font-weight: var(--weight-bold); }
.empty p { margin: 0 auto; font-size: var(--text-sm); max-width: 60ch; }
.skeleton { position: relative; overflow: hidden; background: var(--surface-inset); border-radius: var(--radius-sm); }
.skeleton::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 7%, transparent), transparent);
  transform: translateX(-100%); animation: shimmer 1.3s infinite;
}
@keyframes shimmer { 100% { transform: translateX(100%); } }
.sk-row { height: 56px; margin-bottom: var(--space-3); }

/* ========================================================================
   FORM
   ======================================================================== */
form { max-width: 560px; }
form .field { margin-bottom: var(--space-4); }
form .field:last-of-type { margin-bottom: var(--space-1); }
label.field-label { display: block; font-weight: var(--weight-semi); font-size: var(--text-sm); margin-bottom: var(--space-2); color: var(--fg-soft); }
label.field-label .req { color: var(--fail); margin-left: 2px; }
.check-label { font-weight: var(--weight-semi); font-size: var(--text-sm); color: var(--fg-soft); }
input[type=text], input[type=number], select {
  width: 100%; padding: var(--space-2) var(--space-3); font: inherit; color: var(--fg);
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs); transition: border-color .12s;
}
input[type=text]:focus-visible, input[type=number]:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent);
}
input[aria-invalid=true] { border-color: var(--fail); }
.check { display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.check input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
.helper { color: var(--muted); font-size: var(--text-xs); margin-top: var(--space-2); max-width: 65ch; }

/* ========================================================================
   BUTTONS — solid accent primary (no gradient, no glow), hairline ghost.
   ======================================================================== */
button {
  appearance: none; font: inherit; font-weight: var(--weight-semi); cursor: pointer;
  border-radius: var(--radius-xs); padding: var(--space-2) var(--space-4); border: 1px solid transparent;
  transition: background .15s, border-color .15s, opacity .15s, transform .1s;
}
button:active { transform: translateY(1px); }
button:disabled { opacity: .55; cursor: default; transform: none; }
button.primary {
  color: var(--on-accent); background: var(--accent); border-color: var(--accent);
}
button.primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
button.ghost {
  background: var(--surface); color: var(--fg-soft); border-color: var(--border-strong);
  padding: var(--space-2) var(--space-3); font-size: var(--text-sm);
}
button.ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

/* ========================================================================
   RUN HEADER — state is the message: status word is the hero.
   ======================================================================== */
.run-head { display: flex; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; margin: 0 0 var(--space-5); }
.run-head .grow { min-width: 0; }
h1.run-state {
  margin: 0; display: flex; align-items: center; gap: var(--space-3);
  font-size: var(--text-2xl); font-weight: var(--weight-bold);
  letter-spacing: -0.02em; line-height: var(--leading-tight);
  color: var(--fg-soft);
}
h1.run-state:focus-visible { outline-offset: 4px; }
h1.run-state .st-glyph { font-size: 1.6rem; line-height: 1; display: inline-block; }
h1.run-state .st-glyph.just-settled { animation: settle .22s cubic-bezier(0.16,1,0.3,1); }
/* Success stays calm; running is steady; failure is the loud one. */
h1.run-state[data-status=running] { color: var(--run); }
h1.run-state[data-status=running] .st-glyph { display: inline-block; animation: glyphSpin 1.4s linear infinite; }
h1.run-state[data-status=success] { color: var(--ok); }
h1.run-state[data-status=failure] { color: var(--fail); }
h1.run-state[data-status=skipped] { color: var(--skip); }
.run-sub { margin: var(--space-2) 0 0; color: var(--muted); font-size: var(--text-sm); display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: baseline; }
.run-sub .wf-name { color: var(--fg-soft); font-weight: var(--weight-semi); }
.run-sub .run-id { font-family: var(--font-mono); }
.run-sub .dot-sep { color: var(--border-strong); }
.run-sub .elapsed { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.run-sub[data-status=failure] .elapsed { color: var(--fail); }
.run-sub[data-status=success] .elapsed { color: var(--ok); }

/* Run layout: the graph is stacked OVER the step logs, both full-width, so the
   DAG reads at full size and the page scrolls as one column. */
.run-grid { display: grid; gap: var(--space-4); }

/* ========================================================================
   WEBHOOKS — hook cards + endpoint URL + hairline-divided deliveries list
   ======================================================================== */
.hooks { display: flex; flex-direction: column; gap: var(--space-4); }
.hook-head { display: flex; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.hook-title { min-width: 0; flex: 1; }
.hook-title .hname {
  font-size: var(--text-lg); font-weight: var(--weight-semi); letter-spacing: -0.01em;
  font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hook-title .hmeta { color: var(--muted); font-size: var(--text-xs); margin-top: 2px; }
.hook-title .hmeta a { font-weight: var(--weight-semi); text-decoration: none; }
.hook-title .hmeta a:hover { text-decoration: underline; }
.hook-badges { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }

/* Compact pill for NON-status metadata only (auth scheme, datasource names). */
.tag {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: 3px var(--space-3); border-radius: 999px; font-size: var(--text-xs); font-weight: var(--weight-semi);
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg-soft);
  white-space: nowrap;
}
.tag.mono { font-family: var(--font-mono); font-weight: var(--weight-semi); }

/* Endpoint URL row — monospace field + copy + send-test. */
.endpoint { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-4); flex-wrap: wrap; }
.endpoint .url {
  flex: 1; min-width: 220px;
  font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-soft);
  background: var(--surface-inset); border: 1px solid var(--border);
  border-radius: var(--radius-xs); padding: var(--space-2) var(--space-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.hook-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

/* Deliveries — a hairline-divided list (no nested cards). */
.deliveries { margin-top: var(--space-4); border-top: 1px solid var(--border); padding-top: var(--space-4); }
.deliveries .section-title { margin-bottom: var(--space-3); }
.del-list { display: flex; flex-direction: column; }
.del-row {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) var(--space-2); font-size: var(--text-xs);
  border-top: 1px solid var(--border);
}
.del-row:first-child { border-top: 0; }
.del-row .del-result { flex: none; }
.del-row .del-status { font-family: var(--font-mono); color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
.del-row .del-when { color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.del-row .del-ip { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
.del-row .del-run { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--accent); flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.del-row.clickable { cursor: pointer; transition: background .12s; border-radius: var(--radius-xs); }
.del-row.clickable:hover { background: var(--surface-2); }
.del-row[data-bad=true] { background: color-mix(in srgb, var(--fail) 6%, transparent); }
.del-row[data-bad=true].clickable:hover { background: color-mix(in srgb, var(--fail) 11%, transparent); }
.del-empty { color: var(--muted); font-size: var(--text-sm); padding: var(--space-3) 2px; }

/* Result badge inside a delivery row (severity by class). */
.rbadge {
  display: inline-flex; align-items: center;
  padding: 2px var(--space-2); border-radius: 999px; font-size: 0.6875rem; font-weight: var(--weight-semi);
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg-soft);
}
.rbadge.r-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.rbadge.r-muted { color: var(--muted); }
.rbadge.r-warn { color: var(--skip); border-color: color-mix(in srgb, var(--skip) 45%, var(--border)); background: color-mix(in srgb, var(--skip) 11%, transparent); }
.rbadge.r-bad { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 50%, var(--border)); background: color-mix(in srgb, var(--fail) 12%, transparent); font-weight: var(--weight-bold); }

.err {
  color: var(--fail); white-space: pre-wrap; margin: var(--space-3) 0 0; font-size: var(--text-sm);
  font-family: var(--font-mono);
}
.err:empty { display: none; }
.err.boxed:not(:empty) {
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--fail) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--fail) 40%, var(--border));
}

/* ========================================================================
   DAG — faithful layered graph; status by glyph + color; fits its container.
   ======================================================================== */
.dag-wrap {
  /* Hug the graph: a small (1-2 job) graph gets a small box, not a full-width
     frame around mostly-empty space. Caps at the card width; a wider graph's
     svg shrinks to fit (svg.dag max-width:100%). */
  width: fit-content; max-width: 100%;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-2);
  overflow-x: auto; padding: var(--space-2);
}
svg.dag { display: block; max-width: 100%; height: auto; }
svg.dag path.edge {
  stroke: var(--border-strong); stroke-width: 2; fill: none; stroke-linecap: round;
  transition: stroke .25s;
}
svg.dag path.edge.lit {
  stroke: var(--accent); stroke-width: 2.5;
  stroke-dasharray: 7 7;
  animation: edgeFlow .55s linear 1 forwards;
}
@keyframes edgeFlow { from { stroke-dashoffset: 14; } to { stroke-dashoffset: 0; } }
svg.dag g.job .node {
  fill: var(--surface); stroke: var(--pend); stroke-width: 1.75;
  transition: stroke .25s, fill .25s;
}
svg.dag g.job .title { fill: var(--fg); font: var(--weight-semi) 13px var(--font-ui); }
svg.dag g.job .meta { fill: var(--muted); font: var(--weight-medium) 10.5px var(--font-mono); }
svg.dag g.job .badge { fill: var(--pend); font: var(--weight-bold) 13px var(--font-ui); transition: fill .25s; }

/* Live status — the SAME data-status contract the runtime drives. Calm states
   change stroke only; failure is the loud one (tinted fill + heavier stroke). */
svg.dag g.job[data-status=running] .node { stroke: var(--run); }
svg.dag g.job[data-status=running] .badge { fill: var(--run); animation: nodePulse 1.6s ease-in-out infinite; }
svg.dag g.job[data-status=running] .title { fill: var(--accent); }
svg.dag g.job[data-status=success] .node { stroke: var(--ok); }
svg.dag g.job[data-status=success] .badge { fill: var(--ok); }
svg.dag g.job[data-status=failure] .node { stroke: var(--fail); stroke-width: 2.5; fill: color-mix(in srgb, var(--fail) 12%, var(--surface)); }
svg.dag g.job[data-status=failure] .badge { fill: var(--fail); }
svg.dag g.job[data-status=skipped] .node { stroke: var(--skip); stroke-dasharray: 5 4; }
svg.dag g.job[data-status=skipped] .badge { fill: var(--skip); }
svg.dag g.job[data-status=skipped] .title, svg.dag g.job[data-status=skipped] .meta { opacity: .65; }
@keyframes nodePulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

/* ========================================================================
   LOGS — collapsible per-step groups, monospace bodies
   ======================================================================== */
.logs { margin-top: var(--space-1); }
.logs .empty-logs { color: var(--muted); font-size: var(--text-sm); padding: var(--space-4) 2px; }
details.step {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  margin-bottom: var(--space-2); background: var(--surface);
  animation: stepIn .26s cubic-bezier(0.16,1,0.3,1);
}
/* A failed step is the loud one: tinted summary + heavier border. */
details.step[data-status=failure] { border-color: color-mix(in srgb, var(--fail) 50%, var(--border)); }
details.step[data-status=failure] > summary { background: color-mix(in srgb, var(--fail) 7%, transparent); }
@keyframes stepIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
details.step > summary {
  list-style: none; cursor: pointer; padding: var(--space-3) var(--space-4);
  display: flex; align-items: center; gap: var(--space-3); font-size: var(--text-sm); font-weight: var(--weight-medium);
  user-select: none; border-radius: var(--radius-sm);
}
details.step[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
details.step > summary::-webkit-details-marker { display: none; }
details.step > summary:hover { background: var(--surface-inset); }
details.step > summary .glyph { flex: none; font-size: var(--text-base); line-height: 1; width: 16px; text-align: center; }
details.step > summary .glyph.running { display: inline-block; animation: glyphSpin 1.4s linear infinite; }
details.step > summary .glyph.just-settled { animation: settle .22s cubic-bezier(0.16,1,0.3,1); }
@keyframes glyphSpin { to { transform: rotate(360deg); } }
@keyframes settle { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
details.step > summary .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.step > summary .label .job-id { color: var(--muted); }
details.step > summary .label .sep { color: var(--muted); margin: 0 5px; }
details.step > summary .meta {
  flex: none; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--muted);
  display: flex; gap: var(--space-3); align-items: center; font-variant-numeric: tabular-nums;
}
details.step > summary .meta .meta-fail { color: var(--fail); font-weight: var(--weight-bold); }
details.step > summary .caret { flex: none; color: var(--muted); transition: transform .15s; }
details.step[open] > summary .caret { transform: rotate(90deg); }
details.step pre {
  margin: 0; padding: var(--space-3) var(--space-4); overflow-x: auto;
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5;
  background: var(--code-bg); color: var(--code-fg);
  border-top: 1px solid var(--border);
  border-bottom-left-radius: var(--radius-sm); border-bottom-right-radius: var(--radius-sm);
  max-height: 460px; overflow-y: auto;
}
pre .stderr { color: #ff8d8d; }

/* ANSI SGR -> classes (see ansiToHtml). Colors tuned for the dark log surface;
   the two dark/dim slots lifted to clear AA on --code-bg. */
.a-bold { font-weight: 700; }
.fg-30 { color: #8a91a3; } .fg-31 { color: #ff6b6b; } .fg-32 { color: #5be37e; }
.fg-33 { color: #f4c95b; } .fg-34 { color: #7c83ff; } .fg-35 { color: #d08bff; }
.fg-36 { color: #4fd3d8; } .fg-37 { color: #d7dbe6; }
.fg-90 { color: #9aa1b3; } .fg-91 { color: #ff8d8d; } .fg-92 { color: #87f0a3; }
.fg-93 { color: #ffdb87; } .fg-94 { color: #9aa0ff; } .fg-95 { color: #e0a8ff; }
.fg-96 { color: #82e6ea; } .fg-97 { color: #ffffff; }

/* glyph colors (history rows + step summaries) */
.glyph.success { color: var(--ok); } .glyph.failure { color: var(--fail); }
.glyph.skipped { color: var(--skip); } .glyph.running { color: var(--run); } .glyph.pending { color: var(--pend); }

/* ========================================================================
   REDUCED MOTION — required. Kill looping motion but keep state legible.
   ======================================================================== */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  /* Running state must still READ as running without looping motion. */
  .st[data-status=running] .st-glyph,
  h1.run-state[data-status=running] .st-glyph,
  details.step > summary .glyph.running { animation: none; }
  svg.dag g.job[data-status=running] .badge { opacity: 1; animation: none; }
  svg.dag path.edge.lit { stroke-dasharray: none; }
  .skeleton::after { display: none; }
}

/* ========================================================================
   RESPONSIVE — intermediate (~960px) tightening + phone layout (≤640px).
   ======================================================================== */
@media (max-width: 960px) {
  main { padding: var(--space-5) var(--space-4) var(--space-7); }
}
@media (max-width: 640px) {
  /* Header: brand on row 1; nav wraps to a full-width segmented tab row. */
  header.app .bar { padding: var(--space-2) var(--space-3); gap: var(--space-2) var(--space-3); flex-wrap: wrap; }
  .spacer, .env-pill { display: none; }
  nav.app { order: 3; width: 100%; margin-left: 0; gap: var(--space-2); }
  nav.app a { flex: 1; min-width: 0; text-align: center; padding: var(--space-2) var(--space-2); font-size: var(--text-sm); min-height: 44px; display: flex; align-items: center; justify-content: center; }

  /* Layout: tighter gutters + type. */
  main { padding: var(--space-5) var(--space-3) var(--space-7); }
  .page-head { margin-bottom: var(--space-4); }
  .page-head h1 { font-size: var(--text-xl); }
  h1.run-state { font-size: var(--text-xl); }
  .card.pad { padding: var(--space-4) var(--space-3); }
  button.ghost { min-height: 44px; }

  /* Webhooks: URL takes a full row, Copy/Send-test split the row below it. */
  .hook-title .hname { font-size: var(--text-base); }
  .endpoint .url { flex-basis: 100%; min-width: 0; }
  .hook-actions { width: 100%; }
  .hook-actions button { flex: 1; }
  .del-row .del-ip { display: none; }

  /* Logs: a touch denser; the DAG scrolls horizontally with momentum. */
  details.step pre { font-size: var(--text-xs); max-height: 360px; }
  .dag-wrap { -webkit-overflow-scrolling: touch; }
}
</style>
</head>
<body>
<a class="skip" href="#app">Skip to main content</a>
<header class="app">
  <div class="bar">
    <a class="brand" id="nav-home" href="#" aria-label="work home">
      <!-- Inline brand mark — the DAG-of-four-nodes logo, one solid accent, no fetch -->
      <svg class="mark" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="30" y1="60" x2="60" y2="30" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
        <line x1="30" y1="60" x2="60" y2="90" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
        <line x1="60" y1="30" x2="90" y2="60" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
        <line x1="60" y1="90" x2="90" y2="60" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
        <circle cx="30" cy="60" r="13" fill="currentColor"/>
        <circle cx="60" cy="30" r="13" fill="currentColor"/>
        <circle cx="60" cy="90" r="13" fill="currentColor"/>
        <circle cx="90" cy="60" r="13" fill="currentColor"/>
      </svg>
      <span class="name"><b>work</b><small>local console</small></span>
    </a>
    <nav class="app" aria-label="Primary">
      <a id="nav-workflows" href="#">Workflows</a>
      <a id="nav-webhooks" href="#">Webhooks</a>
      <a id="nav-history" href="#">History</a>
    </nav>
    <span class="spacer"></span>
    <span class="env-pill" aria-label="Bound host 127.0.0.1" title="Bound host">127.0.0.1</span>
  </div>
</header>
<main id="app"></main>
<div id="route-live" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>

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
const routeLive = document.getElementById('route-live');

// The one EventSource for the run currently on screen. Closed (and replaced)
// whenever we open another run or navigate away, so a past-run replay or a stale
// live tail can't keep streaming into a view the user already left.
let activeEs = null;
function closeActiveEs() { if (activeEs) { activeEs.close(); activeEs = null; } }

// ---- helpers -----------------------------------------------------------
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const GLYPH = { success:'✓', failure:'✗', skipped:'⊘', running:'◌', pending:'○' };
// Human label for a status — paired with the glyph so state is never color-alone.
const STATUS_LABEL = { success:'Succeeded', failure:'Failed', skipped:'Skipped', running:'Running', pending:'Pending' };

// The one status atom, reused for run/job/step/delivery state. Returns SAFE HTML:
// a pill carrying glyph + word, colored + shaped by data-status. The label arg
// overrides the default word (e.g. raw step status); extra adds classes.
function statusPill(status, label, extra) {
  const cls = 'st' + (extra ? ' ' + extra : '');
  const word = label !== undefined ? label : (STATUS_LABEL[status] || status);
  return '<span class="' + cls + '" data-status="' + esc(status) + '">' +
    '<span class="st-glyph" aria-hidden="true">' + (GLYPH[status] || '•') + '</span>' +
    '<span class="st-label">' + esc(word) + '</span></span>';
}

// Mount a freshly-built view: move focus to its <h1> so keyboard/AT users land in
// the new content on every SPA route swap, and announce the route name politely.
function mount(routeName) {
  const h1 = app.querySelector('h1');
  if (h1) {
    h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: false });
  }
  if (routeName && routeLive) routeLive.textContent = routeName;
}

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

// Small inline icon set (no network). All decorative — marked aria-hidden so AT
// doesn't expose them as empty graphics.
const ICON = {
  workflow: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7 7l3.5 9M17 7l-3.5 9"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  webhook: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16.5a3 3 0 1 0 0 .01"/><path d="M9 7.5a3 3 0 1 0-2.6 4.5"/><path d="M9 12.5a3 3 0 1 0 2.6 4.5"/><path d="M12 7.5l3 5M9 17h6"/></svg>',
};

// ---- workflows list ----------------------------------------------------
async function viewWorkflows() {
  closeActiveEs();
  setActiveNav('nav-workflows');
  app.innerHTML =
    '<div class="page-head"><h1>Workflows</h1>' +
    '<p class="sub">Sandboxed workflows discovered in <code>.workflows/</code> — pick one to configure and run.</p></div>' +
    '<div class="list" id="wf">' + skeletonRows(3) + '</div>';
  mount('Workflows');
  const ul = document.getElementById('wf');
  let workflows;
  try { workflows = await getJson('/api/workflows'); }
  catch (e) { app.innerHTML = errorBlock(e.message); mount(); return; }
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
    '<div class="page-head"><h1>Webhooks</h1>' +
    '<p class="sub">Authenticated <code>POST /hooks/&lt;name&gt;</code> triggers — bound to the loopback ' +
    'interface by default, exposed externally via a tunnel. Each accepted delivery dispatches its ' +
    'mapped workflow.</p></div>' +
    '<div class="hooks" id="hooks">' + skeletonRows(2) + '</div>';
  mount('Webhooks');
  const list = document.getElementById('hooks');
  let hooks;
  try { hooks = await getJson('/api/webhooks'); }
  catch (e) { app.innerHTML = errorBlock(e.message); mount(); return; }
  if (!hooks.length) {
    list.outerHTML = emptyState(
      'No webhooks configured',
      'Add a <code>webhooks:</code> block to <code>work.json</code> mapping a hook ' +
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
  // Hook config state reuses the one status atom (glyph + word + color), so it's
  // never color-alone and reads consistently with run/delivery state elsewhere.
  const stateTag = !h.configured
    ? statusPill('failure', 'no secret')
    : h.enabled
      ? statusPill('success', 'enabled')
      : statusPill('skipped', 'disabled');
  const authTag = '<span class="tag mono">' + esc(h.auth || 'bearer') + '</span>';

  const dsChips = Array.isArray(h.datasources) && h.datasources.length
    ? '<div class="chips stack-4">' +
        h.datasources.map((d) => '<span class="tag mono">' + esc(d) + '</span>').join('') +
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
      '<h2 class="section-title">Recent deliveries</h2>' +
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
    const rc = resultClass(d.result);
    const row = document.createElement('div');
    row.className = 'del-row' + (d.runId ? ' clickable' : '');
    if (rc === 'r-bad') row.dataset.bad = 'true';
    const status = (d.httpStatus !== undefined && d.httpStatus !== null) ? String(d.httpStatus) : '—';
    row.innerHTML =
      '<span class="del-result"><span class="rbadge ' + rc + '">' + esc(d.result) + '</span></span>' +
      '<span class="del-status">' + esc(status) + '</span>' +
      '<span class="del-when">' + esc(fmtWhen(d.ts)) + '</span>' +
      (d.sourceIp ? '<span class="del-ip">' + esc(d.sourceIp) + '</span>' : '') +
      (d.runId ? '<span class="del-run">' + ICON.chevron + esc(String(d.runId).slice(0, 8)) + '</span>' : '');
    if (d.runId) {
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label',
        'Delivery ' + d.result + ', HTTP ' + status + ', ' + fmtWhen(d.ts) + ' — open run ' + String(d.runId).slice(0, 8));
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
    '<div class="page-head"><h1>' + esc(name) + '</h1>' +
    '<p class="sub">Provide inputs and dispatch a run. Each job executes in its own micro-VM.</p></div>' +
    '<div class="card pad"><h2 class="section-title">Inputs</h2><div id="formwrap"><div class="skeleton sk-row"></div></div></div>';
  mount('Run workflow: ' + name);
  let inputs;
  try { inputs = await getJson('/api/workflows/' + encodeURIComponent(name) + '/form'); }
  catch (e) { document.getElementById('formwrap').innerHTML = errorBlock(e.message); return; }

  const form = document.createElement('form');
  const fields = buildForm(inputs);
  if (!fields.childNodes.length) {
    const none = document.createElement('p');
    none.className = 'helper';
    none.textContent = 'This workflow takes no inputs.';
    form.appendChild(none);
  } else {
    form.appendChild(fields);
  }

  const actions = document.createElement('div');
  actions.className = 'row stack-4';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'primary';
  btn.textContent = 'Run workflow';
  actions.appendChild(btn);
  form.appendChild(actions);

  const errBox = document.createElement('p');
  errBox.className = 'err boxed';
  errBox.id = 'form-err';
  errBox.setAttribute('role', 'alert');
  form.appendChild(errBox);
  form.setAttribute('aria-describedby', 'form-err');

  const wrap = document.getElementById('formwrap');
  wrap.innerHTML = '';
  wrap.appendChild(form);

  // Clear a field's invalid state once the user edits it again.
  function clearInvalid(el) {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  }

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    errBox.textContent = '';
    let values;
    try { values = collectInputs(form, inputs); }
    catch (e) {
      errBox.textContent = e.message;
      // Move focus to the offending control and associate the error with it.
      const bad = e.field && form.querySelector('[data-input="' + cssEscape(e.field) + '"]');
      if (bad) {
        bad.setAttribute('aria-invalid', 'true');
        bad.setAttribute('aria-describedby', 'form-err');
        bad.addEventListener('input', () => clearInvalid(bad), { once: true });
        bad.focus();
      }
      return;
    }
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
      span.className = 'check-label';
      span.textContent = name;
      lab.appendChild(span);
      field.appendChild(lab);
    } else {
      const lab = document.createElement('label');
      lab.className = 'field-label';
      lab.htmlFor = ctrlId;
      // The required marker is decorative (aria-hidden); the requirement is spoken
      // via a visually-hidden "(required)" text equivalent, not by color alone.
      lab.innerHTML = esc(name) + (spec.required
        ? ' <span class="req" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>'
        : '');
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
      if (Number.isNaN(n)) { const err = new Error('input "' + name + '" must be a number'); err.field = name; throw err; }
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
  // State is the message: the status WORD is the h1 (colored + glyph), the
  // workflow name and run-id hash are demoted to a mono subtitle. The run begins
  // in the 'running' state; run-init carries the workflow name when present.
  app.innerHTML =
    '<div class="run-head">' +
      '<div class="grow">' +
        '<h1 class="run-state" id="run-state" data-status="running">' +
          '<span class="st-glyph" aria-hidden="true">' + GLYPH.running + '</span>' +
          '<span id="run-state-word">Running</span>' +
        '</h1>' +
        '<p class="run-sub" id="run-sub" data-status="running">' +
          '<span class="wf-name" id="run-wf"></span>' +
          '<span class="dot-sep" aria-hidden="true">·</span>' +
          '<span class="run-id">run ' + esc(runId.slice(0, 8)) + '</span>' +
          '<span class="dot-sep" aria-hidden="true">·</span>' +
          '<span class="elapsed" id="run-elapsed">0.0s</span>' +
        '</p>' +
      '</div>' +
      '<button class="ghost" id="rerun" title="Re-run with the same inputs">↻ Re-run</button>' +
    '</div>' +
    '<p class="err boxed" id="run-err"></p>' +
    '<div class="run-grid">' +
      '<div class="dag-pane">' +
        '<div class="card pad">' +
          '<h2 class="section-title">Graph</h2>' +
          '<div id="dag"></div>' +
        '</div>' +
      '</div>' +
      '<div class="logs-pane">' +
        '<div class="card pad">' +
          '<h2 class="section-title">Step logs</h2>' +
          '<div class="logs" id="logs"><div class="empty-logs">Waiting for the run to start…</div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="run-live" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>';
  mount('Run ' + runId.slice(0, 8));

  const dagEl = document.getElementById('dag');
  const logsEl = document.getElementById('logs');
  const stateEl = document.getElementById('run-state');
  const stateWord = document.getElementById('run-state-word');
  const subEl = document.getElementById('run-sub');
  const wfEl = document.getElementById('run-wf');
  const elapsedEl = document.getElementById('run-elapsed');
  const errEl = document.getElementById('run-err');
  const rerunBtn = document.getElementById('rerun');
  const runLive = document.getElementById('run-live');
  const started = Date.now();
  // 250ms is plenty for a human-readable elapsed clock and calmer than 100ms.
  const tick = setInterval(() => { elapsedEl.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's'; }, 250);

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
    det.dataset.status = 'running';
    // A freshly-started step opens (it's the active one); on success it collapses
    // to its summary, on failure it stays open and is scrolled to (step-end).
    det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML =
      '<span class="glyph running" aria-hidden="true">' + GLYPH.running + '</span>' +
      '<span class="label"><span class="job-id">' + esc(jobId) + '</span>' +
      '<span class="sep">›</span>' + esc(title || stepName) + '</span>' +
      '<span class="meta"></span>' +
      '<span class="caret">' + ICON.caret + '</span>';
    det.appendChild(sum);
    const body = document.createElement('pre');
    det.appendChild(body);
    logsEl.appendChild(det);
    rec = { body, summary: sum, metaEl: sum.querySelector('.meta'), details: det, key };
    stepBodies.set(key, rec);
    return rec;
  }

  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/events');
  activeEs = es;

  es.addEventListener('run-init', (e) => {
    const init = JSON.parse(e.data);
    drawDag(dagEl, init);
    // Carry the workflow name into the heading subtitle (recognition over recall).
    // The DAG already receives init.jobs; init.name/workflow is shown when present.
    const wfName = init.name || init.workflow;
    if (wfName) { wfEl.textContent = wfName; } else { wfEl.remove(); subEl.querySelector('.dot-sep').remove(); }
  });
  es.addEventListener('job-start', (e) => {
    const d = JSON.parse(e.data);
    setJobStatus(dagEl, d.jobId, 'running');
    if (runLive) runLive.textContent = 'Job ' + d.jobId + ' started';
  });
  es.addEventListener('step-start', (e) => { const d = JSON.parse(e.data); ensureStep(d.jobId, d.stepName, d.title, d.ts); });
  es.addEventListener('step-output', (e) => {
    const d = JSON.parse(e.data);
    const rec = ensureStep(d.jobId, d.stepName, d.title || d.stepName, d.ts);
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
    const rec = ensureStep(d.jobId, d.stepName, d.title || d.stepName, d.ts);
    const cls = d.status;
    rec.details.dataset.status = cls;
    const glyph = rec.summary.querySelector('.glyph');
    // Resolve the glyph with a one-shot settle (success quiet, failure noticed).
    glyph.className = 'glyph ' + cls + ' just-settled';
    glyph.textContent = GLYPH[cls] || '?';
    // duration (always useful) from ts delta; exit code only when non-zero (noise
    // on the calm path otherwise — exit 0 is the absence of information).
    let meta = '';
    const startTs = stepStart.get(rec.key);
    if (startTs !== undefined && d.ts !== undefined) {
      meta += '<span>' + ((d.ts - startTs) / 1000).toFixed(1) + 's</span>';
    }
    if (d.exitCode !== 0 && d.exitCode !== undefined && d.exitCode !== null) {
      meta += '<span class="meta-fail">exit ' + esc(d.exitCode) + '</span>';
    }
    rec.metaEl.innerHTML = meta;
    // Collapse succeeded/skipped steps to their summary; keep failures open and
    // bring the failed step into view (loud only on failure).
    if (cls === 'failure') {
      rec.details.open = true;
      rec.details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (runLive) runLive.textContent = 'Step ' + d.jobId + ' › ' + (d.title || d.stepName) + ' failed';
    } else if (cls === 'success' || cls === 'skipped') {
      rec.details.open = false;
    }
  });
  es.addEventListener('job-end', (e) => { const d = JSON.parse(e.data); setJobStatus(dagEl, d.jobId, d.status); });
  es.addEventListener('run-end', (e) => {
    const d = JSON.parse(e.data);
    setRunState(d.status);
    if (d.error) { errEl.textContent = d.error; }
    elapsedEl.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
    clearInterval(tick);
    closeActiveEs();
    if (runLive) runLive.textContent = 'Run ' + (STATUS_LABEL[d.status] || d.status) + (d.error ? ': ' + d.error : '');
  });
  // The replay path emits this for an unknown id (headers were already sent, so
  // the server can't send a JSON 404). Show it and stop — don't let EventSource
  // reconnect-loop on a run that will never exist.
  es.addEventListener('error', (e) => {
    if (e && e.data) {
      let msg;
      try { msg = JSON.parse(e.data).error || e.data; } catch { msg = e.data; }
      errEl.textContent = msg;
      if (runLive) runLive.textContent = 'Run error: ' + msg;
    }
    clearInterval(tick);
    closeActiveEs();
  });
  es.onerror = () => { /* keep retrying while the run is live; closed on run-end */ };

  // Flip the hero heading + subtitle to a terminal run status (success quiet,
  // failure loud — handled in CSS by the data-status on the h1/sub). Settle the
  // glyph once so the resolution is felt without a loop.
  function setRunState(status) {
    stateEl.dataset.status = status;
    subEl.dataset.status = status;
    stateWord.textContent = STATUS_LABEL[status] || status;
    const g = stateEl.querySelector('.st-glyph');
    g.textContent = GLYPH[status] || '•';
    g.classList.add('just-settled');
  }
}

function setJobStatus(dagEl, jobId, status) {
  const g = dagEl.querySelector('g.job[data-job="' + cssEscape(jobId) + '"]');
  if (g) {
    g.dataset.status = status;
    // Keep the node's accessible name + in-node status glyph in sync (status is
    // never color-alone, and the live change carries an accessible value).
    g.setAttribute('aria-label', jobId + ' — ' + (STATUS_LABEL[status] || status));
    const badge = g.querySelector('text.badge');
    if (badge) badge.textContent = GLYPH[status] || '•';
    // Light the incoming edges of this node for a flowing feel; a failed node's
    // edges read as failed, not lit, so the path doesn't lie about state.
    for (const p of dagEl.querySelectorAll('path.edge[data-to="' + cssEscape(jobId) + '"]')) {
      if (status === 'running' || status === 'success') p.classList.add('lit');
      else if (status === 'failure') p.classList.remove('lit');
    }
  }
}
function cssEscape(s) { return String(s).replace(/["\\\\]/g, '\\\\$&'); }

// ---- DAG — faithful layered graph. x = level (column), y = row-within-level.
// Status on each node is glyph + color (never color alone); the SVG scales to its
// container (viewBox kept, fixed pixel width/height dropped) and each node carries
// a <title> so a clipped id is still recoverable on hover / to assistive tech.
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
  // Render at the graph's INTRINSIC pixel size so nodes are a consistent size no
  // matter how many jobs there are. The width/height attrs set that natural size;
  // the viewBox + CSS (max-width:100%, height:auto) only ever scale the graph
  // DOWN to fit a narrow card — never up. (Without this a 1-node graph stretched
  // to fill the whole card, blowing the node up ~6x.)
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  svg.setAttribute('role', 'img');
  const jobCount = init.jobOrder.length;
  svg.setAttribute('aria-label', 'Workflow graph, ' + jobCount + (jobCount === 1 ? ' job' : ' jobs'));

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
  // Nodes — pill shape; label = job id + runs-on / step count; a leading glyph
  // badge that carries status (set in setJobStatus); a <title> with the full id.
  for (const id of init.jobOrder) {
    const p = pos[id];
    const j = jobs[id];
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'job');
    g.setAttribute('data-job', id);
    g.dataset.status = 'pending';
    g.setAttribute('role', 'img');
    g.setAttribute('aria-label', id + ' — Pending');

    const stepCount = (j.steps && j.steps.length) || 0;
    const runsOn = j.runsOn || 'job';
    // Full, untruncated id + runs-on + step count, recoverable on hover / via AT.
    const tip = document.createElementNS(ns, 'title');
    tip.textContent = id + ' · ' + runsOn + ' · ' + stepCount + (stepCount === 1 ? ' step' : ' steps');
    g.appendChild(tip);

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'node');
    rect.setAttribute('x', p.x); rect.setAttribute('y', p.y);
    rect.setAttribute('width', BW); rect.setAttribute('height', BH);
    rect.setAttribute('rx', BH / 2);
    g.appendChild(rect);

    // Status glyph badge (left) — non-color status cue inside the node.
    const badge = document.createElementNS(ns, 'text');
    badge.setAttribute('class', 'badge');
    badge.setAttribute('x', p.x + 22); badge.setAttribute('y', p.y + BH / 2);
    badge.setAttribute('text-anchor', 'middle');
    badge.setAttribute('dominant-baseline', 'central');
    badge.textContent = GLYPH.pending;
    g.appendChild(badge);

    const title = document.createElementNS(ns, 'text');
    title.setAttribute('class', 'title');
    title.setAttribute('x', p.x + 40); title.setAttribute('y', p.y + BH / 2 - 4);
    title.textContent = clip(id, 18);
    g.appendChild(title);

    const meta = document.createElementNS(ns, 'text');
    meta.setAttribute('class', 'meta');
    meta.setAttribute('x', p.x + 40); meta.setAttribute('y', p.y + BH / 2 + 13);
    meta.textContent = clip(runsOn, 14) + ' · ' + stepCount + (stepCount === 1 ? ' step' : ' steps');
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
    '<div class="page-head"><h1>Run history</h1>' +
    '<p class="sub">Recent runs in this session — open one to replay its stream.</p></div>' +
    '<div id="hist">' + skeletonRows(3) + '</div>';
  mount('Run history');
  const ul = document.getElementById('hist');
  let runs;
  try { runs = await getJson('/api/runs'); }
  catch (e) { app.innerHTML = errorBlock(e.message); mount(); return; }
  if (!runs.length) {
    ul.outerHTML = emptyState('No runs yet', 'Trigger a workflow and its run will show up here.');
    return;
  }
  // Triage header: total + failed count, so "what broke today" is answered before
  // scanning. Failed rows below also carry a faint red surface and lead the eye.
  const failed = runs.filter((r) => r.status === 'failure').length;
  const summary = runs.length + (runs.length === 1 ? ' run' : ' runs') +
    (failed ? ' · ' + failed + ' failed' : '');
  ul.outerHTML =
    '<p class="hist-summary">' + esc(summary) + '</p>' +
    '<div class="card"><div class="hist-list" id="hist-list"></div></div>';
  const list = document.getElementById('hist-list');
  for (const r of runs) {
    const btn = document.createElement('button');
    btn.className = 'hrow';
    btn.dataset.status = r.status;
    const when = new Date(r.startedAt).toLocaleTimeString();
    btn.innerHTML =
      statusPill(r.status) +
      '<span class="hbody"><span class="t">' + esc(r.name) + '</span>' +
      '<span class="m">' + esc(when) + (r.trigger ? ' · ' + esc(r.trigger) : '') + '</span></span>' +
      '<span class="chev">' + ICON.chevron + '</span>';
    btn.setAttribute('aria-label', r.name + ' — ' + (STATUS_LABEL[r.status] || r.status) + ', ' + when);
    btn.onclick = () => viewRun(r.id);
    list.appendChild(btn);
  }
}

// ---- shared view fragments ---------------------------------------------
function emptyState(title, html) {
  return '<div class="empty">' +
    '<div class="glyph-lg"><svg width="40" height="40" viewBox="0 0 120 120" fill="none" stroke="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<line x1="30" y1="60" x2="60" y2="30" stroke-width="8" stroke-linecap="round"/>' +
      '<line x1="30" y1="60" x2="60" y2="90" stroke-width="8" stroke-linecap="round"/>' +
      '<line x1="60" y1="30" x2="90" y2="60" stroke-width="8" stroke-linecap="round"/>' +
      '<line x1="60" y1="90" x2="90" y2="60" stroke-width="8" stroke-linecap="round"/>' +
      '<circle cx="30" cy="60" r="13" fill="currentColor"/><circle cx="60" cy="30" r="13" fill="currentColor"/>' +
      '<circle cx="60" cy="90" r="13" fill="currentColor"/><circle cx="90" cy="60" r="13" fill="currentColor"/></svg></div>' +
    '<h2>' + esc(title) + '</h2><p>' + html + '</p></div>';
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
