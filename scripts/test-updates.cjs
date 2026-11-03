const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

const file = path.resolve(__dirname, "../electron/updates.cjs");
const localRequire = createRequire(file);
const moduleState = { exports: {} };
let now = 0;
vm.runInNewContext(fs.readFileSync(file, "utf8"), {
	module: moduleState, Date: { now: () => now },
	require(name) {
		if (name === "../scripts/update-helper.cjs") { return { findNode: async () => process.execPath }; }
		return localRequire(name);
	},
});
const { parseVersion, newer, latestTag, checkForUpdate, updatePrepare } = moduleState.exports;
const appDir = path.resolve(__dirname, "..");
const sha = "a".repeat(40);
const replies = {
	"rev-parse --show-toplevel": appDir,
	"ls-remote --tags --refs origin": "abc\trefs/tags/v0.10.0\nabc\trefs/tags/v0.9.0",
	"rev-parse --abbrev-ref HEAD": "main",
	"status --porcelain --untracked-files=no": "",
	"fetch --no-tags origin refs/tags/v0.10.0:refs/tags/v0.10.0": "",
	"merge-base --is-ancestor HEAD v0.10.0": "",
	"show v0.10.0:package.json": '{"version":"0.10.0"}',
	"tag -l --format=%(contents) v0.10.0": "First note\nSecond note",
	"rev-parse HEAD": sha,
};

function runner(overrides = {}) {
	const calls = [];
	const runGit = async (args, cwd, timeout, options) => {
		calls.push(args.join(" "));
		assert.equal(cwd, appDir);
		assert.equal(options.env.GCM_INTERACTIVE, "never");
		assert.equal(timeout, args[0] === "fetch" ? 60000 : 20000);
		const answer = { ...replies, ...overrides }[args.join(" ")];
		assert.notEqual(answer, undefined, `Unexpected git command ${args.join(" ")}`);
		return typeof answer === "string" ? { code: 0, out: answer } : answer;
	};
	return { runGit, calls };
}

async function checkRelease(overrides, current = "0.9.0") {
	return checkForUpdate(appDir, current, { ...runner(overrides), force: true });
}

async function checkPrepare(overrides = {}, findNode = async () => process.execPath, tag = "v0.10.0") {
	const stub = runner(overrides);
	return { result: await updatePrepare(appDir, "0.9.0", tag, { ...stub, findNode }), calls: stub.calls };
}

function checkEnvironment() {
	const gitFile = path.resolve(__dirname, "../electron/git.cjs");
	const gitRequire = createRequire(gitFile);
	const state = { exports: {} };
	const environments = [];
	vm.runInNewContext(fs.readFileSync(gitFile, "utf8"), {
		module: state, process, Buffer, setTimeout, clearTimeout,
		require(name) {
			if (name !== "child_process") { return gitRequire(name); }
			return { spawn(_command, _args, options) {
				environments.push(options.env);
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				process.nextTick(() => child.emit("close", 0));
				return child;
			} };
		},
	});
	return (async () => {
		await state.exports.git(["status"], appDir, 1000, { env: { GCM_INTERACTIVE: "never" } });
		await state.exports.git(["status"], appDir, 1000);
		assert.equal(environments[0].GCM_INTERACTIVE, "never");
		assert.equal(environments[1].GCM_INTERACTIVE, process.env.GCM_INTERACTIVE);
		assert.equal(environments[0].GIT_TERMINAL_PROMPT, "0");
	})();
}

async function main() {
	assert.equal(JSON.stringify(parseVersion("0.2.0")), "[0,2,0]");
	assert.equal(JSON.stringify(parseVersion("v0.2.0")), "[0,2,0]");
	for (const value of ["v1.2", "1.2.3-beta", "v01.2.3", "a", null]) { assert.equal(parseVersion(value), null); }
	assert.equal(newer("0.10.0", "0.9.0"), true);
	assert.equal(newer([1, 0, 0], [0, 99, 99]), true);
	assert.equal(newer("0.9.0", "0.9.0"), false);
	assert.equal(newer("0.9.0", "0.10.0"), false);
	assert.equal(latestTag(""), null);
	assert.equal(latestTag("a refs/tags/v1.2\na refs/tags/v9.0.0-beta\na refs/tags/other"), null);
	assert.equal(latestTag(`${replies["ls-remote --tags --refs origin"]}\na refs/tags/v9.0.0^{}`).tag, "v0.10.0");
	assert.equal((await checkRelease({ "rev-parse --show-toplevel": { code: 1 } })).reason, "not-checkout");
	assert.equal((await checkRelease({ "rev-parse --show-toplevel": path.dirname(appDir) })).reason, "not-checkout");
	assert.equal((await checkRelease({ "ls-remote --tags --refs origin": "" })).reason, "no-releases");
	assert.equal((await checkRelease({}, "0.10.0")).reason, "up-to-date");
	assert.equal((await checkRelease({ "ls-remote --tags --refs origin": { code: 1 } })).ok, false);
	assert.equal((await checkRelease({})).latest, "0.10.0");
	const cached = runner();
	await checkForUpdate(appDir, "0.9.0", cached);
	assert.equal(cached.calls.length, 0);
	now += 60 * 60 * 1000 + 1;
	await checkForUpdate(appDir, "0.9.0", cached);
	assert.equal(cached.calls.length, 2);
	await checkForUpdate(appDir, "0.9.0", { ...cached, force: true });
	assert.equal(cached.calls.length, 4);
	assert.equal((await checkPrepare({}, undefined, "v0.10.0;evil")).calls.length, 0);
	for (const [overrides, reason] of [
		[{ "rev-parse --abbrev-ref HEAD": "feature" }, "on branch feature"],
		[{ "status --porcelain --untracked-files=no": " M a.txt" }, "aren't committed"],
		[{ "fetch --no-tags origin refs/tags/v0.10.0:refs/tags/v0.10.0": { code: 1 } }, "couldn't be downloaded"],
		[{ "merge-base --is-ancestor HEAD v0.10.0": { code: 1 } }, "aren't in the release"],
		[{ "merge-base --is-ancestor HEAD v0.10.0": { code: 128 } }, "couldn't compare"],
		[{ "show v0.10.0:package.json": '{"version":"0.9.0"}' }, "doesn't match"],
	]) {
		const { result, calls } = await checkPrepare(overrides);
		assert.equal(result.ready, false);
		assert.ok(result.reason.includes(reason), result.reason);
		if (reason === "on branch feature" || reason === "aren't committed") { assert.equal(calls.some((call) => call.startsWith("fetch")), false); }
	}
	const missingNode = await checkPrepare({}, async () => null);
	assert.equal(missingNode.result.reason, "Node.js isn't on PATH.");
	assert.equal(missingNode.calls.some((call) => call.startsWith("fetch")), false);
	const prepared = await checkPrepare({ "tag -l --format=%(contents) v0.10.0": "n".repeat(4500) });
	assert.equal(prepared.result.ready, true);
	assert.equal(prepared.result.from, sha);
	assert.equal(prepared.result.node, process.execPath);
	assert.equal(prepared.result.notes.length, 4000);
	await checkEnvironment();
	console.log("Update release and readiness tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
