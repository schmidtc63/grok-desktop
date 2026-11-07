#!/bin/bash
# Builds the macOS release zips into out/. Run npm ci and npm run build first. macOS only (codesign, plutil, ditto, hdiutil).
set -euo pipefail
cd "$(dirname "$0")/.."
name="Codewomplers Grok Desktop"
version="$(node -p 'require("./package.json").version')"
rm -rf out
mkdir out
# The .icns is committed: sips failed to write it on the GitHub macOS runner (Error 13, v0.6.0 release run).
# No asar archive: the update helper and the startup recovery read the app folder as plain files.
# Copy only node-pty's runtime after packaging; Vite bundles the renderer dependencies into dist/.
npx electron-packager . "$name" --platform=darwin --arch=arm64,x64 --icon=assets/codewomplers-grok-desktop.icns --app-bundle-id=com.codewomplers.grokdesktop --app-copyright="Copyright (c) 2026 Codewomplers" --out=out --no-asar --no-prune --ignore='^/(node_modules|src|out|\.github)(/|$)'
for arch in arm64 x64; do
	app="out/$name-darwin-$arch/$name.app"
	node scripts/package-node-pty.cjs "$app/Contents/Resources/app" darwin "$arch"
	# Packaging edits the bundle Electron shipped signed. Apple silicon runs only signed code, so sign it again ad hoc (no certificate).
	codesign --force --deep --sign - "$app"
	codesign --verify --deep --strict "$app"
	test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$version"
	test -f "$app/Contents/Resources/app/electron/main.cjs"
	test -f "$app/Contents/Resources/app/dist/index.html"
	# ditto keeps the symlinks inside Electron Framework.framework; zip -r would break them and the signature.
	ditto -c -k --keepParent "$app" "out/Codewomplers-Grok-Desktop-mac-$arch.zip"
	# A disk image with an Applications link: open it and drag the app across.
	mkdir "out/dmg-$arch"
	ditto "$app" "out/dmg-$arch/$name.app"
	ln -s /Applications "out/dmg-$arch/Applications"
	hdiutil create -volname "$name" -srcfolder "out/dmg-$arch" -ov -format UDZO "out/Codewomplers-Grok-Desktop-mac-$arch.dmg"
	hdiutil verify "out/Codewomplers-Grok-Desktop-mac-$arch.dmg"
done
