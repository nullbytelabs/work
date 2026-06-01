#!/usr/bin/env bash

echo "Basic Graph Rendering"
echo "---------------------"

./pi-workflows --workspace ./test/e2e/agent-project graph ci

echo ""
echo ""

echo "Graph Rendering with Steps"
echo "---------------------"

./pi-workflows --workspace ./test/e2e/agent-project graph ci --steps --format mermaid

echo ""
echo ""

echo "Execute Workflows"
echo "---------------------"

./pi-workflows --workspace ./test/e2e/agent-project run ci