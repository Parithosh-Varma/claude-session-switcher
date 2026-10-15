#!/bin/bash
# Build a Firefox-loadable copy of the extension into firefox/build/.
# Run from the repo root: ./firefox/make-firefox.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/firefox/build"
rm -rf "$BUILD"
mkdir -p "$BUILD/icons"
cp "$ROOT/firefox/manifest.json" "$BUILD/manifest.json"
cp "$ROOT/popup.html" "$ROOT/popup.js" "$ROOT/shared.js" "$ROOT/background.js" "$ROOT/firefox/firefox-shim.js" "$BUILD/"
cp "$ROOT"/icons/*.png "$BUILD/icons/"
# Load the shim before shared core in the popup.
sed -i.bak 's|<script src="shared.js">|<script src="firefox-shim.js"></script><script src="shared.js">|' "$BUILD/popup.html" && rm "$BUILD/popup.html.bak"
# background.scripts already loads shared.js first; drop the worker-only import.
sed -i.bak '/^importScripts("shared.js");$/d' "$BUILD/background.js" && rm "$BUILD/background.js.bak"
echo "Firefox build ready in firefox/build — load via about:debugging → This Firefox → Load Temporary Add-on → manifest.json"
