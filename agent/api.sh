#!/usr/bin/env bash
# Calls the local Job Hunt API with the agent token.
#   agent/api.sh GET   /api/agent/context
#   agent/api.sh POST  /api/agent/jobs  path/to/body.json     (or "-" to read JSON from stdin)
#   agent/api.sh PATCH /api/agent/applications/12 '{"stage":"applied"}'
#   agent/api.sh UPLOAD <application_id> <png-file> [confirmation text]
# APP_CURL_MAX_TIME=<seconds> gives up on a call that takes longer (the server carries on).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
: "${AGENT_TOKEN:?AGENT_TOKEN missing; run npm run setup}"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"

method="${1:?method}"
shift

if [ "$method" = "UPLOAD" ]; then
  app_id="${1:?application_id}"; file="${2:?png file}"; text="${3:-}"
  exec curl -sS --fail-with-body -X POST "$APP_URL/api/agent/screenshots" \
    -H "Authorization: Bearer $AGENT_TOKEN" \
    -F "application_id=$app_id" -F "file=@$file;type=image/png" ${text:+-F "confirmation_text=$text"}
fi

path="${1:?path}"
body="${2:-}"
args=(-sS --fail-with-body -X "$method" "$APP_URL$path" -H "Authorization: Bearer $AGENT_TOKEN")
[ -n "${APP_CURL_MAX_TIME:-}" ] && args+=(--max-time "$APP_CURL_MAX_TIME")
if [ -n "$body" ]; then
  args+=(-H "Content-Type: application/json")
  if [ "$body" = "-" ]; then args+=(--data-binary @-)
  elif [ -f "$body" ]; then args+=(--data-binary "@$body")
  else args+=(--data-binary "$body"); fi
fi
curl "${args[@]}"
echo
