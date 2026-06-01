#!/usr/bin/env bash

WS="./test/e2e/agent-project"

echo "Basic Graph Rendering"
echo "---------------------"

echo "[ci]"
./pi-workflows --workspace "$WS" graph ci
echo ""
echo "[review]"
./pi-workflows --workspace "$WS" graph review

echo ""
echo ""

echo "Graph Rendering with Steps"
echo "---------------------"

echo "[ci]"
./pi-workflows --workspace "$WS" graph ci --steps --format mermaid
echo ""
echo "[review]"
./pi-workflows --workspace "$WS" graph review --steps --format mermaid

echo ""
echo ""

echo "Execute Workflows"
echo "---------------------"

echo "[ci] fast verification"
./pi-workflows --workspace "$WS" run ci

echo ""

echo "[review] agent review (separate pipeline)"
./pi-workflows --workspace "$WS" run review
