// The sandbox module's rules: which choices are valid, how paths map, and what reaches a command line.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const sandbox = require("../electron/sandbox.cjs");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sandbox-test-"));
sandbox.setDataDir(path.join(scratch, "data"));

// The Windows build ignores --sandbox, so a profile must never be accepted on Windows. Windows options exist only there.
assert.ok(sandbox.choiceProblem({ option: "profile" }, "win32").includes("Windows build"));
assert.strictEqual(sandbox.choiceProblem({ option: "profile", profile: "strict" }, "linux"), "");
assert.strictEqual(sandbox.choiceProblem({ option: "profile" }, "darwin"), "");
assert.ok(sandbox.choiceProblem({ option: "docker" }, "linux"));
assert.ok(sandbox.choiceProblem({ option: "wsl", distro: "Ubuntu" }, "darwin"));
assert.ok(sandbox.choiceProblem({ option: "git-bash" }, "win32"));
assert.ok(sandbox.choiceProblem(null, "win32"));
assert.ok(sandbox.choiceProblem(["docker"], "win32"));
assert.ok(sandbox.choiceProblem({ option: "profile", profile: "bogus" }, "linux"));
assert.strictEqual(sandbox.choiceProblem({ option: "docker" }, "win32"), "");
assert.strictEqual(sandbox.choiceProblem({ option: "docker", image: "ghcr.io/me/grok:1.0@sha256:abc" }, "win32"), "");
assert.ok(sandbox.choiceProblem({ option: "docker", image: "--privileged" }, "win32"));
assert.ok(sandbox.choiceProblem({ option: "docker", image: "a b" }, "win32"));
assert.strictEqual(sandbox.choiceProblem({ option: "wsl", distro: "Ubuntu-24.04" }, "win32"), "");
assert.ok(sandbox.choiceProblem({ option: "wsl" }, "win32"));
assert.ok(sandbox.choiceProblem({ option: "wsl", distro: "-d x" }, "win32"));
assert.strictEqual(sandbox.choiceProblem({ option: "windows-sandbox", mappedFolders: ["C:\\tools"] }, "win32"), "");
assert.ok(sandbox.choiceProblem({ option: "windows-sandbox", mappedFolders: ["tools"] }, "win32"));
assert.ok(sandbox.choiceProblem({ option: "windows-sandbox", mappedFolders: "C:\\tools" }, "win32"));

// Two different choices never look the same to the running Grok, and no sandbox differs from any of them.
assert.notStrictEqual(sandbox.choiceKey({ option: "wsl", distro: "A" }), sandbox.choiceKey({ option: "wsl", distro: "B" }));
assert.notStrictEqual(sandbox.choiceKey({ option: "profile", profile: "strict" }), sandbox.choiceKey({ option: "profile", profile: "workspace" }));
assert.strictEqual(sandbox.choiceKey(undefined), "");

// A folder's name inside a sandbox is stable, and two folders with one name don't collide.
assert.strictEqual(sandbox.slugOf("C:\\a\\My Project"), sandbox.slugOf("C:\\a\\My Project"));
assert.notStrictEqual(sandbox.slugOf("C:\\a\\app"), sandbox.slugOf("C:\\b\\app"));
assert.match(sandbox.slugOf("C:\\a\\My Project!"), /^My-Project-[0-9a-f]{6}$/);

// WSL paths.
assert.strictEqual(sandbox.wslToGuest("Ubuntu", "C:\\Users\\me\\My App"), "/mnt/c/Users/me/My App");
assert.strictEqual(sandbox.wslToGuest("Ubuntu", "D:\\"), "/mnt/d");
assert.strictEqual(sandbox.wslToGuest("Ubuntu", "\\\\wsl.localhost\\Ubuntu\\home\\me\\app"), "/home/me/app");
assert.strictEqual(sandbox.wslToGuest("ubuntu", "\\\\wsl$\\Ubuntu\\home\\me"), "/home/me");
assert.strictEqual(sandbox.wslToGuest("Ubuntu", "\\\\wsl.localhost\\Debian\\home\\me"), "", "another distribution's folder can't be reached");
assert.strictEqual(sandbox.wslToGuest("Ubuntu", "\\\\server\\share\\app"), "");
assert.strictEqual(sandbox.wslToHost("Ubuntu", "/mnt/c/Users/me/a.txt"), "C:\\Users\\me\\a.txt");
assert.strictEqual(sandbox.wslToHost("Ubuntu", "/mnt/d"), "D:\\");
assert.strictEqual(sandbox.wslToHost("Ubuntu", "/home/me/a.txt"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt");
assert.strictEqual(sandbox.wslToHost("Ubuntu", "src/a.txt"), "src/a.txt", "a relative path stays relative");

// Docker and Windows Sandbox hold only some folders.
const linux = sandbox.rootMapper([{ host: "C:\\work\\app", guest: "/workspace/app" }], false);
assert.strictEqual(linux.toGuest("C:\\work\\app\\src\\a.txt"), "/workspace/app/src/a.txt");
assert.strictEqual(linux.toGuest("c:\\WORK\\app"), "/workspace/app");
assert.strictEqual(linux.toGuest("C:\\work\\app2\\a.txt"), "", "a sibling with the same prefix isn't inside");
assert.strictEqual(linux.toHost("/workspace/app/src/a.txt"), "C:\\work\\app\\src\\a.txt");
assert.strictEqual(linux.toHost("/workspace/app"), "C:\\work\\app");
assert.strictEqual(linux.toHost("/etc/passwd"), "", "a file only the sandbox has isn't on this computer");
assert.strictEqual(linux.toHost("src/a.txt"), "src/a.txt");
const windows = sandbox.rootMapper([{ host: "C:\\work\\app", guest: "C:\\work\\app-1a2b3c" }], true);
assert.strictEqual(windows.toHost("c:\\work\\APP-1a2b3c\\b.txt"), "C:\\work\\app\\b.txt");
assert.strictEqual(windows.toGuest("C:\\work\\app\\b.txt"), "C:\\work\\app-1a2b3c\\b.txt");
assert.strictEqual(windows.toHost("C:\\Windows\\win.ini"), "");

// Only the app's own profiles change. A person's profile, before or after them, stays.
const first = sandbox.withProfiles("", ["/run/WSL"]);
assert.match(first, /\[profiles\.grok-desktop\]\nextends = "workspace"\ndeny = \["\/run\/WSL"\]\n/);
assert.match(first, /\[profiles\.grok-desktop-strict\]\nextends = "strict"\ndeny = \["\/run\/WSL"\]\n/);
const own = "[profiles.mine]\nextends = \"read-only\"\n";
const mixed = sandbox.withProfiles(`${own}\n${first}\n[profiles.after]\nextends = "strict"\n`, []);
assert.ok(mixed.includes(own));
assert.ok(mixed.includes("[profiles.after]\nextends = \"strict\""));
assert.strictEqual((mixed.match(/\[profiles\.grok-desktop\]/g) || []).length, 1);
assert.strictEqual((mixed.match(/\[profiles\.grok-desktop-strict\]/g) || []).length, 1);
assert.ok(!mixed.includes("/run/WSL"), "the old deny list is gone");
assert.strictEqual(sandbox.withProfiles(first, ["/run/WSL"]), first, "writing the same profiles changes nothing");
assert.strictEqual(sandbox.withProfiles("[profiles.grok-desktop]\r\nextends = \"workspace\"\r\n", []), sandbox.withProfiles("", []));

// A profile Grok failed to apply is a refusal. The newest event for that profile decides, and no event says nothing.
const home = path.join(scratch, "home");
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
const events = path.join(home, "sessions", "sandbox-events.jsonl");
assert.strictEqual(sandbox.enforcementProblem(home, "grok-desktop"), "");
fs.writeFileSync(events, `${JSON.stringify({ event_type: "ApplyFailed", profile: "grok-desktop" })}\n`);
assert.ok(sandbox.enforcementProblem(home, "grok-desktop"));
assert.strictEqual(sandbox.enforcementProblem(home, "grok-desktop-strict"), "", "another profile's event doesn't count");
fs.appendFileSync(events, `${JSON.stringify({ event_type: "ProfileApplied", profile: "grok-desktop", enforced: true })}\nnot json\n`);
assert.strictEqual(sandbox.enforcementProblem(home, "grok-desktop"), "");
fs.appendFileSync(events, `${JSON.stringify({ event_type: "ProfileApplied", profile: "grok-desktop", enforced: false })}\n`);
assert.ok(sandbox.enforcementProblem(home, "grok-desktop"));

// wsl -l -v, as the app reads it once its UTF-16 NULs are gone.
const distros = sandbox.parseWslList("  NAME              STATE           VERSION\n* Ubuntu            Stopped         2\n  docker-desktop    Running         2\n  Legacy            Stopped         1\n");
assert.deepStrictEqual(distros, [{ name: "Ubuntu", isDefault: true, version: 2 }, { name: "Legacy", isDefault: false, version: 1 }]);

function loadWslSandbox(folder, respond, currentHome = "/home/current-user") {
	const commands = [];
	const loaded = { exports: {} };
	const timers = new Set();
	const childProcess = {
		spawn(command, args) {
			assert.equal(command, "wsl.exe");
			commands.push(args.slice(0, 2).join(" "));
			const timer = [...timers].at(-1);
			const child = Object.assign(new EventEmitter(), { kill() {}, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end() {} }) });
			queueMicrotask(() => {
				const result = respond(args);
				if (result.timedOut) { timer(); return; }
				child.stdout.emit("data", result.out || "");
				child.emit("close", result.code ?? 0);
			});
			return child;
		},
		spawnSync(command, args) {
			assert.equal(command, "wsl.exe");
			commands.push(`sync ${args.slice(0, 2).join(" ")}`);
			return { status: 0, stdout: currentHome };
		},
	};
	vm.runInNewContext(fs.readFileSync(require.resolve("../electron/sandbox.cjs"), "utf8"), {
		module: loaded,
		require: (name) => {
			if (name === "child_process") { return childProcess; }
			if (name === "fs") { return { ...fs, readFileSync: () => "", writeFileSync() {}, mkdirSync() {}, existsSync: () => false }; }
			return require(name);
		},
		process: { platform: "win32", env: {} },
		setTimeout(callback) { timers.add(callback); return callback; },
		clearTimeout(callback) { timers.delete(callback); },
	});
	loaded.exports.setDataDir(folder);
	return { sandbox: loaded.exports, commands };
}

async function checkSavedWslRoots() {
	const folder = path.join(scratch, "wsl-restart");
	const respond = (args) => {
		if (args[0] === "-l") { return { out: "  NAME STATE VERSION\n* Ubuntu Stopped 2\n  Empty Stopped 2\n  Legacy Stopped 1\n  docker-desktop Stopped 2\n" }; }
		if (!args.at(-1).includes("chat_history.jsonl")) { return { out: "/srv/grok-user" }; }
		return { out: args[1] === "Empty" ? "empty" : "saved\n/srv/grok-user" };
	};
	const first = loadWslSandbox(folder, respond);
	const firstReads = await Promise.all([first.sandbox.sessionRoots(), first.sandbox.sessionRoots()]);
	const expected = [
		path.join(folder, "docker-home", "sessions"),
		path.join(folder, "wsb-home", "sessions"),
		"\\\\wsl.localhost\\Ubuntu\\srv\\grok-user\\.grok\\sessions",
	];
	for (const roots of firstReads) {
		assert.deepStrictEqual([...roots].slice(0, 2), expected.slice(0, 2));
		assert.ok(roots.includes(expected[2]), "the first reads include saved WSL data without opening a WSL session");
	}
	assert.deepStrictEqual(first.commands, ["-l -v", "-d Ubuntu", "-d Empty"], "concurrent first reads share discovery and only probe user WSL 2 distros");
	await first.sandbox.sessionRoots();
	assert.equal(first.commands.length, 3, "successful discovery is retained for the launch");
	const restarted = loadWslSandbox(folder, respond);
	assert.deepStrictEqual([...(await restarted.sandbox.sessionRoots())], [...firstReads[0]], "a restart restores the saved roots");
	assert.deepStrictEqual(restarted.commands, ["-l -v"], "a restart never starts a known empty distro to rediscover HOME");
	assert.deepStrictEqual([...(await restarted.sandbox.sessionRoots())], expected, "empty distributions contribute no saved-data roots");
	restarted.sandbox.targetFor({ option: "wsl", distro: "Empty" }, "C:\\work\\app", { platform: "win32" });
	const afterTarget = await restarted.sandbox.sessionRoots();
	assert.ok(afterTarget.includes("\\\\wsl.localhost\\Empty\\home\\current-user\\.grok\\sessions"), "opening a target refreshes an empty record with the current HOME");
	assert.ok(restarted.commands.includes("sync -d Empty"), "persisted records never replace runtime HOME resolution");
	const setup = loadWslSandbox(folder, (args) => args.at(-1).includes("command -v") ? { out: "grok=yes\nbwrap=yes\nauth=yes\nhome=/home/installed-user" } : respond(args));
	assert.equal((await setup.sandbox.check({ option: "wsl", distro: "Empty" })).ready, true);
	assert.ok((await setup.sandbox.sessionRoots()).includes("\\\\wsl.localhost\\Empty\\home\\installed-user\\.grok\\sessions"), "explicit setup refreshes an old saved home");
	const failedSetup = loadWslSandbox(folder, (args) => args.at(-1).includes("command -v") ? { code: 1 } : respond(args));
	const choice = { option: "wsl", distro: "Empty" };
	failedSetup.sandbox.targetFor(choice, "C:\\work\\app", { platform: "win32" });
	assert.equal((await failedSetup.sandbox.check(choice)).ready, false);
	failedSetup.sandbox.targetFor(choice, "C:\\work\\app", { platform: "win32" });
	assert.ok((await failedSetup.sandbox.sessionRoots()).includes("\\\\wsl.localhost\\Empty\\home\\current-user\\.grok\\sessions"), "a target after a failed setup restores its saved root before Grok writes history");
}

async function checkWslDiscoveryRetry() {
	for (const failure of [{ code: 1 }, { timedOut: true }]) {
		let listings = 0;
		let probes = 0;
		const folder = path.join(scratch, failure.timedOut ? "wsl-timeout" : "wsl-list-failure");
		const loaded = loadWslSandbox(folder, (args) => {
			if (args[0] === "-l") {
				listings += 1;
				return listings === 1 ? failure : { out: "  NAME STATE VERSION\n* Ubuntu Stopped 2\n" };
			}
			probes += 1;
			if (probes === 1) { return { code: 1 }; }
			return { out: args.at(-1).includes("chat_history.jsonl") ? "saved\n/srv/recovered" : "/srv/recovered" };
		});
		const missing = await Promise.all([loaded.sandbox.sessionRoots(), loaded.sandbox.sessionRoots()]);
		assert.equal(listings, 1, "concurrent failures coalesce");
		assert.equal(missing[0].length, 2, "a failed listing preserves local sandbox roots");
		assert.equal((await loaded.sandbox.sessionRoots()).length, 2, "a failed home probe remains unclassified");
		assert.ok((await loaded.sandbox.sessionRoots()).includes("\\\\wsl.localhost\\Ubuntu\\srv\\recovered\\.grok\\sessions"), "a later read retries failed listing and home discovery in the same launch");
		assert.deepStrictEqual([listings, probes], [3, 2]);
	}
}

// /run/WSL is what blocks Windows programs, so it stays whatever else is dropped. A rule never covers the session's folder.
const denied = sandbox.wslDeny("Ubuntu", "C:\\Users\\me\\AppData\\project", "/home/me", {
	windowsHome: "C:\\Users\\me",
	exists: () => true,
});
const credentialNames = [".ssh", ".aws", ".azure", ".docker", ".kube", ".gnupg", ".git-credentials", ".netrc", "_netrc", ".npmrc", ".config/gh", ".config/gcloud"];
assert.deepStrictEqual(denied, [
	"/run/WSL",
	...credentialNames.map((name) => `/home/me/${name}`),
	...[...credentialNames, ".grok"].map((name) => `/mnt/c/Users/me/${name}`),
]);

// Mac and Linux: the Grok home gets the profile, and only `--sandbox` changes on the command line.
const grokHome = path.join(scratch, "grok-home");
const profile = sandbox.targetFor({ option: "profile", profile: "strict" }, "/work/app", { platform: "linux", grokExe: "grok", grokHome });
assert.strictEqual(profile.profile, "grok-desktop-strict");
assert.ok(fs.readFileSync(path.join(grokHome, "sandbox.toml"), "utf8").includes("[profiles.grok-desktop-strict]\nextends = \"strict\""));
const profileRun = profile.launch(["agent", "stdio"], { PATH: "x" });
assert.strictEqual(profileRun.command, "grok");
assert.deepStrictEqual(profileRun.args, ["--sandbox", "grok-desktop-strict", "agent", "stdio"]);
assert.strictEqual(profile.toHost("/work/app/a.txt"), "/work/app/a.txt");
assert.throws(() => sandbox.targetFor({ option: "profile" }, "C:\\app", { platform: "win32", grokExe: "grok", grokHome }), /Windows build/);

// Docker: the key is named, never valued, and nothing of this computer goes in beyond the project and the sandbox's Grok home.
const key = "xai-do-not-print";
const docker = sandbox.targetFor({ option: "docker" }, "C:\\work\\My App", { platform: "win32", grokExe: "grok", grokHome });
const dockerRun = docker.launch(["agent", "stdio"], { XAI_API_KEY: key, SECRET_OF_THIS_PC: "secret", GROK_PROMPT_SUGGESTIONS: "1" });
assert.strictEqual(dockerRun.command, "docker");
assert.ok(!dockerRun.args.join(" ").includes(key));
assert.ok(!dockerRun.args.join(" ").includes("SECRET_OF_THIS_PC"));
assert.ok(dockerRun.args.includes("XAI_API_KEY"));
assert.strictEqual(dockerRun.env.XAI_API_KEY, key);
assert.ok(dockerRun.args.includes("--cap-drop") && dockerRun.args.includes("no-new-privileges") && dockerRun.args.includes("--rm"));
assert.deepStrictEqual(dockerRun.args.slice(dockerRun.args.indexOf("--pull"), dockerRun.args.indexOf("--pull") + 2), ["--pull", "never"]);
assert.deepStrictEqual(dockerRun.args.slice(-4), ["grok-desktop-sandbox", "grok", "agent", "stdio"]);
assert.ok(dockerRun.args.includes(`C:/work/My App:${docker.guestCwd}`));
assert.ok(docker.guestCwd.startsWith("/workspace/My-App-"));
assert.strictEqual(docker.toGuest("C:\\work\\My App\\a.txt"), `${docker.guestCwd}/a.txt`);
assert.strictEqual(docker.toHost(`${docker.guestCwd}/a.txt`), "C:\\work\\My App\\a.txt");
assert.strictEqual(docker.toGuest("C:\\other\\a.txt"), "");
assert.ok(!docker.launch([], {}).args.includes(key));
const dockerOwn = sandbox.targetFor({ option: "docker", image: "me/grok" }, "C:\\work\\app", { platform: "win32", grokExe: "grok", grokHome }).launch(["agent"], {});
assert.ok(!dockerOwn.args.includes("--pull"), "a person's own image may come from a registry");
assert.ok(dockerOwn.args.includes("me/grok"));

// Windows Sandbox starts Grok from a script inside the VM, which only a live check can run. Its paths can be checked here.
const wsbTarget = sandbox.targetFor({ option: "windows-sandbox" }, "C:\\work\\app", { platform: "win32", grokExe: "C:\\grok\\grok.exe", grokHome });
assert.ok(wsbTarget.guestCwd.startsWith("C:\\work\\app-"));
assert.strictEqual(wsbTarget.toHost(`${wsbTarget.guestCwd}\\a.txt`), "C:\\work\\app\\a.txt");

// Windows runs one Windows Sandbox, so one session holds it at a time. Docker and WSL run side by side.
const windowsSandbox = { option: "windows-sandbox" };
assert.strictEqual(sandbox.windowsSandboxHolder(), "");
assert.strictEqual(sandbox.inUseProblem(windowsSandbox, "two"), "");
sandbox.wsbClients.add({ spec: {} });
assert.strictEqual(sandbox.windowsSandboxHolder(), "", "a test or a sign-in holds nothing");
sandbox.wsbClients.add({ spec: { owner: "one" } });
assert.strictEqual(sandbox.windowsSandboxHolder(), "one");
assert.strictEqual(sandbox.inUseProblem(windowsSandbox, "one"), "", "a session's own next Grok and side chat use it too");
assert.ok(sandbox.inUseProblem(windowsSandbox, "two").includes("Windows runs only one at a time"));
assert.strictEqual(sandbox.inUseProblem({ option: "docker" }, "two"), "");
assert.strictEqual(sandbox.inUseProblem({ option: "wsl", distro: "Ubuntu" }, "two"), "");
assert.strictEqual(sandbox.inUseProblem(undefined, "two"), "");
sandbox.wsbClients.clear();
assert.strictEqual(sandbox.inUseProblem(windowsSandbox, "two"), "", "it's free once that session's Grok stops");
const dockerName = () => {
	const { args } = sandbox.targetFor({ option: "docker" }, "C:\\work\\app", { platform: "win32", grokExe: "grok", grokHome }).launch(["agent"], {});
	return args[args.indexOf("--name") + 1];
};
assert.notStrictEqual(dockerName(), dockerName(), "each Docker session gets its own container");

async function checkWindowsSetupIsolation() {
	const options = { platform: "win32", grokExe: "C:\\test\\not-grok.exe", grokHome, env: {}, model: "test-model", onText() {} };
	const session = { spec: { owner: "one" } };
	sandbox.wsbClients.add(session);
	try {
		assert.match((await sandbox.runTest(windowsSandbox, options)).error, /Another session is using Windows Sandbox/);
		assert.match((await sandbox.signIn(windowsSandbox, options)).error, /Another session is using Windows Sandbox/);
	} finally {
		sandbox.wsbClients.delete(session);
	}
	const signingIn = sandbox.signIn(windowsSandbox, options);
	assert.equal(sandbox.windowsSandboxHolder(), "", "setup is not reported as a session");
	assert.match(sandbox.inUseProblem(windowsSandbox, "one"), /running a test or sign-in/);
	assert.match((await sandbox.runTest(windowsSandbox, options)).error, /running a test or sign-in/);
	assert.match((await signingIn).error, /Install Grok on this computer first/);
	assert.equal(sandbox.inUseProblem(windowsSandbox, "one"), "", "a setup failure releases the reservation");
}

checkSavedWslRoots().then(checkWslDiscoveryRetry).then(checkWindowsSetupIsolation).then(() => console.log("sandbox tests passed"), (error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
