// Runs Grok confined to a session's folder. On macOS and Linux that is Grok's own --sandbox profile.
// The Windows build of Grok ignores --sandbox, so on Windows Grok runs in a Docker container, WSL or Windows Sandbox instead.
// The test results behind these choices are in docs/Claude-plan-sandbox-2026-11-08.md.
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OPTIONS = new Set(["profile", "docker", "wsl", "windows-sandbox"]);
const PROFILES = new Map([["workspace", "grok-desktop"], ["strict", "grok-desktop-strict"]]);
const BASES = new Map([["grok-desktop", "workspace"], ["grok-desktop-strict", "strict"]]);
const DEFAULT_IMAGE = "grok-desktop-sandbox";
const IMAGE_NAME = /^[A-Za-z0-9][\w./:@-]{0,199}$/;
const MODEL_NAME = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const SYSTEM_FOLDER = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const SIGN_IN_FILE = "auth.json";
// Where the setup steps are: the panel a Windows session opens with its Sandbox checkbox, and Settings on macOS and Linux.
const TO_SETUP = process.platform === "win32" ? "Uncheck Sandbox and check it again" : "In Settings, open Sandbox";
const SIGN_IN_ERROR = `Grok isn't signed in inside the sandbox. ${TO_SETUP}, then press Sign in, or save an xAI API key.`;
const WSB_IN_USE = "Another session is using Windows Sandbox, and Windows runs only one at a time. Uncheck Sandbox and check it again to choose Docker or WSL, or try again after that session has been idle for 10 minutes.";
const WSB_SETUP_IN_USE = "Windows Sandbox is running a test or sign-in. Wait for it to finish.";
// Only these reach Grok inside a container, WSL or Windows Sandbox. The rest of this computer's environment stays out.
const PASSED_ENV = ["XAI_API_KEY", "GROK_PROMPT_SUGGESTIONS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];
// A mounted folder belongs to another user as far as git can tell, and git would refuse to work in it.
const GIT_ANY_OWNER = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates && useradd -m grok
RUN curl -fsSL https://x.ai/cli/install.sh | bash && rm -f /usr/local/bin/grok /usr/local/bin/agent && cp -L /root/.grok/bin/grok /usr/local/bin/grok && chmod 755 /usr/local/bin/grok && rm -rf /root/.grok
USER grok
WORKDIR /workspace
`;

let dataDir = path.join(os.tmpdir(), "grok-desktop-sandbox");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) => String(text || "").replace(/\0/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function setDataDir(dir) {
	dataDir = dir;
}

function dataFolder(name) {
	const folder = path.join(dataDir, name);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
}

function choiceProblem(choice, platform = process.platform) {
	if (!choice || typeof choice !== "object" || Array.isArray(choice) || !OPTIONS.has(choice.option)) { return "Choose a sandbox."; }
	if (platform === "win32" && choice.option === "profile") { return "The Windows build of Grok can't sandbox itself. Uncheck Sandbox and check it again to choose Docker, WSL or Windows Sandbox."; }
	if (platform !== "win32" && choice.option !== "profile") { return "That sandbox is only for Windows."; }
	if (choice.profile !== undefined && !PROFILES.has(choice.profile)) { return "Choose a sandbox profile."; }
	if (choice.option === "docker" && choice.image !== undefined && !IMAGE_NAME.test(choice.image)) { return "Enter a valid Docker image name."; }
	if (choice.option === "wsl" && !/^[A-Za-z0-9][\w.-]{0,63}$/.test(String(choice.distro || ""))) { return "Choose a WSL distribution."; }
	if (choice.option === "windows-sandbox" && choice.mappedFolders !== undefined && (!Array.isArray(choice.mappedFolders) || choice.mappedFolders.length > 20 || choice.mappedFolders.some((folder) => typeof folder !== "string" || !path.win32.isAbsolute(folder) || folder.includes("\0")))) {
		return "Folders for Windows Sandbox must be full paths.";
	}
	return "";
}

function choiceKey(choice) {
	return choice ? JSON.stringify(["option", "profile", "image", "distro", "mappedFolders"].map((key) => choice[key] ?? null)) : "";
}

// A stable folder name inside a container or sandbox, so two projects never share one path, and so Grok's per-folder records stay apart.
function slugOf(folder) {
	const name = path.win32.basename(folder).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "project";
	return `${name}-${crypto.createHash("sha256").update(folder.toLowerCase()).digest("hex").slice(0, 6)}`;
}

function relativeInside(root, file, sep, ignoreCase) {
	const key = (value) => (ignoreCase ? value.toLowerCase() : value);
	if (key(file) === key(root)) { return ""; }
	return key(file).startsWith(key(root) + sep) ? file.slice(root.length + 1) : null;
}

// Paths between this computer and a place that holds only some of its folders. "" means the other side can't reach that path.
function rootMapper(roots, guestIsWindows) {
	const hostClean = (value) => path.win32.normalize(String(value)).replace(/\\+$/, "");
	const guestClean = (value) => (guestIsWindows ? hostClean(value) : path.posix.normalize(String(value)).replace(/\/+$/, ""));
	const guestSep = guestIsWindows ? "\\" : "/";
	return {
		toGuest(file) {
			for (const root of roots) {
				const relative = relativeInside(hostClean(root.host), hostClean(file), "\\", true);
				if (relative !== null) { return relative ? `${root.guest}${guestSep}${relative.replace(/\\/g, guestSep)}` : root.guest; }
			}
			return "";
		},
		toHost(file) {
			const value = String(file);
			if (!(guestIsWindows ? path.win32.isAbsolute(value) : value.startsWith("/"))) { return value; }
			for (const root of roots) {
				const relative = relativeInside(guestClean(root.guest), guestClean(value), guestSep, guestIsWindows);
				if (relative !== null) { return relative ? path.win32.join(root.host, relative) : root.host; }
			}
			return "";
		},
	};
}

// ponytail: assumes WSL's default /mnt automount root. A distribution that moved it in wsl.conf gets "folder not found" from Grok.
function wslToGuest(distro, file) {
	const value = String(file).replace(/\//g, "\\");
	const drive = /^([A-Za-z]):(?:\\(.*))?$/.exec(value);
	if (drive) { return `/mnt/${drive[1].toLowerCase()}/${path.win32.normalize(drive[2] || "").replace(/^\.$/, "").replace(/\\/g, "/")}`.replace(/\/+$/, ""); }
	const share = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(value);
	if (share && share[1].toLowerCase() === String(distro).toLowerCase()) { return (share[2] || "\\").replace(/\\/g, "/"); }
	return "";
}

function wslToHost(distro, file) {
	const value = String(file);
	if (!value.startsWith("/")) { return value; }
	const normal = path.posix.normalize(value);
	const drive = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(normal);
	if (drive) { return `${drive[1].toUpperCase()}:\\${(drive[2] || "").replace(/\//g, "\\")}`; }
	return `\\\\wsl.localhost\\${distro}${normal.replace(/\//g, "\\")}`;
}

function profileBlock(name, deny) {
	return `[profiles.${name}]\nextends = "${BASES.get(name)}"\n${deny.length ? `deny = ${JSON.stringify(deny)}\n` : ""}`;
}

// Only the app's own two profiles are replaced. A person's own profiles in this file stay as they are.
function withProfiles(text, deny) {
	const others = String(text || "").replace(/^\[profiles\.grok-desktop(?:-strict)?\][^\S\n]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm, "").trimEnd();
	return `${others ? `${others}\n\n` : ""}${[...BASES.keys()].map((name) => profileBlock(name, deny)).join("\n")}`;
}

function writeProfiles(file, deny) {
	let text = "";
	try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") { throw error; } }
	const next = withProfiles(text, deny);
	if (next === text) { return; }
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, next);
}

// A profile Grok could not apply shows in its event log. A log with no entry says nothing, and Grok refuses a custom profile it can't load.
function enforcementProblem(home, profile) {
	for (const file of [path.join(home, "sessions", "sandbox-events.jsonl"), path.join(home, "sandbox-events.jsonl")]) {
		let lines;
		try {
			lines = readTail(file, 64 * 1024).trim().split("\n").reverse();
		} catch {
			continue;
		}
		for (const line of lines) {
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (!event || event.profile !== profile || (event.event_type !== "ProfileApplied" && event.event_type !== "ApplyFailed")) { continue; }
			return event.event_type === "ApplyFailed" || event.enforced === false ? `Grok couldn't apply the sandbox on this computer, so this session was stopped. ${TO_SETUP} to check the setup.` : "";
		}
	}
	return "";
}

function readTail(file, limit) {
	const handle = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(handle).size;
		const length = Math.min(size, limit);
		const buffer = Buffer.alloc(length);
		fs.readSync(handle, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		fs.closeSync(handle);
	}
}

function guestEnv(env, extra = {}) {
	const passed = Object.fromEntries(PASSED_ENV.filter((name) => env[name]).map((name) => [name, env[name]]));
	return { ...passed, GROK_DISABLE_AUTOUPDATER: "1", ...GIT_ANY_OWNER, ...extra };
}

function profileTarget(choice, cwd, { grokExe, grokHome }) {
	const profile = PROFILES.get(choice.profile || "workspace");
	writeProfiles(path.join(grokHome, "sandbox.toml"), []);
	return {
		guestCwd: cwd,
		home: grokHome,
		profile,
		missing: "Grok is not installed, or not on PATH. Set GROK_PATH to its full path.",
		toGuest: (file) => file,
		toHost: (file) => file,
		launch: (grokArgs, env, plain) => ({ command: grokExe, args: [...(plain ? [] : ["--sandbox", profile]), ...grokArgs], env }),
	};
}

function dockerTarget(choice, cwd) {
	const home = dataFolder("docker-home");
	const image = choice.image || DEFAULT_IMAGE;
	const guestCwd = `/workspace/${slugOf(cwd)}`;
	const name = `grok-desktop-${crypto.randomUUID()}`;
	const stop = (sync) => {
		const run = sync ? spawnSync : spawn;
		try { run("docker", ["rm", "-f", name], { windowsHide: true, stdio: "ignore", ...(sync ? { timeout: 10000 } : {}) }).on?.("error", () => {}); } catch { /* Docker is gone, so the container is too. */ }
	};
	return {
		guestCwd,
		home,
		profile: "",
		missing: `Docker isn't installed. ${TO_SETUP} to see the setup steps.`,
		...rootMapper([{ host: cwd, guest: guestCwd }, { host: home, guest: "/grok-home" }], false),
		stop,
		launch(grokArgs, env) {
			const passed = guestEnv(env, { GROK_HOME: "/grok-home" });
			return {
				command: "docker",
				args: [
					"run", "-i", "--rm", "--init", "--name", name, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
					// A missing built-in image means Build image hasn't run. It must never come from a registry under the same name.
					...(image === DEFAULT_IMAGE ? ["--pull", "never"] : []),
					// Names only: docker reads each value from its own environment, so a key is never on a command line.
					...Object.keys(passed).flatMap((key) => ["-e", key]),
					"-v", `${cwd.replace(/\\/g, "/")}:${guestCwd}`, "-v", `${home.replace(/\\/g, "/")}:/grok-home`, "-w", guestCwd,
					image, "grok", ...grokArgs,
				],
				env: { ...process.env, ...passed },
			};
		},
	};
}

const wslHomes = new Map();
const wslSavedHomes = new Map();
let wslSavedLoading;
let wslSavedWriting = Promise.resolve();
let wslHomeDiscovery;
const wslHomeArgs = (distro, script = 'printf %s "$HOME"') => ["-d", distro, "--exec", "sh", "-c", script];
const WSL_SAVED_HOME = `if [ ! -d "$HOME" ] || [ ! -r "$HOME" ] || [ ! -x "$HOME" ]; then exit 1; fi
if [ -e "$HOME/.grok" ] && { [ ! -d "$HOME/.grok" ] || [ ! -r "$HOME/.grok" ] || [ ! -x "$HOME/.grok" ]; }; then exit 1; fi
if [ -d "$HOME/.grok/sessions" ]; then
	history=$(find -L "$HOME/.grok/sessions" -mindepth 3 -maxdepth 3 -type f -name chat_history.jsonl -print -quit) || exit 1
	if [ -n "$history" ]; then printf 'saved\\n%s' "$HOME"; else printf empty; fi
else
	printf empty
fi`;

function loadWslSavedHomes() {
	wslSavedLoading ??= (async () => {
		try {
			const saved = JSON.parse(await fs.promises.readFile(path.join(dataDir, "wsl-homes.json"), "utf8"));
			for (const entry of Array.isArray(saved) ? saved : []) {
				if (!entry || typeof entry.distro !== "string" || choiceProblem({ option: "wsl", distro: entry.distro }, "win32") || (entry.home !== null && (typeof entry.home !== "string" || !/^\/[^\r\n\0]*$/.test(entry.home)))) { continue; }
				const key = entry.distro.toLowerCase();
				if (!wslSavedHomes.has(key)) { wslSavedHomes.set(key, { distro: entry.distro, home: entry.home }); }
			}
		} catch { /* Missing or damaged discovery data is rebuilt from installed distributions. */ }
	})();
	return wslSavedLoading;
}

function saveWslSavedHomes() {
	wslSavedWriting = wslSavedWriting.then(async () => {
		await loadWslSavedHomes();
		const file = path.join(dataDir, "wsl-homes.json");
		await fs.promises.mkdir(dataDir, { recursive: true });
		await fs.promises.writeFile(`${file}.tmp`, JSON.stringify([...wslSavedHomes.values()]));
		await fs.promises.rename(`${file}.tmp`, file);
		return true;
	}).catch(() => false);
	return wslSavedWriting;
}

function rememberWslHome(distro, home) {
	wslSavedHomes.set(distro.toLowerCase(), { distro, home });
	wslHomeDiscovery = undefined;
	return saveWslSavedHomes();
}

// ponytail: a blocking call once per distribution, because Grok's spawn is synchronous. It waits for a stopped distribution to boot, usually a second or two.
function wslHome(distro) {
	if (wslHomes.has(distro)) { return wslHomes.get(distro); }
	const result = spawnSync("wsl.exe", wslHomeArgs(distro), { windowsHide: true, encoding: "utf8", timeout: 60000 });
	const home = clean(result.stdout).trim();
	if (result.status !== 0 || !home.startsWith("/")) { throw new Error(`WSL couldn't start ${distro}. ${clean(result.stdout || result.stderr).trim().slice(0, 200)}`); }
	wslHomes.set(distro, home);
	void rememberWslHome(distro, home);
	return home;
}

// Previously unclassified distros are checked once for pre-upgrade history. Known empty distros stay stopped on later launches.
async function discoverWslHomes() {
	await loadWslSavedHomes();
	const listed = await runTool("wsl.exe", ["-l", "-v"], { timeout: 5000 });
	if (listed.code !== 0) { return false; }
	const distros = parseWslList(listed.out).filter(({ name, version }) => version === 2 && !choiceProblem({ option: "wsl", distro: name }, "win32"));
	const installed = new Set(distros.map(({ name }) => name.toLowerCase()));
	for (const key of wslSavedHomes.keys()) {
		if (!installed.has(key)) { wslSavedHomes.delete(key); }
	}
	const found = await Promise.all(distros.map(async ({ name }) => {
		const key = name.toLowerCase();
		if (wslSavedHomes.has(key)) { return true; }
		const { code, out } = await runTool("wsl.exe", wslHomeArgs(name, WSL_SAVED_HOME), { timeout: 60000 });
		const saved = /^saved\r?\n(\/[^\r\n\0]*)$/.exec(out);
		if (code !== 0 || (!saved && out !== "empty")) { return false; }
		if (!wslSavedHomes.has(key)) { wslSavedHomes.set(key, { distro: name, home: saved ? saved[1] : null }); }
		return true;
	}));
	const persisted = await saveWslSavedHomes();
	return persisted && found.every(Boolean);
}

// /run/WSL holds the socket that starts Windows programs, which the Linux sandbox doesn't confine. Without it Grok can only run Linux programs.
// The rest keeps credentials out of reach, because the workspace profile can read everything else. A path that doesn't exist needs no rule, and neither may cover the session's folder.
function wslDeny(distro, cwd, home, { windowsHome = os.homedir(), exists = fs.existsSync } = {}) {
	const credentialNames = [".ssh", ".aws", ".azure", ".docker", ".kube", ".gnupg", ".git-credentials", ".netrc", "_netrc", ".npmrc", ".config/gh", ".config/gcloud"];
	const windowsNames = [...credentialNames, ".grok", "AppData"];
	const paths = [...credentialNames.map((name) => `${home}/${name}`), ...windowsNames.map((name) => wslToGuest(distro, path.win32.join(windowsHome, name)))];
	const guestCwd = wslToGuest(distro, cwd);
	return ["/run/WSL", ...paths.filter((entry) => {
		if (!entry || guestCwd === entry || guestCwd.startsWith(`${entry}/`)) { return false; }
		try { return exists(wslToHost(distro, entry)); } catch { return false; }
	})];
}

function wslTarget(choice, cwd) {
	const { distro } = choice;
	const guestCwd = wslToGuest(distro, cwd);
	if (!guestCwd) { throw new Error(`WSL can't reach this folder: ${cwd}`); }
	const guestHome = `${wslHome(distro)}/.grok`;
	const home = wslToHost(distro, guestHome);
	const profile = PROFILES.get(choice.profile || "workspace");
	writeProfiles(path.win32.join(home, "sandbox.toml"), wslDeny(distro, cwd, wslHome(distro)));
	return {
		guestCwd,
		home,
		profile,
		missing: `WSL isn't installed. ${TO_SETUP} to see the setup steps.`,
		toGuest: (file) => wslToGuest(distro, file),
		toHost: (file) => wslToHost(distro, file),
		launch(grokArgs, env, plain) {
			const passed = guestEnv(env);
			const shared = [...new Set([...String(env.WSLENV || "").split(":").filter(Boolean), ...Object.keys(passed)])].join(":");
			return {
				command: "wsl.exe",
				// --exec runs no shell of WSL's own, so nothing in these arguments is reparsed.
				args: ["-d", distro, "--cd", guestCwd, "--exec", "sh", "-c", 'G="$HOME/.grok/bin/grok"; [ -x "$G" ] || G=grok; exec "$G" "$@"', "grok", ...(plain ? [] : ["--sandbox", profile]), ...grokArgs],
				env: { ...process.env, ...passed, WSLENV: shared },
			};
		},
	};
}

function runTool(command, args, { timeout = 30000, input } = {}) {
	return new Promise((resolve) => {
		let child;
		let out = "";
		let err = "";
		let settled = false;
		const finish = (result) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ out: clean(out).trim(), err: clean(err).trim(), ...result });
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* It already ended. */ }
			finish({ code: -1, timedOut: true });
		}, timeout);
		try {
			child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			finish({ code: -1, missing: true });
			return;
		}
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.on("data", (chunk) => { err += chunk; });
		child.on("error", (error) => finish({ code: -1, missing: error && error.code === "ENOENT" }));
		child.on("close", (code) => finish({ code: code === null ? -1 : code }));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const WSB_CONFIG = "<Configuration><vGPU>Disable</vGPU><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection></Configuration>";
const WSB_RUN = "C:\\run";
const WSB_HOME = "C:\\grokhome";
const WSB_BASE_PORT = 24200;
const wsb = { vm: null, id: "", owner: "", mountKey: "", setup: null, clients: new Set(), next: 0, stopTimer: null };
const wsbGit = () => {
	const found = spawnSync("where", ["git"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
	const first = clean(found.stdout).split(/\r?\n/).find((line) => /\\cmd\\git\.exe$/i.test(line.trim()));
	return first ? first.trim().replace(/\\cmd\\git\.exe$/i, "") : "";
};
const toolFolder = (folder) => `C:\\tools\\${slugOf(folder)}`;
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function retried(attempts, gap, work) {
	let result;
	for (let tried = 0; tried < attempts; tried += 1) {
		result = await work();
		if (result.code === 0) { return result; }
		await sleep(gap);
	}
	return result;
}

// wsb exits 0 when the command inside fails. It reports that command's code in its own output instead.
async function wsbExec(id, command, timeout = 120000) {
	const result = await runTool("wsb", ["exec", "--id", id, "-r", "System", "-c", command], { timeout });
	const inner = /exited with code:\s*(-?\d+)/i.exec(result.out);
	return inner ? { ...result, code: Number(inner[1]) } : result;
}

// PowerShell exits with this code when its script isn't there. A session started while the VM is running writes its script after the VM has listed that folder.
const SCRIPT_NOT_SEEN = -196608;

async function wsbPowerShell(id, file, timeout) {
	let result;
	for (let tried = 0; tried < 20; tried += 1) {
		result = await wsbExec(id, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${file}`, timeout);
		if (result.code !== SCRIPT_NOT_SEEN) { return result; }
		await sleep(1000);
	}
	return result;
}

async function wsbShare(vm, host, guest, write) {
	const key = guest.toLowerCase();
	if (!vm.shared.has(key)) {
		vm.shared.set(key, retried(15, 1000, () => runTool("wsb", ["share", "--id", vm.id, "-f", host, "-s", guest, ...(write ? ["-w"] : [])], { timeout: 60000 })).then((result) => {
			if (result.code !== 0) { throw new Error(`Windows Sandbox couldn't share ${host}. ${result.err || result.out}`.slice(0, 300)); }
		}).catch((error) => {
			vm.shared.delete(key);
			throw error;
		}));
	}
	await vm.shared.get(key);
}

// wsb exec shows nothing of what a script prints, so a script's failure goes in a file this computer can read.
function wsbStopOnError(errName) {
	return ["$ErrorActionPreference = 'Stop'", `trap { "$_" | Set-Content ${psQuote(`${WSB_RUN}\\${errName}`)}; exit 1 }`];
}

function readLast(file) {
	try { return clean(fs.readFileSync(file, "utf8")).trim().split(/\r?\n/).slice(-2).join(" "); } catch { return ""; }
}

// The two policy lines turn off Smart App Control inside this disposable VM only, so mapped unsigned tools such as Git for Windows can run.
// A LogonCommand would not run: with no window, nobody signs in.
function wsbBootScript() {
	return [
		...wsbStopOnError("boot.err"),
		'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy" /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f | Out-Null',
		"CiTool.exe -r -json | Out-Null",
		`netsh advfirewall firewall add rule name=grok-desktop dir=in action=allow protocol=TCP localport=${WSB_BASE_PORT}-${WSB_BASE_PORT + 999} | Out-Null`,
	].join("\r\n");
}

async function wsbBootOnce(grokFolder, gitFolder, run) {
	const started = await runTool("wsb", ["start", "--raw", "-c", WSB_CONFIG], { timeout: 60000 });
	if (started.missing) { throw new Error(`Windows Sandbox's wsb command wasn't found. ${TO_SETUP} to see the setup steps.`); }
	const id = (started.out.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i) || [])[0];
	if (started.code !== 0 || !id) { return { problem: started.err || started.out || "wsb start failed." }; }
	wsb.id = id;
	fs.writeFileSync(path.join(run, "vm-id.txt"), id);
	const vm = { id, shared: new Map() };
	fs.writeFileSync(path.join(run, "boot.ps1"), wsbBootScript());
	await wsbShare(vm, run, WSB_RUN, true);
	await wsbShare(vm, grokFolder, "C:\\grok", false);
	if (gitFolder) { await wsbShare(vm, gitFolder, "C:\\git", false); }
	const booted = await retried(5, 2000, () => wsbPowerShell(id, `${WSB_RUN}\\boot.ps1`));
	return booted.code === 0 ? { vm } : { problem: readLast(path.join(run, "boot.err")) || booted.err || booted.out || "The sandbox's start script failed." };
}

// Grok's installer puts it on PATH under this name when GROK_HOME holds no copy. Anything else isn't a program Windows Sandbox can run.
function windowsProgram(named, fileName) {
	if (path.win32.isAbsolute(named)) { return path.win32.basename(named).toLowerCase() === fileName ? named : ""; }
	const found = spawnSync("where", [fileName], { windowsHide: true, encoding: "utf8", timeout: 5000 });
	return clean(found.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

// A crash of this app can leave a Windows Sandbox running with nothing using it, and it would block a new one.
// One the person opened themselves isn't in this file. It makes wsb start fail, and that error is shown.
async function stopSavedVm() {
	const file = path.join(dataDir, "wsb-run", "vm-id.txt");
	let saved = "";
	try { saved = fs.readFileSync(file, "utf8").trim(); } catch { return; }
	if (saved && saved !== wsb.id) { await runTool("wsb", ["stop", "--id", saved], { timeout: 30000 }); }
	if (!wsb.id) { try { fs.rmSync(file, { force: true }); } catch { /* A later start stops it again, which is harmless. */ } }
}

// When the app starts, nothing in the work folder is of use. A session started in the meantime has its files there, so then they stay.
async function stopLeftover() {
	await stopSavedVm();
	if (wsb.clients.size || wsb.vm) { return; }
	try { fs.rmSync(path.join(dataDir, "wsb-run"), { recursive: true, force: true }); } catch { /* Windows may still hold a file. The next start tries again. */ }
}

async function wsbBoot(grokFolder, gitFolder, run) {
	await stopSavedVm();
	let problem = "";
	// A start straight after a stop can die at once with "ID not found". A later start works.
	for (let tried = 0; tried < 3; tried += 1) {
		try {
			const result = await wsbBootOnce(grokFolder, gitFolder, run);
			if (result.vm) { return result.vm; }
			({ problem } = result);
		} catch (error) {
			problem = error.message;
			if (/wasn't found/.test(problem)) { throw error; }
		}
		await sleep(3000);
	}
	throw new Error(`Windows Sandbox couldn't start. ${problem}`.slice(0, 400));
}

// Windows runs one Windows Sandbox. Setup jobs reserve it without reporting themselves as sessions.
function windowsSandboxHolder() {
	for (const client of wsb.clients) {
		if (typeof client.spec.owner === "string" && client.spec.owner) { return client.spec.owner; }
	}
	return "";
}

function inUseProblem(choice, owner) {
	if (!choice || choice.option !== "windows-sandbox") { return ""; }
	if (wsb.setup && wsb.setup !== owner) { return WSB_SETUP_IN_USE; }
	const holder = windowsSandboxHolder();
	return holder && holder !== owner ? WSB_IN_USE : "";
}

// A folder shared with a VM stays shared until the VM stops. Reuse requires the same owner and mounts.
function wsbStartVm({ grokExe, owner, run, mounts, client }) {
	if (wsb.setup && wsb.setup !== owner) { throw new Error(WSB_SETUP_IN_USE); }
	const holder = windowsSandboxHolder();
	if (holder && holder !== owner) { throw new Error(WSB_IN_USE); }
	const onDisk = windowsProgram(grokExe, "grok.exe");
	if (!onDisk) { throw new Error("Install Grok on this computer first. Windows Sandbox uses that copy."); }
	const grokFolder = path.win32.dirname(onDisk);
	const gitFolder = wsbGit();
	const mountKey = JSON.stringify([run, grokFolder, gitFolder, [...new Set(mounts.map((mount) => JSON.stringify(mount)))].sort()]);
	const replace = wsb.vm && (wsb.owner !== owner || wsb.mountKey !== mountKey);
	if (replace) {
		const others = [...wsb.clients].filter((child) => child !== client);
		if (client?.spec.side && others.some((child) => !child.spec.side && child.spec.guestCwd.toLowerCase() === client.spec.guestCwd.toLowerCase())) {
			throw new Error("The main session is changing its Windows Sandbox. Try again after its message finishes.");
		}
		for (const child of others) { child.stopRemote(); }
	}
	clearTimeout(wsb.stopTimer);
	if (!wsb.vm || replace) {
		const before = replace ? wsb.vm.catch(() => {}).then(() => { wsb.id = ""; }) : Promise.resolve();
		const booting = before.then(() => wsbBoot(grokFolder, gitFolder, run)).catch((error) => {
			if (wsb.vm === booting) { wsb.vm = null; }
			throw error;
		});
		wsb.owner = owner;
		wsb.mountKey = mountKey;
		wsb.vm = booting;
	}
	return wsb.vm;
}

function wsbStopVm(sync) {
	const { id } = wsb;
	wsb.vm = null;
	wsb.id = "";
	wsb.owner = "";
	wsb.mountKey = "";
	if (!id) { return; }
	if (sync) {
		spawnSync("wsb", ["stop", "--id", id], { windowsHide: true, stdio: "ignore", timeout: 15000 });
	} else {
		void runTool("wsb", ["stop", "--id", id], { timeout: 30000 });
	}
	try { fs.rmSync(path.join(dataFolder("wsb-run"), "vm-id.txt"), { force: true }); } catch { /* A later start stops it again, which is harmless. */ }
}

function wsbScriptEnv(env, keyFile) {
	const passed = guestEnv(env, { GROK_HOME: WSB_HOME });
	delete passed.XAI_API_KEY;
	return [
		"$env:PATH = 'C:\\git\\cmd;C:\\git\\bin;' + $env:PATH",
		...Object.entries(passed).map(([name, value]) => `$env:${name} = ${psQuote(value)}`),
		// The key goes in a file this script reads and deletes, because wsb exec has only a command line.
		...(keyFile ? [`$env:XAI_API_KEY = (Get-Content ${psQuote(keyFile)} -Raw).Trim()`, `Remove-Item ${psQuote(keyFile)}`] : []),
	];
}

// Looks like the child process agent.cjs expects, but talks to `grok agent serve` inside Windows Sandbox.
// wsb exec returns no output, so it can't carry stdio.
class WsbChild extends EventEmitter {
	constructor(spec) {
		super();
		this.spec = spec;
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.queue = [];
		this.ws = null;
		this.done = false;
		this.stdin = { writable: true, on: () => {}, write: (line) => this.send(line), end: () => {} };
		wsb.clients.add(this);
		clearTimeout(wsb.stopTimer);
		this.start().catch((error) => this.finish(error.message || "Windows Sandbox couldn't start Grok."));
	}

	send(line) {
		if (this.ws && this.ws.readyState === 1) {
			this.ws.send(String(line).trim());
		} else {
			this.queue.push(line);
		}
		return true;
	}

	async start() {
		const { owner, grokExe, guestCwd, cwd, home, grokArgs, env, mappedFolders } = this.spec;
		// These files go in place before the VM starts, because a new file can take seconds to show up inside a running VM.
		const number = ++wsb.next;
		const port = WSB_BASE_PORT + (number % 1000);
		const secret = crypto.randomBytes(24).toString("hex");
		const run = dataFolder("wsb-run");
		const keyName = `${number}.key`;
		this.files = [`${number}.ps1`, `${number}.pid`, `${number}.err`, `${number}.out`, keyName].map((name) => path.join(run, name));
		this.pidFile = path.join(run, `${number}.pid`);
		if (env.XAI_API_KEY) { fs.writeFileSync(path.join(run, keyName), env.XAI_API_KEY); }
		const args = [...grokArgs.slice(0, -1), "serve", "--bind", `0.0.0.0:${port}`];
		fs.writeFileSync(path.join(run, `${number}.ps1`), [
			...wsbStopOnError(`${number}.err`),
			...wsbScriptEnv(env, env.XAI_API_KEY ? `${WSB_RUN}\\${keyName}` : ""),
			...mappedFolders.flatMap((folder) => [`$env:PATH = ${psQuote(`${toolFolder(folder)};${toolFolder(folder)}\\bin;`)} + $env:PATH`]),
			`$env:GROK_AGENT_SECRET = ${psQuote(secret)}`,
			`$p = Start-Process -FilePath C:\\grok\\grok.exe -ArgumentList ${psQuote(args.join(" "))} -WorkingDirectory ${psQuote(guestCwd)} -WindowStyle Hidden -RedirectStandardError ${psQuote(`${WSB_RUN}\\${number}.err`)} -RedirectStandardOutput ${psQuote(`${WSB_RUN}\\${number}.out`)} -PassThru`,
			`$p.Id | Set-Content ${psQuote(`${WSB_RUN}\\${number}.pid`)}`,
		].join("\r\n"));
		const mounts = [[cwd, guestCwd, true], [home, WSB_HOME, true], ...mappedFolders.map((folder) => [folder, toolFolder(folder), false])];
		const vm = await wsbStartVm({ grokExe, owner, run, mounts, client: this });
		this.vmId = vm.id;
		if (this.done) { return; }
		for (const mount of mounts) {
			if (this.done) { return; }
			await wsbShare(vm, ...mount);
		}
		if (this.done) { return; }
		const started = await wsbPowerShell(vm.id, `${WSB_RUN}\\${number}.ps1`);
		for (const name of [keyName, `${number}.ps1`]) { fs.rmSync(path.join(run, name), { force: true }); }
		if (started.code !== 0) { throw new Error(`Windows Sandbox couldn't start Grok. ${readLast(path.join(run, `${number}.err`)) || started.err || started.out}`.slice(0, 300)); }
		const ip = await runTool("wsb", ["ip", "--id", vm.id, "--raw"]);
		const address = (ip.out.match(/\d+\.\d+\.\d+\.\d+/) || [])[0];
		if (!address) { throw new Error("Windows Sandbox didn't report an address."); }
		await this.connect(`ws://${address}:${port}/ws?server-key=${secret}`, path.join(run, `${number}.err`));
	}

	async connect(url, errFile) {
		const deadline = Date.now() + 60000;
		while (!this.done) {
			const socket = await new Promise((resolve) => {
				const attempt = new WebSocket(url);
				attempt.addEventListener("open", () => resolve(attempt));
				attempt.addEventListener("error", () => resolve(null));
			});
			if (socket) {
				if (this.done) { socket.close(); return; }
				this.ws = socket;
				socket.addEventListener("message", (event) => {
					const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
					this.stdout.emit("data", Buffer.from(`${text}\n`));
				});
				socket.addEventListener("close", () => this.finish(""));
				for (const line of this.queue.splice(0)) { this.send(line); }
				return;
			}
			if (Date.now() > deadline) { throw new Error(`Grok didn't answer inside Windows Sandbox. ${readLast(errFile)}`.slice(0, 300)); }
			await sleep(500);
		}
	}

	finish(message) {
		if (this.done) { return; }
		this.done = true;
		this.stdin.writable = false;
		if (message) { this.stderr.emit("data", Buffer.from(message)); }
		wsb.clients.delete(this);
		this.cleanUp();
		setImmediate(() => this.emit("exit", message ? 1 : 0));
	}

	cleanUp() {
		let pid = "";
		try { pid = fs.readFileSync(this.pidFile, "utf8").trim(); } catch { /* Grok never started. */ }
		const removeFiles = () => {
			for (const file of this.files || []) { try { fs.rmSync(file, { force: true }); } catch { /* Windows may still hold it. Nothing reads it again. */ } }
		};
		// Grok holds its log files open until it has stopped.
		if (/^\d+$/.test(pid) && this.vmId) { void wsbExec(this.vmId, `taskkill /PID ${pid} /T /F`).finally(removeFiles); } else { removeFiles(); }
		// A new message or a mode change starts Grok again soon, so the VM waits a minute before it stops.
		if (!wsb.clients.size) {
			clearTimeout(wsb.stopTimer);
			wsb.stopTimer = setTimeout(() => { if (!wsb.clients.size) { wsbStopVm(false); } }, 60000);
			wsb.stopTimer.unref?.();
		}
	}

	// The session's side chat or a test can be using the same VM, so this stops only this Grok. shutdown() stops the VM when the app closes.
	stopRemote() {
		const { ws } = this;
		this.finish("");
		try { ws?.close(); } catch { /* It already closed. */ }
	}

	kill() {
		this.stopRemote();
	}
}

function windowsSandboxTarget(choice, cwd, { grokExe, owner, side }) {
	const home = dataFolder("wsb-home");
	const guestCwd = `C:\\work\\${slugOf(cwd)}`;
	const mappedFolders = choice.mappedFolders || [];
	return {
		guestCwd,
		home,
		profile: "",
		missing: "",
		...rootMapper([{ host: cwd, guest: guestCwd }, { host: home, guest: WSB_HOME }], true),
		launch(grokArgs, env, plain) {
			if (plain) { return { run: (onText) => wsbRunOnce({ grokExe, grokArgs, env, home, onText, owner }) }; }
			return { child: new WsbChild({ owner, side, grokExe, guestCwd, cwd, home, grokArgs, env, mappedFolders }) };
		},
	};
}

// One command to its end, with its output read back from shared files. Used to sign in.
async function wsbRunOnce({ grokExe, grokArgs, env, home, onText, owner }) {
	const run = dataFolder("wsb-run");
	const number = ++wsb.next;
	const files = ["ps1", "out", "err", "pid"].map((kind) => path.join(run, `${number}.${kind}`));
	const readFile = (file) => { try { return clean(fs.readFileSync(file, "utf8")); } catch { return ""; } };
	fs.writeFileSync(files[0], [
		...wsbStopOnError(`${number}.err`),
		...wsbScriptEnv({ ...env, XAI_API_KEY: "" }, ""),
		`$p = Start-Process -FilePath C:\\grok\\grok.exe -ArgumentList ${psQuote(grokArgs.join(" "))} -WorkingDirectory C:\\ -WindowStyle Hidden -RedirectStandardOutput ${psQuote(`${WSB_RUN}\\${number}.out`)} -RedirectStandardError ${psQuote(`${WSB_RUN}\\${number}.err`)} -PassThru`,
		// PowerShell loses the exit code of a process unless something holds its handle before it ends.
		"$null = $p.Handle",
		`$p.Id | Set-Content ${psQuote(`${WSB_RUN}\\${number}.pid`)}`,
		"$p.WaitForExit()",
		"exit $p.ExitCode",
	].join("\r\n"));
	const vm = await wsbStartVm({ grokExe, owner, run, mounts: [[home, WSB_HOME, true]] });
	await wsbShare(vm, home, WSB_HOME, true);
	let shown = 0;
	const show = () => {
		const text = `${readFile(files[1])}${readFile(files[2])}`;
		if (text.length > shown) {
			onText(text.slice(shown));
			shown = text.length;
		}
	};
	const stop = () => {
		const pid = readFile(files[3]).trim();
		if (/^\d+$/.test(pid)) { void wsbExec(vm.id, `taskkill /PID ${pid} /T /F`); }
	};
	const timer = setInterval(show, 1000);
	const running = { kill: stop };
	job = running;
	try {
		return await wsbPowerShell(vm.id, `${WSB_RUN}\\${number}.ps1`, 10 * 60 * 1000);
	} finally {
		if (job === running) { job = null; }
		stop();
		clearInterval(timer);
		show();
		for (const file of files) { try { fs.rmSync(file, { force: true }); } catch { /* Windows may still hold it. Nothing reads it again. */ } }
		if (!wsb.clients.size) {
			clearTimeout(wsb.stopTimer);
			wsbStopVm(false);
		}
	}
}

function shutdown() {
	clearTimeout(wsb.stopTimer);
	wsbStopVm(true);
}

function targetFor(choice, cwd, { platform = process.platform, grokExe, grokHome, owner, side }) {
	const problem = choiceProblem(choice, platform);
	if (problem) { throw new Error(problem); }
	if (choice.option === "profile") { return profileTarget(choice, cwd, { grokExe, grokHome }); }
	if (choice.option === "docker") { return dockerTarget(choice, cwd); }
	if (choice.option === "wsl") { return wslTarget(choice, cwd); }
	return windowsSandboxTarget(choice, cwd, { grokExe, owner, side });
}

// Where sandboxed sessions keep their files, for the panes that read them.
async function sessionRoots() {
	if (process.platform === "win32") {
		wslHomeDiscovery ??= discoverWslHomes();
		const discovery = wslHomeDiscovery;
		if (!await discovery && wslHomeDiscovery === discovery) { wslHomeDiscovery = undefined; }
	}
	return [path.join(dataDir, "docker-home", "sessions"), path.join(dataDir, "wsb-home", "sessions"), ...[...wslSavedHomes.values()].filter(({ home }) => home).map(({ distro, home }) => wslToHost(distro, `${home}/.grok/sessions`))];
}

async function checkDocker(choice) {
	const version = await runTool("docker", ["version", "--format", "{{.Server.Version}}"]);
	if (version.missing) { return { ready: false, problem: "Docker Desktop isn't installed." }; }
	if (version.code !== 0) { return { ready: false, installed: true, problem: "Docker is installed but isn't running. Start Docker Desktop." }; }
	const image = choice.image || DEFAULT_IMAGE;
	if (!IMAGE_NAME.test(image)) { return { ready: false, installed: true, problem: "Enter a valid Docker image name." }; }
	const found = await runTool("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
	const signedIn = fs.existsSync(path.join(dataDir, "docker-home", SIGN_IN_FILE));
	if (found.code !== 0) { return { ready: false, installed: true, signedIn, problem: choice.image ? `Docker can't find the image ${image}.` : "The sandbox image isn't built yet." }; }
	return { ready: true, installed: true, signedIn, detail: `Docker ${version.out} is running.` };
}

function parseWslList(text) {
	return clean(text).split(/\r?\n/).slice(1).map((line) => /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line)).filter(Boolean)
		.map((match) => ({ name: match[2], isDefault: !!match[1], version: Number(match[4]) }))
		.filter((item) => !/^docker-desktop/i.test(item.name));
}

async function checkWsl(choice) {
	const listed = await runTool("wsl.exe", ["-l", "-v"]);
	if (listed.missing) { return { ready: false, distros: [], problem: "WSL isn't installed." }; }
	const distros = parseWslList(listed.out);
	if (listed.code !== 0 || !distros.length) { return { ready: false, distros: [], problem: "WSL has no Linux distribution installed." }; }
	const picked = distros.find((item) => item.name === choice.distro) || distros.find((item) => item.isDefault) || distros[0];
	const names = distros.map((item) => item.name);
	if (picked.version !== 2) { return { ready: false, installed: true, distros: names, distro: picked.name, problem: `${picked.name} runs on WSL 1, which can't sandbox. Run: wsl --set-version ${picked.name} 2` }; }
	await loadWslSavedHomes();
	wslSavedHomes.delete(picked.name.toLowerCase());
	wslHomes.clear();
	wslHomeDiscovery = undefined;
	await saveWslSavedHomes();
	const script = 'G="$HOME/.grok/bin/grok"; [ -x "$G" ] || G=grok; if command -v "$G" >/dev/null 2>&1; then echo grok=yes; else echo grok=no; fi; if command -v bwrap >/dev/null 2>&1; then echo bwrap=yes; else echo bwrap=no; fi; if [ -f "$HOME/.grok/auth.json" ]; then echo auth=yes; else echo auth=no; fi; printf "\\nhome=%s\\n" "$HOME"';
	const probe = await runTool("wsl.exe", ["-d", picked.name, "--exec", "sh", "-c", script], { timeout: 60000 });
	const base = { installed: true, distros: names, distro: picked.name, signedIn: probe.out.includes("auth=yes") };
	if (probe.code !== 0) { return { ...base, ready: false, problem: `WSL couldn't start ${picked.name}.` }; }
	const home = /^home=(\/[^\r\n\0]*)$/m.exec(probe.out);
	if (home && probe.out.includes("grok=yes")) { await rememberWslHome(picked.name, home[1]); }
	if (probe.out.includes("grok=no")) { return { ...base, ready: false, problem: `Grok isn't installed in ${picked.name}.` }; }
	if (probe.out.includes("bwrap=no")) { return { ...base, ready: false, problem: `Bubblewrap isn't installed in ${picked.name}.` }; }
	return { ...base, ready: true, detail: `${picked.name} is ready.` };
}

async function checkWindowsSandbox() {
	const version = await runTool("wsb", ["--version"]);
	const signedIn = fs.existsSync(path.join(dataDir, "wsb-home", SIGN_IN_FILE));
	if (version.missing) {
		const installed = fs.existsSync(path.win32.join(SYSTEM_FOLDER, "WindowsSandbox.exe"));
		return { ready: false, installed, signedIn, problem: installed ? "This version of Windows has no wsb command. Windows 11 24H2 or later has it." : "Windows Sandbox isn't turned on." };
	}
	const listed = await runTool("wsb", ["list", "--raw"]);
	if (listed.code !== 0) { return { ready: false, signedIn, problem: "Windows Sandbox isn't turned on, or it couldn't answer." }; }
	return { ready: true, installed: true, signedIn, detail: `Windows Sandbox is available.${wsbGit() ? "" : " Git for Windows wasn't found, so Grok won't have git there."}` };
}

async function checkProfile(platform) {
	if (platform !== "linux") { return { ready: true, detail: "macOS can sandbox Grok with no setup." }; }
	const found = await runTool("bwrap", ["--version"]);
	return found.code === 0 ? { ready: true, detail: "Bubblewrap is installed." } : { ready: false, problem: "Grok needs Bubblewrap here. Install the bubblewrap package." };
}

function check(choice, platform = process.platform) {
	const option = choice && choice.option;
	if (option === "docker") { return checkDocker(choice); }
	if (option === "wsl") { return checkWsl(choice); }
	if (option === "windows-sandbox") { return checkWindowsSandbox(); }
	return checkProfile(platform);
}

// Long jobs started from the Sandbox panel: building the image and signing in. One at a time, and closing the panel cancels it.
let job = null;

function cancelJob() {
	const current = job;
	job = null;
	try { current?.kill(); } catch { /* It already ended. */ }
}

function streamJob(command, args, { env, input, onText, timeout, stop }) {
	return new Promise((resolve) => {
		cancelJob();
		let child;
		let tail = "";
		const running = {
			kill() {
				try { child.kill(); } catch { /* It already ended. */ }
				stop?.(false);
			},
		};
		const finish = (result) => {
			clearTimeout(timer);
			if (job === running) { job = null; }
			resolve(result);
		};
		const timer = setTimeout(() => {
			cancelJob();
			finish({ ok: false, error: "That took too long and was stopped." });
		}, timeout);
		const take = (chunk) => {
			const text = clean(chunk);
			tail = (tail + text).slice(-400);
			onText(text);
		};
		try {
			child = spawn(command, args, { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			finish({ ok: false, error: error.message });
			return;
		}
		job = running;
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("error", (error) => finish({ ok: false, error: error && error.code === "ENOENT" ? `${command} isn't installed.` : "It could not start." }));
		child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: tail.trim().split(/\r?\n/).slice(-3).join(" ").slice(-300) || "It stopped without saying why." }));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

function buildImage(onText) {
	return streamJob("docker", ["build", "-t", DEFAULT_IMAGE, "-"], { input: DOCKERFILE, onText, timeout: 20 * 60 * 1000, env: process.env });
}

async function signIn(choice, { grokExe, grokHome, env, onText, platform = process.platform }) {
	const busy = inUseProblem(choice);
	if (busy) { return { ok: false, error: busy }; }
	const owner = choice?.option === "windows-sandbox" ? (wsb.setup = Symbol()) : undefined;
	try {
		const target = targetFor(choice, dataFolder("sign-in"), { platform, grokExe, grokHome, owner });
		const launch = target.launch(["login", "--device-auth"], env, true);
		if (launch.run) {
			const result = await launch.run(onText);
			return result.code === 0 ? { ok: true } : { ok: false, error: "Sign-in didn't finish." };
		}
		return await streamJob(launch.command, launch.args, { env: launch.env, onText, timeout: 10 * 60 * 1000, stop: target.stop });
	} catch (error) {
		return { ok: false, error: error.message || "Sign-in couldn't start." };
	} finally {
		if (owner) { wsb.setup = null; }
	}
}

// A Windows program started from WSL keeps the Linux working folder, so it can name the folder next to this one by a relative path, with no spaces to quote.
const POSIX_PROBE = `#!/bin/sh
try() { name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "$name=ok"; else echo "$name=blocked"; fi; }
writeTo() { echo marker > "$1"; }
try write-inside writeTo inside-marker.txt
try write-outside writeTo "$1/outside-marker.txt"
try read-outside cat "$2"
if [ -e ./cmdcopy.exe ]; then
	try windows-program /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Set-Content -Path ..\\\\outside\\\\interop-marker.txt -Value x -ErrorAction Stop"
	try windows-program-in-folder ./cmdcopy.exe /c "echo x> ..\\\\outside\\\\exe-marker.txt"
fi
`;

const WINDOWS_PROBE = `param($Outside, $Decoy)
function Step($Name, [scriptblock]$Action) { try { & $Action | Out-Null; "$Name=ok" } catch { "$Name=blocked" } }
Step "write-inside" { Set-Content -Path "inside-marker.txt" -Value inside -ErrorAction Stop }
Step "write-outside" { Set-Content -Path "$Outside/outside-marker.txt" -Value outside -ErrorAction Stop }
Step "read-outside" { Get-Content -Path $Decoy -ErrorAction Stop }
`;

// Grok runs a small script through one real turn, and the app then looks on this computer for what it managed to write.
async function runTest(choice, { grokExe, grokHome, env, model, platform = process.platform }) {
	const problem = choiceProblem(choice, platform) || inUseProblem(choice) || (MODEL_NAME.test(String(model)) ? "" : "Pick a model first.");
	if (problem) { return { ok: false, checks: [], error: problem }; }
	const root = path.join(dataFolder("test"), crypto.randomUUID());
	const project = path.join(root, "project");
	const outside = path.join(root, "outside");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(outside, "decoy.txt"), "decoy\n");
	const isWsl = choice.option === "wsl";
	const usesWindowsShell = choice.option === "windows-sandbox";
	let child;
	let target;
	const owner = usesWindowsShell ? (wsb.setup = Symbol()) : undefined;
	try {
		target = targetFor(choice, project, { platform, grokExe, grokHome, owner });
		if (usesWindowsShell) {
			fs.writeFileSync(path.join(project, "probe.ps1"), WINDOWS_PROBE);
		} else {
			fs.writeFileSync(path.join(project, "probe.sh"), POSIX_PROBE);
		}
		if (isWsl) { fs.copyFileSync(path.win32.join(SYSTEM_FOLDER, "cmd.exe"), path.join(project, "cmdcopy.exe")); }
		const outsideGuest = target.toGuest(outside) || (usesWindowsShell ? "C:\\not-shared\\outside" : "/not-shared/outside");
		const decoyGuest = usesWindowsShell ? `${outsideGuest}\\decoy.txt` : `${outsideGuest}/decoy.txt`;
		const command = usesWindowsShell
			? `powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1 "${outsideGuest}" "${decoyGuest}"`
			: `sh probe.sh "${outsideGuest}" "${decoyGuest}"`;
		const grokArgs = ["--permission-mode", "default", "agent", "--no-leader", "--always-approve", "--model", model, "--reasoning-effort", "low", "stdio"];
		const launch = target.launch(grokArgs, env);
		child = launch.child || spawn(launch.command, launch.args, { cwd: project, env: launch.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const output = await promptOnce(child, target.guestCwd, `Run this exact command once with your shell tool, then reply with its output verbatim and nothing else. Do not read other files or run anything else.\n\n${command}`);
		const wrote = (name, folder = outside) => fs.existsSync(path.join(folder, name));
		const checks = [
			{ label: "Grok can change files in the session's folder", pass: wrote("inside-marker.txt", project) },
			{ label: "Grok can't change files outside it", pass: !wrote("outside-marker.txt") },
			...(isWsl ? [{ label: "Grok can't start Windows programs", pass: !wrote("interop-marker.txt") && !wrote("exe-marker.txt") }] : []),
		];
		return { ok: checks.every((item) => item.pass), checks, canReadOutside: /read-outside=ok/.test(output) };
	} catch (error) {
		return { ok: false, checks: [], error: error.message || "The test couldn't finish." };
	} finally {
		try { target?.stop?.(false); } catch { /* It already ended. */ }
		try { child?.kill?.(); } catch { /* It already ended. */ }
		if (owner) { wsb.setup = null; }
		try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* A leftover test folder holds nothing of value. */ }
	}
}

// The app's own client is tied to its sessions and cards. The test needs only one turn, with every tool allowed.
function promptOnce(child, cwd, text) {
	return new Promise((resolve, reject) => {
		const pending = new Map();
		let nextId = 1;
		let buffer = "";
		let stderr = "";
		let output = "";
		let settled = false;
		const timer = setTimeout(() => settle(new Error("Grok didn't finish within three minutes.")), 180000);
		const settle = (error) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (error) { reject(error); } else { resolve(output); }
		};
		const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		const request = (method, params) => new Promise((done, fail) => {
			const id = nextId++;
			pending.set(id, { done, fail });
			send({ id, method, params });
		});
		child.stderr.on("data", (chunk) => { stderr = (stderr + clean(chunk)).slice(-1000); });
		child.on("error", (error) => settle(new Error(error.message)));
		child.on("exit", () => settle(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(" ").slice(-300) || "Grok stopped before the test finished.")));
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines) {
				let message;
				try { message = JSON.parse(line); } catch { continue; }
				if (message.method == null && pending.has(message.id)) {
					const call = pending.get(message.id);
					pending.delete(message.id);
					if (message.error) { call.fail(new Error(message.error.message || "Grok refused the test.")); } else { call.done(message.result); }
					continue;
				}
				const update = message.params && message.params.update;
				if (update && update.sessionUpdate === "agent_message_chunk" && update.content && update.content.text) { output += update.content.text; }
				if (update && update.sessionUpdate === "tool_call_update" && update.rawOutput) { output += JSON.stringify(update.rawOutput.output_for_prompt || ""); }
				if (message.id != null && message.method) {
					const allow = message.method === "session/request_permission" ? (message.params.options || []).find((option) => option && option.kind === "allow_once") : null;
					send({ id: message.id, result: message.method === "session/request_permission" ? { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } : null });
				}
			}
		});
		child.stdin.on?.("error", () => {});
		(async () => {
			const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "grok-code", version: "sandbox-test" } });
			const methods = (init && init.authMethods || []).map((item) => item && item.id);
			if (!methods.includes("cached_token") && !methods.includes("xai.api_key")) { throw new Error(SIGN_IN_ERROR); }
			await request("authenticate", { methodId: methods.includes("cached_token") ? "cached_token" : "xai.api_key" });
			const created = await request("session/new", { cwd, mcpServers: [] });
			await request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text }] });
			settle();
		})().catch((error) => settle(error));
	});
}

module.exports = {
	buildImage, cancelJob, check, choiceKey, choiceProblem, enforcementProblem, inUseProblem, parseWslList, rootMapper, runTest, sessionRoots, setDataDir, shutdown, signIn, slugOf, stopLeftover, targetFor, windowsSandboxHolder, withProfiles, wslDeny, wslToGuest, wslToHost,
	wsbClients: wsb.clients,
	SIGN_IN_ERROR,
};
