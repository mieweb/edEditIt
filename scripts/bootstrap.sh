#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Bootstrap edEditIt: initialize/update vendored submodules and Git LFS assets.
#
# Usage:
#   ./scripts/bootstrap.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "📦 Initializing submodules under vendor/ ..."
git submodule update --init --recursive

if command -v git-lfs >/dev/null 2>&1; then
  echo "🗂  Pulling Git LFS assets (hey-ozwell models, etc.) ..."
  git lfs install
  ( cd vendor/hey-ozwell && git lfs pull ) || echo "⚠️  hey-ozwell LFS pull skipped"
else
  echo "⚠️  git-lfs not installed; hey-ozwell ONNX models will be stubs."
fi

echo "✨ Bootstrap complete. Submodules:"
git submodule status
