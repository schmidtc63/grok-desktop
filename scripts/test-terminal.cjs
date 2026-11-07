const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { folderProblem } = require("../electron/agent.cjs");
const source = fs.readFileSync(path.join(__dirname, "../electron/terminal.cjs"), "utf8");

function checkTerminalShell() {
	const source = fs.readFileSync(path.join(__dirname, "../electron/terminal.cjs"), "utf8");
	const fallback = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const preferred = path.join(os.tmpdir(), "PowerShell", "pwsh.exe");
	for (const [found, expected] of [
		[{ status: 0, stdout: `pwsh.exe\r\n${preferred}\r\n` }, preferred],
		[{ status: 1, stdout: preferred }, fallback],
		[{ status: 0, stdout: "pwsh.exe\r\nnot-an-executable.txt\r\n" }, fallback],
	]) {
		let probes = 0;
		const sandbox = {
			module: { exports: {} },
			process: { ...process, platform: "win32" },
			require: (name) => {
				if (name === "node-pty") { throw new Error("Unavailable in this test"); }
				if (name === "./agent.cjs") { return { folderProblem: () => "" }; }
				if (name === "child_process") {
					return { spawnSync: (command, args, options) => {
						probes++;
						assert.equal(command, "where.exe");
						assert.deepEqual(Array.from(args), ["pwsh.exe"]);
						assert.equal(options.windowsHide, true);
						assert.equal(options.timeout, 5000);
						return found;
					} };
				}
				return require(name);
			},
		};
		vm.runInNewContext(source, sandbox, { filename: "terminal.cjs" });
		assert.equal(sandbox.module.exports.terminalShell(), expected);
		assert.equal(sandbox.module.exports.terminalShell(), expected);
		assert.equal(probes, 1, "the shell lookup is cached, including its fallback");
	}
	console.log("PASS terminal prefers an absolute pwsh path, falls back on failed/invalid lookup, and caches the result");
}

function checkOutputBatching() {
	const timers = new Map();
	const batched = [];
	const sandbox = {
		module: { exports: {} },
		require: (name) => { if (name === "node-pty") { throw new Error("Unavailable in this test"); } return name === "./agent.cjs" ? { folderProblem: () => "" } : require(name); },
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/terminal.cjs"), "utf8"), sandbox, { filename: "terminal.cjs" });
	const batching = new sandbox.module.exports.TerminalHost((event) => batched.push(event), { flushMs: 30 });
	const makeTab = (id) => { const tab = { id, history: "", done: false }; batching.tabs.set(id, tab); return tab; };
	const last = makeTab("last");
	batching.output(last, "one");
	batching.output(last, "two");
	assert.deepEqual(batched, []);
	assert.equal(last.history, "onetwo", "history is immediately available while events wait");
	batching.finish(last, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(batched)), [{ type: "terminal-data", id: "last", data: "onetwo" }, { type: "terminal-exit", id: "last", code: 0 }]);
	assert.equal(timers.size, 0, "exit flushes and clears the pending timer");
	const ongoing = makeTab("ongoing");
	const flush = () => {
		assert.equal(timers.size, 1);
		const timer = [...timers.values()][0];
		assert.equal(timer.ms, 30);
		timer.callback();
	};
	batching.output(ongoing, "first");
	flush();
	assert.equal(ongoing.flushTimer, null);
	batching.output(ongoing, "second");
	flush();
	assert.deepEqual(batched.slice(-2).map((event) => event.data), ["first", "second"], "later output schedules a fresh timer");
	assert.equal(timers.size, 0);
	console.log("PASS terminal output batches, flushes before exit, and schedules later output");
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadTerminal({ platform = "win32", ptyAvailable = true, spawnFails = false, flushMs = 0 } = {}) {
	const events = [];
	const ptys = [];
	const children = [];
	const spawns = [];
	const syncSpawns = [];
	const kills = [];
	const timers = new Map();
	const preferred = path.join(os.tmpdir(), "PowerShell", "pwsh.exe");
	const fakePty = {
		spawn(shell, args, options) {
			if (spawnFails) { throw new Error("PTY failed"); }
			let data;
			let exited;
			const child = Object.assign(new EventEmitter(), {
				pid: 700 + ptys.length, shell, args: Array.from(args), options: plain(options), writes: [], sizes: [], killCalls: 0, disposed: 0,
				onData(callback) { data = callback; return { dispose() { child.disposed++; } }; },
				onExit(callback) { exited = callback; return { dispose() { child.disposed++; } }; },
				write(text) { if (child.writeFails) { throw new Error("closed"); } child.writes.push(text); },
				resize(cols, rows) { if (child.resizeFails) { throw new Error("closed"); } child.sizes.push([cols, rows]); },
				kill() { child.killCalls++; if (child.exitOnKill) { exited({ exitCode: 0 }); } },
				data(text) { data(text); },
				exit(code) { exited({ exitCode: code }); },
			});
			ptys.push(child);
			return child;
		},
	};
	const loaded = { exports: {} };
	vm.runInNewContext(source, {
		module: loaded,
		process: { platform, env: { SystemRoot: process.env.SystemRoot || "C:/Windows" }, kill: (...args) => kills.push(args) },
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
		require(name) {
			if (name === "node-pty") { if (!ptyAvailable) { throw new Error("native module unavailable"); } return fakePty; }
			if (name === "./agent.cjs") { return { folderProblem, OWN_GROUP: platform === "win32" ? {} : { detached: true }, killTree: (...args) => { kills.push(args); return true; } }; }
			if (name === "child_process") {
				return {
					spawnSync(command, args, options) { syncSpawns.push({ command, args: Array.from(args), options }); return command === "where.exe" ? { status: 0, stdout: preferred } : { status: 0 }; },
					spawn(command, args, options) {
						const child = Object.assign(new EventEmitter(), { pid: 800 + children.length, exitCode: null, writes: [] });
						child.stdout = new EventEmitter();
						child.stderr = new EventEmitter();
						child.stdin = Object.assign(new EventEmitter(), { write: (text) => child.writes.push(text) });
						children.push(child);
						spawns.push({ command, args: Array.from(args), options, child });
						return child;
					},
				};
			}
			return require(name);
		},
	}, { filename: "terminal.cjs" });
	return { host: new loaded.exports.TerminalHost((event) => events.push(event), { flushMs }), events, ptys, children, spawns, syncSpawns, kills, timers, preferred };
}

function checkPty() {
	for (const platform of ["win32", "linux", "darwin"]) {
		const run = loadTerminal({ platform, flushMs: 30 });
		const cwd = os.tmpdir();
		const opened = run.host.open({ cwd, shell: "untrusted", env: { INJECTED: "bad" } });
		assert.equal(opened.ok, true);
		assert.equal(opened.backend, "pty");
		assert.equal(run.spawns.length, 0, "PTY tabs do not start pipe shells");
		const child = run.ptys[0];
		assert.equal(child.shell, platform === "win32" ? run.preferred : "bash");
		assert.equal(child.options.cwd, cwd);
		assert.equal(child.options.name, "xterm-256color");
		assert.equal(child.options.cols, 80);
		assert.equal(child.options.rows, 24);
		assert.equal(child.options.env.TERM, "xterm-256color");
		assert.equal(child.options.env.INJECTED, undefined, "the renderer does not choose a shell or environment");
		if (platform === "win32") {
			assert.equal(child.args[child.args.indexOf("-ExecutionPolicy") + 1], "RemoteSigned");
		} else {
			assert.deepEqual(child.args, ["--noprofile", "--norc", "-i"], "a real terminal retains interactive line editing and job control");
		}
		assert.equal(run.host.input(opened.id, "vi file\r\x1b[A\x03\x00").ok, true);
		assert.deepEqual(child.writes, ["vi file\r\x1b[A\x03\x00"], "raw control bytes, including Ctrl+Space, are not changed or submitted twice");
		assert.equal(run.host.write(opened.id, "one\r\ntwo\n").ok, true);
		assert.equal(child.writes.at(-1), "one\rtwo\r", "Run-button commands finish with Enter");
		assert.equal(run.host.write(opened.id, "x".repeat(20000)).ok, true);
		assert.equal(child.writes.at(-1).length, 20001, "the command limit excludes its added Enter");
		assert.equal(run.host.resize(opened.id, 120, 40).ok, true);
		assert.deepEqual(child.sizes, [[120, 40]]);
		child.data("\x1b[31mone");
		child.data("two\x1b[0m");
		assert.deepEqual(run.events, []);
		assert.equal(run.host.history(opened.id), "\x1b[31monetwo\x1b[0m", "ANSI sequences stay in the history");
		const timer = [...run.timers.values()][0];
		assert.equal(timer.ms, 30);
		timer.callback();
		assert.equal(run.events.length, 1, "PTY output is batched before IPC");
		assert.equal(run.events[0].data, "\x1b[31monetwo\x1b[0m");
		child.data("last");
		child.exitOnKill = true;
		child.exit(3);
		assert.equal(child.killCalls, 1, "natural exit still releases native PTY helpers explicitly");
		assert.equal(child.disposed, 2);
		assert.deepEqual(run.events.slice(-2).map((event) => event.type), ["terminal-data", "terminal-exit"]);
		assert.equal(run.events.at(-1).code, 3);
		assert.deepEqual(plain(run.host.list()), []);
		child.data("ignored after exit");
		run.host.close(opened.id);
		assert.equal(run.events.filter((event) => event.type === "terminal-exit").length, 1);
		assert.equal(child.killCalls, 1, "cleanup is idempotent");
	}
	console.log("PASS PTY spawn, raw input, command submission, resize, ANSI batching and explicit natural-exit cleanup");
}

async function checkPtyLifecycle() {
	const run = loadTerminal();
	const first = run.host.open({ cwd: os.tmpdir() });
	const child = run.ptys[0];
	assert.deepEqual(plain(await run.host.interrupt(first.id)), { ok: true, stopped: 1 });
	assert.equal(child.writes.at(-1), "\x03", "interrupt reaches the foreground program as Ctrl+C");
	assert.equal(child.killCalls, 0, "interrupt does not close the terminal");
	run.host.output(run.host.tabs.get(first.id), "x".repeat(450000));
	assert.equal(run.host.history(first.id).length, 200000, "scrollback stays bounded");
	run.host.close(first.id);
	assert.equal(child.killCalls, 1);
	assert.equal(run.host.list().length, 0);
	const tabs = [];
	for (let i = 0; i < 12; i++) { tabs.push(run.host.open({ cwd: os.tmpdir() })); }
	assert.equal(run.host.open({ cwd: os.tmpdir() }).ok, false, "the thirteenth tab is refused");
	run.host.closeAll();
	assert.equal(run.host.list().length, 0);
	assert.equal(run.ptys.every((pty) => pty.killCalls === 1), true, "closeAll explicitly kills every native tab");
	assert.equal(run.events.filter((event) => event.type === "terminal-exit").length, 13);
	assert.equal(run.spawns.length, 0, "PTY cleanup does not leave taskkill helper processes");
	assert.equal((await run.host.interrupt("missing")).ok, false);
	const failed = loadTerminal();
	failed.host.open({ cwd: os.tmpdir() });
	failed.ptys[0].emit("error", new Error("native stream error"));
	assert.equal(failed.ptys[0].killCalls, 1, "a native stream error also releases its PTY");
	assert.equal(failed.host.list().length, 0);
	console.log("PASS PTY interrupt, bounded history, Close/closeAll, tab limit and idempotent native cleanup");
}

function checkBounds() {
	const run = loadTerminal();
	for (const cwd of ["", null, undefined, __filename, path.join(os.tmpdir(), "missing-terminal-folder")]) { assert.equal(run.host.open({ cwd }).ok, false); }
	assert.equal(run.ptys.length, 0, "invalid folders never spawn");
	const opened = run.host.open({ cwd: os.tmpdir() });
	for (const value of [42, null, undefined, "x".repeat(20001)]) { assert.equal(run.host.input(opened.id, value).ok, false); }
	for (const value of [42, null, "x\0y", "x".repeat(20001)]) { assert.equal(run.host.write(opened.id, value).ok, false); }
	for (const [cols, rows] of [[1, 24], [501, 24], [80, 0], [80, 301], [80.5, 24], [80, NaN], ["80", 24], [Infinity, 24]]) {
		assert.equal(run.host.resize(opened.id, cols, rows).ok, false);
	}
	assert.equal(run.host.resize(opened.id, 2, 1).ok, true);
	assert.equal(run.host.resize(opened.id, 500, 300).ok, true);
	assert.equal(run.host.input("missing", "x").ok, false);
	assert.equal(run.host.write("missing", "x").ok, false);
	assert.equal(run.host.resize("missing", 80, 24).ok, false);
	run.ptys[0].writeFails = true;
	assert.equal(run.host.input(opened.id, "x").ok, false);
	assert.equal(run.host.write(opened.id, "x").ok, false);
	run.ptys[0].resizeFails = true;
	assert.equal(run.host.resize(opened.id, 80, 24).ok, false);
	run.host.closeAll();
	assert.equal(loadTerminal({ spawnFails: true }).host.open({ cwd: os.tmpdir() }).ok, false);
	console.log("PASS terminal folder, raw-input/command caps, dimension bounds and native operation failures");
}

async function checkPipeFallback() {
	for (const platform of ["win32", "linux", "darwin"]) {
		const run = loadTerminal({ platform, ptyAvailable: false });
		const opened = run.host.open({ cwd: os.tmpdir() });
		assert.equal(opened.backend, "pipe");
		assert.match(opened.warning, /basic pipe terminal/);
		const child = run.children[0];
		assert.equal(run.host.input(opened.id, "ab").ok, true);
		assert.deepEqual(child.writes, [], "fallback raw input is buffered until Enter");
		run.host.input(opened.id, "\x7fc\r\n");
		assert.deepEqual(child.writes, ["ac\n"], "backspace edits the pending line and CRLF submits once");
		run.host.write(opened.id, "one\ntwo");
		assert.equal(child.writes.at(-1), platform === "win32" ? "one\ntwo\n\n" : "one\ntwo\n");
		assert.equal(run.host.resize(opened.id, 80, 24).ok, true);
		const bytes = Buffer.from("héllo");
		child.stdout.emit("data", bytes.subarray(0, 2));
		child.stdout.emit("data", bytes.subarray(2));
		assert.ok(run.host.history(opened.id).includes("héllo"), "pipe fallback keeps UTF-8 decoding");
		if (platform !== "win32") {
			assert.equal(run.spawns[0].options.detached, true);
			child.stdout.emit("data", Buffer.from("bash: no job control in this shell\n"));
			assert.equal(run.host.history(opened.id).includes("no job control"), false);
			const pending = run.host.interrupt(opened.id);
			const query = run.spawns.at(-1);
			assert.equal(query.command, "pgrep");
			query.child.stdout.emit("data", Buffer.from(String(child.pid) + "\n901\n"));
			query.child.emit("close", 0);
			assert.equal((await pending).stopped, 1);
			assert.deepEqual(run.kills.at(-1), [901, "SIGKILL"]);
		} else {
			const pending = run.host.interrupt(opened.id);
			const query = run.spawns.at(-1);
			assert.ok(query.args.includes("-NonInteractive"));
			query.child.stdout.emit("data", Buffer.from("901\n"));
			query.child.emit("close", 0);
			const killer = run.spawns.at(-1);
			assert.equal(killer.command, "taskkill");
			killer.child.emit("close", 0);
			assert.equal((await pending).stopped, 1);
		}
		assert.equal(child.exitCode, null, "the fallback shell stays available after interrupt");
		run.host.write(opened.id, "echo after");
		run.host.close(opened.id);
		child.emit("close", 0);
		assert.equal(run.events.filter((event) => event.type === "terminal-exit").length, 1);
		const extra = run.host.open({ cwd: os.tmpdir() });
		run.host.closeAll();
		assert.equal(run.host.list().length, 0);
		assert.equal(run.events.some((event) => event.type === "terminal-exit" && event.id === extra.id), true);
		if (platform === "win32") { assert.equal(run.syncSpawns.at(-1).command, "taskkill"); }
		else { assert.equal(run.kills.at(-1)[1], true, "app quit keeps synchronous pipe process-tree cleanup"); }
	}
	console.log("PASS missing-native fallback warning, buffered pipe input, UTF-8, shell state/interrupt and process-tree cleanup");
}

async function main() {
	checkTerminalShell();
	checkOutputBatching();
	checkPty();
	await checkPtyLifecycle();
	checkBounds();
	await checkPipeFallback();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
