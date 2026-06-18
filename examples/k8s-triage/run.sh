#!/usr/bin/env bash
# Run the triage against the cluster setup.sh created: mint a fresh short-lived
# read-only token, hand the engine the kind CA, and invoke the workflow.
#
# Uses this repository's own CLI (bin/work.mjs) so the example never depends on
# the globally installed `work` being current. The underlying invocation, for
# running it by hand or against another cluster:
#
#   export K8S_TRIAGE_TOKEN=$(kubectl --context kind-work-triage -n triage create token triage-bot --duration=2h)
#   NODE_EXTRA_CA_CERTS=kind-ca.crt \
#     work run triage --config ../../work.json --datasources k8s
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER=${CLUSTER:-work-triage}

[ -f kind-ca.crt ] || { echo "no kind-ca.crt here — run ./setup.sh first" >&2; exit 1; }
[ -f ../../dist/cli.js ] || { echo "building the CLI (first run)…" >&2; (cd ../.. && npm run build) >/dev/null; }

export K8S_TRIAGE_TOKEN=$(kubectl --context "kind-$CLUSTER" -n triage create token triage-bot --duration=2h)

NODE_EXTRA_CA_CERTS=kind-ca.crt \
  exec node ../../bin/work.mjs run triage \
  --config ../../work.json --datasources k8s
