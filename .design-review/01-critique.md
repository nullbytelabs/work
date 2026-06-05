# Critique — work --web console

Lens: UX, information hierarchy, signal-to-noise, "state is the message." Target: `src/web/client.ts` (`renderShell`). Other agents own color tokens, raw contrast ratios, keyboard a11y, and motion; cross-cutting notes here are one line each.

Headline: the file self-identifies as "CANDIDATE B — the premium product dashboard redesign" / "airy card-forward SaaS console, indigo brand gradient" (lines 1–22). That framing is, almost line-for-line, the two explicit anti-references in PRODUCT.md ("Generic AI-startup look" / "Flat, generic Bootstrap"). The brand brief is "precise, trustworthy, unfussy" with "calm by default, loud only on failure" and "earn every element." The implementation spends its loudest visual currency — indigo gradients, glow drop-shadows, lifting cards, pulsing dots — on chrome and on the *happy path*, not on state and not on failure. Functionally the views are correct and complete; the hierarchy is inverted against the product's own thesis.

## Score

Scored per critique.md (Nielsen 0–4 each), through the UX/hierarchy/signal lens.

| # | Heuristic | Score | One line |
|---|-----------|-------|----------|
| 1 | Visibility of system status | 3 | Live SSE, elapsed timer, DAG status, per-step glyphs + duration are genuinely good; gap is that *run-level* status is a small chip equal in weight to everything else. |
| 2 | Match system / real world | 3 | Speaks CI/DAG language to a CI audience well; "eyebrow" labels (Catalog/Integrations/Activity) add register noise, not meaning. |
| 3 | User control & freedom | 2 | No cancel/stop on a running run; no back from a run to its source list beyond top nav; re-run is the only control. |
| 4 | Consistency & standards | 3 | Strong shared vocabulary (chip/tag/rbadge/tile), but three near-identical status-badge systems and gradient applied inconsistently (tiles vs history rows). |
| 5 | Error prevention | 3 | Typed inputs, present-only collection, disabled test button with reason tooltip, required markers. Solid. |
| 6 | Recognition rather than recall | 3 | Status by glyph+label+color (color-blind safe), URLs shown, deliveries linked to runs. Run view loses the workflow *name* (shows only an 8-char id). |
| 7 | Flexibility & efficiency | 2 | Re-run is nice; otherwise no filtering/grouping of history, no run search, no expand/collapse-all logs, no deep links. |
| 8 | Aesthetic & minimalist design | 2 | This is the lens's core failure: decoration (gradient hero band, glow shadows, lifting cards, eyebrows, gradient empty-state logo) competes with state for attention. Several elements carry no information. |
| 9 | Error recovery | 3 | Errors surface in boxed `.err`, preserved inline, buttons re-enable. SSE-404 handled. Messages are raw server text though. |
| 10 | Help & documentation | 3 | Page `.sub` lines teach each surface concisely and in-context. Good for a local tool. |
| **Total** | | **27/40** | Acceptable. Functionally trustworthy; the visual-hierarchy budget is spent backwards. |

## Findings

### 1. Run-level status is undersized — the single most important fact on the live view is a small chip
- **Severity:** high
- **Location:** `viewRun`, `client.ts:1058–1062`
- **Problem:** The whole job of this surface (PRODUCT.md: "a developer glances and instantly knows what ran, what's running, what broke") is the run's *state*. On the live run view that state is a 12.5px chip (`#run-status`) sitting in a `.chips` row, the same size and weight as the neutral mono elapsed-timer chip beside it. The visually dominant elements on the page are instead: the indigo gradient background band (`--bg-grad`), the gradient brand mark with a glow (`drop-shadow ... rgba(100,108,255,0.35)`), and the page-head `h1` which is just a truncated 8-char run id in mono. "State is the message" is violated: the message is small, and a hash is big.
- **Fix:** Make run status the hero of the view. Replace the id-as-h1 with status-as-h1: a large status word ("Running" / "Failed" / "Succeeded") colored by `--run/--fail/--ok` with its glyph, the workflow *name* as the line under it, and the run id demoted to mono metadata. Concretely, restructure the `.page-head`:
  ```
  <h1 class="run-state" data-status="running"><span class="glyph">◌</span> Running</h1>
  <p class="sub"><b>{workflow name}</b> · run {id8} · {elapsed}</p>
  ```
  Status drives the heading color; success stays calm (no fill), failure goes loud (red word + boxed error already exists). This also fixes finding #6 (lost workflow name).

### 2. Success is not quiet and failure is not loud enough — emphasis is spent on the happy path
- **Severity:** high
- **Location:** DAG node styles `client.ts:424–435`; `button.primary` `281–285`; tiles `212–231`
- **Problem:** PRODUCT.md principle "calm by default, loud only on failure." Here the *running* and *success* states get the glow/gradient treatment (running node: `drop-shadow(0 0 6px ...)` + gradient fill + pulsing badge; success: green border). Failure gets only a red border at the same stroke weight as success — it does **not** read louder than a healthy run. Meanwhile the primary button and the running state carry the most saturated, shadowed, animated styling in the app. The contrast budget is inverted: the calm states shout and the failure state whispers.
- **Fix:** Flatten success and running (border-color change only, drop the gradient node-fill and the glow on running; a quiet pulse on the badge is enough to say "live"). Reallocate that emphasis to failure: give `g.job[data-status=failure] .node` a filled red tint (`fill: color-mix(in srgb, var(--fail) 12%, transparent)`), heavier stroke, and surface a count of failed jobs at the run level. A failed run should be the loudest thing on screen; right now a *running* run is.

### 3. The gradient hero band, glow shadows, and eyebrow labels are decoration that carries no run information
- **Severity:** high
- **Location:** `--bg-grad` radial indigo wash `client.ts:56,97,134`; brand glow `160`; `.page-head .eyebrow` `185–188` used at `654,724,897,1054,1314`; gradient empty-state logo `1346–1358`
- **Problem:** "Earn every element. No decoration that doesn't carry information." The radial indigo background wash, the brand-mark drop-shadow, the gradient-filled DAG nodes, and the per-page eyebrows (`Catalog`, `Integrations`, `Run workflow`, `Activity`) are pure aesthetic. The eyebrows specifically are called out in the impeccable absolute bans ("tiny uppercase tracked eyebrow above every section ... AI grammar") and the gradient + glow combo is the "generic AI-startup look" anti-reference verbatim. None of it tells the developer what ran or what broke; it raises the visual noise floor every other (informational) element must compete against.
- **Fix:** Delete the eyebrows entirely; the `h1` already names the surface. Remove `--bg-grad` (flat `--bg`). Drop the brand-mark glow and the gradient empty-state logo (a flat single-color mark is enough). Reserve gradient/indigo strictly for the one primary action per view and current-nav selection (which the product reference explicitly allows: "accent for primary actions, current selection, state indicators only, not decoration").

### 4. Three parallel status-badge systems for the same concept (run state)
- **Severity:** medium
- **Location:** `.chip[data-status]` `303–308`; `.tag.ok/.warn/.bad` `337–342`; `.rbadge.r-*` `381–384`; plus `.glyph.*` `484–485`
- **Problem:** Status is the product's core vocabulary, yet it is encoded four different ways: chips (run/step status), tags (hook auth/enabled), rbadges (delivery result), and bare glyphs (history rows, DAG, step summaries). A developer scanning across views has to re-learn "what does green mean here" three times. The history-row status (line 1334) is plain text `success · 10:42:03` with a separate colored glyph in the icon slot — different again from the run view's chip. "Legible under density" and Nielsen consistency both suffer.
- **Fix:** Collapse to one status-pill component (one shape, one size ramp, one color map keyed by `data-status`) and use it everywhere a run/job/step/delivery state appears, including history rows. Keep `tag` only for non-status metadata (auth scheme, datasource names). One status atom, reused, is the "legible under density" win.

### 5. History rows bury status inside a metadata string; the list does not answer "what broke" at a glance
- **Severity:** medium
- **Location:** `viewHistory`, `client.ts:1326–1339`
- **Problem:** Run history is where a developer triages "what failed today." Each row renders status as small text concatenated with time and trigger (`status · when · trigger`, line 1334), with only a colored glyph in the icon position. Failed and succeeded rows have identical weight, layout, and background — a failure does not pull the eye. There is no grouping, no failed-first ordering, no count. To find the broken run you read every row.
- **Fix:** Promote status to a leading status-pill (per #4), and let failed rows carry a subtle red-tinted surface so failures are scannable in a long list. Add a one-line summary header ("12 runs · 2 failed") so the answer is available before scanning. Consider failed-first or a filter; at minimum make failure visually heavier than success in the list.

### 6. Run view drops the workflow name — the run is identified only by an 8-char hash
- **Severity:** medium
- **Location:** `viewRun` heading `client.ts:1055`
- **Problem:** The live/replay run view shows `runId.slice(0,8)` as the h1 and never shows which workflow this run *is*. Arriving from a webhook delivery row or a deep link, the developer sees a hash and a DAG but not the name of the thing running. Recognition-over-recall fails; the most human-meaningful identifier is absent while a machine id is the largest text on the page.
- **Fix:** Fetch/carry the workflow name into the run view and make it the heading (see #1). The 8-char id becomes secondary metadata. If the name isn't already in the `run-init` SSE frame, this is worth a small contract addition; the DAG already receives `init.jobs`.

### 7. No way to stop a running run, and no contextual "back to list"
- **Severity:** medium
- **Location:** `viewRun` controls `client.ts:1057` (only `#rerun`)
- **Problem:** Once a run is live the only control is Re-run (disabled-relevant only after completion). There is no Cancel/Stop for a long or runaway run, and no in-context link back to the workflow or to history — the user must use top nav, which loses their place. Nielsen "user control and freedom" is the lowest-scoring heuristic for exactly this reason.
- **Fix:** Add a Cancel control for `running` runs (if the engine supports abort; if not, this is a real product gap worth flagging). Add a quiet back affordance in the page-head (e.g. "‹ History" or the workflow name as a link to its trigger page). Keep Re-run secondary/ghost as it is.

### 8. All log `<details>` open by default — a real dense run becomes a wall of output
- **Severity:** medium
- **Location:** `ensureStep` sets `det.open = true` `client.ts:1119`; logs container `1066–1068`
- **Problem:** "Legible under density. A real run has many jobs, steps, and lines of output." Every step opens expanded with a 460px-max scroll body. A matrix fan-out with a dozen steps produces a page of stacked open logs; the *failed* step is not privileged and gets lost among succeeded ones. The default optimizes for a 1–2 step demo, not a real run.
- **Fix:** Default steps to collapsed once they end *successfully*, keep the currently-running step open, and auto-open (and scroll to) any step that ends in `failure`. The summary line already carries glyph + duration + exit code, so a collapsed succeeded step still communicates state. Add an "expand all / collapse all" control for the power user (ties to finding on flexibility).

### 9. Step exit code shown for every step, including success — noise on the calm path
- **Severity:** low
- **Location:** `step-end` handler `client.ts:1165`
- **Problem:** Every finished step renders `exit {code}` in its summary meta, including `exit 0` on success. "Earn every element" / "calm by default": `exit 0` is the absence of information shown as if it were information, on every successful step. The signal (a non-zero exit) is diluted by the constant `exit 0` noise.
- **Fix:** Show the exit code only when non-zero (where it's diagnostic), or only on failed/non-success steps. Keep duration always (that *is* useful per-step signal). Quiet success.

### 10. Elapsed timer keeps the same neutral styling whether the run is healthy or failed/long
- **Severity:** low
- **Location:** `#run-elapsed` chip `client.ts:1061`, tick `1079`
- **Problem:** The elapsed chip is `.chip.mono` (neutral) and updates at 100ms. It never reflects state — a 20-minute stuck run looks the same as a 2-second one, and it keeps ticking visually even though run-end clears the interval (fine) but leaves the final time in neutral styling. Minor "state is the message" gap: time is shown but not made meaningful.
- **Fix:** On `run-end`, freeze the elapsed value and tint it to the final status (or move final duration into the status heading line per #1). 100ms tick is finer than human-useful; 250–500ms is plenty and calmer.

### 11. Loading/empty/error states are present and good — but the empty-state logo is decorative
- **Severity:** low
- **Location:** `emptyState` `1346–1358`, `skeletonRows` `1359`, `errorBlock` `1364`
- **Problem (positive, with one nit):** Skeleton rows (not spinners), teaching empty states ("Add a YAML file to `.workflows/`..."), and inline boxed errors are exactly what the product reference asks for — this is a genuine strength. The one nit in-lens: the empty state leads with a 44px gradient brand logo (`#emptyG`), decoration where a quieter informational glyph (or nothing) would do, and `errorBlock` replaces the whole page with a generic "Something went wrong" h1, discarding navigation context.
- **Fix:** Keep the empty-state copy; drop or flatten the gradient logo. For `errorBlock`, keep the page-head/nav context and render the error inline rather than blowing away the view (so the user can retry/navigate without a reload).

### 12. Deliveries panel: result severity is well-mapped, but the row's most important cell (result) isn't the visual anchor
- **Severity:** low
- **Location:** `loadDeliveries` row markup `client.ts:852–857`, `resultClass` `684–703`
- **Problem (mostly positive):** The `resultClass` mapping (accepted/test green, duplicate muted, disabled/not_opted_in amber, rejections red) is thoughtful and operator-aware — good signal design. In the row layout, though, the result badge, the HTTP status, the timestamp, and the source IP all sit at similar weight; a rejected delivery (the thing an operator cares about) doesn't dominate its row.
- **Fix:** Lead the row with the result badge at slightly heavier weight and let `r-bad` rows carry a faint red surface, consistent with the failed-run treatment in #5. Same "loud only on failure" principle applied to the deliveries list.

### Cross-cutting (one line each, owned by other agents)
- Color/contrast: muted body (`--muted #71748a` on `--surface-2`) and 11.5px mono metadata are at/below AA on the light theme — flag for the color agent.
- A11y: status `data-status` is paired with glyph+label (color-blind safe — good); DAG `<svg>` has no `role`/title and run state changes aren't announced — flag for the a11y agent.
- Motion: shimmer, node pulse, and chip pulse have no `prefers-reduced-motion` fallback — flag for the motion agent.

## Prioritized

### Quick wins (style/markup, no new server contract)
1. **Delete the eyebrows** (`.page-head .eyebrow` at 5 call sites) — removes the clearest AI-grammar tell and the most pointless chrome. (#3)
2. **Remove `--bg-grad`, brand glow, gradient empty-state logo** — flatten chrome so state can lead. (#3, #11)
3. **Quiet success / amplify failure** on DAG nodes and run/history rows — flip the contrast budget. (#2, #5)
4. **Show `exit` only when non-zero**; freeze + tint elapsed on run-end. (#9, #10)
5. **Collapse succeeded step logs, keep running open, auto-open failed.** (#8)

### Larger restructures
1. **Make run status the hero of the run view** — status word as h1 (colored, glyph), workflow name as subtitle, id demoted. This is the single highest-impact change against "state is the message." Pairs with carrying the workflow name into the view. (#1, #6)
2. **Unify the four status-badge systems into one reused status atom** used across run, history, DAG, and deliveries. (#4, #12)
3. **History as a triage surface** — leading status pill, failed rows tinted, summary count, optional filter/failed-first. (#5)
4. **Add run control + context** — Cancel for running runs (engine permitting), in-context back affordance. (#7)
