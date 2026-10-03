#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Bootstrap edEditIt: initialize the pinned templit MDY reference.
#
# Usage:
#   ./scripts/bootstrap.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "📦 Initializing the pinned templit reference ..."
git submodule update --init --recursive -- vendor/templit

echo "✨ Bootstrap complete. MDY reference:"
git submodule status -- vendor/templit
