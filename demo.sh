#!/usr/bin/env bash

WS="./test/e2e/agent-project"
WORK="./bin/pi-workflows.mjs"

echo "Basic Graph Rendering"
echo "---------------------"

echo "[ci]"
$WORK --workspace "$WS" graph ci
echo ""
echo "[review]"
$WORK --workspace "$WS" graph review

echo ""
echo ""

echo "Graph Rendering with Steps"
echo "---------------------"

echo "[ci]"
$WORK --workspace "$WS" graph ci --steps --format mermaid
echo ""
echo "[review]"
$WORK --workspace "$WS" graph review --steps --format mermaid

echo ""
echo ""

echo "Execute Workflows"
echo "---------------------"

echo "[ci] fast verification"
$WORK --workspace "$WS" run ci

echo ""

echo "[review] agent review (composite action/summarize -> work/agent)"
$WORK --workspace "$WS" run review

echo ""
echo ""

echo "Built-in actions"
echo "---------------------"

echo "[checkout] git clone a public repo (work/checkout)"
$WORK --workspace ./test/e2e/checkout run checkout

echo ""

echo "[install-node] install a specific Node version (work/install-node)"
$WORK --workspace ./test/e2e/install-node run install-node
