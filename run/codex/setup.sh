#!/usr/bin/env bash
# Codex setup script for 3dpmon
set -euxo pipefail

cd /workspace/3dpmon

# Ensure corepack and install dependencies
corepack enable
npm ci --ignore-scripts

# Run tests once to compile modules
npm run -s test || true
