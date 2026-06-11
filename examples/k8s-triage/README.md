# k8s-triage — repeatable Kubernetes issue triage

A workflow that triages a Kubernetes cluster: two `run:` jobs gather facts with
kubectl in parallel (namespaces, workloads, pods; then describe/logs/events for
anything unhealthy), and an agent job fans the evidence in and writes the
incident report. The agent never touches the cluster — it only reasons over
what the deterministic jobs collected.

The demo cluster ships one healthy workload and one deliberately broken one:
`shop/checkout` reads `DATABASE_URL` from ConfigMap key `database_url`, but the
ConfigMap defines `db_url`. The pod crash-loops with a FATAL log line; the
proof is spread across the logs, the pod spec, and the ConfigMap.

## Run it

All commands below run **from this folder** (`examples/k8s-triage/`).

Requirements: `kind`, `kubectl`, docker, and a `work` built from this
repository — the `--datasources` flag and datasource `resolve` pins are newer
than the latest published release. From the repo root:
`npm run build && npm i -g .` (or invoke `node ./bin/work.mjs` directly).

```bash
# 1. throwaway kind cluster + demo workloads + read-only triage credentials.
#    Prints the datasource block for work.json when it finishes.
./setup.sh

# 2. add the printed datasource block to the repo-root work.json
#    (which also needs a model configured — see docs-site/reference/configuration.md),
#    mint a token, and run:
export K8S_TRIAGE_TOKEN=$(kubectl --context kind-work-triage -n triage create token triage-bot --duration=2h)

NODE_EXTRA_CA_CERTS=kind-ca.crt \
  work run triage \
  --config ../../work.json --datasources k8s \
  --inputs '{"server":"https://work-triage.internal:7443"}'

# 3. clean up
./teardown.sh
```

## How it works

- **The cluster is a datasource.** `work.json` declares the API server under
  `datasources.k8s` with the ServiceAccount token; the run opts in with
  `--datasources k8s`. Jobs see a placeholder `$K8S_TOKEN` — the engine swaps
  the real token into the `Authorization` header host-side, scoped to that one
  host. The credential never enters the guest.
- **`resolve` pins the address.** The cluster lives on the engine host's
  loopback (kind's default), which public DNS can't name — so the datasource
  pins its hostname to `127.0.0.1`, exactly like `curl --resolve`. The
  hostname (`work-triage.internal`) is just a label; the engine rewrites it to
  the pinned address before its policy checks and the dial. Pinning is an
  explicit grant, so it also lifts the sandbox's private-address block for
  that one address.
- **Least privilege, short-lived.** `triage-bot` is bound to a read-only
  ClusterRole (`manifests/triage-rbac.yaml`); the token comes from
  `kubectl create token --duration=2h`.
- **TLS is two hops.** The sandbox terminates guest TLS to mediate egress:
  in-guest, kubectl verifies the sandbox's egress CA (`$NODE_EXTRA_CA_CERTS`
  inside the guest); host-side, the engine verifies the real kind CA
  (`NODE_EXTRA_CA_CERTS=kind-ca.crt` on the `work` process) against the
  pinned `127.0.0.1` — a name kind's default API server certificate already
  carries.
- **kubectl is baked into the image.** `runs-on: work:k8s` resolves to the
  workspace-local image in `.workflows/images/k8s/` (base toolchain +
  kubectl), built once on first use instead of downloaded per job.
- **Deterministic collection, analysis-only agent.** The `diagnose` job gets
  no datasource and no kubeconfig — just the captured outputs of `observe` and
  `hunt` interpolated into its prompt.
