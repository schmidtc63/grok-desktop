const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const { main, markerLive, readMarker, findNode, writeAtomic, renameRetry, run } = require("./update-helper.cjs");

// The helper stops and relaunches the app with Windows tools, and updatePrepare offers it only on Windows (test-updates checks that).
if (process.platform !== "win32") {
	console.log("SKIP update helper checks: the in-app updater runs on Windows only");
	process.exit(0);
}

const tempBase = os.tmpdir();
const root = fs.mkdtempSync(path.join(tempBase, "codex-update-helper-tests-"));
let serial = 0;

function git(repo, args) {
	return execFileSync("git", ["-c", "core.hooksPath=NUL", ...args], { cwd: repo, windowsHide: true, encoding: "utf8", stdio: "pipe" }).trim();
}

function write(file, contents) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

function fixture() {
	const appDir = path.join(root, `case-${++serial}`);
	const userData = path.join(appDir, "profile");
	fs.mkdirSync(userData, { recursive: true });
	git(appDir, ["init", "--quiet", "-b", "main"]);
	git(appDir, ["config", "user.email", "fixture@example.invalid"]);
	git(appDir, ["config", "user.name", "Update fixture"]);
	write(path.join(appDir, ".gitignore"), "node_modules*\ndist*\nprofile\n");
	write(path.join(appDir, "package.json"), "{\"version\":\"0.2.0\"}");
	write(path.join(appDir, "scripts", "windows-name.mjs"), "process.exitCode = 0;\n");
	git(appDir, ["add", "."]);
	git(appDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "original"]);
	const from = git(appDir, ["rev-parse", "HEAD"]);
	git(appDir, ["switch", "--quiet", "-c", "release"]);
	write(path.join(appDir, "package.json"), "{\"version\":\"0.2.1\"}");
	git(appDir, ["commit", "--quiet", "--no-gpg-sign", "-am", "release"]);
	git(appDir, ["tag", "v0.2.1"]);
	const target = git(appDir, ["rev-parse", "HEAD"]);
	git(appDir, ["switch", "--quiet", "main"]);
	write(path.join(appDir, "node_modules", "sentinel"), "original packages");
	write(path.join(appDir, "node_modules", "electron", "dist", "electron.exe"), "original binary");
	write(path.join(appDir, "dist", "index.html"), "original page");
	const options = { appDir, userData, tag: "v0.2.1", from, fromVersion: "0.2.0", waitPid: 987654, args: [path.join(root, "wrapper.cjs"), "--build-if-stale"], cwd: root };
	return { appDir, userData, from, target, options };
}

function dependencies(item, failure = "") {
	const launches = [];
	const notices = [];
	const operations = [];
	let time = Date.now();
	const fileSystem = new Proxy(fs, { get(target, key) {
		if (key === "rmSync") { return (file, options) => { assert.equal(options.maxRetries, 10); assert.equal(options.retryDelay, 200); operations.push(["remove", file]); return fs.rmSync(file, options); }; }
		if (key === "renameSync") { return (source, target) => { operations.push(["rename", source, target]); return fs.renameSync(source, target); }; }
		return target[key];
	} });
	const deps = {
		fs: fileSystem,
		alive: () => false,
		now: () => time,
		sleep: async (ms) => { time += ms; },
		markerLive: async (marker) => !!marker && marker.pid === process.pid,
		spawn(exe, args, options) {
			if (exe === "powershell.exe") {
				assert.equal(args.at(-2), "-EncodedCommand");
				const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
				assert.match(script, /WScript\.Shell\)\.Popup/);
				notices.push(Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], "base64").toString("utf8"));
			} else { launches.push({ exe, args, options }); }
			const child = new EventEmitter();
			child.unref = () => {};
			process.nextTick(() => child.emit("spawn"));
			return child;
		},
		async run(command, args, cwd, timeout) {
			if (command === "git" || args.some((arg) => arg.endsWith("windows-name.mjs"))) { return run(command, args, cwd, timeout); }
			if (command === "cmd.exe" || args.includes("ci")) {
				assert.ok(args.some((arg) => arg.includes("--no-audit")));
				write(path.join(item.appDir, "node_modules", "new"), "new packages");
				if (failure === "npm ci") { return { code: 1, out: "", err: "fixture npm failure" }; }
				return { code: 0, out: "installed", err: "" };
			}
			if (args[0].endsWith("install.js")) {
				if (failure === "Electron install") { return { code: 1, out: "", err: "fixture binary failure" }; }
				if (failure !== "missing exe") { write(path.join(item.appDir, "node_modules", "electron", "dist", "electron.exe"), "new binary"); }
				return { code: 0, out: "binary", err: "" };
			}
			assert.ok(args[0].endsWith("vite.js"));
			write(path.join(item.appDir, "dist", "index.html"), "new page");
			if (failure === "build") { return { code: 1, out: "", err: "fixture build failure" }; }
			return { code: 0, out: "built", err: "" };
		},
	};
	return { deps, launches, notices, operations };
}

function originals(item) {
	assert.equal(git(item.appDir, ["rev-parse", "HEAD"]), item.from);
	assert.equal(fs.readFileSync(path.join(item.appDir, "node_modules", "sentinel"), "utf8"), "original packages");
	assert.equal(fs.readFileSync(path.join(item.appDir, "dist", "index.html"), "utf8"), "original page");
}

function stale(item, extra = {}) {
	const marker = { ...item.options, pid: 987654, pidStart: 1, beatAt: 1, phase: "updating", mergeStarted: false, writerPending: null, target: item.target, toVersion: "0.2.1", ...extra };
	writeAtomic(path.join(item.userData, "update-running.json"), marker);
	return marker;
}

async function checks() {
	for (const killFailure of ["spawn", "exit", "none"]) {
		const child = Object.assign(new EventEmitter(), { pid: 321, stdout: new EventEmitter(), stderr: new EventEmitter() });
		const timed = await run("fixture-command", [], root, 1, { spawn(command, args) {
			if (command !== "taskkill") { return child; }
			assert.deepEqual(args, ["/PID", "321", "/T", "/F"]);
			const killer = new EventEmitter();
			process.nextTick(() => {
				if (killFailure === "spawn") { killer.emit("error", new Error("taskkill unavailable")); return; }
				killer.emit("close", killFailure === "exit" ? 1 : 0);
				if (killFailure === "none") { child.emit("close", 1); }
			});
			return killer;
		} });
		assert.equal(timed.timedOut, true);
		assert.equal(timed.unsafeStop, killFailure !== "none");
	}
	for (const [report, live, unsafe] of [
		[`ERROR: The process "321" not found.\r\n`, [], false],
		[`SUCCESS: The process with PID 400 (child process of PID 321) has been terminated.\r\nERROR: The process with PID 321 (child process of PID ${process.pid}) could not be terminated.\r\nReason: There is no running instance of the task.\r\n`, [], false],
		[`ERROR: The process with PID 400 (child process of PID 321) could not be terminated.\r\nReason: Access is denied.\r\n`, [400], true],
	]) {
		const child = Object.assign(new EventEmitter(), { pid: 321, stdout: new EventEmitter(), stderr: new EventEmitter() });
		const kill = (pid) => {
			if (!live.includes(pid)) { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }
		};
		const timed = await run("fixture-command", [], root, 1, { kill, spawn(command) {
			if (command !== "taskkill") { return child; }
			const killer = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
			process.nextTick(() => {
				killer.stdout.emit("data", report);
				killer.emit("close", 128);
				child.emit("close", 1);
			});
			return killer;
		} });
		assert.equal(timed.unsafeStop, unsafe, `a failed taskkill is unsafe only while a printed PID still runs: ${report.trim()}`);
	}
	const owner = { pid: 123, pidStart: Date.parse("2026-11-03T12:00:00Z"), beatAt: Date.parse("2026-11-03T10:00:00Z") };
	const lookup = (response, kill = () => {}) => markerLive(owner, { kill, now: () => owner.pidStart, run: async (command) => response(command) });
	assert.equal(await lookup(() => ({ code: 0, out: new Date(owner.pidStart).toISOString() })), true, "sleep does not stale a matching process");
	assert.equal(await lookup(() => ({ code: 0, out: new Date(owner.pidStart + 10000).toISOString() })), false, "reused PID is stale");
	assert.equal(await lookup(() => ({ code: 1, out: "", err: "Cannot find a process with the process identifier" })), false);
	assert.equal(await lookup(() => { throw new Error("lookup should not run"); }, () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; }), false);
	const tasklist = (image) => ({ code: 0, out: `"${image}","123","Console","1","100 K"` });
	assert.equal(await lookup((command) => { assert.equal(command, "tasklist"); return tasklist("node.exe"); }, () => { const error = new Error("denied"); error.code = "EPERM"; throw error; }), true);
	for (const response of [{ code: 1, out: "", err: "You cannot call a method on a null-valued expression" }, { code: -1, out: "", err: "blocked" }, { code: 0, out: "", timedOut: true }]) {
		for (const image of ["node.exe", "svchost.exe"]) { assert.equal(await lookup((command) => command === "powershell.exe" ? response : tasklist(image)), image === "node.exe"); }
	}
	assert.equal(await lookup((command) => { if (command === "powershell.exe") { throw new Error("spawn failed"); } return tasklist("node.exe"); }), true);
	assert.equal(await markerLive({ ...owner, beatAt: owner.pidStart - 1000 }, { kill() {}, now: () => owner.pidStart, run: async () => ({ code: -1, out: "" }) }), true);
	assert.equal(await lookup(() => ({ code: -1, out: "" })), false, "only both lookup failures use marker age");
	assert.equal(await findNode({ run: async () => ({ code: 0, out: `relative/node.exe\r\n${process.execPath}\r\n` }) }), process.execPath);
	assert.equal(await findNode({ run: async () => ({ code: 1, out: "" }) }), null);

	const held = path.join(root, "held.json");
	const denial = (code) => Object.assign(new Error(`fixture ${code}`), { code });
	let denials = 0;
	writeAtomic(held, { saved: true }, { ...fs, renameSync(source, target) {
		const code = ["EPERM", "EBUSY", "EACCES"][denials++];
		if (code) { throw denial(code); }
		fs.renameSync(source, target);
	} });
	assert.deepEqual(JSON.parse(fs.readFileSync(held, "utf8")), { saved: true }, "a brief hold on the file doesn't lose the write");
	assert.throws(() => renameRetry(held, held, { renameSync() { denials++; throw denial("ENOENT"); } }), /ENOENT/);
	assert.equal(denials, 5, "only a held file is retried");

	const success = fixture();
	const clean = dependencies(success);
	const result = await main(success.options, clean.deps);
	assert.equal(result.ok, true);
	assert.equal(git(success.appDir, ["rev-parse", "HEAD"]), success.target);
	assert.equal(readMarker(success.userData), null);
	assert.equal(fs.existsSync(path.join(success.appDir, "node_modules.update-old")), false);
	assert.equal(fs.existsSync(path.join(success.appDir, "dist.update-old")), false);
	assert.equal(clean.launches.length, 1);
	assert.deepEqual(clean.launches[0].args, success.options.args);
	assert.equal(clean.launches[0].options.cwd, root);
	assert.equal(JSON.parse(fs.readFileSync(path.join(success.userData, "update-result.json"))).ok, true);
	for (const failure of ["npm ci", "Electron install", "missing exe", "build"]) {
		const item = fixture();
		const note = path.join(item.appDir, "personal", "notes.txt");
		if (failure === "npm ci") { write(note, "keep my notes"); }
		const originalStatus = git(item.appDir, ["status", "--porcelain", "--untracked-files=all"]);
		const probe = dependencies(item, failure);
		const failed = await main(item.options, probe.deps);
		assert.equal(failed.ok, false);
		assert.match(failed.message, /The previous version is ready/);
		originals(item);
		assert.equal(git(item.appDir, ["status", "--porcelain", "--untracked-files=all"]), originalStatus);
		if (failure === "npm ci") { assert.equal(fs.readFileSync(note, "utf8"), "keep my notes"); }
		assert.equal(probe.launches.length, 1);
		assert.equal(probe.notices.length, 0);
	}
	for (const race of ["commit", "edit", "disk", "disk before staging"]) {
		const item = fixture();
		const probe = dependencies(item, "npm ci");
		const normalRun = probe.deps.run;
		const tracked = path.join(item.appDir, "package.json");
		let expected = item.from;
		let diskFull = false;
		const failedWrites = new Set();
		probe.deps.fs = new Proxy(probe.deps.fs, { get(target, key) {
			if (key !== "appendFileSync" && key !== "openSync") { return target[key]; }
			return (file, ...args) => {
				const name = path.basename(file);
				if (diskFull && (name === "update.log" || name.endsWith(".json.tmp"))) {
					failedWrites.add(name);
					throw denial("ENOSPC");
				}
				return target[key](file, ...args);
			};
		} });
		probe.deps.run = async (command, args, cwd, timeout) => {
			if (race === "commit" && args.includes("update-ref")) {
				write(tracked, "concurrent commit after verification");
				git(item.appDir, ["commit", "--quiet", "--no-gpg-sign", "-am", "concurrent rollback commit"]);
				expected = git(item.appDir, ["rev-parse", "HEAD"]);
				diskFull = true;
			}
			if (race === "edit" && args.includes("read-tree")) { write(tracked, "edit after verification"); }
			if (race === "disk" && (command === "cmd.exe" || args.includes("ci"))) { diskFull = true; }
			if (race === "disk before staging" && args.includes("--verify")) { diskFull = true; }
			return normalRun(command, args, cwd, timeout);
		};
		const failed = await main(item.options, probe.deps);
		assert.equal(git(item.appDir, ["rev-parse", "HEAD"]), expected);
		assert.deepEqual(probe.notices, [failed.message], "the native dialog receives the actual result even when disk writes fail");
		if (diskFull) {
			for (const name of ["update.log", "update-running.json.tmp", "update-result.json.tmp"]) { assert.ok(failedWrites.has(name), name); }
		}
		if (race.startsWith("disk")) {
			assert.match(failed.message, /The previous version is ready/);
			originals(item);
			assert.equal(probe.launches.length, 1);
			if (race === "disk before staging") { assert.equal(probe.operations.some((operation) => operation[2]?.endsWith(".update-old")), false); }
		} else {
			assert.match(failed.message, race === "commit" ? /main branch changed before rollback/ : /couldn't restore a clean checkout/);
			assert.equal(fs.readFileSync(tracked, "utf8"), race === "commit" ? "concurrent commit after verification" : "edit after verification");
			assert.ok(fs.existsSync(path.join(item.appDir, "dist.update-old", "index.html")));
			assert.equal(probe.launches.length, 0);
			const repeated = await main({ recover: true, userData: item.userData }, probe.deps);
			assert.equal(repeated.message.split("\n\n").at(-1), failed.message.split("\n\n").at(-1), "manual steps can be repeated even if recovery text couldn't be saved");
		}
	}
	for (const race of ["stale before merge", "commit before merge", "partial merge", "edit before relaunch"]) {
		const item = fixture();
		const probe = dependencies(item);
		const normalRun = probe.deps.run;
		const tracked = path.join(item.appDir, "package.json");
		let merged = false;
		let expected = race === "edit before relaunch" ? item.target : item.from;
		probe.deps.run = async (command, args, cwd, timeout) => {
			if (race === "stale before merge" && args.includes("status") && fs.existsSync(path.join(item.appDir, "dist.update-old"))) {
				write(tracked, "edit made after staging");
			}
			if (race === "edit before relaunch" && args.includes("status") && fs.readdirSync(item.appDir).some((name) => name.startsWith("dist.update-trash-"))) {
				write(tracked, "edit made before relaunch");
			}
			if (args.includes("merge")) {
				merged = true;
				if (race === "commit before merge") {
					write(tracked, "someone else's commit");
					git(item.appDir, ["commit", "--quiet", "--no-gpg-sign", "-am", "concurrent change"]);
					expected = git(item.appDir, ["rev-parse", "HEAD"]);
				}
				if (race === "partial merge") {
					write(tracked, "changed by a partial merge");
					return { code: 1, out: "", err: "fixture interrupted checkout" };
				}
			}
			return normalRun(command, args, cwd, timeout);
		};
		const failed = await main(item.options, probe.deps);
		assert.match(failed.message, /1\. Open PowerShell/);
		assert.deepEqual(probe.notices, [failed.message]);
		assert.equal(merged, race !== "stale before merge");
		assert.equal(git(item.appDir, ["rev-parse", "HEAD"]), expected);
		assert.equal(fs.readFileSync(tracked, "utf8"), { "stale before merge": "edit made after staging", "commit before merge": "someone else's commit", "partial merge": "changed by a partial merge", "edit before relaunch": "edit made before relaunch" }[race]);
		const backup = fs.readdirSync(item.appDir).find((name) => name.startsWith("dist.update-"));
		assert.equal(fs.readFileSync(path.join(item.appDir, backup, "index.html"), "utf8"), "original page");
		assert.equal(probe.launches.length, 0);
	}
	const divergent = fixture();
	git(divergent.appDir, ["tag", "-d", "v0.2.1"]);
	write(path.join(divergent.appDir, "other.txt"), "local commit");
	git(divergent.appDir, ["add", "other.txt"]);
	git(divergent.appDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "diverged"]);
	divergent.from = divergent.options.from = git(divergent.appDir, ["rev-parse", "HEAD"]);
	git(divergent.appDir, ["tag", "v0.2.1", divergent.target]);
	assert.match((await main(divergent.options, dependencies(divergent).deps)).message, /Git couldn't move.*The previous version is ready/);
	assert.equal(git(divergent.appDir, ["rev-parse", "HEAD"]), divergent.from);
	originals(divergent);

	const locked = fixture();
	const lockedProbe = dependencies(locked);
	lockedProbe.deps.fs = new Proxy(lockedProbe.deps.fs, { get(target, key) {
		if (key === "openSync") { return (file, flags) => { if (flags === "r+") { const error = new Error("locked"); error.code = "EBUSY"; throw error; } return target.openSync(file, flags); }; }
		return target[key];
	} });
	assert.match((await main(locked.options, lockedProbe.deps)).message, /didn't close/);
	originals(locked);
	assert.equal(lockedProbe.launches.length, 0);
	const movedArgs = fixture();
	movedArgs.options.args = [path.join(movedArgs.appDir, "node_modules.update-old", "wrapper.cjs")];
	const movedProbe = dependencies(movedArgs);
	await main(movedArgs.options, movedProbe.deps);
	assert.equal(movedProbe.launches[0].exe, path.join(movedArgs.appDir, "node_modules", "electron", "dist", "electron.exe"));

	for (const interrupted of ["untouched", "before merge", "after merge", "committed", "partial restore", "partial checkout", "pending installer", "rebooted merge", "rebooted with stale lock"]) {
		const item = fixture();
		const probe = dependencies(item);
		const merged = ["after merge", "committed", "pending installer", "rebooted with stale lock"].includes(interrupted);
		probe.deps.uptime = () => interrupted.startsWith("rebooted") ? 10 : 2000;
		stale(item, {
			phase: interrupted === "committed" ? "committed" : "updating",
			asidesReady: interrupted !== "untouched",
			mergeStarted: merged || ["before merge", "partial checkout", "rebooted merge"].includes(interrupted),
			writerPending: interrupted === "rebooted merge" ? "Git merge" : interrupted === "pending installer" ? "npm ci" : null,
			systemUptime: 1000,
		});
		if (interrupted === "rebooted with stale lock") {
			writeAtomic(path.join(item.userData, "update-recover.lock"), { pid: 987654, pidStart: 1, beatAt: 1, systemUptime: 5 });
		}
		if (interrupted !== "untouched") {
			renameRetry(path.join(item.appDir, "node_modules"), path.join(item.appDir, "node_modules.update-old"));
			if (interrupted !== "partial restore") { renameRetry(path.join(item.appDir, "dist"), path.join(item.appDir, "dist.update-old")); }
			if (merged) { git(item.appDir, ["merge", "--quiet", "--ff-only", "v0.2.1"]); }
			if (interrupted === "partial checkout") { write(path.join(item.appDir, "new-source.cjs"), "partially checked out"); }
			if (interrupted === "committed") {
				write(path.join(item.appDir, "node_modules", "electron", "dist", "electron.exe"), "new binary");
				write(path.join(item.appDir, "dist", "index.html"), "new page");
			}
		}
		let aliveCalls = 0;
		probe.deps.alive = () => ++aliveCalls < 2;
		const recovered = await main({ recover: true, userData: item.userData, waitPid: 456 }, probe.deps);
		const pending = ["pending installer", "rebooted with stale lock"].includes(interrupted);
		assert.equal(Boolean(readMarker(item.userData)), pending);
		assert.equal(fs.existsSync(path.join(item.userData, "update-recover.lock")), false);
		const manual = interrupted === "partial checkout" || pending;
		assert.equal(probe.launches.length, manual ? 0 : 1);
		assert.equal(aliveCalls, 2);
		if (interrupted === "committed") {
			assert.equal(recovered.ok, true);
			assert.equal(git(item.appDir, ["rev-parse", "HEAD"]), item.target);
			assert.equal(fs.existsSync(path.join(item.appDir, "node_modules.update-old")), false);
		} else if (manual) {
			assert.match(recovered.message, merged ? /may still be writing/ : /The app stayed closed/);
			assert.equal(git(item.appDir, ["rev-parse", "HEAD"]), merged ? item.target : item.from);
			assert.ok(fs.existsSync(path.join(item.appDir, "dist.update-old", "index.html")));
			if (!merged) { assert.equal(fs.readFileSync(path.join(item.appDir, "new-source.cjs"), "utf8"), "partially checked out"); }
			assert.deepEqual(probe.notices, [recovered.message]);
			if (interrupted === "pending installer") {
				assert.match(recovered.message, /1\. Restart Windows/);
				probe.deps.markerLive = async () => false;
				probe.deps.uptime = () => 10;
				assert.match((await main({ recover: true, userData: item.userData }, probe.deps)).message, /The previous version is ready/);
				assert.equal(readMarker(item.userData), null);
				assert.equal(probe.launches.length, 1);
				originals(item);
			}
		} else { assert.match(recovered.message, /The previous version is ready/); originals(item); }
	}
	const live = fixture();
	const liveMarker = { ...stale(live), pid: process.pid };
	writeAtomic(path.join(live.userData, "update-running.json"), liveMarker);
	assert.equal((await main({ recover: true, userData: live.userData }, dependencies(live).deps)).skipped, true);
	assert.equal(readMarker(live.userData).pid, process.pid);
	assert.equal((await main({ busy: true, userData: live.userData }, dependencies(live).deps)).code, 1);
	stale(live);
	assert.equal((await main({ busy: true, userData: live.userData }, dependencies(live).deps)).code, 0);
	fs.unlinkSync(path.join(live.userData, "update-running.json"));
	assert.equal((await main({ busy: true, userData: live.userData }, dependencies(live).deps)).code, 0);

	const damaged = fixture();
	write(path.join(damaged.userData, "update-running.json"), "broken JSON");
	assert.deepEqual(readMarker(damaged.userData), { damaged: true });
	const recovered = execFileSync(process.execPath, [path.join(__dirname, "update-helper.cjs"), "--recover", damaged.userData], { encoding: "utf8" });
	assert.match(recovered, /1\. Open PowerShell[\s\S]*5\. Run: npm run desktop/);
	assert.equal(readMarker(damaged.userData), null);
	fs.unlinkSync(path.join(damaged.userData, "update-result.json"));
	assert.equal(execFileSync(process.execPath, [path.join(__dirname, "update-helper.cjs"), "--recover", damaged.userData], { encoding: "utf8" }), recovered);
	originals(damaged);
	const emptyLock = fixture();
	stale(emptyLock);
	write(path.join(emptyLock.userData, "update-recover.lock"), "");
	assert.equal((await main({ recover: true, userData: emptyLock.userData }, dependencies(emptyLock).deps)).skipped, true);
	assert.ok(readMarker(emptyLock.userData));
	const fullLock = fixture();
	stale(fullLock);
	const fullLockProbe = dependencies(fullLock);
	fullLockProbe.deps.fs = new Proxy(fullLockProbe.deps.fs, { get(target, key) {
		if (key === "writeFileSync") { return () => { throw denial("ENOSPC"); }; }
		return target[key];
	} });
	assert.match((await main({ recover: true, userData: fullLock.userData }, fullLockProbe.deps)).message, /recovery lock couldn't be written[\s\S]*5\. Run: npm run desktop/);
	assert.equal(fs.existsSync(path.join(fullLock.userData, "update-recover.lock")), false);

	const timed = fixture();
	stale(timed);
	const timedProbe = dependencies(timed);
	timedProbe.deps.alive = () => true;
	assert.equal((await main({ recover: true, userData: timed.userData, waitPid: 456 }, timedProbe.deps)).skipped, true);
	assert.ok(readMarker(timed.userData), "failed recovery wait leaves marker for next launch");
	assert.equal(fs.existsSync(path.join(timed.userData, "update-recover.lock")), false);
	assert.equal(timedProbe.launches.length, 0);

	const oldAside = fixture();
	write(path.join(oldAside.appDir, "node_modules.update-old", "stale"), "previous failed cleanup");
	const oldProbe = dependencies(oldAside);
	await main(oldAside.options, oldProbe.deps);
	const quarantined = oldProbe.operations.find((operation) => operation[0] === "rename" && operation[1].endsWith("node_modules.update-old") && operation[2].includes(".update-trash-"));
	assert.ok(quarantined);
	assert.ok(oldProbe.operations.some((operation) => operation[0] === "remove" && operation[1] === quarantined[2]));
	const failedCleanup = fixture();
	write(path.join(failedCleanup.appDir, "node_modules.update-old", "sentinel"), "older packages");
	const failedCleanupProbe = dependencies(failedCleanup);
	failedCleanupProbe.deps.fs = new Proxy(failedCleanupProbe.deps.fs, { get(target, key) {
		if (key === "renameSync") { return (source, destination) => { if (source.endsWith("node_modules.update-old")) { throw new Error("fixture old aside locked"); } return target.renameSync(source, destination); }; }
		return target[key];
	} });
	assert.match((await main(failedCleanup.options, failedCleanupProbe.deps)).message, /The previous version is ready/);
	originals(failedCleanup);
	assert.equal(fs.readFileSync(path.join(failedCleanup.appDir, "node_modules.update-old", "sentinel"), "utf8"), "older packages", "a cleanup failure cannot restore a different old install over the intact current install");
	const interruptedCleanup = fixture();
	const cleaningMarker = { ...stale(interruptedCleanup), asidesReady: false };
	writeAtomic(path.join(interruptedCleanup.userData, "update-running.json"), cleaningMarker);
	write(path.join(interruptedCleanup.appDir, "dist.update-old", "sentinel"), "older page");
	await main({ recover: true, userData: interruptedCleanup.userData }, dependencies(interruptedCleanup).deps);
	originals(interruptedCleanup);
	assert.equal(fs.readFileSync(path.join(interruptedCleanup.appDir, "dist.update-old", "sentinel"), "utf8"), "older page", "recovery before staging never restores leftover older asides");
	const failedTrash = fixture();
	write(path.join(failedTrash.appDir, "dist.update-old", "sentinel"), "older page");
	const failedTrashProbe = dependencies(failedTrash);
	failedTrashProbe.deps.fs = new Proxy(failedTrashProbe.deps.fs, { get(target, key) {
		if (key === "readdirSync") { return () => { throw new Error("fixture unreadable trash list"); }; }
		return target[key];
	} });
	await main(failedTrash.options, failedTrashProbe.deps);
	originals(failedTrash);
	const partialMove = fixture();
	const partialMoveProbe = dependencies(partialMove);
	partialMoveProbe.deps.fs = new Proxy(partialMoveProbe.deps.fs, { get(target, key) {
		if (key === "renameSync") { return (source, destination) => { if (source === path.join(partialMove.appDir, "dist")) { throw denial("EPERM"); } return target.renameSync(source, destination); }; }
		return target[key];
	} });
	assert.match((await main(partialMove.options, partialMoveProbe.deps)).message, /The previous version is ready/);
	originals(partialMove);
	for (const won of [true, false]) {
		const lockRace = fixture();
		stale(lockRace);
		write(path.join(lockRace.userData, "update-recover.lock"), JSON.stringify({ pid: 987654, pidStart: 1, beatAt: 1 }));
		const lockProbe = dependencies(lockRace);
		if (!won) {
			lockProbe.deps.fs = new Proxy(lockProbe.deps.fs, { get(target, key) {
				if (key === "renameSync") { return (source, destination) => { if (source.endsWith("update-recover.lock")) { const error = new Error("another recover won rename"); error.code = "ENOENT"; throw error; } return target.renameSync(source, destination); }; }
				return target[key];
			} });
		}
		const lockResult = await main({ recover: true, userData: lockRace.userData }, lockProbe.deps);
		assert.equal(lockProbe.launches.length, won ? 1 : 0);
		assert.equal(!!lockResult.skipped, !won);
		originals(lockRace);
	}

	const concurrent = fixture();
	stale(concurrent);
	const first = dependencies(concurrent);
	let release;
	let waiting = true;
	first.deps.alive = () => waiting;
	first.deps.sleep = () => new Promise((resolve) => { release = () => { waiting = false; resolve(); }; });
	const firstRun = main({ recover: true, userData: concurrent.userData, waitPid: 456 }, first.deps);
	for (let spin = 0; spin < 100 && !release; spin++) { await new Promise((resolve) => setImmediate(resolve)); }
	assert.ok(release);
	const second = dependencies(concurrent);
	second.deps.markerLive = async (marker) => !!marker && !marker.phase && marker.pid === process.pid;
	assert.equal((await main({ recover: true, userData: concurrent.userData }, second.deps)).skipped, true, "a second recovery cannot pass the real lock even if it sampled a stale marker");
	release();
	await firstRun;
	assert.equal(first.launches.length, 1);
	const unsafeStop = fixture();
	const unsafeProbe = dependencies(unsafeStop);
	const normalRun = unsafeProbe.deps.run;
	let keptAlive = false;
	unsafeProbe.deps.run = async (command, args, cwd, timeout) => {
		if (command === "cmd.exe" || args.includes("ci")) { return { code: -1, out: "", err: "taskkill failed", timedOut: true, unsafeStop: true, stopPid: 321 }; }
		return normalRun(command, args, cwd, timeout);
	};
	unsafeProbe.deps.setInterval = (callback, ms) => { assert.equal(ms, 60000); keptAlive = true; callback(); };
	assert.match((await main(unsafeStop.options, unsafeProbe.deps)).message, /Stop those installer processes first, then stop update helper PID/);
	assert.equal(keptAlive, true);
	assert.equal(unsafeProbe.launches.length, 0);
	assert.ok(readMarker(unsafeStop.userData), "uncertain writers keep the live marker, preventing recovery");
	assert.equal(git(unsafeStop.appDir, ["rev-parse", "HEAD"]), unsafeStop.target, "unsafe stop cannot reset while children may still write");
	assert.ok(fs.existsSync(path.join(unsafeStop.appDir, "node_modules.update-old", "sentinel")));
	assert.ok(fs.existsSync(path.join(unsafeStop.appDir, "dist.update-old", "index.html")));
	console.log("update helper checks passed");
}

checks().then(() => {
	const resolved = path.resolve(root);
	assert.ok(resolved.startsWith(`${tempBase}${path.sep}codex-update-helper-tests-`));
	fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}).catch((error) => { console.error(error); console.error(`Retained fixture: ${root}`); process.exitCode = 1; });
