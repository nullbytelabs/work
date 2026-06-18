# Kubernetes triage: agents on evidence, not on clusters

[`examples/k8s-triage`](https://github.com/nullbytelabs/work/tree/main/examples/k8s-triage)
is a runnable workflow that triages a Kubernetes cluster: deterministic jobs
gather facts with kubectl, an agent names the root cause. It demonstrates a
division of labor we think matters for repeatable operations work:

- **`run:` jobs collect.** Two jobs fan out in parallel, each in its own
  micro-VM: `observe` inventories the cluster (namespaces, workloads, pods);
  `hunt` finds unhealthy pods and captures `describe`, logs, events, and the
  config the pod references.
- **The agent only analyzes.** `diagnose` fans the captured outputs in through
  `needs.*` interpolation and writes an incident report. It has no kubeconfig,
  no token, and no cluster egress — every run reasons over the same kind of
  evidence, gathered the same way.

```mermaid
graph LR
  observe["observe<br/>(kubectl inventory)"] --> diagnose["diagnose<br/>(agent: root cause)"]
  hunt["hunt<br/>(unhealthy pods → evidence)"] --> diagnose
```

## The cluster is a datasource

The workflow never holds a credential. `work.json` declares the API server as a
datasource, and the run opts in with `--datasources k8s`:

```json
"datasources": {
  "k8s": {
    "baseUrl": "https://work-triage.internal:7443",
    "resolve": "127.0.0.1",
    "token": "$K8S_TRIAGE_TOKEN"
  }
}
```

The hostname is just a label. The demo cluster lives on the engine host's
loopback (kind's default), which no DNS can name, so the datasource pins it
with `resolve`, exactly like `curl --resolve`: the engine rewrites the host to
the pinned address before its policy checks and the dial. Pinning is an
explicit grant, so it also lifts the sandbox's private-address block for that
one address.

Jobs see a placeholder env var — the engine swaps the real ServiceAccount token
into the `Authorization` header host-side, scoped to that one host. kubectl
authenticates normally; the secret never enters the guest:

```yaml
- name: point kubectl at the cluster
  env:
    SERVER: ${{ inputs.server }}
  run: |
    kubectl config set-cluster triage --server="$SERVER" --certificate-authority="$NODE_EXTRA_CA_CERTS"
    kubectl config set-credentials triage-bot --token="$K8S_TOKEN"
    kubectl config set-context triage --cluster=triage --user=triage-bot
    kubectl config use-context triage
```

The token itself is least-privilege and short-lived: a read-only ClusterRole
bound to a dedicated ServiceAccount, minted with
`kubectl create token --duration=2h`.

kubectl comes from a **workspace-local image**: `runs-on: work:k8s` resolves to
`.workflows/images/k8s/build-config.json` (the base toolchain plus kubectl),
built once on first use instead of downloaded in every job.

## Run it

The example ships a deliberately broken workload: `shop/checkout` reads
`DATABASE_URL` from ConfigMap key `database_url`, but the ConfigMap defines
`db_url`. The pod crash-loops; the proof is spread across the logs, the pod
spec, and the ConfigMap — three clues a triage has to reassemble.

All commands run from `examples/k8s-triage/`:

```bash
# throwaway kind cluster + demo workloads + read-only triage credentials.
# Prints the work.json datasource block on success.
./setup.sh

export K8S_TRIAGE_TOKEN=$(kubectl --context kind-work-triage -n triage create token triage-bot --duration=2h)
NODE_EXTRA_CA_CERTS=kind-ca.crt \
  work run triage \
  --config ../../work.json --datasources k8s \
  --inputs '{"server":"https://work-triage.internal:7443"}'
```

The agent's report from a real run, unedited:

```
===== INCIDENT REPORT =====
WORKLOAD: shop/checkout

FAILURE: CrashLoopBackOff — container exits with code 1 on every startup,
leaving the deployment at 0/1 Ready and 0 Available.

ROOT CAUSE: The container expects a ConfigMap key named `database_url`, but
the mounted ConfigMap `checkout-config` only provides the key `db_url`.
Because the environment variable is `Optional: true`, the pod starts with an
empty `DATABASE_URL`, and the startup script explicitly exits with code 1 when
that variable is unset.
Proving evidence:
- `DATABASE_URL:  <set to the key 'database_url' of config map 'checkout-config'>  Optional: true`
- `data: db_url: postgres://checkout:checkout@db.shop.svc:5432/checkout`
- `State:          Terminated` / `Reason:       Error` / `Exit Code:    1`

FIX: Update the ConfigMap `checkout-config` in namespace `shop` to rename the
key from `db_url` to `database_url` so it matches the key the Deployment expects.
```

## Remote clusters (EKS, GKE, AKS)

The workflow is cluster-agnostic: the server URL is an input and auth is a
bearer token, which is exactly how managed clusters authenticate. Pointing the
triage at a remote cluster means changing only `work.json`:

```json
"k8s": {
  "baseUrl": "https://ABC123.gr7.us-east-1.eks.amazonaws.com",
  "token": "$EKS_TRIAGE_TOKEN"
}
```

and the local-only scaffolding drops away: a managed cluster has a real DNS
name, so there is no `resolve` pin: the datasource is a hostname and a token,
nothing else. The pin (the same knob any loopback upstream would use — a local
Postgres, a docker-published port, an SSH tunnel) is the only thing that made
the laptop case special.

In both cases TLS is two hops: in-guest, kubectl verifies the sandbox's egress
CA (exported as `$NODE_EXTRA_CA_CERTS` inside the guest); host-side, the engine
verifies the cluster's real CA. Hand it over with `NODE_EXTRA_CA_CERTS` on the
`work` process, the same CA you'd put in a kubeconfig. For kind that's the CA
`setup.sh` exports, verified against the pinned `127.0.0.1`, a name kind's
default API server certificate already carries.
