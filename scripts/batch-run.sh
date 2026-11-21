#!/usr/bin/env bash
# launchd entry for the Batch API scorer (scripts/batch-prepare.ts): score, then write materials, then record both.
# Does nothing without an API key (LODESTAR_ANTHROPIC_KEY in .env or the "lodestar-anthropic" Keychain item).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p logs
exec npx --no-install tsx scripts/batch-prepare.ts "${1:-auto}" >> "logs/batch-$(date +%Y%m%d).log" 2>&1
