const path = require("path");
const { git } = require("./git.cjs");
const { findNode } = require("../scripts/update-helper.cjs");

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const QUIET = { env: { GCM_INTERACTIVE: "never" } };
const cache = new Map();

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

async function checkForUpdate(appDir, current, { force = false, runGit = git } = {}) {
	const key = `${path.resolve(appDir).toLowerCase()}\n${current}`;
	const previous = cache.get(key);
	if (!force && previous && Date.now() - previous.at < 60 * 60 * 1000) { return previous.result; }
	let result;
	try {
		const root = await runGit(["rev-parse", "--show-toplevel"], appDir, 20000, QUIET);
		if (root.code !== 0 || path.resolve(root.out.trim()).toLowerCase() !== path.resolve(appDir).toLowerCase()) {
			result = { ok: true, available: false, reason: "not-checkout", current };
		} else {
			const remote = await runGit(["ls-remote", "--tags", "--refs", "origin"], appDir, 20000, QUIET);
			if (remote.code !== 0) {
				result = { ok: false };
			} else {
				const release = latestTag(remote.out);
				result = !release ? { ok: true, available: false, reason: "no-releases", current }
					: { ok: true, available: newer(release.version, current), ...(!newer(release.version, current) ? { reason: "up-to-date" } : {}), current, latest: release.version, tag: release.tag };
			}
		}
	} catch {
		result = { ok: false };
	}
	cache.set(key, { at: Date.now(), result });
	return result;
}

async function updatePrepare(appDir, current, tag, { runGit = git, findNode: locateNode = findNode } = {}) {
	const info = { ok: true, ready: false, notes: "", current, latest: typeof tag === "string" ? tag.slice(1) : "", tag };
	const refuse = (reason) => ({ ...info, reason });
	if (typeof tag !== "string" || !TAG.test(tag) || !parseVersion(tag)) { return refuse("That release tag isn't valid."); }
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

module.exports = { TAG, parseVersion, newer, latestTag, checkForUpdate, updatePrepare };
