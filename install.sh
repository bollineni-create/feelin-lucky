#!/usr/bin/env bash
# One-step install / update for Mac. Paste into Terminal:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/bollineni-create/feelin-lucky/refs/heads/claude/auto-apply-jobs-eppnao/install.sh)"
# Downloads the app into ~/JobHunt (keeping your data on updates), picks up my-profile.json and your
# resume/CV PDFs from Downloads, then runs "Install Job Hunt.command".
set -euo pipefail

REPO="bollineni-create/feelin-lucky"
BRANCH="${JOBHUNT_BRANCH:-claude/auto-apply-jobs-eppnao}"
DEST="${JOBHUNT_DIR:-$HOME/JobHunt}"

[ "$(uname)" = "Darwin" ] || { echo "This installer is for macOS."; exit 1; }
echo "==> Downloading Job Hunt into $DEST"
mkdir -p "$DEST"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components 1 -C "$DEST"

# The newest my-profile*.json in Downloads (browsers add " (1)" to repeat downloads).
PROFILE="$(ls -t "$HOME"/Downloads/my-profile*.json 2>/dev/null | head -1 || true)"
if [ -n "$PROFILE" ] && { [ ! -f "$DEST/my-profile.json" ] || [ "$PROFILE" -nt "$DEST/my-profile.json" ]; }; then
  cp "$PROFILE" "$DEST/my-profile.json"
  echo "==> Using your profile from $PROFILE"
fi

exec bash "$DEST/Install Job Hunt.command"
