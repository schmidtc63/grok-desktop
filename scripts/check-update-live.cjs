// Runs one real update of an installed copy, for .github/workflows/update-check.yml. A stubbed spawn can't show that a real launch works.
//   node scripts/check-update-live.cjs <executable> <appRoot> <tag> [--no-reopen]
//   node scripts/check-update-live.cjs --setup <Setup.exe> <executable> <appRoot>
// --no-reopen is for a target whose Setup can't reopen the app, which is every release before this code shipped.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installedUpdateCommand } = require("../electron/updates.cjs");

const PORT = "9333";
const SETUP_IMAGE = "Codewomplers-Grok-Desktop-Setup*";
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function log(text) {
	console.log(`[${new Date().toISOString()}] ${text}`);
}

async function waitFor(label, seconds, check) {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const value = await check();
		if (value) { return value; }
		if (Date.now() > deadline) { throw new Error(`Gave up after ${seconds} seconds: ${label}`); }
		await new Promise((resolve) => { setTimeout(resolve, 1000); });
	}
}

function imageRunning(image) {
	// CSV, because the table form cuts names to 25 characters.
	const listed = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
	return listed.stdout.includes(image.replace("*", ""));
}

// The oldest process started from this exact file. Matching the whole command would also find this script, which names the path.
function appProcess(executable) {
	if (isWindows) { return imageRunning(path.win32.basename(executable)); }
	const found = spawnSync("pgrep", ["-o", "-f", `^${executable}`], { encoding: "utf8" });
	return Number(found.stdout.trim()) || 0;
}

function closeApp(executable) {
	if (isWindows) {
		spawnSync("taskkill", ["/F", "/IM", path.win32.basename(executable)]);
	} else {
		spawnSync("pkill", ["-f", `^${executable}`]);
	}
}

function processGone(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

function installedVersion(appRoot) {
	const file = isMac ? path.join(appRoot, "Contents", "Resources", "app", "package.json") : path.join(appRoot, "resources", "app", "package.json");
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")).version;
	} catch {
		return null;
	}
}

function appDataFolder() {
	if (isWindows) { return process.env.APPDATA; }
	if (isMac) { return path.join(os.homedir(), "Library", "Application Support"); }
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

async function pageSocket() {
	try {
		const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
		return targets.find((item) => item.type === "page" && item.url.includes("dist/index.html"))?.webSocketDebuggerUrl;
	} catch {
		return null;
	}
}

function evaluate(socketUrl, expression) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(socketUrl);
		socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
		socket.onmessage = (event) => {
			const reply = JSON.parse(event.data);
			if (reply.id !== 1) { return; }
			socket.close();
			if (reply.result?.exceptionDetails) { reject(new Error(JSON.stringify(reply.result.exceptionDetails))); }
			resolve(reply.result?.result?.value);
		};
		socket.onerror = () => reject(new Error("The DevTools connection failed."));
	});
}

// macOS starts it as a double-click would, so the check also covers the helper outliving an app started that way.
function startApp(executable, appRoot) {
	if (isMac) {
		spawnSync("/usr/bin/open", ["--env", `GROK_CODE_DEBUG_PORT=${PORT}`, appRoot], { stdio: "inherit" });
		return null;
	}
	return spawn(executable, [], { env: { ...process.env, GROK_CODE_DEBUG_PORT: PORT }, stdio: "ignore" });
}

async function checkUpdate(executable, appRoot, tag, flag) {
	const version = tag.slice(1);
	log(`Starting version ${installedVersion(appRoot)} from ${appRoot}`);
	const child = startApp(executable, appRoot);
	const socket = await waitFor("DevTools lists the app's page", 90, pageSocket);
	const pid = child ? child.pid : await waitFor("the app's process", 30, () => appProcess(executable));
	log(`Preparing ${tag}`);
	const prepared = await evaluate(socket, `window.grokCode.updatePrepare(${JSON.stringify(tag)})`);
	log(`Prepare answered ${JSON.stringify(prepared)}`);
	if (!prepared?.ready) { throw new Error("The prepare wasn't ready."); }
	// The app closes before it can reply.
	evaluate(socket, `window.grokCode.updateStart(${JSON.stringify(tag)})`).catch(() => {});
	await waitFor("the app exits", 60, () => processGone(pid));
	log("The app exited");
	await waitFor(`the installed version is ${version}`, 300, () => installedVersion(appRoot) === version);
	log(`Installed version ${version}`);
	if (isWindows) { await waitFor("Setup finishes", 120, () => !imageRunning(SETUP_IMAGE)); }
	if (flag === "--no-reopen") { return; }
	await waitFor("the app reopens", 120, () => appProcess(executable));
	log("The app reopened");
	// v0.9.0 came before this code, so it doesn't know the file.
	if (tag !== "v0.9.0") {
		await waitFor("the new copy reads update-expected.json", 60, () => !fs.existsSync(path.join(appDataFolder(), "grok-code", "update-expected.json")));
		log("The new copy read the result");
	}
	closeApp(executable);
}

// Proves the Setup script of this branch, which no published release has yet, with the arguments the app passes.
async function checkSetup(setup, executable, appRoot) {
	const finished = spawnSync("cmd", ["/c", "exit"]).pid;
	const { program, args } = installedUpdateCommand({ kind: "setup", file: path.resolve(setup) }, { platform: "win32", pid: finished, userData: os.tmpdir() });
	spawn(program, args, { detached: true, stdio: "ignore", cwd: os.tmpdir() }).unref();
	await waitFor("the app reopens", 180, () => appProcess(executable));
	log("The app reopened");
	await waitFor("Setup finishes", 120, () => !imageRunning(SETUP_IMAGE));
	closeApp(executable);
	if (fs.existsSync(path.join(appRoot, "resources", "app", "stale.txt"))) { throw new Error("Setup left the old version's file behind."); }
	if (!fs.existsSync(path.join(appRoot, "unins000.exe"))) { throw new Error("Setup left no uninstaller."); }
	log("Setup removed the old file and kept its uninstaller");
}

const [first, ...rest] = process.argv.slice(2);
const run = first === "--setup" ? checkSetup(...rest) : checkUpdate(first, ...rest);
run.then(() => {
	log("Passed");
	process.exit(0);
}, (error) => {
	console.error(error.message);
	process.exit(1);
});
