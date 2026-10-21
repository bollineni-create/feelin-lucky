#!/usr/bin/env bash
# Builds "Lodestar.app" (the Job Hunt app) in /Applications, like Palimpsest, and keeps it in the Dock. (If this Mac
# account can't write to /Applications, it goes in ~/Applications instead.) Opening it starts the app server if it
# isn't already running (through the com.jobhunt.app launch agent when installed), checks GitHub for an update, and
# shows the app. With Apple's command line tools (xcode-select --install) it's a native window with its own menus,
# like Palimpsest (scripts/mac/JobHunt.swift); without them it opens the app in the default browser instead.
#   scripts/make-mac-app.sh               create / recreate the app
#   scripts/make-mac-app.sh --if-changed  only if the app's own files changed or it's in the old place (auto-update.sh)
#   scripts/make-mac-app.sh --remove      delete it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="${LODESTAR_APPS_DIR:-/Applications}"
[ -w "$APPS_DIR" ] || APPS_DIR="$HOME/Applications"
APP="$APPS_DIR/Lodestar.app"
# Earlier copies: ~/Applications before the move to /Applications, and "Job Hunt.app" before the rename.
OLD_APPS=("$HOME/Applications/Lodestar.app" "$HOME/Applications/Job Hunt.app")
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# Changes whenever the files the app is built from change, so the updater knows when to rebuild it.
HASH="$(cat "$ROOT/scripts/make-mac-app.sh" "$ROOT/scripts/mac/JobHunt.swift" "$ROOT/scripts/app-icon.svg" 2>/dev/null | shasum -a 256 | cut -c1-16)"
running() { pgrep -f "/Lodestar.app/Contents/MacOS/JobHunt" >/dev/null 2>&1 || pgrep -f "/Job Hunt.app/Contents/MacOS/JobHunt" >/dev/null 2>&1; }

if [ "${1:-}" = "--remove" ]; then rm -rf "$APP" "${OLD_APPS[@]}"; echo "Removed $APP (remove it from the Dock by dragging it out)"; exit 0; fi
[ "$(uname)" = "Darwin" ] || { echo "This builds a macOS app; run it on your Mac."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
NODE_DIR="$(dirname "$(command -v node)")"

IF_CHANGED=0
if [ "${1:-}" = "--if-changed" ]; then
  IF_CHANGED=1
  HAVE_ANY=0
  for a in "$APP" "${OLD_APPS[@]}"; do [ -d "$a" ] && HAVE_ANY=1; done
  [ "$HAVE_ANY" = 1 ] || exit 0   # never installed here, or deleted on purpose: leave it that way
  STALE=0
  for a in "${OLD_APPS[@]}"; do [ "$a" != "$APP" ] && [ -d "$a" ] && STALE=1; done
  if [ "$STALE" = 0 ] && [ -d "$APP" ] \
     && [ "$(/usr/libexec/PlistBuddy -c "Print :JobHuntAppHash" "$APP/Contents/Info.plist" 2>/dev/null)" = "$HASH" ] \
     && [ "$(/usr/libexec/PlistBuddy -c "Print :JobHuntFolder" "$APP/Contents/Info.plist" 2>/dev/null)" = "$ROOT" ]; then
    exit 0   # up to date, and nothing left in the old place
  fi
fi

WAS_RUNNING=0
if running; then WAS_RUNNING=1; fi
# A plain signal rather than "tell application to quit": that needs Automation permission when the updater runs it.
pkill -f "/Lodestar.app/Contents/MacOS/JobHunt" >/dev/null 2>&1 || true
pkill -f "/Job Hunt.app/Contents/MacOS/JobHunt" >/dev/null 2>&1 || true
for a in "${OLD_APPS[@]}"; do
  if [ "$a" != "$APP" ] && [ -d "$a" ]; then "$LSREGISTER" -u "$a" >/dev/null 2>&1 || true; rm -rf "$a"; fi
done
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Lodestar</string>
  <key>CFBundleDisplayName</key><string>Lodestar</string>
  <key>CFBundleIdentifier</key><string>com.jobhunt.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>JobHunt</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Lodestar reads the emails employers send about your applications and files them in a Lodestar mailbox.</string>
  <key>JobHuntFolder</key><string>__ROOT__</string>
  <key>JobHuntNodeDir</key><string>__NODE_DIR__</string>
  <key>JobHuntAppHash</key><string>__HASH__</string>
</dict>
</plist>
PLIST
sed -i '' -e "s#__ROOT__#$ROOT#" -e "s#__NODE_DIR__#$NODE_DIR#" -e "s#__HASH__#$HASH#" "$APP/Contents/Info.plist"

# Native window: needs swiftc from the command line tools. Checking xcode-select first avoids the
# "install developer tools?" pop-up that /usr/bin/swiftc shows when they're missing.
NATIVE=0
if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  echo "Compiling the Lodestar window app"
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
alert() { osascript -e "display alert \"Lodestar\" message \"$1\" as critical" >/dev/null 2>&1; }

if [ ! -d "$ROOT" ]; then alert "The Job Hunt folder moved or was deleted ($ROOT). Run 'Install Job Hunt.command' again from its new location."; exit 1; fi
# Check GitHub for an update in the background, like the window app does when it opens.
(nohup /bin/bash "$ROOT/scripts/auto-update.sh" >/dev/null 2>&1 &)
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

# Icon: the Lodestar north star on a teal tile, drawn with the system's own tools (no downloads).
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
"$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

# Keep it in the Dock (once; reinstalls leave the Dock alone). A tile for an earlier copy (~/Applications, or the old
# "Job Hunt.app") is pointed at this one, so it keeps its place; any extra ones are dropped.
# The edit goes through defaults export/import: macOS caches the Dock's settings, so editing the file directly can be lost.
APP_URL="file://${APP// /%20}/"
DOCK="$(mktemp)"
defaults export com.apple.dock "$DOCK" 2>/dev/null || true
DOCK_CHANGED=0
HAS_TILE=0
i=0
while URL_I="$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$DOCK" 2>/dev/null)" \
   || /usr/libexec/PlistBuddy -c "Print :persistent-apps:$i" "$DOCK" >/dev/null 2>&1; do
  if [ "$URL_I" = "$APP_URL" ] && [ "$HAS_TILE" = 0 ]; then
    HAS_TILE=1
  elif [[ "$URL_I" == *"/Job%20Hunt.app/" || "$URL_I" == *"/Lodestar.app/" ]]; then
    if [ "$HAS_TILE" = 0 ]; then
      # The bookmark ("book") still points at the old copy; without it the Dock goes by the URL.
      /usr/libexec/PlistBuddy -c "Set :persistent-apps:$i:tile-data:file-data:_CFURLString $APP_URL" "$DOCK"
      /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i:tile-data:book" "$DOCK" 2>/dev/null || true
      /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i:tile-data:file-label" "$DOCK" 2>/dev/null || true
      HAS_TILE=1
      i=$((i + 1))
    else
      /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i" "$DOCK"
    fi
    DOCK_CHANGED=1
  else
    i=$((i + 1))
  fi
  URL_I=""
done
if [ "$DOCK_CHANGED" = 1 ]; then defaults import com.apple.dock "$DOCK"; fi
rm -f "$DOCK"
# The updater never adds one: no tile there means it was dragged out of the Dock.
if [ "$NATIVE" = 1 ] && [ "$HAS_TILE" = 0 ] && [ "$IF_CHANGED" = 0 ]; then
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$APP_URL</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  DOCK_CHANGED=1
  echo "Added Lodestar to the Dock"
fi
if [ "$DOCK_CHANGED" = 1 ]; then killall Dock 2>/dev/null || true; fi

echo "Created $APP"
# An update rebuilt it while it was open: open the new one.
if [ "$IF_CHANGED" = 1 ] && [ "$WAS_RUNNING" = 1 ]; then open "$APP" || true; exit 0; fi
[ "$IF_CHANGED" = 1 ] && exit 0
if [ "$NATIVE" = 1 ]; then
  echo "Click Lodestar in the Dock to open it in its own window."
else
  echo "Open it from Launchpad or Spotlight (\"Lodestar\"). For its own window and a Dock icon, run"
  echo "  xcode-select --install"
  echo "then run the installer again."
fi
