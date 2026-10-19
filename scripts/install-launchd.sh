#!/usr/bin/env bash
# Installs three launch agents:
#   com.jobhunt.app     keeps the app running on 127.0.0.1:3000
#   com.jobhunt.daily   runs scripts/daily-run.sh at 7:00 AM, Monday–Friday
#   com.jobhunt.update  runs scripts/auto-update.sh every 15 minutes (installs new commits on main)
# launchd uses the Mac's local time zone; keep the Mac on Pacific time for 7:00 AM PT.
#   scripts/install-launchd.sh            install / reinstall
#   scripts/install-launchd.sh --remove   uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
APP_PLIST="$AGENTS/com.jobhunt.app.plist"
DAILY_PLIST="$AGENTS/com.jobhunt.daily.plist"
UPDATE_PLIST="$AGENTS/com.jobhunt.update.plist"
UID_NUM="$(id -u)"

unload() { launchctl bootout "gui/$UID_NUM" "$1" 2>/dev/null || true; }

if [ "${1:-}" = "--remove" ]; then
  unload "$APP_PLIST"; unload "$DAILY_PLIST"; unload "$UPDATE_PLIST"
  rm -f "$APP_PLIST" "$DAILY_PLIST" "$UPDATE_PLIST"
  echo "Removed launch agents."; exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "launchd is macOS only."; exit 1; }
NPM="$(command -v npm)" || { echo "npm not found"; exit 1; }
NODE_DIR="$(dirname "$(command -v node)")"
CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"
TZ_NAME="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
mkdir -p "$AGENTS" "$ROOT/logs"

DAYS=""
for d in 1 2 3 4 5; do
  DAYS+="    <dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
"
done

cat > "$APP_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunt.app</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key>
  <array><string>$NPM</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:$CLAUDE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/app.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/app.log</string>
</dict>
</plist>
PLIST

cat > "$DAILY_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunt.daily</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/scripts/daily-run.sh</string><string>--trigger</string><string>schedule</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:$CLAUDE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <array>
$DAYS  </array>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd-daily.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd-daily.log</string>
</dict>
</plist>
PLIST

cat > "$UPDATE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunt.update</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/scripts/auto-update.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd-update.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd-update.log</string>
</dict>
</plist>
PLIST

for p in "$APP_PLIST" "$DAILY_PLIST" "$UPDATE_PLIST"; do
  unload "$p"
  launchctl bootstrap "gui/$UID_NUM" "$p"
done
echo "Installed. App: http://127.0.0.1:3000 · daily run: weekdays 7:00 AM ($TZ_NAME) · updates from GitHub: checked every 15 minutes."
[ "$TZ_NAME" = "America/Los_Angeles" ] || echo "Note: this Mac isn't on Pacific time, so 7:00 AM is local time."
echo "Logs: $ROOT/logs/"
