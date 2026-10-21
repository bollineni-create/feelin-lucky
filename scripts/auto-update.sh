#!/usr/bin/env bash
# Keeps this copy on the latest commit of main. The com.jobhunt.update launch agent runs it every minute, so
# a commit on main is installed within a minute or two of landing; it does nothing unless GitHub has a newer commit. On a new commit it downloads it, keeps your
# data (data/, logs/, .env, my-profile.json, PDFs), reinstalls dependencies, rebuilds and restarts the app, and
# rebuilds Lodestar.app when its own files changed (an open Lodestar window reloads by itself). Lodestar also runs
# this each time it opens, and from Lodestar → Check for Updates… (with --tell).
#   scripts/auto-update.sh           update if there's a newer commit
#   scripts/auto-update.sh --force   update even if this commit is already installed
#   scripts/auto-update.sh --tell    also show a notification when there's nothing to install
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

  FORCE=0; TELL=0
  for arg in "$@"; do case "$arg" in --force) FORCE=1 ;; --tell) TELL=1 ;; esac; done
  tell() { [ "$TELL" = 1 ] && notify "$1"; return 0; }
  # Keeps Lodestar.app in /Applications built from this version (does nothing when it already is).
  refresh_app() { bash scripts/make-mac-app.sh --if-changed >>"$LOG" 2>&1 || log "Rebuilding Lodestar.app failed; run 'Install Job Hunt.command' again."; }
  # Installs from before the every-minute check still have com.jobhunt.update on a 15-minute interval. Move it over
  # once. Reloading that agent ends the job this script runs as (launchd stops the job's process group), so the reload
  # runs from a new session, a few seconds after this script is done.
  refresh_update_agent() {
    local plist="$HOME/Library/LaunchAgents/com.jobhunt.update.plist"
    [ -f "$plist" ] || return 0
    [ "$(/usr/libexec/PlistBuddy -c "Print :StartInterval" "$plist" 2>/dev/null)" = "60" ] && return 0
    log "Moving com.jobhunt.update to check GitHub every minute (was every 15)."
    python3 - "$ROOT" <<'PY' 2>>"$LOG" || log "Couldn't reload com.jobhunt.update; run 'scripts/install-launchd.sh --update-only' or 'Install Job Hunt.command' again."
import os, subprocess, sys
root = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    log = open(os.path.join(root, "logs", "update.log"), "a")
    subprocess.Popen(["/bin/bash", "-c", 'sleep 3; exec /bin/bash "$0/scripts/install-launchd.sh" --update-only', root], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    os._exit(0)
PY
  }

  [ "${JOBHUNT_AUTO_UPDATE:-1}" = "0" ] && { tell "Automatic updates are off (JOBHUNT_AUTO_UPDATE=0 in .env)."; exit 0; }
  # Don't restart the app under a running agent; the next check picks the update up.
  # (A lock whose pid is gone was left by a killed run; the next run takes it over.)
  RUN_PID="$(cat logs/.run.lock/pid 2>/dev/null)"
  [ -d logs/.run.lock ] && { [ -z "$RUN_PID" ] || ps -o stat= -p "$RUN_PID" 2>/dev/null | grep -qv Z; } && { tell "The agent is running. Lodestar will update when it's done."; exit 0; }

  LOCK="logs/.update.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ] || { tell "An update is already being installed."; exit 0; }
    rm -rf "$LOCK" && mkdir "$LOCK"
  fi
  trap 'rm -rf "$LOCK"; [ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT

  # Installs from before email tracking start the server through npm (`npm start`), which macOS won't let control
  # Mail. Rewrite that launch agent to run node itself (once; it restarts the server, so only when no agent run is
  # going). If restarting it failed, the marker has the next check try again.
  APP_PLIST="$HOME/Library/LaunchAgents/com.jobhunt.app.plist"
  RETRY="logs/.app-agent-retry"
  if [ -f "$APP_PLIST" ] && { [ "$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" "$APP_PLIST" 2>/dev/null)" = "start" ] || [ -f "$RETRY" ]; }; then
    if bash scripts/install-launchd.sh --app-only >>"$LOG" 2>&1; then rm -f "$RETRY"; log "Moved com.jobhunt.app to run node directly (needed for Apple Mail access)."
    else touch "$RETRY"; log "Couldn't restart com.jobhunt.app; trying again on the next check. Or run 'Install Job Hunt.command' again."; fi
  fi

  # Ask git for the branch head rather than the GitHub API: the API allows 60 unauthenticated calls an hour, and this
  # runs every minute. The API is the fallback for a Mac without git.
  if command -v git >/dev/null 2>&1; then
    LATEST="$(git ls-remote -q "https://github.com/$REPO.git" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  else
    LATEST="$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null)"
  fi
  # Offline or rate-limited; try again next time.
  [[ "$LATEST" =~ ^[0-9a-f]{40}$ ]] || { tell "Couldn't reach GitHub to check for updates. Try again later."; exit 0; }
  CURRENT="$(cat "$SHA_FILE" 2>/dev/null || true)"
  if [ "$LATEST" = "$CURRENT" ] && [ "$FORCE" = 0 ]; then
    refresh_app   # e.g. the first check after an update that came from an older copy of this script
    refresh_update_agent
    tell "Lodestar is up to date (${CURRENT:0:7})."
    exit 0
  fi

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

  # The app applies database migrations when it starts.
  launchctl kickstart -k "gui/$(id -u)/com.jobhunt.app" >>"$LOG" 2>&1 || log "Couldn't restart com.jobhunt.app; restart it or log out and back in."
  # Written after the restart: an open Lodestar window watches this file and reloads when it changes.
  echo "$LATEST" >"$SHA_FILE"
  refresh_app
  log "Updated to ${LATEST:0:7}."
  notify "Updated to the latest version."
  refresh_update_agent
}

main "$@"
