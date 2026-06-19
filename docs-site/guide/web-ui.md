# The serve host

`work serve` boots a small, long-lived **local host** for a project: an HTTP API
with a browser console to run your workflows and watch them live, an authenticated
**webhook receiver**, and a **scheduler** that fires `on: schedule` triggers. It's
the same engine as the CLI, kept running. One process, bound to loopback.

```bash
work serve
# work serve: http://127.0.0.1:4280/
#   workspace: /path/to/project
#   history:   /path/to/project/.workflows/db
#   auth token: 1f3a…
# Press Ctrl-C to stop.
```

Open the printed URL. The host serves the workflows in that workspace's
`.workflows/` directory; leave it running for as long as you want the console, the
[webhook receiver](#webhook-triggers), and the [scheduler](#scheduled-triggers) up.
Stop it with `Ctrl-C`. Point it at another project with `--workspace <dir>` and
move its port with `--port <n>`.

::: tip No extra dependencies
The server is plain `node:http` — there's no separate web server to install and
nothing leaves your machine. It binds to loopback only (see [Security](#security)).
:::

::: warning One host per workspace
The host owns the workspace's durable store (an in-process Postgres under
`.workflows/db/`), and that store is single-process. Run **one** `work serve` per
workspace — don't point a second `serve` (or a `work runs`/`work logs` CLI) at a
workspace a `serve` is already running. Read live state through this host's API and
console instead, never by opening its database from another process.
:::

## What it gives you

Every page has its own URL, so you can **bookmark, share, and refresh** any view —
a specific run (`/runs/<id>`), a workflow's trigger form (`/workflows/<name>`), or
`/history`, `/webhooks`, `/schedules`. Back/forward navigate as you'd expect, and a
link to a finished run replays its full output. (Paste a run URL to a teammate and
they land on exactly that run.)

The console has four pages, all backed by the real engine:

| Page | What it does |
|---|---|
| **Workflows** | Every workflow in the workspace, as a card. Pick one to get an auto-generated input form (from its `inputs:`), run it, and watch the job DAG and per-step output stream live. |
| **Webhooks** | The [webhook triggers](#webhook-triggers) declared in your config — each with its public receiver URL, a **Send test** button, and a delivery audit log. |
| **Schedules** | The [`on: schedule`](#scheduled-triggers) triggers this host is driving, each with its cron expression and its last-fired / next-fire instants. |
| **History** | Past runs with status and timing. Open one to replay its output, or **re-run** it with the same inputs in one click. |

![A finished run in the work console: the job graph and per-step timings, replayed from history](/screenshots/console-run.png)

*A finished `checks` run replayed in the console — the job graph plus each step's
output and timing. This is the project's own dogfood pipeline (see
[Dogfooding](../examples/dogfooding)).*

### Running a workflow

![The Workflows page listing the project's workflows as cards](/screenshots/console-workflows.png)


On the **Workflows** page, click a workflow to open it. If it declares
[`inputs:`](../reference/workflow-syntax#inputs), the console renders a typed form
(required fields, defaults, `options:` as a dropdown, and `pattern:` validation),
so you fill it in instead of hand-writing `--inputs` JSON. Submit, and the run
starts immediately.

While it runs you see the job DAG light up as dependencies clear, and each step's
output streams in live (the page subscribes to the run over Server-Sent Events).
The same view replays from history after the run finishes.

### History and re-runs

Every run is recorded durably (see [Where data lives](#where-data-lives)), so the
**History** page survives restarts of the server. Open any past run to read its
full output again, or hit **Re-run** to launch a fresh run with the same workflow
and inputs, handy for re-triggering a report.

When a run ends in **failure**, a **Retry failed** button also appears: it re-runs
*only* the jobs that failed — reusing the ones that already passed — under the same
run id, picking up where the passing jobs left off. It's the quickest way to tell a
flaky failure from a real one without redoing work that already succeeded (the
console equivalent of [`work retry`](../reference/cli#work-resume-work-rerun-work-retry)).

![The History page listing recent runs with status badges and timing](/screenshots/console-history.png)

If the server is stopped while a run is still in flight, that run isn't lost: when
the server next starts it **resumes** the run automatically, picking up from where
it left off: finished jobs are reused rather than redone.

## Webhook triggers

The host doubles as a **webhook receiver**: an external system can `POST` to it to
trigger a workflow run. This is opt-in and authenticated at every layer: a
workflow is only reachable by webhook if it explicitly opts in **and** an operator
wires up a matching, secret-bearing hook in config.

### 1. Opt the workflow in

Add an `on: webhook` trigger to the workflow. This is the gate the receiver checks;
without it, no `POST` can ever start this workflow:

```yaml
# .workflows/alert-triage.yaml
name: alert-triage
on: webhook            # opt in to remote, authenticated triggering
jobs:
  triage:
    steps:
      - run: echo "severity=${{ event.commonLabels.severity }}"
```

The committed workflow stays **secret-free** — it names *what* may be triggered,
never *how to authenticate*. The mapping form can point at a named secret and hint
the sender shape:

```yaml
on:
  webhook:
    secret: alertmanager   # → webhooks.alertmanager in your config
    source: alertmanager   # free-form hint of the expected sender
```

### 2. Wire up the hook in config

The operator declares the matching receiver in `work.json`. This is
where the secret and auth scheme live, referenced by name, never committed
literally. See the [Configuration reference](../reference/configuration#webhooks):

```json
{
  "webhooks": {
    "alertmanager": {
      "workflow": "alert-triage",
      "auth": "hmac-sha256",
      "secret": "$ALERTMANAGER_WEBHOOK_SECRET",
      "signatureHeader": "X-Hub-Signature-256"
    }
  }
}
```

The hook's public URL is `POST /hooks/alertmanager`. The **Webhooks** page shows
it, lets you fire a signed **test** delivery, and lists every delivery with its
result (`accepted`, `unauthorized`, `duplicate`, …). The audit log never stores
the payload or the secret.

![The Webhooks page: a hook card with its receiver URL and a fail-closed delivery audit log](/screenshots/console-webhooks.png)

*The repo's own `ci` hook (`on: webhook`), its receiver URL, and the delivery
audit log — here showing two rejected, unauthenticated attempts (`401`/`403`),
the fail-closed behavior in action.*

### 3. Read the payload with `event.*`

A webhook-triggered run can read the POST body through the `event` expression
context (with nested paths and array indexing), in both interpolation and `if:`
conditions:

```yaml
jobs:
  page:
    if: ${{ event.alerts[0].labels.severity == 'critical' }}
    steps:
      - run: ./notify.sh "${{ event.commonLabels.alertname }}"
```

### Auth, fail-closed

The receiver is built to **deny by default**. A delivery is rejected unless the
workflow opted in, a matching hook exists, and the request authenticates:

- **HMAC-SHA256** — the signature header is verified against the per-hook secret
  over the **raw body**, constant-time. Both GitHub-style `sha256=…` and bare-hex
  (Grafana-style) signatures are accepted.
- **Bearer** — a `Authorization: Bearer <token>` compared constant-time.
- **Replay protection** — duplicate deliveries are de-duped and recorded as
  `duplicate` rather than run twice.
- **Bounded** — the body is size-capped and parsed only *after* auth passes;
  concurrent runs are bounded so a burst of deliveries can't overwhelm the host.

## Scheduled triggers

The host also runs a **scheduler**: a workflow that declares `on: schedule` fires
itself when a cron slot comes due, with no external trigger. The schedule lives in
the workflow (it's committed, secret-free), and `work serve` is what evaluates it.
There's no separate daemon and no CLI scheduling.

### 1. Declare the schedule

Add an `on: schedule` block listing one or more cron expressions. Cron is the
familiar five-field syntax, evaluated in **UTC**:

```yaml
# .workflows/nightly-report.yaml
name: nightly-report
on:
  schedule:
    - cron: '0 6 * * *'    # 06:00 UTC every day
    - cron: '0 18 * * 1-5' # and 18:00 UTC on weekdays
jobs:
  report:
    steps:
      - run: ./build-report.sh
```

Each `cron:` is validated when the workflow is parsed, so a malformed expression is
a clean error at load time, not a silent no-fire.

### 2. Run the host

A schedule only fires while `work serve` is running over the workspace; it's the
scheduler. Nothing else is required:

```bash
work serve
```

A newly-seen schedule is baselined to "now" and fires from its **next** slot
forward; it never back-fires for time before the host first saw it. If the host
is down across one or more slots, those slots are **skipped**, not back-filled: on
restart the schedule resumes from the next upcoming slot (no catch-up storm). Each
fired slot dispatches the workflow down the same path a manual run takes, recorded
in History with a `schedule` trigger.

### 3. See what's scheduled

The **Schedules** page lists every `on: schedule` trigger the host is driving:
the workflow, its cron expression, when it last fired, and when it'll fire next.
The same data is available from the API at `GET /api/schedules`:

```bash
curl -s http://127.0.0.1:4280/api/schedules
# { "active": true,
#   "schedules": [
#     { "workflow": "nightly-report", "cron": "0 6 * * *",
#       "lastFired": 1749880800000, "nextFire": 1749967200000 } ] }
```

This is the *only* place schedule status lives — read through the running host.
There's deliberately no CLI command to inspect schedules: that would mean a second
process opening the workspace's single-owner database while `serve` holds it.

## Security

The console is meant for your machine, and the defaults enforce that:

- **Loopback only.** The server binds `127.0.0.1` — never `0.0.0.0`. It isn't
  reachable from the network.
- **Host-header pinned.** Requests with any `Host` other than
  `127.0.0.1:<port>` / `localhost:<port>` are rejected `403`, defeating
  DNS-rebinding.
- **CSRF token.** Every mutating request (`POST`) must echo a per-session
  `X-Work-Token` minted into the page, so a random site can't drive your console.

The one deliberately external surface is the webhook receiver
(`POST /hooks/*`) — it has to accept a public `Host` from a tunnel, so it's exempt
from the loopback Host check and instead stands entirely on its own HMAC/bearer
auth, fail-closed.

## Where data lives

Run history, webhook deliveries, and schedule baselines are journaled to an
in-process Postgres under `<workspace>/.workflows/db/`. That directory is the
host's durable store: it's why History, the delivery log, and schedule state
persist across restarts. It's machine-local runtime state, so keep it out of git;
add `**/.workflows/db/` to your `.gitignore`.

## Flags

| Flag | Effect |
|---|---|
| `--workspace <dir>` | Project root whose `.workflows/` the host serves (default: current directory). |
| `--port <n>` | Port to bind (default `4280`; `1`–`65535`). |

`serve` takes no positional arguments and ignores the run/graph-only flags. See the
[CLI reference](../reference/cli#work-serve).
