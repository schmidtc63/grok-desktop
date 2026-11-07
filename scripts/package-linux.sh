#!/bin/bash
# Builds Linux x64 releases from dist/ and node-pty's Linux source build. Run npm ci and npm run build first.
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
	printf '%s\n' 'Build the Linux x64 packages on Linux x86-64.' >&2
	exit 1
fi
for tool in node python3 curl sha256sum tar dpkg-deb install; do
	command -v "$tool" >/dev/null
done
for file in package.json package-lock.json dist/index.html electron/main.cjs assets/codewomplers-grok-desktop.png scripts/update-helper.cjs scripts/package-node-pty.cjs node_modules/node-pty/build/Release/pty.node LICENSE; do
	test -f "$file"
done

version="$(python3 - <<'PY'
import json
import re

with open("package.json", encoding="utf-8") as source:
	version = json.load(source)["version"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
	raise SystemExit("package.json must name a release version.")
print(version)
PY
)"
electron_version="$(python3 - <<'PY'
import json
import re

with open("package-lock.json", encoding="utf-8") as source:
	version = json.load(source)["packages"]["node_modules/electron"]["version"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
	raise SystemExit("package-lock.json must pin an exact Electron version.")
print(version)
PY
)"

build="$(mktemp -d "${TMPDIR:-/tmp}/grok-linux.XXXXXX")"
trap 'rm -rf -- "$build"' EXIT
archive="electron-v${electron_version}-linux-x64.zip"
release="https://github.com/electron/electron/releases/download/v${electron_version}"
curl --fail --location --retry 3 "$release/$archive" --output "$build/$archive"
curl --fail --location --retry 3 "$release/SHASUMS256.txt" --output "$build/SHASUMS256.txt"
python3 - "$build/SHASUMS256.txt" "$archive" > "$build/electron.sha256" <<'PY'
import re
import sys

with open(sys.argv[1], encoding="utf-8") as source:
	for line in source:
		parts = line.split()
		if len(parts) == 2 and parts[1].lstrip("*") == sys.argv[2] and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
			print(f"{parts[0]}  {sys.argv[2]}")
			break
	else:
		raise SystemExit("Electron's checksum list does not contain the Linux archive.")
PY
(cd "$build" && sha256sum --check electron.sha256)

folder="Codewomplers-Grok-Desktop-linux-x64"
app="$build/$folder"
python3 - "$build/$archive" "$app" <<'PY'
import os
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
	archive.extractall(sys.argv[2])
	for entry in archive.infolist():
		mode = (entry.external_attr >> 16) & 0o777
		if mode:
			os.chmod(os.path.join(sys.argv[2], entry.filename), mode)
PY
mv -- "$app/electron" "$app/codewomplers-grok-desktop"
mkdir -p "$app/resources/app/scripts"
cp -a -- dist electron assets package.json LICENSE "$app/resources/app/"
cp -- scripts/update-helper.cjs "$app/resources/app/scripts/"
python3 - "$app/resources/app" <<'PY'
import os
import sys

for root, directories, files in os.walk(sys.argv[1]):
	os.chmod(root, 0o755)
	for name in files:
		os.chmod(os.path.join(root, name), 0o644)
PY
node scripts/package-node-pty.cjs "$app/resources/app" linux x64
test -x "$app/codewomplers-grok-desktop"
test -f "$app/chrome-sandbox"
test -f "$app/resources/app/dist/index.html"
test -f "$app/resources/app/electron/main.cjs"

payload="$build/debian"
mkdir -p "$payload/DEBIAN" "$payload/opt/codewomplers-grok-desktop" "$payload/usr/bin"
cp -a -- "$app/." "$payload/opt/codewomplers-grok-desktop/"
ln -s /opt/codewomplers-grok-desktop/codewomplers-grok-desktop "$payload/usr/bin/codewomplers-grok-desktop"
install -Dm644 assets/codewomplers-grok-desktop.png "$payload/usr/share/pixmaps/codewomplers-grok-desktop.png"
mkdir -p "$payload/usr/share/applications"
cat > "$payload/usr/share/applications/codewomplers-grok-desktop.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Codewomplers Grok Desktop
Comment=Unofficial desktop app for the Grok CLI
Exec=codewomplers-grok-desktop
Icon=codewomplers-grok-desktop
Terminal=false
Categories=Development;IDE;
DESKTOP
cat > "$payload/DEBIAN/control" <<CONTROL
Package: codewomplers-grok-desktop
Version: $version
Section: devel
Priority: optional
Architecture: amd64
Maintainer: Codewomplers
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxss1, libxtst6, libxkbcommon0, libdrm2, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0, xdg-utils
Description: Unofficial desktop app for the Grok CLI
 Chat, file editing, diffs, terminals and a browser pane for local coding tasks.
CONTROL
cat > "$payload/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
case "$1" in
	configure)
		chown root:root /opt/codewomplers-grok-desktop/chrome-sandbox
		chmod 4755 /opt/codewomplers-grok-desktop/chrome-sandbox
		;;
esac
exit 0
POSTINST
chmod 755 "$payload/DEBIAN/postinst"

tar_name="Codewomplers-Grok-Desktop-linux-x64.tar.gz"
deb_name="codewomplers-grok-desktop_${version}_amd64.deb"
tar --owner=0 --group=0 --numeric-owner -C "$build" -czf "$build/$tar_name" "$folder"
dpkg-deb --build --root-owner-group "$payload" "$build/$deb_name"
mkdir -p out
mv -f -- "$build/$tar_name" "out/$tar_name"
mv -f -- "$build/$deb_name" "out/$deb_name"
printf 'Built out/%s and out/%s with Electron %s.\n' "$tar_name" "$deb_name" "$electron_version"
