const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const PID_START = Date.now() - process.uptime() * 1000;
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
const BUSY = "Codewomplers Grok Desktop is updating. Try again in a minute.";
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

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
		const fullStatus = command === "git" && args.includes("--untracked-files=all");
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
		child.stdout.on("data", (data) => { out = fullStatus ? out + data : `${out}${data}`.slice(-12000); });
		child.stderr.on("data", (data) => { err = `${err}${data}`.slice(-12000); });
		child.on("error", (error) => { err = error.message; });
		child.on("close", (value) => { code = value === null ? -1 : value; closed = true; finish(); });
	});
}

// Windows denies a rename while another process has the file, or anything inside the folder, open. A file watcher does that
// for about a millisecond right after a change, so wait out a brief hold instead of failing the update.
function renameRetry(source, target, fileSystem = fs) {
	for (let wait = 10; ; wait *= 2) {
		try {
			fileSystem.renameSync(source, target);
			return;
		} catch (error) {
			if (wait > 640 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) { throw error; }
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
		}
	}
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
	renameRetry(temp, file, fileSystem);
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

function restartedSince(marker, uptime) {
	// A drop in uptime proves a restart without relying on the wall clock.
	return Number.isFinite(marker?.systemUptime) && uptime() < marker.systemUptime;
}

async function markerLive(marker, deps = {}) {
	if (!marker || !Number.isInteger(marker.pid) || marker.pid <= 0 || !Number.isFinite(marker.pidStart)) { return false; }
	if (restartedSince(marker, deps.uptime || os.uptime)) { return false; }
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

const RECOVERY_STEPS = [
	"1. Open PowerShell in a writable folder with enough space. If grok-desktop-recovery already exists, use a new name in steps 2 and 3.",
	"2. Run: git clone https://github.com/schmidtc63/grok-desktop.git grok-desktop-recovery",
	"3. Run: Set-Location -LiteralPath grok-desktop-recovery",
	"4. Run: npm install",
	"5. Run: npm run desktop",
].join("\n");

function startDetached(program, args, options, launch = spawn) {
	return new Promise((resolve, reject) => {
		const child = launch(program, args, { detached: true, stdio: "ignore", ...options });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}

function showRecovery(message, launch) {
	const body = Buffer.from(message, "utf8").toString("base64");
	const script = `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}')); (New-Object -ComObject WScript.Shell).Popup($text, 0, 'Codewomplers Grok Desktop update', 4144)`;
	return startDetached("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true }, launch);
}

async function main(options, deps = {}) {
	const fileSystem = deps.fs || fs;
	const execute = deps.run || run;
	const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const now = deps.now || Date.now;
	const uptime = deps.uptime || os.uptime;
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
	const resultFile = path.join(userData, "update-result.json");
	const recoveryFile = path.join(userData, "update-recovery.json");
	const defaultAppDir = path.resolve(options.appDir || path.join(__dirname, ".."));
	const repeatRecovery = () => {
		try {
			const saved = JSON.parse(fileSystem.readFileSync(recoveryFile, "utf8"));
			if (typeof saved.message === "string") { return saved; }
		} catch {}
		return { skipped: true, message: `If the app still needs repair, use a fresh copy.\n\n${RECOVERY_STEPS}` };
	};
	let ownsLock = false;
	let recoveryOnThisBoot = false;
	if (recovering) {
		if (!marker) { return repeatRecovery(); }
		if (await isLive(marker)) { return { skipped: true, message: BUSY }; }
		const claim = () => {
			const fd = fileSystem.openSync(lockFile, "wx");
			ownsLock = true;
			try {
				fileSystem.writeFileSync(fd, JSON.stringify({ pid: process.pid, pidStart: PID_START, beatAt: now(), systemUptime: uptime() }));
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
					try { if (now() - fileSystem.statSync(lockFile).mtimeMs < 10000) { return { skipped: true, message: BUSY }; } } catch { return { skipped: true, message: BUSY }; }
				}
				if (owner && await isLive(owner)) { return { skipped: true, message: BUSY }; }
				recoveryOnThisBoot = Number.isFinite(owner?.systemUptime) && !restartedSince(owner, uptime);
				const broken = `${lockFile}.broken-${randomUUID()}`;
				try { renameRetry(lockFile, broken, fileSystem); } catch { return { skipped: true, message: BUSY }; }
				fileSystem.unlinkSync(broken);
				try { claim(); } catch (error) {
					if (error.code === "EEXIST" && !ownsLock) { return { skipped: true, message: BUSY }; }
					throw error;
				}
			}
			marker = readMarker(userData, fileSystem);
			if (!marker || await isLive(marker)) {
				fileSystem.unlinkSync(lockFile);
				return marker ? { skipped: true, message: BUSY } : repeatRecovery();
			}
		} catch {
			if (ownsLock) { try { fileSystem.unlinkSync(lockFile); } catch {} }
			const result = { ok: false, message: `The recovery lock couldn't be written.\n\n${RECOVERY_STEPS}` };
			if (options.waitPid) { await showRecovery(result.message, deps.spawn).catch(() => {}); }
			return result;
		}
	} else if (marker && await isLive(marker)) {
		return { skipped: true };
	}
	const damaged = recovering && (typeof marker.appDir !== "string" || !COMMIT.test(marker.from) || !Array.isArray(marker.args));
	const appDir = recovering && !damaged ? path.resolve(marker.appDir) : defaultAppDir;
	const exe = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
	let state = recovering && !damaged ? marker : { ...options, appDir, phase: "updating", asidesReady: false, mergeStarted: false, writerPending: null, toVersion: String(options.tag || "").replace(/^v/, "") };
	state = { ...state, pid: process.pid, pidStart: PID_START, beatAt: now() };
	if (recovering && restartedSince(marker, uptime)) {
		state.writerPending = recoveryOnThisBoot ? "Previous recovery" : null;
	}
	try { fileSystem.mkdirSync(userData, { recursive: true }); } catch {}
	const log = (message) => {
		try { fileSystem.appendFileSync(path.join(userData, "update.log"), `${new Date(now()).toISOString()} ${message}\n`); } catch {}
	};
	const persist = (file, value) => {
		try { writeAtomic(file, value, fileSystem); return true; } catch (error) {
			log(`Write ${path.basename(file)}: ${error.message}`);
			try { fileSystem.unlinkSync(`${file}.tmp`); } catch {}
			return false;
		}
	};
	const beat = (step) => {
		state.beatAt = now();
		state.systemUptime = uptime();
		const saved = persist(markerFile, state);
		if (step) { log(step); }
		return saved;
	};
	let unsafeStopResult = null;
	const command = async (step, program, args, timeout, writer) => {
		if (writer) { state.writerPending = step; }
		if (!beat(step) && writer === "update") {
			state.writerPending = null;
			return { code: -1, out: "", err: "The update couldn't record the next command." };
		}
		const result = await execute(program, args, appDir, timeout);
		log(`${step}: exit ${result.code}${result.timedOut ? " (timeout)" : ""}\n${`${result.out || ""}\n${result.err || ""}`.slice(-2000)}`);
		if (result.unsafeStop) {
			const reason = `The update couldn't stop the installer process tree (PID ${result.stopPid}). Stop those installer processes first, then stop update helper PID ${process.pid}, then in the app's folder run: node scripts/update-helper.cjs --recover.`;
			(deps.setInterval || setInterval)(() => beat(), 60000);
			unsafeStopResult = await manual(reason, true);
			throw new Error(reason);
		}
		if (writer) { state.writerPending = null; beat(); }
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
	const quarantineAside = (name) => {
		const aside = path.join(appDir, `${name}.update-old`);
		if (!fileSystem.existsSync(aside)) { return null; }
		const trash = path.join(appDir, `${name}.update-trash-${randomUUID()}`);
		renameRetry(aside, trash, fileSystem);
		return trash;
	};
	const sourceStatus = async (commit, untracked) => {
		if (!COMMIT.test(commit)) { return null; }
		const status = await command("Check source checkout", "git", ["-C", appDir, "-c", "core.quotePath=true", "status", "--porcelain=v2", "--branch", `--untracked-files=${untracked}`, "--ignore-submodules=none"], 120000);
		const lines = status.out.split(/\r?\n/);
		if (status.code !== 0 || status.timedOut || !lines.includes(`# branch.oid ${commit}`) || !lines.includes("# branch.head main")) { return null; }
		return lines.filter((line) => line && !line.startsWith("# branch."));
	};
	const sourceAt = async (commit, { allowedUntracked, requireClean = true } = {}) => {
		const lines = await sourceStatus(commit, allowedUntracked ? "all" : "no");
		return lines !== null && (!requireClean || lines.every((line) => line.startsWith("? ") && allowedUntracked?.has(line)));
	};
	const runtime = [["node_modules", path.join("electron", "dist", "electron.exe")], ["dist", "index.html"]];
	const runtimeReady = () => runtime.every(([name, entry]) => fileSystem.existsSync(path.join(appDir, name, entry)));
	const restore = async () => {
		const baseline = { allowedUntracked: new Set(Array.isArray(state.untrackedBeforeMerge) ? state.untrackedBeforeMerge : []) };
		const oldSourceOptions = state.mergeStarted === false ? undefined : baseline;
		const oldSource = await sourceAt(state.from, oldSourceOptions);
		const rollback = !oldSource && state.asidesReady === true && await sourceAt(state.target, baseline);
		if (!oldSource && !rollback) { return "The checkout doesn't match a clean update commit."; }
		const replaceRuntime = rollback || state.phase === "restoring";
		const moves = [];
		for (const [name, entry] of runtime) {
			const original = path.join(appDir, name);
			const aside = `${original}.update-old`;
			if (state.asidesReady !== false && fileSystem.existsSync(aside)) {
				if (!fileSystem.existsSync(path.join(aside, entry)) ||
					(fileSystem.existsSync(original) && !replaceRuntime)) {
					return "The previous runtime couldn't be verified.";
				}
				moves.push([name, aside, original]);
			} else if (rollback || (state.asidesReady === true && state.mergeStarted && state.phase !== "restoring") ||
				!fileSystem.existsSync(path.join(original, entry))) {
				return "The previous runtime couldn't be verified.";
			}
		}
		if (rollback) {
			state.phase = "restoring";
			// Git compares and moves the ref under its lock before any checkout files are touched.
			const ref = await command("Move main back if it still points to the release", "git", ["-C", appDir, "update-ref", "-m", "grok desktop: recover interrupted update", "refs/heads/main", state.from, state.target], 120000, "rollback");
			if (ref.code !== 0 || ref.timedOut) {
				const current = await command("Check main after rollback refusal", "git", ["-C", appDir, "rev-parse", "refs/heads/main"], 120000);
				return current.code === 0 && !current.timedOut && ![state.from, state.target].includes(current.out.trim())
					? "The main branch changed before rollback. Its current commit was kept."
					: "Git couldn't move the main branch back safely.";
			}
			if (!await sourceAt(state.from, { requireClean: false })) { return "The branch or commit changed during rollback."; }
			const checkedOut = await command("Restore tracked files without overwriting local edits", "git", ["-C", appDir, "read-tree", "-m", "-u", state.target, state.from], 120000, "rollback");
			if (checkedOut.code !== 0 || checkedOut.timedOut || !await sourceAt(state.from, baseline)) { return "Git couldn't restore a clean checkout."; }
		}
		try {
			if (moves.length) { state.phase = "restoring"; beat("Restore previous runtime"); }
			for (const [name, aside, original] of moves) {
				if (fileSystem.existsSync(original)) {
					if (!replaceRuntime) { return "A runtime folder changed during recovery."; }
					renameRetry(original, path.join(appDir, `${name}.update-trash-${randomUUID()}`), fileSystem);
				}
				renameRetry(aside, original, fileSystem);
			}
		} catch (error) {
			log(`Restore previous runtime: ${error.message}`);
			return "The previous runtime couldn't be put back.";
		}
		return runtimeReady() && (!moves.length || await sourceAt(state.from, oldSourceOptions)) ? null : "The previous version couldn't be verified.";
	};
	const clearMarker = () => {
		try { fileSystem.unlinkSync(markerFile); return true; } catch (error) {
			if (error.code === "ENOENT") { return true; }
			log(`Clear update marker: ${error.message}`);
			return false;
		}
	};
	const show = async (message) => {
		if (recovering && !options.waitPid) { return; }
		try { await showRecovery(message, deps.spawn); } catch (error) { log(`Show update message: ${error.message}`); }
	};
	const manual = async (reason, keepMarker = false, steps = RECOVERY_STEPS) => {
		if (!keepMarker) { clearMarker(); }
		const result = { ok: false, message: `${reason}\n\n${steps}` };
		log(result.message);
		persist(resultFile, result);
		persist(recoveryFile, result);
		await show(result.message);
		return result;
	};
	const finish = async (result, relaunch = false) => {
		if (!clearMarker()) { return await manual("The update marker couldn't be cleared.", true); }
		log(result.message);
		const saved = persist(resultFile, result);
		try { fileSystem.unlinkSync(recoveryFile); } catch {}
		if (relaunch) {
			try {
				await startDetached(exe, state.args || [appDir, "--build-if-stale"], { cwd: state.cwd || appDir, windowsHide: false }, deps.spawn);
			} catch (error) {
				log(`Relaunch: ${error.message}`);
				return await manual(`${result.message} The app couldn't reopen.`);
			}
		}
		if (!saved) { await show(result.message); }
		return result;
	};
	const failedUpdate = async (reason) => {
		const failure = await restore();
		if (failure) { return await manual(`${reason} ${failure} The app stayed closed.`); }
		return await finish({ ok: false, message: `${reason} The previous version is ready.` }, true);
	};
	const completeUpdate = async () => {
		if (!runtimeReady() || !await sourceAt(state.target)) { return await manual("The updated version couldn't be verified."); }
		const trash = [];
		for (const [name] of runtime) {
			try {
				const aside = quarantineAside(name);
				if (aside) { trash.push(aside); }
			} catch (error) { log(`Cleanup ${name}: ${error.message}`); }
		}
		if (!await sourceAt(state.target) || !runtimeReady()) { return await manual("The updated version changed before it could reopen."); }
		const result = await finish({ ok: true, message: `Updated to version ${state.toVersion}.` }, true);
		if (result.ok) {
			for (const aside of trash) { try { remove(aside); } catch (error) { log(`Cleanup ${aside}: ${error.message}`); } }
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
		const recorded = beat(recovering ? "Recover interrupted update" : "Start update");
		if (damaged) { return await manual("The update was interrupted and its recovery record is damaged."); }
		const waitPid = options.waitPid;
		const exited = !waitPid || await waitFor(() => !alive(waitPid), 120000);
		const free = exited && await waitFor(() => {
			try { const fd = fileSystem.openSync(exe, "r+"); fileSystem.closeSync(fd); return true; } catch (error) { return error.code === "ENOENT"; }
		}, 30000);
		if (!free) {
			if (recovering) {
				const message = "The app didn't close. Recovery will retry at the next launch.";
				log(message);
				return { skipped: true, message };
			}
			return await finish({ ok: false, message: "The app didn't close, so nothing was updated." }, false);
		}
		if (recovering) {
			if (state.phase === "committed") { return await completeUpdate(); }
			if (state.writerPending || (state.writerPending === undefined && state.asidesReady !== false && state.mergeStarted !== false)) {
				return await manual("An interrupted update command may still be writing to the original copy.", true, [
					"1. Restart Windows.",
					"2. In the app's folder, run: node scripts/update-helper.cjs --recover",
					"3. If the app stays closed, follow the printed recovery steps.",
				].join("\n"));
			}
			return await failedUpdate("The update was interrupted.");
		}
		if (!recorded) { return await failedUpdate("The update couldn't write its recovery record."); }
		const stale = "The source checkout changed after the update was prepared.";
		if (!await sourceAt(state.from)) { return await manual(stale); }
		const target = await command("Read release commit", "git", ["-C", appDir, "rev-parse", "--verify", `refs/tags/${state.tag}^{commit}`], 120000);
		state.target = target.out.trim();
		if (target.code !== 0 || target.timedOut || !COMMIT.test(state.target)) {
			return await failedUpdate("Git couldn't read the release commit.");
		}
		cleanupTrash();
		beat("Set previous packages and page aside");
		try {
			for (const [name] of runtime) {
				const aside = quarantineAside(name);
				if (aside) { remove(aside); }
			}
		} catch (error) {
			log(`Clean previous aside: ${error.message}`);
			return await failedUpdate("The update couldn't start.");
		}
		state.asidesReady = true;
		if (!beat("Stage current version aside")) {
			state.asidesReady = false;
			return await failedUpdate("The update couldn't record where it would save the previous version.");
		}
		try {
			for (const name of ["node_modules", "dist"]) { renameRetry(path.join(appDir, name), path.join(appDir, `${name}.update-old`), fileSystem); }
		} catch (error) {
			log(`Set aside: ${error.message}`);
			return await failedUpdate("The update couldn't start.");
		}
		const untrackedBeforeMerge = await sourceStatus(state.from, "all");
		if (!untrackedBeforeMerge || untrackedBeforeMerge.some((line) => !line.startsWith("? "))) { return await manual(stale); }
		state.untrackedBeforeMerge = untrackedBeforeMerge;
		state.mergeStarted = true;
		const merged = await command("Git merge", "git", ["-C", appDir, "merge", "--ff-only", "--no-overwrite-ignore", state.target], 120000, "update");
		if (merged.code !== 0 || merged.timedOut) {
			return await failedUpdate("Git couldn't move to the new version.");
		}
		if (!await sourceAt(state.target)) { return await manual("The release checkout couldn't be verified."); }
		const node = process.execPath;
		const npm = path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
		const installed = fileSystem.existsSync(npm) ? await command("npm ci", node, [npm, "ci", "--no-audit", "--no-fund"], 600000, "update") : await command("npm ci", "cmd.exe", ["/d", "/s", "/c", "npm ci --no-audit --no-fund"], 600000, "update");
		let failed = installed.code !== 0 || installed.timedOut ? "npm ci" : "";
		if (!failed) {
			const binary = await command("Electron install", node, [path.join(appDir, "node_modules", "electron", "install.js")], 600000, "update");
			if (binary.code !== 0 || binary.timedOut || !fileSystem.existsSync(exe)) { failed = "Electron install"; }
		}
		if (!failed) {
			await command("Windows name", node, [path.join(appDir, "scripts", "windows-name.mjs")], 120000, "update");
			const built = await command("Build", node, [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "build"], 120000, "update");
			if (built.code !== 0 || built.timedOut) { failed = "build"; }
		}
		if (failed) {
			return await failedUpdate(`The update didn't finish (${failed}).`);
		}
		state.phase = "committed";
		beat("Commit completed update");
		return await completeUpdate();
	} catch (error) {
		if (unsafeStopResult) { return unsafeStopResult; }
		log(`Update error: ${error.message}`);
		return await manual("The update didn't finish.", Boolean(state.writerPending));
	} finally {
		if (ownsLock) { try { fileSystem.unlinkSync(lockFile); } catch {} }
	}
}

module.exports = { main, markerLive, readMarker, findNode, writeAtomic, renameRetry, run };

if (require.main === module) {
	let options;
	// Only Windows source copies use this update helper.
	if (process.platform !== "win32" && (process.argv[2] === "--recover" || process.argv[2] === "--busy")) {
		if (process.argv[2] === "--recover") { console.log("This recovery command is for Windows source copies."); }
		process.exit(0);
	}
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
			if (options.recover) { console.log(result.message); }
			process.exitCode = result.code || 0;
		}).catch((error) => { console.error(error.message); process.exitCode = 1; });
	}
}
