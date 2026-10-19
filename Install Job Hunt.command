#!/usr/bin/env bash
# Double-click in Finder to install Job Hunt on this Mac: dependencies, database, build,
# the always-on app server + weekday 7:00 AM agent run, and "Job Hunt.app" in ~/Applications.
# Safe to run again after pulling updates.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
finish() { echo; read -r -p "Press Return to close this window." _ || true; }
trap finish EXIT

# Use Node.js if it's already here (PATH, nvm, Volta, or a copy from an earlier install);
# otherwise download the official Node.js 22 LTS into .node/ in this folder. No admin password needed.
NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="$PWD/.node/bin:$HOME/.volta/bin:${NVM_NODE:+$NVM_NODE:}$PATH"
if ! command -v node >/dev/null 2>&1; then
  step "Downloading Node.js (one time, about 50 MB)"
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  OS="${NODE_OS:-darwin}"
  BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(printf '%s\n' "$SUMS" | awk -v f="-$OS-$ARCH.tar.gz" '$2 ~ f"$" {print $2}')"
  [ -n "$FILE" ] || { echo "Couldn't find a Node.js download for $OS-$ARCH."; exit 1; }
  TMP="$(mktemp -d)"
  curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $FILE\$" | shasum -a 256 -c -) || { echo "Download checksum didn't match; try again."; exit 1; }
  rm -rf .node && mkdir .node && tar -xzf "$TMP/$FILE" -C .node --strip-components 1
  rm -rf "$TMP"
fi
echo "Using Node.js $(node -v) from $(dirname "$(command -v node)")"

step "Installing dependencies (a few minutes the first time)"
npm install

step "Setting up the database"
npm run setup

step "Building the app"
npm run build

step "Keeping the app running and scheduling the daily agent"
bash scripts/install-launchd.sh   # (re)loads the server, so it serves this build

step "Creating Job Hunt.app"
bash scripts/make-mac-app.sh

step "Opening Job Hunt"
open "$HOME/Applications/Job Hunt.app"
echo "Done. Next time, click Job Hunt in the Dock (or find it with Spotlight)."
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ] && [ ! -x "$HOME/.claude/local/claude" ]; then
  echo
  echo "One thing left for the agent to search and apply: install Claude Code and sign in."
  echo "  curl -fsSL https://claude.ai/install.sh | bash   then run: claude"
  echo "Then add the Claude in Chrome extension to Chrome and connect it."
fi
