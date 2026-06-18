# k8s-triage — repeatable Kubernetes issue triage

A workflow that triages a Kubernetes cluster: one `run:` job gathers facts with
kubectl (namespaces, workloads, pods; then describe/logs/events for anything
unhealthy), and an agent job fans the evidence in and writes the incident
report. The agent never touches the cluster — it only reasons over what the
deterministic job collected.

The demo cluster ships one healthy workload and one deliberately broken one:
`shop/checkout` reads `DATABASE_URL` from ConfigMap key `database_url`, but the
ConfigMap defines `db_url`. The pod crash-loops with a FATAL log line; the
proof is spread across the logs, the pod spec, and the ConfigMap.

## Run it

All commands below run **from this folder** (`examples/k8s-triage/`).

Requirements: `kind`, `kubectl`, and docker. The scripts use this repository's
own CLI (`bin/work.mjs`, built on first run) — to run the commands by hand
with a global `work` instead, install it from the repo root: `npm i -g .`.

```bash
# 1. throwaway kind cluster + demo workloads + read-only triage credentials.
#    Prints the datasource block for work.json when it finishes.
./setup.sh

# 2. add the printed datasource block to the repo-root work.json
#    (which also needs a model configured — see docs-site/reference/configuration.md),
#    mint a token, and run:
export K8S_TRIAGE_TOKEN=$(kubectl --context kind-work-triage -n triage create token triage-bot --duration=2h)

NODE_EXTRA_CA_CERTS=kind-ca.crt \
  work run triage --config ../../work.json --datasources k8s

# 3. clean up
./teardown.sh
```

## How it works

- **The connection is a normal kubeconfig.** `kubeconfig.yaml` in this folder is
  a plain, static kubeconfig; `KUBECONFIG` points at it, so jobs just run
  `kubectl` with no per-job setup. It stays static because the datasource
  supplies the moving parts host-side (below). kubeconfig.yaml has the details.
- **The cluster is a datasource.** `work.json` declares the API server under
  `datasources.k8s` with the ServiceAccount token; the run opts in with
  `--datasources k8s`. In-guest the token is only a placeholder (`$K8S_TOKEN`) —
  the engine swaps the real token into the `Authorization` header host-side,
  scoped to that one host. The credential never enters the guest.
- **`resolve` pins the address.** kind publishes its API server on the engine
  host's loopback, which public DNS can't name — so the datasource pins its
  hostname to `127.0.0.1`, like `curl --resolve`. The hostname
  (`work-triage.internal`) is just a label the engine rewrites before its policy
  checks and the dial. Full egress path: `docs/egress-data-path.md`.
- **Least privilege, short-lived.** `triage-bot` is bound to a read-only
  ClusterRole (`manifests/triage-rbac.yaml`); the token comes from
  `kubectl create token --duration=2h`.
- **kubectl is baked into the image.** `runs-on: work:k8s` resolves to the
  workspace-local image in `.workflows/images/k8s/` (base toolchain +
  kubectl), built once on first use instead of downloaded per job.
- **Deterministic collection, analysis-only agent.** The `diagnose` job runs no
  kubectl and gets no cluster connection — just the captured outputs of
  `collect` interpolated into its prompt.
