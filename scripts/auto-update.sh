#!/usr/bin/env bash
# Keeps this copy on the latest commit of main. The com.jobhunt.update launch agent runs it every 15
# minutes; it does nothing unless GitHub has a newer commit. On a new commit it downloads it, keeps your
# data (data/, logs/, .env, my-profile.json, PDFs), reinstalls dependencies, rebuilds and restarts the app.
#   scripts/auto-update.sh           update if there's a newer commit
#   scripts/auto-update.sh --force   update even if this commit is already installed
# Set JOBHUNT_AUTO_UPDATE=0 in .env to turn it off.
set -uo pipefail

# Everything runs inside main so bash has read the whole file before the update replaces it.
main() {
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$ROOT"
  export PATH="$ROOT/.node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
  [ -f .env ] && set -a && . ./.env && set +a

  REPO="bollineni-create/feelin-lucky"
  BRANCH="${JOBHUNT_BRANCH:-main}"
  SHA_FILE="$ROOT/.installed-sha"
  mkdir -p logs
  LOG="logs/update.log"
  log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }
  notify() { osascript -e "display notification \"$1\" with title \"Lodestar\"" >/dev/null 2>&1 || true; }

  [ "${JOBHUNT_AUTO_UPDATE:-1}" = "0" ] && exit 0
  # Don't restart the app under a running agent; the next check picks the update up.
  [ -d logs/.run.lock ] && exit 0

  LOCK="logs/.update.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ] || exit 0
    rm -rf "$LOCK" && mkdir "$LOCK"
  fi
  trap 'rm -rf "$LOCK"; [ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT

  LATEST="$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null)"
  [[ "$LATEST" =~ ^[0-9a-f]{40}$ ]] || exit 0   # offline or rate-limited; try again next time
  CURRENT="$(cat "$SHA_FILE" 2>/dev/null || true)"
  [ "$LATEST" = "$CURRENT" ] && [ "${1:-}" != "--force" ] && exit 0

  log "Updating ${CURRENT:0:7}${CURRENT:+ → }${LATEST:0:7}"
  if [ -d .git ]; then
    git fetch -q origin "$BRANCH" && git merge -q --ff-only "origin/$BRANCH" >>"$LOG" 2>&1 || { log "git pull failed; update by hand."; exit 1; }
  else
    TMP="$(mktemp -d)"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$LATEST" | tar -xz --strip-components 1 -C "$TMP" || { log "Download failed."; exit 1; }
    # Mirror the repo, removing files it deleted, but never touch anything git-ignored (your data lives there).
    rsync -a --delete \
      --exclude '/node_modules/' --exclude '/.next/' --exclude '/.node/' --exclude '/data/' --exclude '/logs/' \
      --exclude '/.env' --exclude '/.env.local' --exclude '/my-profile.json' --exclude '/*.pdf' \
      --exclude '/next-env.d.ts' --exclude '*.tsbuildinfo' --exclude '.DS_Store' --exclude '/.installed-sha' \
      "$TMP/" "$ROOT/" >>"$LOG" 2>&1 || { log "Copying the new files failed."; exit 1; }
  fi

  if ! { npm install --no-audit --no-fund && npm run build; } >>"$LOG" 2>&1; then
    log "Install or build failed; the app keeps running the previous build until it restarts. See above."
    notify "Couldn't install the latest update. Details in logs/update.log."
    exit 1
  fi

  echo "$LATEST" >"$SHA_FILE"
  # The app applies database migrations when it starts.
  launchctl kickstart -k "gui/$(id -u)/com.jobhunt.app" >>"$LOG" 2>&1 || log "Couldn't restart com.jobhunt.app; restart it or log out and back in."
  log "Updated to ${LATEST:0:7}."
  notify "Updated to the latest version."
}

main "$@"
