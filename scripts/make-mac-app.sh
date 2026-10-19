#!/usr/bin/env bash
# Builds "Job Hunt.app" in ~/Applications and keeps it in the Dock. Opening it starts the app server if it
# isn't already running (through the com.jobhunt.app launch agent when installed) and shows the app.
# With Apple's command line tools (xcode-select --install) it's a native window with its own menus, like
# Palimpsest (scripts/mac/JobHunt.swift); without them it opens the app in the default browser instead.
#   scripts/make-mac-app.sh            create / recreate the app
#   scripts/make-mac-app.sh --remove   delete it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/Applications/Job Hunt.app"

if [ "${1:-}" = "--remove" ]; then rm -rf "$APP"; echo "Removed $APP (remove it from the Dock by dragging it out)"; exit 0; fi
[ "$(uname)" = "Darwin" ] || { echo "This builds a macOS app; run it on your Mac."; exit 1; }
NODE_DIR="$(dirname "$(command -v node)")" || { echo "node not found"; exit 1; }

osascript -e 'tell application id "com.jobhunt.launcher" to quit' >/dev/null 2>&1 || true
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Job Hunt</string>
  <key>CFBundleDisplayName</key><string>Job Hunt</string>
  <key>CFBundleIdentifier</key><string>com.jobhunt.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>JobHunt</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>JobHuntFolder</key><string>__ROOT__</string>
  <key>JobHuntNodeDir</key><string>__NODE_DIR__</string>
</dict>
</plist>
PLIST
sed -i '' -e "s#__ROOT__#$ROOT#" -e "s#__NODE_DIR__#$NODE_DIR#" "$APP/Contents/Info.plist"

# Native window: needs swiftc from the command line tools. Checking xcode-select first avoids the
# "install developer tools?" pop-up that /usr/bin/swiftc shows when they're missing.
NATIVE=0
if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  echo "Compiling the Job Hunt window app"
  if xcrun swiftc -O -o "$APP/Contents/MacOS/JobHunt" "$ROOT/scripts/mac/JobHunt.swift"; then NATIVE=1; fi
fi

if [ "$NATIVE" = 0 ]; then
# No compiler: a small launcher that opens the app in the browser. It has no window of its own, so keep it out of the Dock.
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist"
# Paths are fixed at build time: apps opened from Finder get a bare PATH.
cat > "$APP/Contents/MacOS/JobHunt" <<LAUNCHER
#!/bin/bash
ROOT="$ROOT"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
LAUNCHER
cat >> "$APP/Contents/MacOS/JobHunt" <<'LAUNCHER'
URL="http://127.0.0.1:3000"
up() { curl -s -o /dev/null --max-time 2 "$URL"; }
alert() { osascript -e "display alert \"Job Hunt\" message \"$1\" as critical" >/dev/null 2>&1; }

if [ ! -d "$ROOT" ]; then alert "The Job Hunt folder moved or was deleted ($ROOT). Run 'Install Job Hunt.command' again from its new location."; exit 1; fi
if ! up; then
  if [ -f "$HOME/Library/LaunchAgents/com.jobhunt.app.plist" ]; then
    launchctl kickstart "gui/$(id -u)/com.jobhunt.app" >/dev/null 2>&1 \
      || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jobhunt.app.plist" >/dev/null 2>&1
  else
    mkdir -p "$ROOT/logs"
    (cd "$ROOT" && nohup npm start >>"$ROOT/logs/app.log" 2>&1 &)
  fi
  for _ in $(seq 60); do up && break; sleep 1; done
fi
if up; then open "$URL"; else alert "The app didn't start within a minute. Details are in $ROOT/logs/app.log"; exit 1; fi
LAUNCHER
chmod +x "$APP/Contents/MacOS/JobHunt"
fi

# Icon: a teal tile with "JH", drawn with the system's own tools (no downloads).
ICON_SRC="$ROOT/scripts/app-icon.svg"
if [ -f "$ICON_SRC" ]; then
  TMP="$(mktemp -d)"
  if qlmanage -t -s 1024 -o "$TMP" "$ICON_SRC" >/dev/null 2>&1 && [ -f "$TMP/app-icon.svg.png" ]; then
    SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
    for s in 16 32 128 256 512; do
      sips -z $s $s "$TMP/app-icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s * 2)) $((s * 2)) "$TMP/app-icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || true
  fi
  rm -rf "$TMP"
fi
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

# Keep it in the Dock (once; reinstalls leave the Dock alone).
if [ "$NATIVE" = 1 ] && ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Job%20Hunt.app"; then
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${APP// /%20}/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock 2>/dev/null || true
  echo "Added Job Hunt to the Dock"
fi

echo "Created $APP"
if [ "$NATIVE" = 1 ]; then
  echo "Click Job Hunt in the Dock to open it in its own window."
else
  echo "Open it from Launchpad or Spotlight (\"Job Hunt\"). For its own window and a Dock icon, run"
  echo "  xcode-select --install"
  echo "then run the installer again."
fi
