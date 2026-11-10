const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const { git } = require("./git.cjs");
const { findNode } = require("../scripts/update-helper.cjs");

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const QUIET = { env: { GCM_INTERACTIVE: "never" } };
const cache = new Map();
const RELEASES = "https://api.github.com/repos/schmidtc63/grok-desktop/releases/latest";
const RELEASE_API = "https://api.github.com/repos/schmidtc63/grok-desktop/releases/tags";
const RELEASE_FILES = "https://github.com/schmidtc63/grok-desktop/releases/download";
const RELEASE_PAGE = "https://github.com/schmidtc63/grok-desktop/releases/latest";
const APP_NAME = "Codewomplers Grok Desktop";
const LINUX_FOLDER = "Codewomplers-Grok-Desktop-linux-x64";
const LINUX_EXECUTABLE = "codewomplers-grok-desktop";
const DEB_ROOT = "/opt/codewomplers-grok-desktop";
const PKEXEC = "/usr/bin/pkexec";
const APT_GET = "/usr/bin/apt-get";
// Runs detached after the app has exited, so nothing is installed until the quit can no longer be cancelled.
// pkexec needs a living parent, which this shell is. With no controlling terminal, pkexec can't prompt in a terminal nobody is watching.
// It always reopens the app, so a failed step leaves the old copy running, and that copy's next launch reports it.
const SWAP_HELPER = `pid="$1"; app="$2"; staged="$3"; previous="$4"; artifact="$5"; sandbox="$6"; checksum="$7"; shift 7
tries=0
while kill -0 "$pid" 2>/dev/null; do
	tries=$((tries + 1))
	if [ "$tries" -gt 300 ]; then staged=""; artifact=""; sandbox=""; break; fi
	sleep 0.2
done
if [ -n "$artifact" ] && [ -z "$sandbox" ]; then
	${PKEXEC} /bin/sh -c '
		umask 077
		dir=$(mktemp -d /tmp/grok-update.XXXXXXXXXX) || exit 1
		trap "rm -rf -- \\"$dir\\"" 0
		[ -f "$1" ] && cp -P -- "$1" "$dir/update.deb" && [ ! -L "$dir/update.deb" ] || exit 1
		printf "%s  %s\\n" "$2" "$dir/update.deb" | sha256sum -c - || exit 1
		${APT_GET} install -y "$dir/update.deb"
	' sh "$artifact" "$checksum"
fi
if [ -n "$sandbox" ] && ! (
	cd "$staged" || exit 1
	stageId=$(stat -c %d:%i .) || exit 1
	replacement=$(${PKEXEC} /bin/sh -c '
		cd "$3" || exit 1
		[ "$(stat -c %u:%d:%i .)" = "$PKEXEC_UID:$4" ] || exit 1
		umask 077
		dir=$(mktemp -d /tmp/grok-update.XXXXXXXXXX) || exit 1
		trap "rm -rf -- \\"$dir\\"" 0
		[ -f "$1" ] && cp -P -- "$1" "$dir/update.tar.gz" && [ ! -L "$dir/update.tar.gz" ] || exit 1
		printf "%s  %s\\n" "$2" "$dir/update.tar.gz" | sha256sum --status -c - || exit 1
		tar -xOzf "$dir/update.tar.gz" -- "${LINUX_FOLDER}/chrome-sandbox" > "$dir/chrome-sandbox" || exit 1
		[ -s "$dir/chrome-sandbox" ] && chmod 4755 "$dir/chrome-sandbox" || exit 1
		# Copy into a new file in the pinned directory. The caller does the final rename without root privileges.
		name=.\${dir##*/}
		cp -nT --preserve=mode,ownership -- "$dir/chrome-sandbox" "$name" || exit 1
		printf "%s\\n" "$name"
	' sh "$artifact" "$checksum" "$staged" "$stageId") || exit 1
	[ "$(stat -c %u:%a -- "$replacement")" = 0:4755 ] && mv -fT -- "$replacement" chrome-sandbox
); then
	staged=""
fi
if [ -n "$staged" ] && mv "$app" "$previous"; then
	mv "$staged" "$app" || mv "$previous" "$app"
fi
exec "$@"
`;
function installCommand(platform = process.platform) {
	if (platform === "win32") { return "irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex"; }
	return "curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash";
}
const INSTALL_COMMAND = installCommand("darwin");
function updateSteps(platform = process.platform) {
	return platform === "linux" ? RELEASE_PAGE : installCommand(platform);
}
function updateInstructions(platform = process.platform) {
	if (platform === "linux") { return `To update, get the new package from ${RELEASE_PAGE}.`; }
	const steps = `To update, quit ${APP_NAME}, then run this in ${platform === "win32" ? "PowerShell" : "Terminal"}:\n${installCommand(platform)}`;
	return platform === "win32" ? `${steps}\n\nThis command installs in the standard folder. If you keep a zip copy elsewhere, download and extract the Windows zip from ${RELEASE_PAGE}.` : steps;
}

function parseVersion(text) {
	if (typeof text !== "string") { return null; }
	const tag = text.startsWith("v") ? text : `v${text}`;
	if (!TAG.test(tag)) { return null; }
	const parts = tag.slice(1).split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
}

function newer(a, b) {
	const left = Array.isArray(a) ? a : parseVersion(a);
	const right = Array.isArray(b) ? b : parseVersion(b);
	if (!left || !right) { return false; }
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) { return left[i] > right[i]; }
	}
	return false;
}

async function publishedRelease(fetchUrl, url = RELEASES) {
	const response = await fetchUrl(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
	if (response.status === 404) { return null; }
	if (!response.ok) { throw new Error(`GitHub answered ${response.status}.`); }
	const { tag_name: tag, draft, prerelease } = await response.json();
	if (draft || prerelease) { return null; }
	return typeof tag === "string" && TAG.test(tag) && parseVersion(tag) ? { tag, version: tag.slice(1) } : null;
}

function releaseResult(release, current) {
	if (!release) { return { ok: true, available: false, reason: "no-releases", current }; }
	const available = newer(release.version, current);
	return { ok: true, available, ...(!available ? { reason: "up-to-date" } : {}), current, latest: release.version, tag: release.tag };
}

async function checkForUpdate(appDir, current, { force = false, runGit = git, packaged = false, fetchUrl } = {}) {
	const key = `${path.resolve(appDir).toLowerCase()}\n${current}`;
	const previous = cache.get(key);
	if (!force && previous && Date.now() - previous.at < 60 * 60 * 1000) { return previous.result; }
	let result;
	try {
		if (packaged) {
			result = releaseResult(await publishedRelease(fetchUrl || fetch), current);
		} else {
			const root = await runGit(["rev-parse", "--show-toplevel"], appDir, 20000, QUIET);
			if (root.code !== 0 || path.resolve(root.out.trim()).toLowerCase() !== path.resolve(appDir).toLowerCase()) {
				result = { ok: true, available: false, reason: "not-checkout", current };
			} else {
				const release = await publishedRelease(fetchUrl || fetch);
				result = releaseResult(release, current);
				if (result.available) {
					const remote = await runGit(["ls-remote", "--exit-code", "--tags", "--refs", "origin", `refs/tags/${release.tag}`], appDir, 20000, QUIET);
					if (remote.code === 2) { result = releaseResult(null, current); }
					else if (remote.code !== 0) { result = { ok: false }; }
				}
			}
		}
	} catch {
		result = { ok: false };
	}
	cache.set(key, { at: Date.now(), result });
	return result;
}

// An install location follows its own system's path rules, whatever system the tests run on. Files under userData are the host's own.
function osPath(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

function installedRoot(platform, execPath) {
	return platform === "darwin" ? osPath(platform).resolve(execPath, "../../..") : osPath(platform).dirname(execPath);
}

function canWrite(folder) {
	try {
		fs.accessSync(folder, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// Which kind of installed copy this is, and the release file that updates it. Anything else gets the manual steps.
function updateTarget({ platform, arch, appRoot, home, localAppData, latest, exists = fs.existsSync, stat = fs.statSync, writable = canWrite }) {
	const paths = osPath(platform);
	const noAccess = { reason: "The app can't write to its own folder." };
	const noInstaller = { reason: "This system has no pkexec or apt-get, so the app can't install the package itself." };
	if (platform === "win32") {
		// Setup always installs here, so from any other folder, such as a zip copy's, it would add a second copy.
		const standard = paths.join(localAppData || "", "Programs", APP_NAME);
		if (!localAppData || paths.normalize(appRoot).toLowerCase() !== standard.toLowerCase()) { return { reason: "The app could not confirm that this copy is in the standard folder. To update a zip copy, download and extract the new Windows zip from the release page. The install command below targets the standard folder." }; }
		return { kind: "setup", asset: "Codewomplers-Grok-Desktop-Setup.exe" };
	}
	if (platform === "darwin") {
		// This also rejects the disk image, and a copy macOS moved to a temporary folder.
		const bundle = `${APP_NAME}.app`;
		if (![paths.join("/Applications", bundle), paths.join(home || "", "Applications", bundle)].includes(appRoot)) { return { reason: "This copy isn't in Applications, so it can't update itself." }; }
		if (!writable(paths.dirname(appRoot))) { return noAccess; }
		// macOS App Management can stop an app changing an installed app. Find out before touching anything, as scripts/install-mac.sh does.
		const check = paths.join(appRoot, "Contents", ".update-check");
		try {
			fs.writeFileSync(check, "");
			fs.unlinkSync(check);
		} catch {
			return { reason: "macOS stopped this app from changing itself. Allow it under System Settings > Privacy & Security > App Management, then try again." };
		}
		return { kind: "swap", asset: `Codewomplers-Grok-Desktop-mac-${arch}.zip` };
	}
	if (appRoot === DEB_ROOT) {
		if (!exists(PKEXEC) || !exists(APT_GET)) { return noInstaller; }
		return { kind: "deb", asset: `codewomplers-grok-desktop_${latest}_amd64.deb` };
	}
	const helper = paths.join(appRoot, "chrome-sandbox");
	if (!exists(helper) || !writable(appRoot) || !writable(paths.dirname(appRoot))) { return noAccess; }
	// A copy someone set up with sudo needs the same setup on the new copy. One that runs without it stays that way.
	const info = stat(helper);
	const sandbox = info.uid === 0 && (info.mode & 0o4000) !== 0;
	if (sandbox && !exists(PKEXEC)) { return noInstaller; }
	return { kind: "swap", asset: "Codewomplers-Grok-Desktop-linux-x64.tar.gz", sandbox };
}

function removeQuietly(target) {
	try {
		fs.rmSync(target, { recursive: true, force: true });
	} catch {}
}

async function fileHash(file) {
	const hash = crypto.createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); }
	return hash.digest("hex");
}

async function releaseNotes(fetchUrl, tag) {
	try {
		const response = await fetchUrl(`${RELEASE_API}/${tag}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
		if (!response.ok) { return ""; }
		const { body } = await response.json();
		return typeof body === "string" ? body.slice(0, 4000) : "";
	} catch {
		return "";
	}
}

async function releaseChecksum(fetchUrl, tag, asset) {
	const response = await fetchUrl(`${RELEASE_FILES}/${tag}/SHA256SUMS.txt`, { signal: AbortSignal.timeout(60000) });
	if (!response.ok) { return null; }
	for (const line of (await response.text()).split(/\r?\n/)) {
		const [hash, name] = line.trim().split(/\s+/);
		if (/^[0-9a-f]{64}$/i.test(hash ?? "") && name?.replace(/^\*/, "") === asset) { return hash.toLowerCase(); }
	}
	return null;
}

async function downloadFile(fetchUrl, url, file) {
	const response = await fetchUrl(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
	if (!response.ok || !response.body) { throw new Error(`GitHub answered ${response.status}.`); }
	const hash = crypto.createHash("sha256");
	await pipeline(response.body, async function* (source) {
		for await (const chunk of source) {
			hash.update(chunk);
			yield chunk;
		}
	}, fs.createWriteStream(file));
	return hash.digest("hex");
}

async function unpackUpdate({ platform, appRoot, file, folder, runTool }) {
	const paths = osPath(platform);
	const mac = platform === "darwin";
	// A Linux copy unpacks beside itself, on the same disk, so the swap is a rename that keeps chrome-sandbox's owner and mode.
	const parent = mac ? paths.join(folder, "new") : `${appRoot}.update`;
	const staged = paths.join(parent, mac ? `${APP_NAME}.app` : LINUX_FOLDER);
	const executable = mac ? paths.join(staged, "Contents", "MacOS", APP_NAME) : paths.join(staged, LINUX_EXECUTABLE);
	const previous = mac ? paths.join(folder, "previous.app") : `${appRoot}.update-previous`;
	const failed = (reason) => {
		removeQuietly(parent);
		return { reason };
	};
	try {
		fs.rmSync(parent, { recursive: true, force: true });
		fs.mkdirSync(parent, { recursive: true });
		if (mac) {
			await runTool("/usr/bin/ditto", ["-x", "-k", file, parent]);
		} else {
			await runTool("tar", ["-xzf", file, "-C", parent]);
		}
		if (!fs.existsSync(executable)) { return failed("The update couldn't be unpacked. Nothing was changed."); }
		if (!mac) {
			// The swap moves the whole folder, so it would take the user's own files out with the old copy.
			const shipped = new Set(fs.readdirSync(staged));
			if (fs.readdirSync(appRoot).some((name) => !shipped.has(name))) { return failed("This folder holds files that aren't part of the app, so it can't update itself."); }
		}
		removeQuietly(previous);
		return { staged, previous };
	} catch {
		return failed("The update couldn't be unpacked. Nothing was changed.");
	}
}

// Downloads, checks and unpacks while the app stays usable. Nothing the user runs changes here.
async function stageUpdate({ platform, appRoot, userData, current, tag, fetchUrl, runTool = (program, args) => promisify(execFile)(program, args, { timeout: 5 * 60 * 1000 }), ...rest }) {
	const latest = tag.slice(1);
	const target = updateTarget({ ...rest, platform, appRoot, latest });
	if (target.reason) { return target; }
	if (!newer(latest, current)) { return { reason: "That release isn't newer than this copy." }; }
	const getUrl = fetchUrl || fetch;
	const notes = await releaseNotes(getUrl, tag);
	const expected = await releaseChecksum(getUrl, tag, target.asset);
	if (!expected) { return { reason: "This release has no checksum, so it can't be checked." }; }
	const downloads = path.join(userData, "update-download");
	const folder = path.join(downloads, tag);
	const file = path.join(folder, target.asset);
	if (!fs.existsSync(file) || await fileHash(file) !== expected) {
		// Removal errors don't matter: a folder macOS won't let go of must not block later updates.
		removeQuietly(downloads);
		fs.mkdirSync(folder, { recursive: true });
		let digest;
		try {
			digest = await downloadFile(getUrl, `${RELEASE_FILES}/${tag}/${target.asset}`, file);
		} catch {
			removeQuietly(file);
			return { reason: "The update couldn't be downloaded." };
		}
		if (digest !== expected) {
			removeQuietly(file);
			return { reason: "The download was damaged. Nothing was changed." };
		}
	}
	const unpacked = target.kind === "swap" ? await unpackUpdate({ platform, appRoot, file, folder, runTool }) : {};
	if (unpacked.reason) { return unpacked; }
	const sandbox = target.sandbox === true;
	const asksPassword = target.kind === "deb" || sandbox;
	return { notes, asksPassword, kind: target.kind, file, staged: unpacked.staged, previous: unpacked.previous, sandbox, ...(asksPassword ? { checksum: expected } : {}) };
}

// The program that replaces an installed copy once the app has quit.
function installedUpdateCommand({ kind, appRoot, file, staged, previous, sandbox, checksum }, { platform, pid, userData, argv = [] }) {
	const paths = osPath(platform);
	if (kind === "setup") {
		// No /SUPPRESSMSGBOXES, so a file in use shows Setup's own Retry dialog instead of a silent stop.
		return { program: file, args: ["/SILENT", "/NORESTART", "/SP-", "/NOCANCEL", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS", "/RELAUNCH=1", `/WAITPID=${pid}`, `/LOG=${paths.join(userData, "update-setup.log")}`] };
	}
	const reopen = platform === "darwin" ? ["/usr/bin/open", appRoot] : [paths.join(appRoot, LINUX_EXECUTABLE), ...argv];
	return { program: "/bin/sh", args: ["-c", SWAP_HELPER, "sh", String(pid), appRoot, staged || "", previous || "", kind === "deb" || sandbox ? file : "", sandbox ? "1" : "", checksum || "", ...reopen] };
}

// Runs once per process, at startup. A window load must not do this: it would delete a staged update the user hasn't answered yet.
function removeUpdateFiles({ platform, appRoot, userData }) {
	removeQuietly(path.join(userData, "update-download"));
	if (platform === "linux") {
		removeQuietly(`${appRoot}.update`);
		removeQuietly(`${appRoot}.update-previous`);
	}
}

async function updatePrepare(appDir, current, tag, { runGit = git, findNode: locateNode = findNode, platform = process.platform, packaged = false, installed = {}, fetchUrl } = {}) {
	const info = { ok: true, ready: false, notes: "", current, latest: typeof tag === "string" ? tag.slice(1) : "", tag };
	const refuse = (reason) => ({ ...info, reason });
	if (typeof tag !== "string" || !TAG.test(tag) || !parseVersion(tag)) { return refuse("That release tag isn't valid."); }
	if (packaged) {
		const steps = updateSteps(platform);
		try {
			const staged = await stageUpdate({ ...installed, platform, current, tag });
			return staged.reason ? { ...refuse(staged.reason), steps } : { ...info, ready: true, ...staged };
		} catch {
			return { ...refuse("The update couldn't be downloaded."), steps };
		}
	}
	// ponytail: scripts/update-helper.cjs stops and relaunches the app with Windows tools only; port it before offering this elsewhere.
	if (platform !== "win32") { return refuse("On macOS and Linux, update by hand: quit the app, then in its folder run git pull, npm install and npm run desktop."); }
	const run = (args, timeout = 20000) => runGit(args, appDir, timeout, QUIET);
	try {
		const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (branch.code !== 0) { return refuse("Git couldn't read this copy's branch."); }
		if (branch.out.trim() !== "main") { return refuse(`This copy is on branch ${branch.out.trim()}, not main.`); }
		const status = await run(["status", "--porcelain", "--untracked-files=no"]);
		if (status.code !== 0) { return refuse("Git couldn't check this copy for changes."); }
		if (status.out.trim()) { return refuse("This copy has changes that aren't committed."); }
		const node = await locateNode();
		if (!node) { return refuse("Node.js isn't on PATH."); }
		const release = await publishedRelease(fetchUrl || fetch, `${RELEASE_API}/${tag}`);
		if (release?.tag !== tag) { return refuse("That release isn't published."); }
		const fetched = await run(["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`], 60000);
		if (fetched.code !== 0) { return refuse("The release couldn't be downloaded from this copy's origin."); }
		const compared = await run(["merge-base", "--is-ancestor", "HEAD", tag]);
		if (compared.code === 1) { return refuse("This copy has commits that aren't in the release."); }
		if (compared.code !== 0) { return refuse("Git couldn't compare this copy with the release."); }
		const packageFile = await run(["show", `${tag}:package.json`]);
		let version;
		try { version = JSON.parse(packageFile.out).version; } catch {}
		if (packageFile.code !== 0 || version !== info.latest) { return refuse("This release's version number doesn't match its tag."); }
		const notes = await run(["tag", "-l", "--format=%(contents)", tag]);
		const head = await run(["rev-parse", "HEAD"]);
		if (head.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(head.out.trim())) { return refuse("Git couldn't read this copy's commit."); }
		return { ...info, ready: true, notes: notes.code === 0 ? notes.out.trim().slice(0, 4000) : "", from: head.out.trim(), node };
	} catch {
		return refuse("The release couldn't be prepared. Try checking again.");
	}
}

module.exports = { TAG, INSTALL_COMMAND, SWAP_HELPER, installCommand, updateSteps, updateInstructions, installedRoot, installedUpdateCommand, removeUpdateFiles, parseVersion, newer, checkForUpdate, updatePrepare };
