const path = require("path");
const { git } = require("./git.cjs");
const { findNode } = require("../scripts/update-helper.cjs");

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const QUIET = { env: { GCM_INTERACTIVE: "never" } };
const cache = new Map();
// An installed copy (scripts/install-mac.sh or scripts/install-windows.ps1) is not a git checkout; it learns about releases from GitHub.
const RELEASES = "https://api.github.com/repos/schmidtc63/grok-desktop/releases/latest";
function installCommand(platform = process.platform) {
	if (platform === "win32") { return "irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex"; }
	return "curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash";
}
const INSTALL_COMMAND = installCommand("darwin");

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

function latestTag(output) {
	let latest = null;
	for (const line of output.split(/\r?\n/)) {
		const ref = line.trim().split(/\s+/)[1];
		if (!ref?.startsWith("refs/tags/")) { continue; }
		const tag = ref.slice("refs/tags/".length);
		if (!TAG.test(tag) || !parseVersion(tag)) { continue; }
		const version = tag.slice(1);
		if (!latest || newer(version, latest.version)) { latest = { tag, version }; }
	}
	return latest;
}

async function latestRelease(fetchUrl) {
	const response = await fetchUrl(RELEASES, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
	if (response.status === 404) { return null; }
	if (!response.ok) { throw new Error(`GitHub answered ${response.status}.`); }
	const tag = (await response.json()).tag_name;
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
			result = releaseResult(await latestRelease(fetchUrl || fetch), current);
		} else {
			const root = await runGit(["rev-parse", "--show-toplevel"], appDir, 20000, QUIET);
			if (root.code !== 0 || path.resolve(root.out.trim()).toLowerCase() !== path.resolve(appDir).toLowerCase()) {
				result = { ok: true, available: false, reason: "not-checkout", current };
			} else {
				const remote = await runGit(["ls-remote", "--tags", "--refs", "origin"], appDir, 20000, QUIET);
				result = remote.code !== 0 ? { ok: false } : releaseResult(latestTag(remote.out), current);
			}
		}
	} catch {
		result = { ok: false };
	}
	cache.set(key, { at: Date.now(), result });
	return result;
}

async function updatePrepare(appDir, current, tag, { runGit = git, findNode: locateNode = findNode, platform = process.platform, packaged = false } = {}) {
	const info = { ok: true, ready: false, notes: "", current, latest: typeof tag === "string" ? tag.slice(1) : "", tag };
	const refuse = (reason) => ({ ...info, reason });
	if (typeof tag !== "string" || !TAG.test(tag) || !parseVersion(tag)) { return refuse("That release tag isn't valid."); }
	if (packaged) {
		const name = platform === "win32" ? "Windows" : "macOS";
		return { ...refuse(`This copy was installed with the ${name} install command.`), steps: installCommand(platform) };
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

module.exports = { TAG, INSTALL_COMMAND, installCommand, parseVersion, newer, latestTag, checkForUpdate, updatePrepare };
