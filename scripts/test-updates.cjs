const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");

const file = path.resolve(__dirname, "../electron/updates.cjs");
const localRequire = createRequire(file);
const moduleState = { exports: {} };
let now = 0;
let stuckFolder = null;
const updateFs = { ...fs, rmSync(target, options) {
	if (target === stuckFolder) { throw new Error("EPERM: macOS won't let this go."); }
	return fs.rmSync(target, options);
} };
vm.runInNewContext(fs.readFileSync(file, "utf8"), {
	module: moduleState, Date: { now: () => now }, process: { platform: "win32" }, AbortSignal,
	require(name) {
		if (name === "../scripts/update-helper.cjs") { return { findNode: async () => process.execPath }; }
		if (name === "fs") { return updateFs; }
		return localRequire(name);
	},
});
const { INSTALL_COMMAND, SWAP_HELPER, installCommand, updateSteps, updateInstructions, installedRoot, installedUpdateCommand, removeUpdateFiles, parseVersion, newer, checkForUpdate, updatePrepare } = moduleState.exports;
const appDir = path.resolve(__dirname, "..");
const sha = "a".repeat(40);
const publishedTag = "v0.10.0";
const releaseRef = `refs/tags/${publishedTag}`;
const matchRelease = `ls-remote --exit-code --tags --refs origin ${releaseRef}`;
const replies = {
	"rev-parse --show-toplevel": appDir,
	"ls-remote --tags --refs origin": `${sha}\t${releaseRef}\n${sha}\trefs/tags/v9.0.0`,
	[matchRelease]: `${sha}\t${releaseRef}`,
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

function github(status, body, endpoint = "latest") {
	return async (url, options) => {
		assert.equal(url, `https://api.github.com/repos/schmidtc63/grok-desktop/releases/${endpoint}`);
		assert.ok(options.signal, "the release request has a timeout");
		return { status, ok: status >= 200 && status < 300, json: async () => body };
	};
}

const fetchLatest = github(200, { tag_name: publishedTag });

async function checkRelease(overrides, current = "0.9.0", fetchUrl = fetchLatest) {
	return checkForUpdate(appDir, current, { ...runner(overrides), force: true, fetchUrl });
}

async function checkPrepare(overrides = {}, findNode = async () => process.execPath, tag = publishedTag, fetchUrl = github(200, { tag_name: publishedTag }, `tags/${publishedTag}`)) {
	const stub = runner(overrides);
	return { result: await updatePrepare(appDir, "0.9.0", tag, { ...stub, findNode, fetchUrl }), calls: stub.calls };
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

const TAG_URL = "https://api.github.com/repos/schmidtc63/grok-desktop/releases/tags/v0.10.0";
const FILES_URL = "https://github.com/schmidtc63/grok-desktop/releases/download/v0.10.0";
const RELEASE_PAGE = "https://github.com/schmidtc63/grok-desktop/releases/latest";
const BUNDLE = "Codewomplers Grok Desktop.app";
const LINUX_FOLDER = "Codewomplers-Grok-Desktop-linux-x64";
const STANDARD_ROOT = "C:\\Users\\me\\AppData\\Local\\Programs\\Codewomplers Grok Desktop";

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

// Answers like GitHub for one release file. A test changes only the part it's about.
function releaseServer(asset, { data = "release file", served = data, sums = `${"0".repeat(64)}  other.zip\n${sha256(data)}  ${asset}\n`, sumsStatus = 200, sumsError = false, fileStatus = 200, dropped = false, notes = () => ({ ok: true, status: 200, json: async () => ({ body: `First note${"n".repeat(4500)}` }) }) } = {}) {
	const calls = [];
	const fetchUrl = async (url, options) => {
		calls.push(url);
		assert.ok(options.signal, `${url} has a timeout`);
		if (url === TAG_URL) { return notes(); }
		if (url === `${FILES_URL}/SHA256SUMS.txt`) {
			if (sumsError) { throw new Error("Offline."); }
			return { ok: sumsStatus === 200, status: sumsStatus, text: async () => sums };
		}
		assert.equal(url, `${FILES_URL}/${asset}`);
		if (fileStatus !== 200) { return { ok: false, status: fileStatus, body: null }; }
		const part = async function* () {
			yield Buffer.from("part");
			throw new Error("Connection dropped.");
		};
		return { ok: true, status: 200, body: dropped ? Readable.from(part()) : Readable.from([Buffer.from(served)]) };
	};
	return { fetchUrl, calls };
}

async function checkWindowsCopy(prepare, refused, userData) {
	const setup = "Codewomplers-Grok-Desktop-Setup.exe";
	const fileUrl = `${FILES_URL}/${setup}`;
	const copy = { localAppData: "C:\\Users\\me\\AppData\\Local", appRoot: STANDARD_ROOT };
	const download = path.join(userData, "update-download", "v0.10.0", setup);
	let server = releaseServer(setup);
	let result = await prepare("win32", copy, server);
	assert.deepEqual([result.ready, result.kind, result.asksPassword, result.steps], [true, "setup", false, undefined]);
	assert.deepEqual(server.calls, [TAG_URL, `${FILES_URL}/SHA256SUMS.txt`, fileUrl]);
	assert.equal(result.file, download);
	assert.equal(fs.readFileSync(download, "utf8"), "release file");
	assert.ok(result.notes.startsWith("First note"));
	assert.equal(result.notes.length, 4000);
	server = releaseServer(setup);
	result = await prepare("win32", { ...copy, appRoot: STANDARD_ROOT.toUpperCase() }, server);
	assert.equal(result.ready, true, "Windows paths ignore case");
	assert.equal(server.calls.includes(fileUrl), false, "a checked file isn't downloaded again");
	fs.writeFileSync(download, "changed");
	server = releaseServer(setup);
	result = await prepare("win32", copy, server);
	assert.equal(server.calls.includes(fileUrl), true, "a file that doesn't match is downloaded again");
	assert.equal(fs.readFileSync(download, "utf8"), "release file");
	fs.writeFileSync(download, "changed");
	stuckFolder = path.join(userData, "update-download");
	result = await prepare("win32", copy, releaseServer(setup));
	stuckFolder = null;
	assert.equal(result.ready, true, "a folder that can't be removed doesn't stop a download");
	assert.equal(fs.readFileSync(download, "utf8"), "release file");

	const zipUpdateSteps = "The app could not confirm that this copy is in the standard folder. To update a zip copy, download and extract the new Windows zip from the release page. The install command below targets the standard folder.";
	await refused("win32", { ...copy, appRoot: "C:\\Tools\\Grok" }, zipUpdateSteps);
	await refused("win32", { ...copy, localAppData: undefined }, zipUpdateSteps);
	await refused("win32", copy, "That release isn't newer than this copy.", "0.10.0");
	for (const [options, reason] of [
		[{ served: "other bytes" }, "The download was damaged. Nothing was changed."],
		[{ fileStatus: 404 }, "The update couldn't be downloaded."],
		[{ dropped: true }, "The update couldn't be downloaded."],
		[{ sumsError: true }, "The update couldn't be downloaded."],
		[{ sums: "no hash here\n" }, "This release has no checksum, so it can't be checked."],
		[{ sumsStatus: 404 }, "This release has no checksum, so it can't be checked."],
	]) {
		fs.rmSync(path.join(userData, "update-download"), { recursive: true, force: true });
		result = await prepare("win32", copy, releaseServer(setup, options));
		assert.deepEqual([result.ready, result.reason, result.steps], [false, reason, installCommand("win32")]);
		assert.equal(fs.existsSync(download), false, `"${reason}" leaves no file behind`);
	}
	for (const notes of [() => ({ ok: false, status: 500 }), () => { throw new Error("Offline."); }]) {
		result = await prepare("win32", copy, releaseServer(setup, { notes }));
		assert.deepEqual([result.ready, result.notes], [true, ""], "failed notes don't stop an update");
	}
}

async function checkMacCopy(prepare, refused, userData, scratch) {
	const home = path.join(scratch, "home");
	const appRoot = path.posix.join(home, "Applications", BUNDLE);
	const contents = path.join(home, "Applications", BUNDLE, "Contents");
	fs.mkdirSync(contents, { recursive: true });
	const tools = [];
	const runTool = async (program, args) => {
		tools.push([program, ...args]);
		const executable = path.join(args[3], BUNDLE, "Contents", "MacOS");
		fs.mkdirSync(executable, { recursive: true });
		fs.writeFileSync(path.join(executable, "Codewomplers Grok Desktop"), "");
	};
	const copy = { home, appRoot, arch: "arm64", runTool };
	const folder = path.join(userData, "update-download", "v0.10.0");
	const zip = "Codewomplers-Grok-Desktop-mac-arm64.zip";
	let result = await prepare("darwin", copy, releaseServer(zip));
	assert.deepEqual([result.ready, result.kind, result.asksPassword, result.sandbox], [true, "swap", false, false]);
	assert.equal(result.staged, path.posix.join(folder, "new", BUNDLE));
	assert.equal(result.previous, path.posix.join(folder, "previous.app"));
	assert.deepEqual(tools.at(-1), ["/usr/bin/ditto", "-x", "-k", path.join(folder, zip), path.posix.join(folder, "new")]);
	assert.equal(fs.existsSync(path.join(contents, ".update-check")), false, "the write test leaves nothing in the bundle");
	result = await prepare("darwin", { ...copy, arch: "x64" }, releaseServer("Codewomplers-Grok-Desktop-mac-x64.zip"));
	assert.equal(result.ready, true, "an Intel copy gets the Intel zip");
	result = await prepare("darwin", { ...copy, runTool: async () => { throw new Error("Bad zip."); } }, releaseServer(zip));
	assert.deepEqual([result.ready, result.reason, result.steps], [false, "The update couldn't be unpacked. Nothing was changed.", INSTALL_COMMAND]);
	assert.equal(fs.existsSync(path.join(folder, "new")), false);
	await refused("darwin", { ...copy, appRoot: `/Volumes/Codewomplers Grok Desktop/${BUNDLE}` }, "This copy isn't in Applications, so it can't update itself.");
	await refused("darwin", { ...copy, writable: () => false }, "The app can't write to its own folder.");
	// /Applications is a recognized place, and this bundle has no Contents folder to write to, as when macOS refuses the write.
	await refused("darwin", { ...copy, appRoot: `/Applications/${BUNDLE}`, writable: () => true }, "macOS stopped this app from changing itself. Allow it under System Settings > Privacy & Security > App Management, then try again.");
}

async function checkLinuxCopies(prepare, refused, userData, scratch) {
	const deb = "codewomplers-grok-desktop_0.10.0_amd64.deb";
	const debCopy = { appRoot: "/opt/codewomplers-grok-desktop", exists: () => true };
	let result = await prepare("linux", debCopy, releaseServer(deb));
	assert.deepEqual([result.ready, result.kind, result.asksPassword, result.staged, result.previous], [true, "deb", true, undefined, undefined]);
	assert.equal(result.file, path.join(userData, "update-download", "v0.10.0", deb));
	const install = installedUpdateCommand({ ...debCopy, ...result }, { platform: "linux", pid: 7, userData, argv: ["--no-sandbox"] });
	assert.deepEqual([...install.args.slice(3)], ["7", debCopy.appRoot, "", "", result.file, "", sha256("release file"), `${debCopy.appRoot}/codewomplers-grok-desktop`, "--no-sandbox"]);
	for (const missing of ["/usr/bin/pkexec", "/usr/bin/apt-get"]) {
		await refused("linux", { ...debCopy, exists: (item) => item !== missing }, "This system has no pkexec or apt-get, so the app can't install the package itself.");
	}

	const appRoot = path.join(scratch, "linux-copy");
	const unpackFolder = `${appRoot}.update`;
	const previous = `${appRoot}.update-previous`;
	const archive = "Codewomplers-Grok-Desktop-linux-x64.tar.gz";
	fs.mkdirSync(appRoot);
	fs.writeFileSync(path.join(appRoot, "chrome-sandbox"), "");
	fs.writeFileSync(path.join(appRoot, "codewomplers-grok-desktop"), "");
	fs.mkdirSync(previous);
	fs.writeFileSync(path.join(previous, "old.txt"), "");
	const tools = [];
	const runTool = async (program, args) => {
		tools.push([program, ...args]);
		const staged = path.join(args[3], LINUX_FOLDER);
		fs.mkdirSync(staged);
		fs.writeFileSync(path.join(staged, "chrome-sandbox"), "");
		fs.writeFileSync(path.join(staged, "codewomplers-grok-desktop"), "");
	};
	const copy = { appRoot, runTool, stat: () => ({ uid: 1000, mode: 0o100755 }) };
	result = await prepare("linux", copy, releaseServer(archive));
	assert.deepEqual([result.ready, result.kind, result.asksPassword, result.sandbox], [true, "swap", false, false]);
	assert.equal(result.staged, path.posix.join(unpackFolder, LINUX_FOLDER));
	assert.equal(result.previous, previous);
	assert.deepEqual(tools.at(-1), ["tar", "-xzf", path.join(userData, "update-download", "v0.10.0", archive), "-C", unpackFolder]);
	assert.equal(fs.existsSync(previous), false, "an old previous copy can't get in the way of the swap");
	assert.equal(fs.existsSync(path.join(result.staged, "codewomplers-grok-desktop")), true);
	const setuid = { ...copy, stat: () => ({ uid: 0, mode: 0o104755 }), exists: (item) => item === "/usr/bin/pkexec" || fs.existsSync(item) };
	result = await prepare("linux", setuid, releaseServer(archive));
	assert.deepEqual([result.ready, result.asksPassword, result.sandbox], [true, true, true], "a copy set up with sudo needs the password");
	assert.equal(result.checksum, sha256("release file"), "the privileged archive update gets the release checksum");
	await refused("linux", { ...setuid, exists: (item) => item !== "/usr/bin/pkexec" && fs.existsSync(item) }, "This system has no pkexec or apt-get, so the app can't install the package itself.");
	await refused("linux", { ...copy, writable: () => false }, "The app can't write to its own folder.");
	await refused("linux", { appRoot: path.join(scratch, "no-such-copy") }, "The app can't write to its own folder.");
	for (const [tool, reason] of [
		[async () => { throw new Error("Bad archive."); }, "The update couldn't be unpacked. Nothing was changed."],
		[async () => {}, "The update couldn't be unpacked. Nothing was changed."],
	]) {
		result = await prepare("linux", { ...copy, runTool: tool }, releaseServer(archive));
		assert.deepEqual([result.ready, result.reason, result.steps], [false, reason, RELEASE_PAGE]);
		assert.equal(fs.existsSync(unpackFolder), false);
	}
	fs.writeFileSync(path.join(appRoot, "my-notes.txt"), "");
	result = await prepare("linux", copy, releaseServer(archive));
	assert.deepEqual([result.ready, result.reason, result.steps], [false, "This folder holds files that aren't part of the app, so it can't update itself.", RELEASE_PAGE]);
	assert.equal(fs.existsSync(unpackFolder), false);
	assert.equal(fs.existsSync(path.join(appRoot, "my-notes.txt")), true);
}

function checkInstalledCommands(scratch) {
	assert.equal(installedRoot("darwin", `/Applications/${BUNDLE}/Contents/MacOS/Codewomplers Grok Desktop`), `/Applications/${BUNDLE}`);
	assert.equal(installedRoot("linux", "/opt/codewomplers-grok-desktop/codewomplers-grok-desktop"), "/opt/codewomplers-grok-desktop");
	assert.equal(installedRoot("win32", `${STANDARD_ROOT}\\Codewomplers Grok Desktop.exe`), STANDARD_ROOT);
	const setup = installedUpdateCommand({ kind: "setup", file: "C:\\d\\Setup.exe" }, { platform: "win32", pid: 7, userData: "C:\\u" });
	assert.equal(setup.program, "C:\\d\\Setup.exe");
	assert.deepEqual([...setup.args], ["/SILENT", "/NORESTART", "/SP-", "/NOCANCEL", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS", "/RELAUNCH=1", "/WAITPID=7", "/LOG=C:\\u\\update-setup.log"]);
	const mac = installedUpdateCommand({ kind: "swap", appRoot: "/A/X.app", file: "/d/x.zip", staged: "/d/new/X.app", previous: "/d/previous.app", sandbox: false }, { platform: "darwin", pid: 7, userData: "/u", argv: ["--ignored"] });
	assert.deepEqual([mac.program, ...mac.args], ["/bin/sh", "-c", SWAP_HELPER, "sh", "7", "/A/X.app", "/d/new/X.app", "/d/previous.app", "", "", "", "/usr/bin/open", "/A/X.app"]);
	const archive = installedUpdateCommand({ kind: "swap", appRoot: "/h/x", file: "/d/x.tar.gz", staged: "/h/x.update/y", previous: "/h/x.update-previous", sandbox: true, checksum: sha256("archive") }, { platform: "linux", pid: 7, userData: "/u" });
	assert.deepEqual([...archive.args.slice(3)], ["7", "/h/x", "/h/x.update/y", "/h/x.update-previous", "/d/x.tar.gz", "1", sha256("archive"), "/h/x/codewomplers-grok-desktop"]);
	assert.match(archive.args[1], /replacement=\$\(\/usr\/bin\/pkexec \/bin\/sh -c/);

	assert.equal(updateSteps("linux"), RELEASE_PAGE);
	assert.equal(updateSteps("darwin"), INSTALL_COMMAND);
	assert.equal(updateSteps("win32"), installCommand("win32"));
	assert.equal(updateInstructions("linux"), `To update, get the new package from ${RELEASE_PAGE}.`);
	assert.ok(updateInstructions("darwin").includes(`run this in Terminal:\n${INSTALL_COMMAND}`));
	assert.ok(updateInstructions("win32").includes(`run this in PowerShell:\n${installCommand("win32")}`));
	assert.match(updateInstructions("win32"), /This command installs in the standard folder\. If you keep a zip copy elsewhere, download and extract the Windows zip/);

	const userData = path.join(scratch, "leftovers");
	const appRoot = path.join(scratch, "leftover-copy");
	const leftovers = () => [path.join(userData, "update-download"), `${appRoot}.update`, `${appRoot}.update-previous`];
	for (const folder of leftovers()) { fs.mkdirSync(folder, { recursive: true }); }
	removeUpdateFiles({ platform: "win32", appRoot, userData });
	assert.deepEqual(leftovers().map((folder) => fs.existsSync(folder)), [false, true, true], "only Linux keeps files beside the app");
	removeUpdateFiles({ platform: "linux", appRoot, userData });
	assert.deepEqual(leftovers().map((folder) => fs.existsSync(folder)), [false, false, false]);
}

// Runs the real helper under /bin/sh with fake privileged commands.
function checkSwapHelper(scratch) {
	if (process.platform === "win32") { return; }
	const area = path.join(scratch, "helper");
	const bin = path.join(area, "bin");
	const seen = path.join(area, "pkexec.txt");
	const reopened = path.join(area, "reopened.txt");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "pkexec"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\n[ "$FAKE_PKEXEC" = 0 ] || exit "$FAKE_PKEXEC"\nexport PKEXEC_UID=$(id -u)\ncd / || exit 1\nexec "$@"\n`, { mode: 0o755 });
	const copyNamed = (folder, name) => {
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "codewomplers-grok-desktop"), `#!/bin/sh\nprintf '%s\\n' "${name} $*" > "${reopened}"\n`, { mode: 0o755 });
	};
	const appRoot = path.join(area, "copy");
	const staged = path.join(area, "copy.update", "new");
	const previous = path.join(area, "copy.update-previous");
	const run = (update, pkexecCode = 0) => {
		const { program, args } = installedUpdateCommand({ appRoot, previous, ...update }, { platform: "linux", pid: spawnSync("true").pid, userData: area, argv: ["--flag"] });
		// Route both privileged commands to test doubles before running the real shell code.
		args[1] = args[1].replaceAll("/usr/bin/pkexec", "pkexec").replaceAll("/usr/bin/apt-get", "apt-get").replace("= 0:4755", `= ${process.getuid()}:4755`);
		const result = spawnSync(program, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PKEXEC: String(pkexecCode) } });
		assert.equal(result.status, 0, String(result.stderr));
		return fs.readFileSync(reopened, "utf8").trim();
	};
	const reset = () => {
		for (const item of [appRoot, staged, previous, seen, reopened]) { fs.rmSync(item, { recursive: true, force: true }); }
		copyNamed(appRoot, "old");
		copyNamed(staged, "new");
	};
	const version = (folder) => fs.readFileSync(path.join(folder, "codewomplers-grok-desktop"), "utf8").includes("new ") ? "new" : "old";
	reset();
	assert.equal(run({ kind: "swap", staged, sandbox: false }), "new --flag", "a swap opens the new copy");
	assert.equal(version(appRoot), "new");
	assert.equal(version(previous), "old");
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.existsSync(seen), false, "no password is asked for without chrome-sandbox set up");

	reset();
	fs.rmSync(staged, { recursive: true, force: true });
	assert.equal(run({ kind: "swap", staged, sandbox: false }), "old --flag", "a failed swap puts the old copy back and opens it");
	assert.equal(version(appRoot), "old");
	assert.equal(fs.existsSync(previous), false);

	if (process.platform !== "linux") { return; }
	const archiveFolder = path.join(area, LINUX_FOLDER);
	const archive = path.join(area, "download archive.tar.gz");
	const victim = path.join(area, "untrusted helper");
	fs.mkdirSync(archiveFolder);
	fs.writeFileSync(path.join(archiveFolder, "chrome-sandbox"), "verified helper");
	fs.writeFileSync(victim, "untrusted helper", { mode: 0o644 });
	const tar = spawnSync("tar", ["-czf", archive, "-C", area, LINUX_FOLDER]);
	assert.equal(tar.status, 0, String(tar.stderr));
	const swap = { kind: "swap", staged, sandbox: true, file: archive, checksum: sha256(fs.readFileSync(archive)) };
	reset();
	fs.symlinkSync(victim, path.join(staged, "chrome-sandbox"));
	assert.equal(run(swap), "new --flag");
	const helper = path.join(appRoot, "chrome-sandbox");
	assert.equal(fs.readFileSync(helper, "utf8"), "verified helper");
	assert.equal(fs.lstatSync(helper).mode & 0o7777, 0o4755);
	assert.equal(fs.statSync(victim).mode & 0o4000, 0, "the staged symlink's target never becomes setuid");

	reset();
	assert.equal(run(swap, 126), "old --flag", "a cancelled password changes nothing and opens the old copy");
	assert.equal(version(appRoot), "old");
	assert.equal(version(staged), "new");
	assert.equal(fs.existsSync(previous), false);

	reset();
	fs.writeFileSync(archive, "substituted archive");
	assert.equal(run(swap), "old --flag", "the archive is checked again before making the helper setuid");
	assert.equal(fs.existsSync(path.join(staged, "chrome-sandbox")), false);

	reset();
	const installed = path.join(area, "apt.txt");
	fs.writeFileSync(path.join(bin, "apt-get"), `#!/bin/sh\nprintf '%s\\n' "$3" > "${installed}"\ncat "$3" >> "${installed}"\n`, { mode: 0o755 });
	const download = path.join(area, "download package.deb");
	const deb = { kind: "deb", file: download, checksum: sha256("release package") };
	fs.writeFileSync(download, "release package");
	assert.equal(run(deb), "old --flag", "a package install reopens the app");
	const [copied, contents] = fs.readFileSync(installed, "utf8").split("\n");
	assert.match(copied, /^\/tmp\/grok-update\.[a-zA-Z0-9]+\/update\.deb$/);
	assert.equal(contents, "release package");
	assert.equal(fs.existsSync(copied), false, "the private copy is removed");
	assert.equal(fs.existsSync(previous), false, "a package install moves no folder");
	fs.unlinkSync(installed);
	fs.writeFileSync(download, "swapped package");
	assert.equal(run(deb), "old --flag", "a rejected package still reopens the app");
	assert.equal(fs.existsSync(installed), false, "a swapped package never reaches apt-get");
}

async function checkInstalledCopies(noGit) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-updates-"));
	const userData = path.join(scratch, "user-data");
	const prepare = (platform, installed, server, current = "0.9.0") => updatePrepare(appDir, current, "v0.10.0", { runGit: noGit, packaged: true, platform, installed: { userData, fetchUrl: server.fetchUrl, ...installed } });
	const refused = async (platform, installed, reason, current) => {
		const idle = releaseServer("nothing");
		const answer = await prepare(platform, installed, idle, current);
		assert.deepEqual([answer.ready, answer.reason, answer.steps], [false, reason, updateSteps(platform)]);
		assert.deepEqual(idle.calls, [], `"${reason}" asks GitHub nothing`);
	};
	try {
		await checkWindowsCopy(prepare, refused, userData);
		await checkMacCopy(prepare, refused, userData, scratch);
		await checkLinuxCopies(prepare, refused, userData, scratch);
		checkInstalledCommands(scratch);
		checkSwapHelper(scratch);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
	const setupScript = fs.readFileSync(path.join(appDir, "scripts", "windows-setup.iss"), "utf8");
	assert.match(setupScript, /\[InstallDelete\]\r?\nType: filesandordirs; Name: "\{app\}\\resources"; Check: IsStandardInstallDir/);
	assert.match(setupScript, /\[UninstallDelete\]\r?\nType: filesandordirs; Name: "\{app\}"; Check: IsStandardInstallDir/);
	assert.match(setupScript, /^UninstallLogMode=overwrite\r?$/m, "upgrading replaces any prior recursive uninstall entry");
	assert.ok(setupScript.includes("Flags: nowait; Check: ShouldRelaunch"), "a silent update reopens the app");
	assert.ok(setupScript.includes("{param:WAITPID|0}"), "Setup waits for the closing app");
}

async function main() {
	assert.equal(JSON.stringify(parseVersion("0.2.0")), "[0,2,0]");
	assert.equal(JSON.stringify(parseVersion("v0.2.0")), "[0,2,0]");
	for (const value of ["v1.2", "1.2.3-beta", "v01.2.3", "a", null]) { assert.equal(parseVersion(value), null); }
	assert.equal(newer("0.10.0", "0.9.0"), true);
	assert.equal(newer([1, 0, 0], [0, 99, 99]), true);
	assert.equal(newer("0.9.0", "0.9.0"), false);
	assert.equal(newer("0.9.0", "0.10.0"), false);
	assert.equal((await checkRelease({})).tag, publishedTag, "a newer bare tag from origin is not offered");
	assert.equal((await checkRelease({}, "0.9.0", github(404, {}))).reason, "no-releases", "bare tags do not count when there are no published releases");
	assert.equal((await checkRelease({ "rev-parse --show-toplevel": { code: 1 } })).reason, "not-checkout");
	assert.equal((await checkRelease({ "rev-parse --show-toplevel": path.dirname(appDir) })).reason, "not-checkout");
	assert.equal((await checkRelease({ [matchRelease]: { code: 2 } })).reason, "no-releases");
	assert.equal((await checkRelease({}, "0.10.0")).reason, "up-to-date");
	assert.equal((await checkRelease({ [matchRelease]: { code: 1 } })).ok, false);
	const cached = { ...runner(), fetchUrl: fetchLatest };
	await checkForUpdate(appDir, "0.9.0", cached);
	assert.equal(cached.calls.length, 0);
	now += 60 * 60 * 1000 + 1;
	await checkForUpdate(appDir, "0.9.0", cached);
	assert.equal(cached.calls.length, 2);
	await checkForUpdate(appDir, "0.9.0", { ...cached, force: true });
	assert.equal(cached.calls.length, 4);
	// A copy installed with scripts/install-mac.sh has no checkout: it asks GitHub's release API and never runs git.
	const noGit = () => { throw new Error("git ran"); };
	const installed = (fetchUrl, current = "0.9.0") => checkForUpdate(appDir, current, { force: true, packaged: true, runGit: noGit, fetchUrl });
	const found = await installed(github(200, { tag_name: "v0.10.0" }));
	assert.deepEqual([found.ok, found.available, found.tag, found.latest], [true, true, "v0.10.0", "0.10.0"]);
	assert.equal((await installed(github(200, { tag_name: "v0.10.0" }), "0.10.0")).reason, "up-to-date");
	assert.equal((await installed(github(404, {}))).reason, "no-releases");
	assert.equal((await installed(github(200, { tag_name: "v0.10.0-rc.1" }))).reason, "no-releases");
	assert.equal((await installed(github(500, {}))).ok, false);
	assert.ok(INSTALL_COMMAND.endsWith("/scripts/install-mac.sh | bash"), INSTALL_COMMAND);
	assert.ok(installCommand("win32").endsWith("/scripts/install-windows.ps1 | iex"), installCommand("win32"));
	await checkInstalledCopies(noGit);
	const installScript = fs.readFileSync(path.join(appDir, "scripts", "install-windows.ps1"), "utf8");
	const packageScript = fs.readFileSync(path.join(appDir, "scripts", "package-windows.ps1"), "utf8");
	assert.ok(installScript.includes("Codewomplers-Grok-Desktop-win-x64.zip"));
	assert.ok(packageScript.includes("Codewomplers-Grok-Desktop-win-x64.zip"));
	assert.ok(packageScript.includes("--no-asar"));
	assert.ok(installScript.includes("$env:LOCALAPPDATA"));
	assert.ok(installScript.includes("Microsoft\\Windows\\Start Menu\\Programs\\Codewomplers Grok Desktop.lnk"));
	assert.equal(installScript.trim().split(/\r?\n/).at(-1), "Install-GrokDesktop -Tag $tagValue");
	const preferenceAt = installScript.indexOf("$ErrorActionPreference = \"Stop\"");
	assert.ok(preferenceAt > installScript.indexOf("function Install-GrokDesktop"), "ErrorActionPreference stays inside the function");
	assert.equal(installScript.split("$ErrorActionPreference = \"Stop\"").length, 2);
	assert.equal((await checkPrepare({}, undefined, "v0.10.0;evil")).calls.length, 0);
	for (const fetchUrl of [github(404, {}, "tags/v9.0.0"), github(200, { tag_name: "v9.0.0", draft: true }, "tags/v9.0.0")]) {
		const { result, calls } = await checkPrepare({}, undefined, "v9.0.0", fetchUrl);
		assert.match(result.reason, /isn't published/);
		assert.equal(calls.some((call) => call.startsWith("fetch")), false, "an unpublished version is refused before fetching its tag");
	}
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
	for (const platform of ["darwin", "linux"]) {
		const manual = await updatePrepare(appDir, "0.9.0", "v0.10.0", { runGit: () => { throw new Error("git ran"); }, platform });
		assert.equal(manual.ready, false, `${platform} never runs the Windows-only update helper`);
		assert.ok(manual.reason.includes("git pull, npm install and npm run desktop"), manual.reason);
	}
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
