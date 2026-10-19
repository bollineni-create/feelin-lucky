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

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Opening nodejs.org — install the LTS version, then double-click this file again."
  open "https://nodejs.org/en/download"
  exit 1
fi

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
echo "Done. Next time, open \"Job Hunt\" from Spotlight, Launchpad or the Dock."
echo "First stop: Settings — fill in and confirm your profile."
