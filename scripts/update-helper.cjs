const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const PID_START = Date.now() - process.uptime() * 1000;
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
const BUSY = "Codewomplers Grok Desktop is updating. Try again in a minute.";

// taskkill /T also exits non-zero when part of the tree had already exited. The tree counts as stopped
// only when the root and every PID taskkill printed are gone; output with no PIDs proves nothing.
function treeStopped(rootPid, report, kill) {
	const pids = (report.match(/\d+/g) || []).map(Number).filter((pid) => pid !== process.pid);
	if (!pids.length) { return false; }
	return [rootPid, ...pids].every((pid) => {
		try { kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
	});
}

function run(command, args, cwd, timeout, deps = {}) {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let timedOut = false;
		let closed = false;
		let stopping = false;
		let unsafeStop = false;
		let code = -1;
		const start = deps.spawn || spawn;
		const child = start(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
		const finish = () => {
			if (!unsafeStop && (!closed || stopping)) { return; }
			clearTimeout(timer);
			resolve({ code, out, err, timedOut, unsafeStop, stopPid: child.pid });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (process.platform !== "win32" || !child.pid) {
				child.kill("SIGKILL");
				return;
			}
			stopping = true;
			const killer = start("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let report = "";
			killer.stdout?.on("data", (data) => { report = `${report}${data}`.slice(-12000); });
			killer.stderr?.on("data", (data) => { report = `${report}${data}`.slice(-12000); });
			killer.on("error", (error) => {
				err = `${err}\n${error.message}`;
				unsafeStop = true;
				stopping = false;
				finish();
			});
			killer.on("close", (value) => {
				unsafeStop = value !== 0 && !treeStopped(child.pid, report, deps.kill || process.kill);
				if (value !== 0) { err = `${err}\n${report}`.slice(-12000); }
				stopping = false;
				finish();
			});
		}, timeout);
		child.stdout.on("data", (data) => { out = `${out}${data}`.slice(-12000); });
		child.stderr.on("data", (data) => { err = `${err}${data}`.slice(-12000); });
		child.on("error", (error) => { err = error.message; });
		child.on("close", (value) => { code = value === null ? -1 : value; closed = true; finish(); });
	});
}

function writeAtomic(file, value, fileSystem = fs) {
	const temp = `${file}.tmp`;
	const fd = fileSystem.openSync(temp, "w");
	try {
		fileSystem.writeFileSync(fd, JSON.stringify(value));
		fileSystem.fsyncSync(fd);
	} finally {
		fileSystem.closeSync(fd);
	}
	fileSystem.renameSync(temp, file);
}

function readMarker(userData, fileSystem = fs) {
	try {
		const value = JSON.parse(fileSystem.readFileSync(path.join(userData, "update-running.json"), "utf8"));
		return value && typeof value === "object" ? value : { damaged: true };
	} catch (error) {
		return error.code === "ENOENT" ? null : { damaged: true };
	}
}

async function findNode(deps = {}) {
	const found = await (deps.run || run)("where.exe", ["node"], undefined, 10000);
	if (found.code !== 0) { return null; }
	return found.out.split(/\r?\n/).map((line) => line.trim()).find((line) => path.isAbsolute(line) && path.basename(line).toLowerCase() === "node.exe") || null;
}

async function markerLive(marker, deps = {}) {
	if (!marker || !Number.isInteger(marker.pid) || marker.pid <= 0 || !Number.isFinite(marker.pidStart)) { return false; }
	const execute = deps.run || run;
	const now = deps.now || Date.now;
	let fallback = false;
	try {
		(deps.kill || process.kill)(marker.pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") { return false; }
		fallback = true;
	}
	if (!fallback) {
		let lookup;
		try { lookup = await execute("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${marker.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], undefined, 10000); } catch { lookup = { code: -1, out: "", err: "" }; }
		const start = Date.parse(lookup.out.trim());
		if (lookup.code === 0 && !lookup.timedOut && Number.isFinite(start)) { return Math.abs(start - marker.pidStart) <= 5000; }
		if (lookup.code === 1 && /Cannot find a process/i.test(`${lookup.out}\n${lookup.err}`)) { return false; }
	}
	let listed;
	try { listed = await execute("tasklist", ["/FI", `PID eq ${marker.pid}`, "/FO", "CSV", "/NH"], undefined, 10000); } catch { listed = { code: -1 }; }
	if (listed.code === 0 && !listed.timedOut) {
		return listed.out.split(/\r?\n/).some((line) => /^"node\.exe",/i.test(line.trim()));
	}
	return Number.isFinite(marker.beatAt) && now() - marker.beatAt < 30 * 60 * 1000;
}

async function main(options, deps = {}) {
	const fileSystem = deps.fs || fs;
	const execute = deps.run || run;
	const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const now = deps.now || Date.now;
	const alive = deps.alive || ((pid) => {
		try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
	});
	const isLive = deps.markerLive || ((marker) => markerLive(marker, { ...deps, run: execute }));
	const userData = options.userData || path.join(process.env.APPDATA, "grok-code");
	let marker = readMarker(userData, fileSystem);
	if (options.busy) { const busy = await isLive(marker); return { busy, code: busy ? 1 : 0 }; }
	const recovering = options.recover === true;
	const markerFile = path.join(userData, "update-running.json");
	const lockFile = path.join(userData, "update-recover.lock");
	let ownsLock = false;
	if (recovering) {
		if (!marker || await isLive(marker)) { return { skipped: true }; }
		const claim = () => {
			const fd = fileSystem.openSync(lockFile, "wx");
			try {
				fileSystem.writeFileSync(fd, JSON.stringify({ pid: process.pid, pidStart: PID_START, beatAt: now() }));
				fileSystem.fsyncSync(fd);
			} finally { fileSystem.closeSync(fd); }
		};
		try {
			try { claim(); } catch (error) {
				if (error.code !== "EEXIST") { throw error; }
				let owner;
				try {
					owner = JSON.parse(fileSystem.readFileSync(lockFile, "utf8"));
					if (!owner || !Number.isInteger(owner.pid)) { throw new Error("Incomplete lock."); }
				} catch {
					try { if (now() - fileSystem.statSync(lockFile).mtimeMs < 10000) { return { skipped: true }; } } catch { return { skipped: true }; }
				}
				if (owner && await isLive(owner)) { return { skipped: true }; }
				const broken = `${lockFile}.broken-${randomUUID()}`;
				try { fileSystem.renameSync(lockFile, broken); } catch { return { skipped: true }; }
				fileSystem.unlinkSync(broken);
				try { claim(); } catch { return { skipped: true }; }
			}
			ownsLock = true;
			marker = readMarker(userData, fileSystem);
			if (!marker || await isLive(marker)) { fileSystem.unlinkSync(lockFile); return { skipped: true }; }
		} catch (error) {
			if (ownsLock) { fileSystem.unlinkSync(lockFile); }
			throw error;
		}
	} else if (marker && await isLive(marker)) {
		return { skipped: true };
	}
	const damaged = recovering && (!marker.appDir || !marker.from || !Array.isArray(marker.args));
	const appDir = path.resolve(recovering && !damaged ? marker.appDir : options.appDir || path.join(__dirname, ".."));
	const exe = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
	let state = recovering && !damaged ? marker : { ...options, appDir, phase: "updating", asidesReady: false, toVersion: String(options.tag || "").replace(/^v/, "") };
	if (damaged) { state = { appDir, phase: "updating", args: [appDir, "--build-if-stale"], cwd: appDir }; }
	state = { ...state, pid: process.pid, pidStart: PID_START, beatAt: now() };
	fileSystem.mkdirSync(userData, { recursive: true });
	const log = (message) => fileSystem.appendFileSync(path.join(userData, "update.log"), `${new Date(now()).toISOString()} ${message}\n`);
	const beat = (step) => {
		state.beatAt = now();
		writeAtomic(markerFile, state, fileSystem);
		if (step) { log(step); }
	};
	let unsafeStopResult = null;
	const command = async (step, program, args, timeout) => {
		beat(step);
		const result = await execute(program, args, appDir, timeout);
		log(`${step}: exit ${result.code}${result.timedOut ? " (timeout)" : ""}\n${`${result.out || ""}\n${result.err || ""}`.slice(-2000)}`);
		if (result.unsafeStop) {
			const error = new Error(`The update couldn't stop the installer process tree (PID ${result.stopPid}). Stop those installer processes first, then stop update helper PID ${process.pid}, then in the app's folder run: node scripts/update-helper.cjs --recover.`);
			error.unsafeStop = true;
			error.result = { ok: false, message: error.message };
			unsafeStopResult = error.result;
			(deps.setInterval || setInterval)(() => { try { beat(); } catch {} }, 60000);
			log(error.message);
			writeAtomic(path.join(userData, "update-result.json"), error.result, fileSystem);
			throw error;
		}
		return result;
	};
	const remove = (target) => fileSystem.rmSync(target, REMOVE);
	const cleanupTrash = () => {
		for (const name of fileSystem.readdirSync(appDir)) {
			if (/^(node_modules|dist)\.update-trash-/.test(name)) {
				try { remove(path.join(appDir, name)); } catch (error) { log(`Cleanup ${name}: ${error.message}`); }
			}
		}
	};
	const discardAside = (name) => {
		const aside = path.join(appDir, `${name}.update-old`);
		if (fileSystem.existsSync(aside)) {
			const trash = path.join(appDir, `${name}.update-trash-${randomUUID()}`);
			fileSystem.renameSync(aside, trash);
			remove(trash);
		}
	};
	const restore = async () => {
		beat("Restore previous version");
		if (state.asidesReady === false) { return true; }
		let restored = true;
		for (const name of ["node_modules", "dist"]) {
			const original = path.join(appDir, name);
			const aside = `${original}.update-old`;
			if (!fileSystem.existsSync(aside)) { continue; }
			try { remove(original); fileSystem.renameSync(aside, original); } catch (error) { log(`Restore ${name}: ${error.message}`); restored = false; }
		}
		if (state.from) {
			const head = await command("Read HEAD", "git", ["-C", appDir, "rev-parse", "HEAD"], 120000);
			if (head.code !== 0) { restored = false; } else if (head.out.trim() !== state.from) {
				const reset = await command("Reset previous commit", "git", ["-C", appDir, "reset", "--keep", state.from], 120000);
				if (reset.code !== 0 || reset.timedOut) { restored = false; }
			}
		}
		return restored;
	};
	const manual = () => `The update failed and the previous version couldn't be fully restored. In the app's folder run: git reset --keep ${state.from}, npm ci, npm run desktop.`;
	const finish = async (result, relaunch = true) => {
		log(result.message);
		writeAtomic(path.join(userData, "update-result.json"), result, fileSystem);
		fileSystem.unlinkSync(markerFile);
		if (relaunch && fileSystem.existsSync(exe)) {
			try {
				await new Promise((resolve, reject) => {
					const child = (deps.spawn || spawn)(exe, state.args || [appDir, "--build-if-stale"], { cwd: state.cwd || appDir, detached: true, stdio: "ignore", windowsHide: false });
					child.once("error", reject);
					child.once("spawn", () => { child.unref(); resolve(); });
				});
			} catch (error) {
				log(`Relaunch: ${error.message}`);
				result = { ok: false, message: `${result.message} The app couldn't reopen. In its folder run: npm run desktop.` };
				writeAtomic(path.join(userData, "update-result.json"), result, fileSystem);
			}
		}
		return result;
	};
	const waitFor = async (free, timeout) => {
		const started = now();
		let heartbeat = started;
		for (let elapsed = 0; elapsed <= timeout; elapsed += 500) {
			if (await free()) { return true; }
			if (elapsed === timeout) { return false; }
			await sleep(500);
			if (now() - heartbeat >= 60000) { beat(); heartbeat = now(); }
		}
		return false;
	};
	try {
		beat(recovering ? "Recover interrupted update" : "Start update");
		const waitPid = options.waitPid;
		const exited = !waitPid || await waitFor(() => !alive(waitPid), 120000);
		const free = exited && await waitFor(() => {
			try { const fd = fileSystem.openSync(exe, "r+"); fileSystem.closeSync(fd); return true; } catch (error) { return error.code === "ENOENT"; }
		}, 30000);
		if (!free) {
			if (recovering) { log("The app didn't close; recovery will retry at the next launch."); return { skipped: true }; }
			return await finish({ ok: false, message: "The app didn't close, so nothing was updated." }, false);
		}
		cleanupTrash();
		if (recovering) {
			if (state.phase === "committed") {
				for (const name of ["node_modules", "dist"]) { try { discardAside(name); } catch (error) { log(`Cleanup ${name}: ${error.message}`); } }
				return await finish({ ok: true, message: `Updated to version ${state.toVersion}.` });
			}
			const restored = await restore();
			return await finish({ ok: false, message: damaged ? "The update was interrupted. In the app's folder run: git status, then npm ci, then npm run desktop." : restored ? "The update was interrupted. The previous version was restored." : manual() });
		}
		beat("Set previous packages and page aside");
		try {
			for (const name of ["node_modules", "dist"]) { discardAside(name); }
		} catch (error) {
			log(`Clean previous aside: ${error.message}`);
			return await finish({ ok: false, message: "The update couldn't start. Nothing was updated." });
		}
		state.asidesReady = true;
		beat("Stage current version aside");
		try {
			for (const name of ["node_modules", "dist"]) { fileSystem.renameSync(path.join(appDir, name), path.join(appDir, `${name}.update-old`)); }
		} catch (error) {
			log(`Set aside: ${error.message}`);
			const restored = await restore();
			return await finish({ ok: false, message: restored ? "The update couldn't start. Nothing was updated." : manual() });
		}
		const merged = await command("Git merge", "git", ["-C", appDir, "merge", "--ff-only", state.tag], 120000);
		if (merged.code !== 0 || merged.timedOut) {
			const restored = await restore();
			return await finish({ ok: false, message: restored ? "Git couldn't move to the new version. Nothing was changed." : manual() });
		}
		const node = process.execPath;
		const npm = path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
		const installed = fileSystem.existsSync(npm) ? await command("npm ci", node, [npm, "ci", "--no-audit", "--no-fund"], 600000) : await command("npm ci", "cmd.exe", ["/d", "/s", "/c", "npm ci --no-audit --no-fund"], 600000);
		let failed = installed.code !== 0 || installed.timedOut ? "npm ci" : "";
		if (!failed) {
			const binary = await command("Electron install", node, [path.join(appDir, "node_modules", "electron", "install.js")], 600000);
			if (binary.code !== 0 || binary.timedOut || !fileSystem.existsSync(exe)) { failed = "Electron install"; }
		}
		if (!failed) {
			await command("Windows name", node, [path.join(appDir, "scripts", "windows-name.mjs")], 120000);
			const built = await command("Build", node, [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "build"], 120000);
			if (built.code !== 0 || built.timedOut) { failed = "build"; }
		}
		if (failed) {
			const restored = await restore();
			return await finish({ ok: false, message: restored ? `The update didn't finish (${failed}). The previous version was restored.` : manual() });
		}
		state.phase = "committed";
		beat("Commit completed update");
		for (const name of ["node_modules", "dist"]) { try { discardAside(name); } catch (error) { log(`Cleanup ${name}: ${error.message}`); } }
		return await finish({ ok: true, message: `Updated to version ${state.toVersion}.` });
	} catch (error) {
		if (unsafeStopResult) { return unsafeStopResult; }
		log(`Update error: ${error.message}`);
		if (state.phase === "committed") { return await finish({ ok: true, message: `Updated to version ${state.toVersion}.` }); }
		const restored = await restore();
		return await finish({ ok: false, message: restored && !damaged ? "The update didn't finish. The previous version was restored." : manual() });
	} finally {
		if (ownsLock) { try { fileSystem.unlinkSync(lockFile); } catch {} }
	}
}

module.exports = { main, markerLive, readMarker, findNode, writeAtomic, run };

if (require.main === module) {
	let options;
	if (process.argv[2] === "--recover" || process.argv[2] === "--busy") {
		const args = process.argv.slice(3);
		const wait = args.indexOf("--wait");
		const waitPid = wait >= 0 ? Number(args.splice(wait, 2)[1]) : undefined;
		options = { recover: process.argv[2] === "--recover", busy: process.argv[2] === "--busy", waitPid, userData: args[0] };
	} else {
		try { options = JSON.parse(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
	}
	if (options) {
		main(options).then((result) => {
			if (result.busy) { console.error(BUSY); }
			process.exitCode = result.code || 0;
		}).catch((error) => { console.error(error.message); process.exitCode = 1; });
	}
}
