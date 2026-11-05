#!/bin/bash
# Installs or updates Codewomplers Grok Desktop on macOS:
#   curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash
# Add `-s -- vX.Y.Z` after bash to install that release instead of the latest.
# curl adds no quarantine mark, so Gatekeeper does not stop this unsigned app at its first launch.
set -euo pipefail

# Everything runs from main, so a download that stops partway through this script runs nothing.
main() {
	local repo="schmidtc63/grok-desktop"
	local app="Codewomplers Grok Desktop.app"
	# work stays global: the EXIT trap runs after main has returned.
	local arch release dest
	if [ "$(uname -s)" != "Darwin" ]; then
		echo "This installer is for macOS." >&2
		exit 1
	fi
	# hw.optional.arm64 is 1 on Apple silicon even when this shell runs under Rosetta.
	if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then arch="arm64"; else arch="x64"; fi
	release="latest/download"
	if [ -n "${1:-}" ]; then release="download/$1"; fi
	dest="/Applications"
	if [ ! -w "$dest" ]; then
		dest="$HOME/Applications"
		mkdir -p "$dest"
	fi
	work="$(mktemp -d)"
	trap 'rm -rf "$work"' EXIT
	curl -fL --progress-bar -o "$work/app.zip" "https://github.com/$repo/releases/$release/Codewomplers-Grok-Desktop-mac-$arch.zip"
	ditto -x -k "$work/app.zip" "$work"
	# pgrep -f matches the full path; plain names are cut to 16 characters on macOS.
	if pgrep -f "/$app/Contents/MacOS/" >/dev/null; then
		echo "Quit Codewomplers Grok Desktop, then run this again." >&2
		exit 1
	fi
	if [ -d "$dest/$app" ]; then
		# macOS App Management can stop Terminal from changing an installed app. Find out before touching it.
		if ! touch "$dest/$app/Contents/.install-check" 2>/dev/null; then
			echo "macOS stopped Terminal from changing the installed app. Allow Terminal under System Settings > Privacy & Security > App Management, then run this again." >&2
			exit 1
		fi
		rm -f "$dest/$app/Contents/.install-check"
		mv "$dest/$app" "$work/previous.app"
	fi
	if ! mv "$work/$app" "$dest/"; then
		if [ -d "$work/previous.app" ]; then mv "$work/previous.app" "$dest/$app"; fi
		echo "The app couldn't be moved into $dest." >&2
		exit 1
	fi
	echo "Installed $dest/$app. Open it from Launchpad, Spotlight or the Applications folder."
}

main "$@"
