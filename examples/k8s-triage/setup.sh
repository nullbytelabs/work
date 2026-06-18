#!/usr/bin/env bash
# Stand up the throwaway kind cluster, deploy the demo workloads, and mint
# read-only triage credentials.
#
# kind publishes the API server on the host's loopback only (127.0.0.1:7443);
# jobs reach it through the engine's host-side egress, which dials the loopback
# via the datasource's `resolve` pin (work.json), like curl --resolve. The
# cluster name and port are fixed so the static kubeconfig.yaml and the printed
# work.json block line up without editing.
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER=${CLUSTER:-work-triage}
API_PORT=${API_PORT:-7443}

kind create cluster --name "$CLUSTER" --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerPort: $API_PORT
EOF

# The engine verifies the API server's TLS host-side with the regular Node
# trust store — hand it the kind CA via NODE_EXTRA_CA_CERTS at run time.
kubectl --context "kind-$CLUSTER" config view --raw --minify \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > kind-ca.crt

KC="kubectl --context kind-$CLUSTER"
$KC apply -f manifests/triage-rbac.yaml
$KC apply -f manifests/demo-shop.yaml

echo "waiting for frontend to come up and checkout to crash…"
$KC -n shop wait --for=condition=Available deploy/frontend --timeout=180s
for _ in $(seq 1 90); do
  reason=$($KC -n shop get pods -l app=checkout \
    -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)
  [ "$reason" = "CrashLoopBackOff" ] && break
  sleep 2
done
$KC -n shop get pods

cat <<MSG

cluster ready.

1. add the cluster as a datasource in the repo-root work.json (next to your
   model config). The hostname is just a label that must match kubeconfig.yaml;
   \`resolve\` pins where the engine actually dials, like curl --resolve:

  "datasources": {
    "k8s": {
      "baseUrl": "https://$CLUSTER.internal:$API_PORT",
      "resolve": "127.0.0.1",
      "token": "\$K8S_TRIAGE_TOKEN"
    }
  }

2. run the triage:

  ./run.sh
MSG
