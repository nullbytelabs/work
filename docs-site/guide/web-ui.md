# Web console

`work --web` boots a small **local web console** for a project — a browser UI to
run your workflows from a form, watch them execute live, browse run history, and
manage webhook triggers. It's the same engine as the CLI, with a front end.

```bash
work --workspace . --web
# pi-workflows web UI: http://127.0.0.1:4280/
```

Open the printed URL. The console serves the workflows in that workspace's
`.workflows/` directory; leave the process running for as long as you want the UI
(and any [webhook receiver](#webhook-triggers)) up. Stop it with `Ctrl-C`.

::: tip No extra dependencies
The server is plain `node:http` — there's no separate web server to install and
nothing leaves your machine. It binds to loopback only (see [Security](#security)).
:::

## What it gives you

The console has three pages, all backed by the real engine:

| Page | What it does |
|---|---|
| **Workflows** | Every workflow in the workspace, as a card. Pick one to get an auto-generated input form (from its `inputs:`), run it, and watch the job DAG and per-step output stream live. |
| **History** | Past runs with status and timing. Open one to replay its output, or **re-run** it with the same inputs in one click. |
| **Webhooks** | The webhook triggers declared in your config — each with its public receiver URL, a **Send test** button, and a delivery audit log. |

### Running a workflow

On the **Workflows** page, click a workflow to open it. If it declares
[`inputs:`](../reference/workflow-syntax#inputs), the console renders a typed form
— required fields, defaults, `options:` as a dropdown, and `pattern:` validation —
so you fill it in instead of hand-writing `--inputs` JSON. Submit, and the run
starts immediately.

While it runs you see the job DAG light up as dependencies clear, and each step's
output streams in live (the page subscribes to the run over
[Server-Sent Events](#how-live-output-works)). The same view replays from history
after the run finishes.

### History and re-runs

Every run is recorded durably (see [Where data lives](#where-data-lives)), so the
**History** page survives restarts of the server. Open any past run to read its
full output again, or hit **Re-run** to launch a fresh run with the same workflow
and inputs — handy for retrying a flaky job or re-triggering a report.

If the server is stopped while a run is still in flight, that run isn't lost: when
the server next starts it **resumes** the run automatically, picking up from where
it left off — finished jobs are reused rather than redone.

## Webhook triggers

The web server doubles as a **webhook receiver**: an external system can `POST` to
it to trigger a workflow run. This is opt-in and authenticated at every layer — a
workflow is only reachable by webhook if it explicitly opts in **and** an operator
wires up a matching, secret-bearing hook in config.

### 1. Opt the workflow in

Add an `on: webhook` trigger to the workflow. This is the gate the receiver checks
— without it, no `POST` can ever start this workflow:

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
where the secret and auth scheme live — referenced by name, never committed
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
result (`accepted`, `unauthorized`, `duplicate`, …) — the audit log never stores
the payload or the secret.

### 3. Read the payload with `event.*`

A webhook-triggered run can read the POST body through the `event` expression
context — with nested paths and array indexing — in both interpolation and `if:`
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

Run history and webhook deliveries are journaled to an in-process Postgres under
`<workspace>/.workflows/db/`. That directory is the console's durable store — it's
why History and the delivery log persist across restarts. It's machine-local
runtime state, so keep it out of git (the scaffold's `.gitignore` already ignores
`**/.workflows/db/`).

## Flags

| Flag | Effect |
|---|---|
| `--web` | Boot the console instead of running a single workflow. |
| `--workspace <dir>` | Project root whose `.workflows/` the console serves (default: current directory). |
| `--port <n>` | Port to bind (default `4280`; `1`–`65535`). |

`--web` takes no positional arguments and ignores the run/graph-only flags. See the
[CLI reference](../reference/cli#work-web).
