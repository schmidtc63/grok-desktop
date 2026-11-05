#!/bin/bash
# Builds the macOS release zips into out/. Run npm ci and npm run build first. macOS only (sips, codesign, ditto).
set -euo pipefail
cd "$(dirname "$0")/.."
name="Codewomplers Grok Desktop"
version="$(node -p 'require("./package.json").version')"
rm -rf out
mkdir out
sips -z 1024 1024 assets/codewomplers-grok-desktop.png --out out/icon.png >/dev/null
sips -s format icns out/icon.png --out out/icon.icns >/dev/null
# No asar archive: the update helper and the startup recovery read the app folder as plain files.
# node_modules stays out: the main process needs only Node built-ins and Electron, and Vite bundles the page into dist/.
npx electron-packager . "$name" --platform=darwin --arch=arm64,x64 --icon=out/icon.icns --app-bundle-id=com.codewomplers.grokdesktop --app-copyright="Copyright (c) 2026 Codewomplers" --out=out --no-asar --no-prune --ignore='^/(node_modules|src|out|\.github)(/|$)'
for arch in arm64 x64; do
	app="out/$name-darwin-$arch/$name.app"
	# Packaging edits the bundle Electron shipped signed. Apple silicon runs only signed code, so sign it again ad hoc (no certificate).
	codesign --force --deep --sign - "$app"
	codesign --verify --deep --strict "$app"
	test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$version"
	test -f "$app/Contents/Resources/app/electron/main.cjs"
	test -f "$app/Contents/Resources/app/dist/index.html"
	# ditto keeps the symlinks inside Electron Framework.framework; zip -r would break them and the signature.
	ditto -c -k --keepParent "$app" "out/Codewomplers-Grok-Desktop-mac-$arch.zip"
done
