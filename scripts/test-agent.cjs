const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { redactKeys, redactDeep, heldTail } = require("../electron/redact.cjs");
const sandboxModule = require("../electron/sandbox.cjs");

// A check whose promise never settles ends the run without the success line, so that run fails.
process.exitCode = 1;
const source = fs.readFileSync(path.join(__dirname, "../electron/agent.cjs"), "utf8");
const input = { uiSessionId: "chat", cwd: path.resolve(__dirname, ".."), text: "Hello", model: "grok-4.7", effort: "high", mode: "Normal" };
const fakeKey = `xai-${"A".repeat(80)}`;
const fakeEnvKey = `xai-${"B".repeat(80)}`;

function makeHost(options, { tmpdir, platform = "win32", killErrors = {}, env = {} } = {}) {
	const timers = new Map();
	const writes = [];
	const spawns = [];
	const kills = [];
	const events = [];
	const children = [];
	// Each Grok spawn gets its own fake process; `writes` collects what every process was sent.
	function fakeChild() {
		const child = new EventEmitter();
		child.pid = 100 + children.length;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.writes = [];
		child.stdin = Object.assign(new EventEmitter(), { writable: true, write: (line) => { const message = JSON.parse(line); writes.push(message); child.writes.push(message); } });
		children.push(child);
		return child;
	}
	// A check can give agent.cjs its own temp folder, which edits may always use, or another platform.
	const sandbox = {
		module: { exports: {} },
		require: (name) => name === "child_process" ? {
			spawn: (...args) => { spawns.push(args); return args[0] === "taskkill" ? new EventEmitter() : fakeChild(); },
			spawnSync: (...args) => { kills.push(args); return { status: 0 }; },
		} : (name === "./redact.cjs" ? { redactKeys, redactDeep, heldTail } : name === "./sandbox.cjs" ? sandboxModule : name === "os" && tmpdir ? { ...os, tmpdir: () => tmpdir } : require(name)),
		// `kill` records process-group kills; killErrors maps a pid to the error code its kill throws.
		process: { platform, env, kill: (pid, signal) => { kills.push(["kill", pid, signal]); if (killErrors[Math.abs(pid)]) { throw Object.assign(new Error("kill failed"), { code: killErrors[Math.abs(pid)] }); } } },
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	};
	vm.runInNewContext(source, sandbox, { filename: "agent.cjs" });
	const host = new sandbox.module.exports.AgentHost((event) => events.push(event), { chunkMs: 0, ...options });
	// A session whose Grok process has started, with a running turn built from `turn`.
	function running(turn) {
		const proc = host.start({ ...input, uiSessionId: turn.uiSessionId, cwd: turn.cwd || input.cwd }, "ask");
		proc.ready.catch(() => {});
		host.turns.set(turn.uiSessionId, { turnId: "turn", cwd: input.cwd, allowedFolders: [], mode: "Normal", agentSessionId: "", promptId: 2, finished: false, cancelled: false, slash: false, said: false, ...turn, proc });
		writes.length = 0;
		return proc;
	}
	const served = new Set();
	// Answers every request a Grok process has been sent, as Grok would, until nothing new arrives. A `held` method waits for a later call.
	async function serve(held) {
		for (let round = 0; round < 20; round += 1) {
			await ticks();
			for (const child of children) {
				for (const message of child.writes) {
					if (message.id == null || !message.method || message.method === held || served.has(message.id)) { continue; }
					served.add(message.id);
					const result = message.method === "session/new" ? { sessionId: `sid-${child.pid}`, ...config() }
						: message.method === "session/load" ? config()
							: message.method === "session/prompt" ? { stopReason: "end_turn" } : {};
					child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
				}
			}
		}
	}
	const { probeGrok, killTree, commandInfo, setSignIn, signInStatus } = sandbox.module.exports;
	return { host, timers, writes, spawns, kills, events, children, running, serve, probeGrok, killTree, commandInfo, setSignIn, signInStatus };
}

// macOS and Linux: each Grok leads its own process group, and killTree ends the group instead of running taskkill.
function checkPosixProcessGroups() {
	const posix = makeHost({}, { platform: "linux", killErrors: { 9: "EPERM", 10: "ESRCH" } });
	posix.host.start({ ...input, uiSessionId: "posix" }, "ask").ready.catch(() => {});
	assert.equal(posix.spawns[0][2].detached, true, "on Linux each Grok leads its own process group");
	assert.equal(posix.killTree([{ pid: 7 }, { pid: 10 }]), true, "ESRCH means that group had already exited");
	const fallback = [];
	assert.equal(posix.killTree([{ pid: 9, kill: (signal) => fallback.push(signal) }]), false, "a group kill that fails reports it");
	assert.deepEqual(fallback, ["SIGKILL"], "and falls back to the direct child");
	assert.deepEqual(posix.kills, [["kill", -7, "SIGKILL"], ["kill", -10, "SIGKILL"], ["kill", -9, "SIGKILL"]]);
	assert.equal(posix.spawns.some((item) => item[0] === "taskkill"), false);
	const windows = makeHost({});
	windows.host.start({ ...input, uiSessionId: "windows" }, "ask").ready.catch(() => {});
	assert.equal("detached" in windows.spawns[0][2], false, "Windows spawns stay attached, so no console window opens");
	console.log("PASS macOS/Linux Grok processes lead their own process group, and killTree ends each group");
}

async function checkProbeGrok() {
	const failed = { ok: false, error: "Grok could not start." };
	const cases = [
		["cached token", { result: { authMethods: [{ id: "grok.com" }, { id: "cached_token" }], _meta: { agentVersion: "1.0.70" } } }, { ok: true, version: "1.0.70", signedIn: true, signIn: "saved", apiKey: false }],
		["signed out", { result: { authMethods: [{ id: "grok.com" }] } }, { ok: true, version: "", signedIn: false, signIn: "none", apiKey: false }],
		["older Grok", { result: { _meta: { agentVersion: "x".repeat(60) } } }, { ok: true, version: "x".repeat(40), signedIn: true, signIn: "saved", apiKey: false }],
		["error reply", { error: { message: "secret" } }, failed],
		["missing result", {}, failed],
		["null result", { result: null }, failed],
		["array result", { result: [] }, failed],
		["ENOENT", null, { ok: false, error: "Grok is not installed, or not on PATH. Set GROK_PATH to its full path." }],
		["EACCES", null, failed],
		["exit", null, failed],
		["timeout", null, failed],
		["stdin error", null, failed],
	];
	for (const [name, reply, expected] of cases) {
		const run = makeHost();
		const pending = run.probeGrok();
		const child = run.children[0];
		assert.deepEqual(plain(run.spawns[0][1]), ["--permission-mode", "default", "agent", "--no-leader", "stdio"], name);
		assert.equal(run.spawns[0][2].cwd, os.homedir());
		assert.equal(run.spawns[0][2].windowsHide, true);
		assert.equal(run.writes.length, 1);
		assert.deepEqual(run.writes[0], { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "grok-code", version: require("../package.json").version } } });
		assert.equal([...run.timers.values()][0].ms, 15000);
		if (reply) {
			child.stdout.emit("data", Buffer.from(`not JSON\n${JSON.stringify({ id: 9, result: {} })}\n`));
			const line = JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply });
			child.stdout.emit("data", Buffer.from(line.slice(0, 12)));
			child.stdout.emit("data", Buffer.from(`${line.slice(12)}\n`));
		} else if (name === "timeout") {
			[...run.timers.values()][0].callback();
		} else if (name === "exit") {
			child.emit("exit", 1);
		} else if (name === "stdin error") {
			child.stdin.emit("error", new Error("secret"));
		} else {
			child.emit("error", Object.assign(new Error("secret"), { code: name }));
		}
		assert.deepEqual(plain(await pending), expected, name);
		assert.deepEqual(taskkills(run.spawns), [String(child.pid)], `${name}: the probe always kills its child`);
		assert.deepEqual(run.writes.map((message) => message.method), ["initialize"], `${name}: no authentication or session is started`);
		assert.equal(run.timers.size, 0);
		child.emit("exit", 0);
		assert.equal(taskkills(run.spawns).length, 1, "a later exit does not finish twice");
	}
	const signedOut = [{ id: "grok.com" }];
	const saved = [{ id: "cached_token" }];
	const accepted = [{ id: "grok.com" }, { id: "xai.api_key" }];
	async function probeSignIn(env, methods, status, version = "") {
		const run = makeHost({}, { env });
		if (status) { run.setSignIn({ status: () => status, grokEnv: () => status.keyReadable ? { XAI_API_KEY: fakeKey } : {} }); }
		const pending = run.probeGrok();
		grokLine(run.children[0], { id: 1, result: { authMethods: methods, _meta: { agentVersion: version } } });
		const result = plain(await pending);
		assertNoKey(result, "the probe result never contains an API key");
		assert.deepEqual(run.writes.map((message) => message.method), ["initialize"], "an API key probe still only initializes");
		return result;
	}
	const keyMode = { mode: "key", hasKey: true, keyReadable: true };
	const unreadable = { ...keyMode, keyReadable: false };
	const keyEnv = { XAI_API_KEY: fakeEnvKey };
	assert.deepEqual(await probeSignIn(keyEnv, accepted), { ok: true, version: "", signedIn: true, signIn: "key", apiKey: true, keySource: "env" });
	assert.deepEqual(await probeSignIn(keyEnv, signedOut), { ok: true, version: "", signedIn: false, signIn: "none", apiKey: true, keySource: "env", keyRejected: true });
	assert.deepEqual(await probeSignIn(keyEnv, accepted, keyMode, fakeKey), { ok: true, version: "[redacted]", signedIn: true, signIn: "key", apiKey: true, keySource: "app" });
	assert.deepEqual(await probeSignIn({}, signedOut, keyMode), { ok: true, version: "", signedIn: false, signIn: "none", apiKey: true, keySource: "app", keyRejected: true });
	assert.deepEqual(await probeSignIn({}, saved, keyMode), { ok: true, version: "", signedIn: true, signIn: "saved", apiKey: true, keySource: "app", keyIgnored: true });
	assert.deepEqual(await probeSignIn({}, signedOut, unreadable), { ok: true, version: "", signedIn: false, signIn: "none", apiKey: false, keyUnreadable: true });
	assert.deepEqual(await probeSignIn(keyEnv, accepted, unreadable), { ok: true, version: "", signedIn: true, signIn: "key", apiKey: true, keySource: "env", keyUnreadable: true });
	assert.deepEqual(await probeSignIn({}, null, keyMode), { ok: true, version: "", signedIn: true, signIn: "saved", apiKey: true }, "older Grok keeps the saved reading");
	assert.deepEqual(await probeSignIn({ XAI_API_KEY: "   " }, signedOut), { ok: true, version: "", signedIn: false, signIn: "none", apiKey: false }, "a blank API key does not count");
	assert.deepEqual(await probeSignIn({ XAI_API_KEY: "" }, signedOut), { ok: true, version: "", signedIn: false, signIn: "none", apiKey: false });
	assert.deepEqual(await probeSignIn(keyEnv, saved), { ok: true, version: "", signedIn: true, signIn: "saved", apiKey: true }, "a saved sign-in wins while it exists");
}

function grokLine(child, message) {
	child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
}

function assertNoKey(value, label) {
	const text = JSON.stringify(value);
	assert.ok(!text.includes(fakeKey) && !text.includes(fakeEnvKey) && !/xai-[A-Za-z0-9_-]{20,}/.test(text), label);
}

async function checkSignInSpawns() {
	const oneShotArgs = ["--permission-mode", "default", "agent", "--no-leader", "stdio"];
	const accepted = { authMethods: [{ id: "xai.api_key" }] };
	const env = { XAI_API_KEY: fakeEnvKey, OTHER: "kept" };
	const run = makeHost({}, { env });
	let status = { mode: "key", hasKey: true, keyReadable: true };
	run.setSignIn({ status: () => status, grokEnv: () => status.keyReadable ? { XAI_API_KEY: fakeKey } : {} });
	assert.deepEqual(plain(run.signInStatus()), status);
	for (const mode of ["key", "grok"]) {
		if (mode === "grok") { status = { mode: "grok" }; }
		const key = mode === "key" ? fakeKey : fakeEnvKey;
		const spawnAt = run.spawns.length;
		const childAt = run.children.length;
		const probe = run.probeGrok();
		const billing = run.host.billing();
		const session = run.host.start(input, "ask");
		const [probeChild, billChild, sessionChild] = run.children.slice(childAt);
		const [probeSpawn, billSpawn, sessionSpawn] = run.spawns.slice(spawnAt);
		for (const spawn of [probeSpawn, billSpawn, sessionSpawn]) {
			assert.ok(spawn[2].env.XAI_API_KEY === key, `${mode} mode uses the expected key`);
			assert.equal(spawn[2].env.OTHER, "kept");
			assertNoKey(spawn[1], "argv never carries a key");
		}
		assert.ok(env.XAI_API_KEY === fakeEnvKey, "spawning leaves the inherited environment alone");
		assert.deepEqual(plain(probeSpawn[1]), oneShotArgs);
		assert.deepEqual(plain(billSpawn[1]), oneShotArgs);
		assert.deepEqual(plain(sessionSpawn[1]), [...oneShotArgs.slice(0, -1), "--model", input.model, "--reasoning-effort", input.effort, "stdio"]);
		grokLine(probeChild, { id: 1, result: accepted });
		grokLine(billChild, { id: 1, result: accepted });
		grokLine(sessionChild, { id: sessionChild.writes[0].id, result: accepted });
		await ticks();
		assert.deepEqual(sessionChild.writes.map(({ method }) => method), ["initialize", "authenticate"]);
		assert.deepEqual(sessionChild.writes[1].params, { methodId: "cached_token" });
		grokLine(sessionChild, { id: sessionChild.writes[1].id, result: { _meta: { email: fakeKey } } });
		await session.ready;
		assertNoKey(run.host.account, "account reads mask the key");
		assertNoKey(await probe, "probe exposes only safe state");
		assert.deepEqual(plain(await billing), { ok: false, error: "Grok did not return usage." });
		assert.deepEqual(billChild.writes.map(({ method }) => method), ["initialize"]);
		run.host.signInChanged();
	}
	const older = makeHost();
	older.setSignIn({ status: () => ({ mode: "key", hasKey: true, keyReadable: true }), grokEnv: () => ({ XAI_API_KEY: fakeKey }) });
	const legacy = older.host.start(input, "ask");
	void legacy.ready.catch(() => {});
	const legacyChild = older.children[0];
	assert.ok(older.spawns[0][2].env.XAI_API_KEY === fakeKey, "the older Grok receives the selected key");
	grokLine(legacyChild, { id: legacyChild.writes[0].id, result: {} });
	await ticks();
	assert.deepEqual(legacyChild.writes.map(({ method }) => method), ["initialize", "authenticate"], "missing authMethods still authenticates in key mode");
	assert.deepEqual(legacyChild.writes[1].params, { methodId: "cached_token" });
	grokLine(legacyChild, { id: legacyChild.writes[1].id, result: {} });
	await legacy.ready;
	older.host.signInChanged();
	for (const [name, readable, detail] of [
		["rejected", true, "Grok rejected the API key, or couldn't reach xAI to check it. Check the key in Settings."],
		["unreadable", false, "The saved API key can't be read on this computer. Enter it again in Settings."],
	]) {
		const each = makeHost();
		each.setSignIn({ status: () => ({ mode: "key", hasKey: true, keyReadable: readable }), grokEnv: () => readable ? { XAI_API_KEY: fakeKey } : {} });
		const prompt = each.host.prompt(input);
		const child = each.children[0];
		grokLine(child, { id: child.writes[0].id, result: { authMethods: [{ id: "grok.com" }] } });
		const result = await prompt;
		assertNoKey(result, "startup errors never echo the key");
		assert.deepEqual(plain(result), { ok: false, error: detail }, name);
		assert.deepEqual(child.writes.map(({ method }) => method), ["initialize"], "the child stops before authenticate");
		assert.deepEqual(taskkills(each.spawns), [String(child.pid)]);
		assert.equal(each.host.procs.size, 0);
	}
	const background = run.host.start(input, "ask");
	const scheduled = run.host.start({ ...input, uiSessionId: "scheduled" }, "ask");
	background.ready.catch(() => {});
	scheduled.ready.catch(() => {});
	background.background = true;
	scheduled.looping = true;
	run.host.limitProbe = { at: Date.now(), promise: Promise.resolve({ ok: true }) };
	const eventAt = run.events.length;
	run.host.signInChanged();
	assert.equal(run.host.limitProbe, null);
	assert.equal(run.host.procs.size, 0);
	assert.deepEqual(taskkills(run.spawns).slice(-2), [String(background.child.pid), String(scheduled.child.pid)]);
	assert.deepEqual(plain(run.events[eventAt]), { type: "account", account: null });
	assert.deepEqual(plain(run.events.at(-1)), { type: "sign-in-changed" });
}

function checkKeyMasking() {
	const sourceValue = { [fakeKey]: { values: [fakeKey, "xai-grok-cli", "xai.api_key", null] } };
	const copy = redactDeep(sourceValue);
	assert.ok(Object.hasOwn(copy, fakeKey), "object keys stay unchanged");
	assert.ok(sourceValue[fakeKey].values[0] === fakeKey, "redaction leaves the original event untouched");
	assertNoKey(copy[fakeKey], "nested values are masked");
	assert.deepEqual(copy[fakeKey].values, ["[redacted]", "xai-grok-cli", "xai.api_key", null]);
	const serialized = redactKeys(JSON.stringify({ value: `before\n${fakeKey}` }));
	assertNoKey(serialized, "an encoded newline does not prevent redaction");
	assert.equal(JSON.parse(serialized).value, "before\n[redacted]");

	const run = makeHost({ chunkMs: 30 });
	const proc = run.running({ uiSessionId: "chat", agentSessionId: "sid-mask" });
	const hook = (id, toolName, toolInput) => grokLine(proc.child, {
		id,
		method: "_x.ai/hooks/run",
		params: { sessionId: "sid-mask", toolUseId: id, toolName, toolInput },
	});
	const commandHook = (id, command) => hook(id, "run_terminal_command", { command });
	const choose = (toolId, decision) => run.host.decide({ uiSessionId: "chat", toolId, decision });
	const update = (update) => grokLine(proc.child, { method: "session/update", params: { sessionId: "sid-mask", update } });
	const command = `npm test -- ${fakeKey}`;
	commandHook("key-command", command);
	assert.ok(run.host.gates.get("key-command").command === command, "the hook retains the original command");
	assertNoKey(run.events, "approval payload and formatted input mask the key");
	assert.equal(run.events.at(-1).tool.noAlways, true);
	assert.equal(run.events.at(-1).tool.command, "npm test -- [redacted]");
	assert.equal(run.events.at(-1).tool.commandPrefix, "npm test", "a safe prefix remains available");
	assert.equal(choose("key-command", "always").ok, true);
	assert.equal(run.writes.at(-1).result.decision, "allow", "an injected Always is one-time only");
	assert.equal(run.host.savedRules().size, 0);
	assert.equal(run.host.always.size, 0);

	commandHook("different-key", `npm test -- ${fakeEnvKey}`);
	assert.equal(run.host.gates.has("different-key"), true, "another key does not inherit a rule from the masked command");
	assert.equal(choose("different-key", "prefix").ok, true);
	commandHook("allowed-prefix", command);
	assert.equal(run.writes.at(-1).result.decision, "allow", "the existing safe prefix still applies to the raw command");
	commandHook("sensitive-prefix", `make ${fakeKey.toLowerCase()}`);
	assert.equal(run.events.at(-1).tool.commandPrefix, undefined);
	assert.equal(choose("sensitive-prefix", "prefix").ok, false, "an injected prefix cannot grant a key");
	choose("sensitive-prefix", "deny");

	hook("key-tool", "use_tool", { tool_name: fakeKey });
	assert.equal(run.events.at(-1).tool.noAlways, true, "the field used by an MCP tool rule is checked");
	assert.equal(choose("key-tool", "always").ok, true);
	hook("same-key-tool", "use_tool", { tool_name: fakeKey });
	assert.equal(run.host.gates.has("same-key-tool"), true, "the MCP rule was never stored");
	choose("same-key-tool", "deny");

	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `key:\n${fakeKey}` } });
	run.host.flushText("chat");
	assertNoKey(run.events, "buffered chat output passes through the masking boundary");
	assert.equal(run.events.at(-1).text, "key:\n[redacted]");
	update({ sessionUpdate: "tool_call", toolCallId: "key-output", kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: `xai-grok-cli ${fakeKey}` } }] });
	assertNoKey(run.events, "tool output sent to the window is masked");
	assert.equal(run.events.at(-1).tool.output, "xai-grok-cli [redacted]");
	run.host.emit({ type: "error", uiSessionId: "chat", message: `Failure:\n${fakeKey}` });
	assertNoKey(run.events, "the event wrapper masks errors sent to the window");
	assert.equal(run.events.at(-1).message, "Failure:\n[redacted]");
}

function checkEditDiffs() {
	const { host, running, events } = makeHost();
	const first = { type: "diff", oldText: "old\n", newText: "new\nnext\n", _meta: { old_line: 3, new_line: 4 } };
	const card = host.toolCard({ toolCallId: "diff", kind: "edit", content: [first, { type: "diff", oldText: "extra\n", newText: "" }] });
	assert.deepEqual(plain(card.diff), { oldText: "old\n", newText: "new\nnext\n", oldLine: 3, newLine: 4 });
	assert.deepEqual([card.additions, card.deletions], [2, 2], "counts still include every diff part");
	const completed = host.toolCard({ toolCallId: "diff", kind: "edit", status: "completed", content: [{ ...first, _meta: { details: [{ old_line: 5, new_line: 6 }] } }] });
	assert.deepEqual(plain(completed.diff), { oldText: "old\n", newText: "new\nnext\n", oldLine: 5, newLine: 6 });
	for (const value of [0, -1, 1.5, "3", null]) {
		const invalid = host.toolCard({ toolCallId: "diff", kind: "edit", content: [{ ...first, _meta: { old_line: value, new_line: value } }] });
		assert.equal(invalid.diff.oldLine, undefined);
		assert.equal(invalid.diff.newLine, undefined);
	}
	const bounded = host.toolCard({ toolCallId: "diff", kind: "edit", content: [{ type: "diff", oldText: "a".repeat(30000), newText: "b".repeat(30000) }] });
	assert.deepEqual(plain(bounded.diff), { oldText: "a".repeat(20000), newText: "b".repeat(20000), clipped: true });
	assert.deepEqual([bounded.additions, bounded.deletions], [1, 1]);
	const proc = running({ uiSessionId: "chat", agentSessionId: "sid" });
	const replace = { file_path: "a.txt", old_string: "a".repeat(30000), new_string: "b", replace_all: true };
	host.onHook(proc, { id: 8001, params: { toolUseId: "replace-diff", toolName: "search_replace", toolInput: replace } });
	assert.deepEqual(plain(events.at(-1).tool.diff), { oldText: "a".repeat(20000), newText: "b", clipped: true, replaceAll: true });
	assert.equal(events.at(-1).tool.input, JSON.stringify(replace, null, 2), "clipped approvals keep all raw arguments");
	const write = { file_path: "b.txt", content: "whole file" };
	host.onHook(proc, { id: 8002, params: { toolUseId: "write-diff", toolName: "write", toolInput: write } });
	assert.deepEqual(plain(events.at(-1).tool.diff), { oldText: "", newText: "whole file", whole: true });
	assert.equal(events.at(-1).tool.input, JSON.stringify(write, null, 2));
	for (const rawInput of [replace, write]) {
		host.onPermission(proc, { id: rawInput === replace ? 8003 : 8004, params: { toolCall: { title: "Edit", kind: "edit", rawInput }, options: [] } });
		assert.equal(events.at(-1).tool.input, JSON.stringify(rawInput, null, 2), "native approvals keep all raw arguments too");
		assert.equal(events.at(-1).tool.diff.newText, rawInput.new_string || rawInput.content);
		assert.equal(events.at(-1).tool.diff.replaceAll, rawInput === replace ? true : undefined);
		assert.equal(events.at(-1).tool.diff.whole, rawInput === write ? true : undefined);
	}
	host.onHook(proc, { id: 8005, params: { toolUseId: "command-diff", toolName: "run_terminal_command", toolInput: { command: "echo hello", old_string: "old", new_string: "new" } } });
	assert.equal(events.at(-1).tool.diff, undefined, "a command never gets an edit preview");
	host.onPermission(proc, { id: 8006, params: { toolCall: { title: "Command", kind: "execute", rawInput: { command: "echo hello", content: "not a file" } }, options: [] } });
	assert.equal(events.at(-1).tool.diff, undefined);
}

function config(model = "grok-4.7", effort = "high") {
	return { configOptions: [
		{ id: "model", currentValue: model, options: [{ value: "grok-4.7" }, { value: "grok-4.5" }] },
		{ id: "reasoning_effort", currentValue: effort, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
	] };
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function ticks() {
	for (let i = 0; i < 10; i += 1) { await Promise.resolve(); }
}

function taskkills(spawns) {
	return spawns.filter((item) => item[0] === "taskkill").map((item) => item[1][1]);
}

async function checkCancellation() {
	for (const stage of ["ready", "ensureSession", "applyConfig"]) {
		const { host } = makeHost();
		const waiting = deferred();
		const calls = [];
		host.procFor = () => ({ uiSessionId: "chat", parents: new Map(), promptTurns: new Map(), ready: stage === "ready" ? waiting.promise : Promise.resolve() });
		host.ensureSession = stage === "ensureSession" ? () => waiting.promise : async () => ({ sessionId: "agent-chat" });
		host.applyConfig = stage === "applyConfig" ? () => waiting.promise : async () => {};
		host.request = (_proc, method) => { calls.push(method); return { id: 1, promise: new Promise(() => {}) }; };
		const sent = host.prompt(input);
		await Promise.resolve();
		await Promise.resolve();
		host.cancel(input.uiSessionId);
		waiting.resolve({ sessionId: "agent-chat" });
		const result = await sent;
		assert.equal(result.ok, false, stage);
		assert.match(result.error, /Stopped/);
		assert.equal(calls.includes("session/prompt"), false, stage);
		assert.equal(host.turns.size, 0);
	}
	const { host, writes, spawns, timers, children } = makeHost();
	const sent = host.prompt(input);
	assert.equal(writes[0].params._meta["x.ai/hooks"].PreToolUse[0].timeout, 600);
	assert.equal(JSON.stringify(spawns[0][1].slice(0, 3)), JSON.stringify(["--permission-mode", "default", "agent"]), "the agent starts in ask mode so Auto-review is not stuck on config always-approve");
	assert.equal(spawns[0][2].cwd, input.cwd, "a session's Grok starts in that session's folder");
	assert.equal(spawns[0][2].env.GROK_PROMPT_SUGGESTIONS, "1", "the app's own setting, not Grok's config.toml, decides prompt suggestions");
	host.cancel(input.uiSessionId);
	[...timers.values()].filter((timer) => timer.ms === 5000).at(-1).callback();
	assert.deepEqual(plain(await sent), { ok: false, error: "Stopped." });
	assert.deepEqual(taskkills(spawns), [String(children[0].pid)], "a Stop during a hung start ends that session's Grok, once");
	assert.equal(host.procs.size, 0);
}

async function checkRestore() {
	const { host, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", promptId: null });
	host.sessions.set("chat", { sessionId: "persisted", cwd: input.cwd, proc, sandboxKey: "", model: "grok-4.7", effort: "high" });
	host.loseProc(proc, "Exited");
	assert.deepEqual(plain(events.shift()), { type: "bg-tasks", uiSessionId: "chat", tasks: [], reset: true });
	assert.deepEqual(plain(events.shift()), { type: "loops", uiSessionId: "chat", loops: [], reset: true });
	assert.equal(host.sessions.get("chat").proc, null);
	assert.equal(host.sessions.get("chat").model, "");
	const next = { uiSessionId: "chat", lost: false, parents: new Map(), sandboxKey: "" };
	const requests = [];
	host.request = (target, method, params) => {
		requests.push({ target, method, params });
		return { promise: Promise.resolve(config()) };
	};
	const restored = await host.ensureSession(next, input);
	assert.equal(requests[0].method, "session/load");
	assert.equal(requests[0].params.sessionId, "persisted");
	assert.equal(requests[0].target, next, "the conversation reloads in the session's new Grok");
	assert.equal(restored.model, "grok-4.7");
	assert.equal(restored.proc, next);
	host.turns.set("chat", { uiSessionId: "chat", promptId: null, proc: next });
	host.onUpdate(next, { update: { sessionUpdate: "agent_message_chunk", content: { text: "historical" } } });
	assert.equal(events.length, 0);
	host.sessions.clear();
	await host.ensureSession(next, { ...input, agentSessionId: "saved-by-renderer" });
	assert.equal(requests[1].method, "session/load");
	assert.equal(requests[1].params.sessionId, "saved-by-renderer");
	host.sessions.clear();
	host.request = () => ({ promise: Promise.reject(new Error("No saved session")) });
	await assert.rejects(host.ensureSession(next, { ...input, agentSessionId: "missing" }), /No saved session/);
	assert.equal(host.sessions.size, 0);
	host.request = () => ({ promise: Promise.reject(Object.assign(new Error("Path not found."), { fromGrok: true })) });
	await assert.rejects(host.ensureSession(next, { ...input, agentSessionId: "missing" }), (error) => error.lostSession === true && /could not reload the earlier conversation \(Path not found\.\)/.test(error.message));
	await assert.rejects(host.ensureSession(next, input), (error) => !error.lostSession && error.message === "Path not found.");
	host.sessions.set("chat", { sessionId: "in-memory", cwd: input.cwd, proc: null, sandboxKey: "" });
	await assert.rejects(host.ensureSession(next, input), (error) => error.lostSession === true, "after a Grok restart, a session Grok cannot reload is reported as lost");
	assert.equal(host.sessions.has("chat"), false, "the stale session is dropped so the next send starts a new one");
	const lost = makeHost().host;
	lost.procFor = () => ({ ready: Promise.resolve(), promptTurns: new Map() });
	lost.ensureSession = async () => { throw Object.assign(new Error("Grok could not reload the earlier conversation."), { lostSession: true }); };
	const lostResult = await lost.prompt({ ...input, agentSessionId: "missing", turnId: "turn-lost" });
	assert.equal(lostResult.ok, false);
	assert.equal(lostResult.lostSession, true);
	assert.equal(lost.turns.size, 0);
}

function checkToolPolicy() {
	const { host, writes, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", turnId: "turn-1", agentSessionId: "sid-1" });
	let nextId = 500;
	function decision(toolName, toolInput) {
		const id = ++nextId;
		host.onHook(proc, { id, params: { toolUseId: `policy-${id}`, toolName, toolInput } });
		const reply = writes.find((item) => item.id === id);
		return reply ? reply.result.decision : "ask";
	}
	assert.equal(decision("scheduler_delete", { task_id: "nightly" }), "ask", "a path-less tool is not an edit");
	assert.equal(decision("image_edit", { prompt: "brighter", image: ["C:/Users/someone/photo.png"] }), "ask");
	assert.equal(decision("chrome__read_page", { tabId: 1 }), "ask", "MCP tools never count as reads");
	assert.equal(decision("shopify-dev-mcp__search_docs_chunks", { query: "x" }), "ask");
	assert.equal(decision("monitor", { command: "tail -f build.log", description: "Watch the build" }), "ask");
	assert.equal(events.at(-1).tool.summary, "tail -f build.log", "the approval shows the monitored command");
	assert.equal(events.at(-1).tool.turnId, undefined);
	assert.equal(events.at(-1).turnId, "turn-1");
	for (const mode of ["Normal", "Plan", "Auto-review", "Always-approve"]) {
		host.turns.get("chat").mode = mode;
		assert.equal(decision("todo_write", { todos: [] }), "allow", `todo_write never asks (${mode})`);
		assert.equal(decision("kill_command_or_subagent", { task_id: "t" }), "allow");
		assert.equal(decision("ask_user_question", { questions: [] }), "allow");
		assert.equal(decision("exit_plan_mode", {}), "allow");
	}
	const planFile = path.join(os.homedir(), ".grok", "sessions", "C%3A%5Cproject", "sid-1", "plan.md");
	host.turns.get("chat").mode = "Plan";
	assert.equal(decision("enter_plan_mode", {}), "allow");
	assert.equal(decision("search_replace", { file_path: planFile, old_string: "", new_string: "# Plan" }), "allow", "Plan mode may write its own plan file");
	assert.equal(decision("write", { file_path: path.join(os.homedir(), ".grok", "sessions", "C%3A%5Cproject", "sid-2", "plan.md") }), "deny", "another session's plan is not this plan");
	assert.equal(decision("write", { file_path: path.join(os.homedir(), ".grok", "sessions", "C%3A%5Cproject", "sid-1", "nested", "plan.md") }), "deny");
	assert.equal(decision("write", { file_path: path.join(input.cwd, "plan.md") }), "deny");
	assert.equal(decision("run_terminal_command", { command: "echo hi" }), "ask");
	assert.equal(decision("monitor", { command: "tail -f x" }), "ask");
	host.turns.get("chat").mode = "Normal";
	assert.equal(decision("enter_plan_mode", {}), "ask", "entering plan mode needs the user's approval");
	assert.equal(decision("search_replace", { file_path: planFile }), "allow");
	assert.equal(decision("write", { file_path: path.join(input.cwd, "x.txt") }), "ask");
	const long = `Write-Output start; ${"x".repeat(6000)}; Remove-Item -Recurse C:/data`;
	assert.equal(decision("run_terminal_command", { command: long }), "ask");
	const gateId = events.at(-1).tool.id;
	assert.equal(events.at(-1).tool.command, long, "an approval shows the whole command");
	assert.ok(events.at(-1).tool.summary.endsWith("…"), "a shortened summary is marked");
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call", toolCallId: gateId, rawInput: { command: long } } });
	assert.equal(events.at(-1).tool.command, long, "Grok's own update keeps the whole command while the approval is open");
	host.onPermission(proc, { id: 902, params: { toolCall: { title: "Execute", kind: "execute", rawInput: { command: long } }, options: [] } });
	assert.equal(events.at(-1).tool.command, long);
	const mcp = { tool_name: "chrome__tabs_open", tool_input: { url: `https://example.com/${"a".repeat(400)}@other.example/` } };
	assert.equal(decision("use_tool", mcp), "ask");
	assert.equal(events.at(-1).tool.input, JSON.stringify(mcp, null, 2), "an approval shows the tool's complete arguments");
	assert.equal(decision("enter_plan_mode", {}), "ask");
	assert.equal(events.at(-1).tool.input, undefined);
	host.onPermission(proc, { id: 900, params: { toolCall: { title: "Read `x`", kind: "read", locations: [{ path: path.join(input.cwd, "package.json") }] }, options: [{ kind: "allow_once", optionId: "yes" }] } });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes");
	host.onPermission(proc, { id: 901, params: { toolCall: { title: "Execute `rm x`", kind: "execute" }, options: [{ kind: "allow_once", optionId: "yes" }] } });
	assert.equal(events.at(-1).tool.kind, "command");
	assert.equal(events.at(-1).tool.waiting, true);
}

async function checkInteractions() {
	const { host, writes, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", turnId: "turn-2", mode: "Plan", agentSessionId: "sid-1" });
	const questions = [{ question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: null }];
	host.onMessage(proc, { id: 50, method: "_x.ai/ask_user_question", params: { sessionId: "sid-1", toolCallId: "call-q", questions, mode: "default" } });
	const asked = events.at(-1);
	assert.equal(asked.turnId, "turn-2");
	assert.deepEqual(plain(asked.tool), { id: "call-q", kind: "question", title: "Question", detail: "Waiting for your answer", waiting: true, questions: [{ question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: false }] });
	assert.equal(host.decide({ uiSessionId: "chat", toolId: "call-q", decision: "allow" }).ok, false, "Allow/Deny cannot answer a question");
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q", answers: { "Another question": "Blue" } }).ok, false);
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q", answers: {} }).ok, false);
	assert.equal(host.answerQuestion({ uiSessionId: "other", toolId: "call-q", answers: { "Which color?": "Blue" } }).ok, false);
	assert.equal(writes.length, 0);
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q", answers: { "Which color?": "Blue" } }).ok, true);
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 50, result: { outcome: "accepted", answers: { "Which color?": "Blue" } } });
	assert.equal(events.at(-1).tool.waiting, false);
	assert.equal(events.at(-1).tool.detail, "Answered");
	assert.deepEqual(plain(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q", answers: { "Which color?": "Red" } })), { ok: false, closed: true, error: "That question already closed." }, "a question is answered once");
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q2", answers: {} }).closed, true);
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-q", status: "completed", content: [{ type: "content", content: { type: "text", text: "User has answered" } }] } });
	assert.equal(events.at(-1).tool.detail, "Answered");
	host.onMessage(proc, { id: 51, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q2", questions } });
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q2", answers: null }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "cancelled" });
	assert.equal(events.at(-1).tool.detail, "Declined");
	host.onMessage(proc, { id: 52, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q3", questions: [] } });
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 52, result: { outcome: "cancelled" } }, "an empty question is declined at once");
	host.onMessage(proc, { id: 53, method: "_x.ai/ask_user_question", params: { questions } });
	assert.equal(events.at(-1).tool.id, "question:chat:53", "a question without a tool id is named for its session, since request ids repeat across Grok processes");
	host.answerQuestion({ uiSessionId: "chat", toolId: "question:chat:53", answers: null });

	host.onMessage(proc, { id: 60, method: "_x.ai/exit_plan_mode", params: { sessionId: "sid-1", toolCallId: "call-p", planContent: "# Plan\n1. Do it" } });
	assert.equal(events.at(-1).tool.plan, "# Plan\n1. Do it");
	assert.equal(events.at(-1).tool.kind, "plan");
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "approved" }).ok, true);
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "abandoned" }).closed, true);
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 60, result: { outcome: "approved" } });
	assert.equal(host.turns.get("chat").mode, "Normal");
	assert.equal(events.at(-1).tool.detail, "Approved · Normal");
	host.onMessage(proc, { id: 61, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p2", planContent: "# Plan" } });
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p2", outcome: "feedback", feedback: "  " }).ok, false);
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p2", outcome: "feedback", feedback: " Add tests. " }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "feedback", feedback: "Add tests." });
	host.onMessage(proc, { id: 62, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p3", planContent: "# Plan" } });
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p3", outcome: "abandoned" }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "abandoned" });
	assert.equal(host.turns.get("chat").mode, "Normal");
	host.onMessage(proc, { id: 63, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q4", questions } });
	host.onMessage(proc, { id: 64, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p4", planContent: "# Plan" } });
	host.cancel("chat");
	assert.deepEqual(writes.find((item) => item.id === 63).result, { outcome: "cancelled" });
	assert.equal(writes.find((item) => item.id === 64).result.outcome, "feedback");
	assert.equal(events.filter((event) => event.tool && event.tool.detail === "Closed · Stopped").length, 2);
	host.onMessage(proc, { id: 65, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q5", questions } });
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 65, result: { outcome: "cancelled" } }, "no open turn declines at once");
	host.turns.clear();
	host.onMessage(proc, { id: 66, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p5" } });
	assert.equal(writes.at(-1).result.outcome, "feedback");
}

async function checkModesAndCards() {
	const { host, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", turnId: "turn-3", agentSessionId: "sid-1" });
	const requests = [];
	host.request = (_proc, method, params) => { requests.push({ method, params }); return { id: requests.length, promise: Promise.resolve({}) }; };
	const session = { sessionId: "sid-1", grokMode: "", proc };
	await host.applyMode(session, { mode: "Normal" });
	await host.applyMode(session, { mode: "Always-approve" });
	await host.applyMode(session, { mode: "Plan" });
	await host.applyMode(session, { mode: "Plan" });
	assert.deepEqual(requests.map((item) => item.params.modeId), ["default", "plan"]);
	host.request = () => ({ id: 9, promise: Promise.reject(Object.assign(new Error("Unknown mode"), { fromGrok: true })) });
	await host.applyMode({ sessionId: "sid-1", grokMode: "", proc }, { ...host.turns.get("chat"), mode: "Plan" });
	assert.match(events.at(-1).text, /^Grok did not switch this session into plan mode \(Unknown mode\)\./, "a refused mode switch is said in the turn");
	assert.equal(events.at(-1).turnId, "turn-3");
	host.sessions.set("chat", session);
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mode", mode: "Plan", uiSessionId: "chat", turnId: "turn-3" });
	assert.equal(host.turns.get("chat").mode, "Plan");
	assert.equal(session.grokMode, "plan");
	host.turns.get("chat").mode = "Always-approve";
	const before = events.length;
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
	assert.equal(events.length, before, "leaving plan after an approval keeps the chosen mode");
	host.turns.get("chat").mode = "Plan";
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mode", mode: "Normal", uiSessionId: "chat", turnId: "turn-3" });
	host.onUpdate(proc, { sessionId: "other", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
	assert.equal(host.turns.get("chat").mode, "Normal", "another Grok session's mode does not move this turn");

	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "Hi" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "Hi", uiSessionId: "chat", turnId: "turn-3" });
	const command = "git status --porcelain; git log -8 --oneline";
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command", rawInput: { command, description: "Check git status" }, _meta: { "x.ai/tool": { label: "Run Command", kind: "execute" } } } });
	assert.equal(events.at(-1).tool.label, "Run Command");
	assert.equal(events.at(-1).tool.description, "Check git status");
	assert.equal(events.at(-1).tool.command, command);
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", kind: "execute", title: `Execute \`${command}\``, content: [{ type: "content", content: { type: "text", text: "Check git status" } }] } });
	assert.equal(events.at(-1).tool.output, undefined, "the description is not output");
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "?? notes.md\n9616861 fix" } }] } });
	assert.equal(events.at(-1).tool.output, "?? notes.md\n9616861 fix");
	assert.equal(events.at(-1).tool.detail, "Ran");
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", kind: "read", title: "Read `a.txt`", locations: [{ path: "C:\\project\\a.txt" }] } });
	assert.equal(events.at(-1).tool.path, "C:\\project\\a.txt");
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed", content: [{ type: "content", content: { type: "text", text: "secret file text" } }] } });
	assert.equal(events.at(-1).tool.output, undefined, "read contents are not copied into the chat");
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-3", kind: "edit", content: [{ type: "diff", path: "C:\\project\\a.txt", oldText: "one\ntwo\n", newText: "one\n2\nthree\n" }] } });
	assert.equal(events.at(-1).tool.additions, 3);
	assert.equal(events.at(-1).tool.deletions, 2);
	host.onUpdate(proc, { sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-4", status: "completed", content: [{ type: "content", content: { type: "text", text: "x".repeat(5000) } }] } });
	assert.equal(events.at(-1).tool.output.length, 1501);
	assert.match(host.inputProblem({ ...input, turnId: "" }), /turn/);
	assert.match(host.inputProblem({ ...input, turnId: "x".repeat(201) }), /turn/);
	assert.equal(host.inputProblem({ ...input, turnId: "turn-4" }), "");
}

async function checkConfig() {
	const { host, timers } = makeHost();
	const session = { sessionId: "agent-chat", model: "grok-4.5", effort: "low", configOptions: config("grok-4.5", "low").configOptions };
	let count = 0;
	host.request = () => { count += 1; return { id: count, promise: Promise.reject(new Error("Rejected")) }; };
	await assert.rejects(host.applyConfig(session, input), /Rejected/);
	await assert.rejects(host.applyConfig(session, input), /Rejected/);
	assert.equal(count, 2);
	assert.equal(session.model, "grok-4.5");
	host.request = () => ({ id: 10, promise: new Promise(() => {}) });
	const timedOut = host.applyConfig(session, input);
	[...timers.values()].find((timer) => timer.ms === 15000).callback();
	await assert.rejects(timedOut, /did not confirm/);
	assert.equal(session.model, "");
	assert.equal(session.effort, "");
	host.request = () => ({ id: 11, promise: Promise.resolve(config("grok-4.5", "low")) });
	await assert.rejects(host.applyConfig(session, input), /did not apply/);
	host.request = (_proc, _method, params) => {
		count += 1;
		return { id: count, promise: Promise.resolve(config(params.configId === "model" ? params.value : session.model, params.configId === "reasoning_effort" ? params.value : "low")) };
	};
	await host.applyConfig(session, input);
	const afterSuccess = count;
	await host.applyConfig(session, input);
	assert.equal(count, afterSuccess);
	assert.equal(session.model, input.model);
	assert.equal(session.effort, input.effort);
	assert.match(host.inputProblem({ ...input, effort: "minimal" }), /effort/);
	assert.equal(host.inputProblem({ ...input, model: "grok-next:preview_1" }), "", "a saved model id is accepted before the live list arrives");
	for (const model of [undefined, "", "--model", "grok next", "x".repeat(81)]) {
		assert.equal(host.inputProblem({ ...input, model }), "Pick a model from the list.", String(model));
	}
	assert.match(host.inputProblem({ ...input, model: "grok-4.5", effort: "xhigh" }), /4.5 supports/);
	await assert.rejects(host.tryConfig(session, "reasoning_effort", "xhigh"), /does not support/);
}

function checkPermissions() {
	const { host, writes, events, timers, running } = makeHost();
	const proc = running({ uiSessionId: "chat" });
	const options = [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }];
	host.onHook(proc, { id: 3, params: { toolUseId: "tool-one", toolName: "write" } });
	assert.equal([...timers.values()].some((timer) => timer.ms === 480000), true);
	assert.equal(writes.length, 0);
	host.decide({ uiSessionId: "chat", toolId: "tool-one", decision: "allow" });
	assert.equal(writes[0].result.decision, "allow");
	host.onPermission(proc, { id: 4, params: { toolCall: { toolCallId: "tool-one", title: "write", kind: "edit" }, options } });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes", "your Allow on that exact call also answers Grok's own prompt for it");
	assert.equal(events.at(-1).tool.id, "tool-one", "no second card");
	host.onHook(proc, { id: 7, params: { toolUseId: "tool-two", toolName: "todo_write" } });
	host.onPermission(proc, { id: 8, params: { toolCall: { toolCallId: "tool-two", title: "write", kind: "edit" }, options } });
	const nativeCard = events.at(-1).tool;
	assert.notEqual(nativeCard.id, "tool-two", "a call allowed by policy, not by your click, still gets Grok's own card");
	assert.equal(nativeCard.id, "native-permission:chat:8", "Grok's own prompt is named for its session, since request ids repeat across Grok processes");
	assert.equal(nativeCard.waiting, true);
	host.decide({ uiSessionId: "chat", toolId: nativeCard.id, decision: "allow" });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes");
	host.onPermission(proc, { id: 5, params: { toolCall: { title: "write" }, options } });
	const deniedCard = events.at(-1).tool;
	host.decide({ uiSessionId: "chat", toolId: deniedCard.id, decision: "deny" });
	assert.equal(writes.at(-1).result.outcome.optionId, "no");
	host.turns.get("chat").mode = "Auto-review";
	host.onHook(proc, { id: 9, params: { toolUseId: "auto-off", toolName: "run_terminal_command", toolInput: { command: "echo hi" }, permissionMode: "bypassPermissions" } });
	assert.equal(host.gates.has("auto-off"), true, "Auto-review asks while Grok reports its own review is off");
	host.decide({ uiSessionId: "chat", toolId: "auto-off", decision: "deny" });
	host.onHook(proc, { id: 10, params: { toolUseId: "auto-unknown", toolName: "write", toolInput: { file_path: path.join(input.cwd, "a.txt") } } });
	assert.equal(host.gates.has("auto-unknown"), true, "Auto-review asks when Grok does not say which permission it runs under");
	host.decide({ uiSessionId: "chat", toolId: "auto-unknown", decision: "deny" });
	host.onHook(proc, { id: 11, params: { toolUseId: "auto-on", toolName: "run_terminal_command", toolInput: { command: "echo hi" }, permissionMode: "auto" } });
	assert.equal(writes.at(-1).result.decision, "allow", "Auto-review leaves the call to Grok's review when that review is on");
	host.onHook(proc, { id: 12, params: { toolUseId: "auto-read", toolName: "read_file", toolInput: { path: "a.txt" }, permissionMode: "default" } });
	assert.equal(writes.at(-1).result.decision, "allow", "Auto-review keeps allowing reads");
	host.turns.get("chat").mode = "Normal";
	host.onPermission(proc, { id: 6, params: { toolCall: { title: "write" }, options } });
	host.cancel("chat");
	assert.equal(writes.find((item) => item.id === 6).result.outcome.optionId, "no");
	for (const mode of ["Auto-review", "Always-approve", "Normal"]) {
		host.turns.get("chat").mode = mode;
		host.onHook(proc, { id: `hook-${mode}`, params: { toolUseId: mode, toolName: "write" } });
		assert.equal(writes.at(-1).result.decision, "deny");
		host.onPermission(proc, { id: `permission-${mode}`, params: { toolCall: { title: "write" }, options } });
		assert.equal(writes.at(-1).result.outcome.optionId, "no");
	}
	host.turns.get("chat").cancelled = false;
	host.turns.get("chat").mode = "Plan";
	for (const toolName of ["get_command_or_subagent_output", "wait_commands_or_subagents"]) {
		host.onHook(proc, { id: toolName, params: { toolUseId: toolName, toolName } });
		assert.equal(writes.at(-1).result.decision, "allow");
	}
}

async function checkAllowedFolders() {
	const taskTemp = path.resolve(os.tmpdir(), process.env.CODEX_THREAD_ID || "grokcode-agent-tests");
	fs.mkdirSync(taskTemp, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(taskTemp, "codex-edit-folders-"));
	try {
		const project = path.join(fixture, "project");
		const outside = path.join(fixture, "outside");
		const extra = path.join(fixture, "extra");
		const sibling = path.join(fixture, "project-other");
		const home = path.join(fixture, "grok");
		const temp = path.join(fixture, "temp");
		for (const folder of [project, outside, extra, sibling, home, temp, path.join(project, "nested")]) { fs.mkdirSync(folder); }
		const insideFile = path.join(project, "file.txt");
		const outsideFile = path.join(outside, "file.txt");
		fs.writeFileSync(insideFile, "inside");
		fs.writeFileSync(outsideFile, "outside");
		fs.writeFileSync(path.join(fixture, "file.txt"), "outside the allowed folders");
		fs.symlinkSync(outside, path.join(project, "escape"), "junction");
		fs.symlinkSync(path.join(fixture, "missing-outside"), path.join(project, "broken"), "junction");
		// The fixture is in the temp folder, where edits are always allowed, so this host's temp folder is elsewhere.
		const { host, writes, events, running } = makeHost({}, { tmpdir: temp, env: { GROK_HOME: home } });
		const proc = running({ uiSessionId: "chat", cwd: project });
		let nextId = 100;
		function check(toolInput, expected, toolName = "write") {
			const id = ++nextId;
			host.onHook(proc, { id, params: { toolUseId: String(id), toolName, toolInput } });
			const reply = writes.find((item) => item.id === id);
			assert.equal(reply ? reply.result.decision : "ask", expected, JSON.stringify({ toolName, toolInput }));
			if (expected === "ask") { assert.equal(events.at(-1).tool.waiting, true); }
			return String(id);
		}
		for (const key of ["file_path", "target_file", "path"]) { check({ [key]: insideFile }, "ask"); }
		check({ path: "file.txt" }, "ask");
		check({ path: "new/deep/file.txt" }, "ask");
		check({ path: "../outside/file.txt" }, "ask");
		check({ path: path.join(sibling, "file.txt") }, "ask");
		check({ path: path.join(project, "escape/file.txt") }, "ask");
		check({ path: path.join(project, "escape/new/deep/file.txt") }, "ask");
		check({ path: path.join(project, "broken/file.txt") }, "ask");
		check({ path: path.join(os.tmpdir(), "grokcode-nonexistent/new/file.txt") }, "ask");
		check({ path: path.join(os.homedir(), ".grok/codex-permission-test.txt") }, "ask");
		for (const target of ["~/.grok/example.txt", "~\\.grok\\example.txt", "~", "~other/example.txt"]) { check({ path: target }, "ask"); }
		check({ path: "./~literal.txt" }, "ask");
		if (process.platform === "win32") { check({ path: insideFile.toUpperCase() }, "ask"); }
		check({ todos: [] }, "allow", "todo_write");
		check({ path: null }, "ask");
		check({ file_path: 42, path: insideFile }, "ask");
		check({ file_path: insideFile, path: outsideFile }, "ask");
		check({ file_path: insideFile, target_file: insideFile }, "ask");
		check("malformed input", "ask");
		// Auto-review without Grok's own review on asks too (checkPermissions covers permissionMode "auto").
		for (const mode of ["Normal", "Plan", "Auto-review", "Always-approve"]) {
			host.turns.get("chat").mode = mode;
			check({ path: outsideFile }, mode === "Plan" ? "deny" : mode === "Always-approve" ? "allow" : "ask");
		}
		host.turns.get("chat").mode = "Normal";
		const readGate = check({ target_file: outsideFile }, "ask", "read_file");
		assert.equal(events.at(-1).tool.always, undefined, "outside reads ask each time");
		assert.equal(host.decide({ uiSessionId: "chat", toolId: readGate, decision: "allow" }).ok, true);
		check({ target_file: outsideFile }, "ask", "read_file");
		const pending = check({ path: path.join(extra, "new.txt") }, "ask");
		const beforeUpdate = writes.length;
		const allowedFolders = [extra];
		assert.equal(host.setAllowedFolders({ uiSessionId: "chat", allowedFolders }).ok, true);
		allowedFolders.push(outside);
		assert.equal(host.turns.get("chat").allowedFolders.length, 1);
		assert.equal(writes.length, beforeUpdate);
		assert.equal(host.gates.has(pending), true);
		check({ path: path.join(extra, "new.txt") }, "ask");
		assert.equal(host.setAllowedFolders({ uiSessionId: "other", allowedFolders: [outside] }).ok, true);
		check({ path: outsideFile }, "ask");
		for (const mode of ["Normal", "Plan", "Auto-review", "Always-approve"]) {
			host.turns.get("chat").mode = mode;
			const restricted = mode === "Normal" || mode === "Plan";
			check({ target_file: "file.txt" }, "allow", "read_file");
			check({ target_directory: extra }, "allow", "list_dir");
			check({ path: home }, "allow", "grep");
			check({ path: temp }, "allow", "grep");
			check({ pattern: "needle" }, "allow", "grep");
			check({ pattern: "needle", path: "" }, "allow", "grep");
			check({ path: "nested/../file.txt" }, "allow", "read_file");
			check({ target_file: "escape/file.txt" }, restricted ? "ask" : "allow", "read_file");
			check({ target_file: "escape/../file.txt" }, restricted ? "ask" : "allow", "read_file");
			check({ target_file: "../outside/file.txt" }, restricted ? "ask" : "allow", "read_file");
			check({ target_directory: outside }, restricted ? "ask" : "allow", "list_dir");
			check({ path: outside }, restricted ? "ask" : "allow", "grep");
			check({}, "allow", "search_tool");
		}
		host.turns.get("chat").mode = "Normal";
		if (process.platform === "win32") {
			const server = "\\\\unapproved.invalid\\share\\file.txt";
			const { lstatSync, readlinkSync } = fs;
			const realpath = fs.realpathSync.native;
			let probed = false;
			const track = (call) => (file, ...args) => {
				if (String(file).startsWith("\\\\unapproved.invalid\\")) { probed = true; throw new Error("Unexpected network probe"); }
				return call(file, ...args);
			};
			try {
				fs.lstatSync = track(lstatSync);
				fs.realpathSync.native = track(realpath);
				fs.readlinkSync = (file, ...args) => file === path.join(project, "escape") ? server : readlinkSync(file, ...args);
				check({ target_file: server }, "ask", "read_file");
				check({ target_file: "escape/file.txt" }, "ask", "read_file");
				assert.equal(probed, false, "an unapproved share and a link to it both ask before opening the share");
			} finally {
				fs.lstatSync = lstatSync;
				fs.realpathSync.native = realpath;
				fs.readlinkSync = readlinkSync;
			}
			const originalTarget = proc.target;
			try {
				proc.target = { guestCwd: "/project", home, toHost: (file) => file === "/tmp" ? temp : file };
				check({ target_file: "nested\\file.txt" }, "ask", "read_file");
			} finally {
				proc.target = originalTarget;
			}
		}
		const otherProc = running({ uiSessionId: "other-chat", cwd: project });
		const nativeOptions = [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }];
		host.onPermission(otherProc, { id: "read-native-out", params: { toolCall: { toolCallId: readGate, title: "Read", kind: "read", locations: [{ path: insideFile }, { path: outsideFile }] }, options: nativeOptions } });
		assert.equal(events.at(-1).tool.waiting, true);
		assert.deepEqual(JSON.parse(events.at(-1).tool.input).locations, [insideFile, outsideFile]);
		assert.equal(writes.some((message) => message.id === "read-native-out"), false);
		host.decide({ uiSessionId: "other-chat", toolId: events.at(-1).tool.id, decision: "deny" });
		assert.equal(writes.at(-1).result.outcome.optionId, "no");
		host.onPermission(otherProc, { id: "read-native-unknown", params: { toolCall: { title: "grep", kind: "search" }, options: nativeOptions } });
		assert.equal(writes.some((message) => message.id === "read-native-unknown"), false);
		assert.equal(events.at(-1).tool.waiting, true);
		host.decide({ uiSessionId: "other-chat", toolId: events.at(-1).tool.id, decision: "deny" });
		const granted = check({ path: insideFile }, "ask");
		assert.equal(host.decide({ uiSessionId: "chat", toolId: granted, decision: "always" }).ok, true);
		check({ path: insideFile }, "allow");
		check({ path: path.join(extra, "new.txt") }, "allow");
		// After Always allow on a write, a junction out, a broken junction, a look-alike folder, a `~` path or a git hook in an added folder still asks.
		for (const target of [path.join(project, "escape/file.txt"), path.join(project, "broken/file.txt"), path.join(sibling, "file.txt"), "~/example.txt", path.join(extra, ".git", "hooks", "post-checkout")]) { check({ path: target }, "ask"); }
		for (const invalid of [null, "folder", ["relative/path"], [null], [""], ["C:/bad\0path"]]) {
			assert.equal(host.setAllowedFolders({ uiSessionId: "chat", allowedFolders: invalid }).ok, false);
			assert.match(host.inputProblem({ ...input, allowedFolders: invalid }), /absolute folder paths/);
		}
		assert.equal(host.setAllowedFolders({ allowedFolders: [] }).ok, false);
		host.cancel("chat");
		check({ path: insideFile }, "deny");
		check({ path: path.join(extra, "new.txt") }, "deny");
		check({ path: "~/.grok/example.txt" }, "deny");
		host.turns.clear();
		check({ path: "~/.grok/example.txt" }, "deny");
		const started = makeHost().host;
		started.dispatch = async () => ({ ok: true });
		const initialFolders = [extra];
		assert.equal((await started.prompt({ ...input, cwd: project, allowedFolders: initialFolders })).ok, true);
		initialFolders.push(outside);
		assert.equal(started.turns.get("chat").allowedFolders.length, 1);
	} finally {
		const relative = path.relative(fs.realpathSync(taskTemp), fs.realpathSync(fixture));
		assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
}

async function checkProcessFailures() {
	const missing = makeHost();
	const missingSent = missing.host.prompt(input);
	missing.children[0].emit("error", Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" }));
	assert.deepEqual(plain(await missingSent), { ok: false, error: "Grok is not installed, or not on PATH. Set GROK_PATH to its full path." });

	const exited = makeHost();
	const proc = exited.running({ uiSessionId: "chat", promptId: 10 });
	exited.host.onHook(proc, { id: 1, params: { toolUseId: "hook-edit", toolName: "write" } });
	exited.host.onPermission(proc, { id: 2, params: { toolCall: { title: "write" }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] } });
	assert.equal(exited.host.gates.size, 2);
	exited.host.loseProc(proc, "Grok exited.");
	const closed = exited.events.filter((event) => event.type === "tool" && event.tool.waiting === false);
	assert.equal(closed.length, 2);
	assert.equal(closed.every((event) => event.tool.detail === "Closed · Grok exited"), true);
	assert.equal(exited.host.gates.size, 0);
	assert.equal(exited.timers.size, 0);
	assert.equal(exited.writes.length, 0, "a failed transport receives no approval reply");
	assert.equal(exited.events.at(-1).type, "error");
	assert.equal(exited.host.decide({ uiSessionId: "chat", toolId: "hook-edit", decision: "allow" }).ok, false);

	const startup = makeHost();
	const sent = startup.host.prompt(input);
	const child = startup.children[0];
	assert.doesNotThrow(() => child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), "a write racing Grok's exit does not crash the app");
	child.stderr.emit("data", Buffer.from("old warning\n".repeat(1000)));
	child.stderr.emit("data", Buffer.from("Login service is unavailable.\n"));
	child.emit("exit", 1);
	const failed = await sent;
	assert.equal(failed.ok, false);
	assert.match(failed.error, /Grok exited\..*Login service is unavailable/);
	assert.ok(failed.error.length < 350);

	const privateFailure = makeHost();
	const privateSent = privateFailure.host.prompt(input);
	privateFailure.children[0].stderr.emit("data", Buffer.from(`Authentication failed. Authorization: Basic dummy-credential\n{"api_key":"dummy-api-key"} token=another-dummy password=private-value xai-grok-cli sk-examplecredential ${fakeKey}\n`));
	privateFailure.children[0].emit("exit", 1);
	const privateResult = await privateSent;
	assertNoKey(privateResult, "stderr diagnostics mask xAI keys");
	assert.match(privateResult.error, /Authentication failed/);
	assert.equal(/dummy-credential|dummy-api-key|another-dummy|private-value|sk-examplecredential/.test(privateResult.error), false);
	assert.match(privateResult.error, /xai-grok-cli \[redacted\] \[redacted\]/);

	const rpc = makeHost();
	const rpcSent = rpc.host.prompt(input);
	rpc.children[0].stderr.emit("data", Buffer.from("Unrelated stderr warning.\n"));
	grokLine(rpc.children[0], { id: rpc.writes[0].id, error: { message: `Authentication rejected by RPC.\n${fakeKey}` } });
	const rpcResult = await rpcSent;
	assertNoKey(rpcResult, "direct IPC errors mask Grok's RPC message");
	assert.equal(rpcResult.error, "Authentication rejected by RPC.\n[redacted]");
}

async function checkSessions() {
	const { host, events, timers, spawns, running } = makeHost();
	const procA = running({ uiSessionId: "a", turnId: "turn-a", agentSessionId: "sid-a", promptId: 2 });
	const procB = running({ uiSessionId: "b", turnId: "turn-b", agentSessionId: "sid-b", promptId: 3 });
	assert.notEqual(procA.child, procB.child, "each session has its own Grok process");
	host.sessions.set("a", { sessionId: "sid-a", proc: procA });
	host.sessions.set("b", { sessionId: "sid-b", proc: procB });
	const turnA = host.turns.get("a");
	const turnB = host.turns.get("b");
	assert.match((await host.prompt({ ...input, uiSessionId: "a" })).error, /still answering in this session/);
	host.dispatch = async () => ({ ok: true });
	assert.equal((await host.prompt({ ...input, uiSessionId: "c" })).ok, true, "another session can start while two are running");
	host.turns.delete("c");
	delete host.dispatch;
	host.onUpdate(procB, { sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "for b" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "for b", uiSessionId: "b", turnId: "turn-b" });
	const count = events.length;
	host.onUpdate(procA, { sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "wrong process" } } });
	assert.equal(events.length, count, "one session's Grok never writes into another session's turn");
	host.onHook(procA, { id: 20, params: { sessionId: "sid-a", toolUseId: "hook-a", toolName: "write" } });
	assert.equal(events.at(-1).uiSessionId, "a");
	host.onMessage(procB, { method: "_x.ai/session_notification", params: { sessionId: "sid-b", update: { sessionUpdate: "subagent_spawned", parent_session_id: "sid-b", child_session_id: "sub-b" } } });
	host.onHook(procB, { id: 21, params: { sessionId: "sub-b", toolUseId: "hook-sub", toolName: "write" } });
	assert.equal(events.at(-1).uiSessionId, "b", "a subagent's approval goes to the session that started it");
	const beforeSub = events.length;
	host.onUpdate(procB, { sessionId: "sub-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "subagent text" } } });
	assert.equal(events.length, beforeSub, "subagent text stays out of the parent reply");
	host.onUpdate(procB, { sessionId: "sub-b", update: { sessionUpdate: "tool_call", toolCallId: "sub-call", title: "read_file", rawInput: { path: "a.txt" } } });
	assert.equal(events.at(-1).uiSessionId, "b", "subagent tool rows still show");
	host.onHook(procA, { id: 22, params: { sessionId: "unknown", toolUseId: "hook-unknown", toolName: "write" } });
	assert.equal(procA.child.writes.at(-1).result.decision, "deny", "an unknown Grok session is never guessed");
	host.onMessage(procA, { method: "_x.ai/session_notification", params: { sessionId: "sid-a", update: { sessionUpdate: "subagent_spawned", parent_session_id: "sid-a", child_session_id: "sub-a" } } });
	procA.lastTurn = turnA;
	host.finishPrompt(turnA, 2, { stopReason: "end_turn" }, "");
	assert.deepEqual(plain(events.at(-1)), { type: "done", stopReason: "end_turn", uiSessionId: "a", turnId: "turn-a" });
	host.onHook(procA, { id: 23, params: { sessionId: "sub-a", toolUseId: "hook-after", toolName: "read_file", toolInput: { path: "a.txt" } } });
	assert.equal(procA.child.writes.at(-1).result.decision, "allow", "a subagent still reads after the prompt that started it has ended");
	host.onMessage(procA, { method: "_x.ai/session_notification", params: { sessionId: "sid-a", update: { sessionUpdate: "subagent_spawned", parent_session_id: "sid-a", child_session_id: "sub-late" } } });
	host.onHook(procA, { id: 27, params: { sessionId: "sub-late", toolUseId: "hook-late", toolName: "read_file", toolInput: { path: "a.txt" } } });
	assert.equal(procA.child.writes.at(-1).result.decision, "allow", "a subagent spawned after the prompt ended still reads");
	host.onHook(procA, { id: 24, params: { sessionId: "sub-a", toolUseId: "hook-after-write", toolName: "write", toolInput: { file_path: "a.txt" } } });
	assert.equal(procA.child.writes.at(-1).result.decision, "deny", "a subagent edit after the prompt cannot ask once the reply is finished");
	assert.match(procA.child.writes.at(-1).result.reason, /already finished/);
	assert.equal(events.at(-1).tool.id, "hook-after-write", "that denial is a row on the finished reply");
	assert.equal(host.gates.has("hook-after-write"), false);
	host.onHook(procA, { id: 25, params: { sessionId: "unknown", toolUseId: "hook-after-unknown", toolName: "read_file" } });
	assert.equal(procA.child.writes.at(-1).result.decision, "deny", "a session the ended turn did not start is still denied");
	assert.deepEqual([...host.turns.keys()], ["b"]);
	assert.equal(procA.child.writes.find((item) => item.id === 20).result.decision, "deny");
	assert.equal(host.gates.has("hook-sub"), true, "ending one session leaves the other's approval open");
	const turnA2 = { ...turnA, turnId: "turn-a2", promptId: 4, finished: false };
	host.turns.set("a", turnA2);
	host.cancel("b");
	assert.equal(procB.child.writes.at(-1).method, "session/cancel");
	assert.equal(procB.child.writes.at(-1).params.sessionId, "sid-b");
	assert.equal(host.gates.has("hook-sub"), false, "Stop closes the session's approvals");
	[...timers.values()].filter((timer) => timer.ms === 5000).at(-1).callback();
	assert.deepEqual(plain(events.at(-1)), { type: "done", stopReason: "cancelled", uiSessionId: "b", turnId: "turn-b" });
	assert.deepEqual(taskkills(spawns), [String(procB.child.pid)], "a Stop that Grok does not answer ends only that session's Grok");
	assert.deepEqual([...host.turns.keys()], ["a"]);
	assert.equal(host.procs.get("a"), procA);
	assert.equal(host.procs.has("b"), false);
	assert.equal(host.sessions.get("b").proc, null, "the next message reloads b's conversation in a new Grok");
	const beforeStale = events.length;
	procB.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "from the stopped prompt" } } } })}\n`));
	assert.equal(events.length, beforeStale, "the stopped Grok's late output reaches no turn");
	assert.equal(turnB.finished, true);
	const procB2 = running({ uiSessionId: "b", turnId: "turn-b2", agentSessionId: "sid-b", promptId: 5 });
	host.onUpdate(procB, { sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "from the old Grok" } } });
	assert.equal(events.length, beforeStale, "a session's replaced Grok never reaches its next turn");
	host.onUpdate(procB2, { sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "next reply" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "next reply", uiSessionId: "b", turnId: "turn-b2" });
	procA.child.emit("exit", 1);
	assert.deepEqual(plain(events.at(-1)), { type: "error", message: "Grok exited.", uiSessionId: "a", turnId: "turn-a2" }, "a crash ends only its own session's turn");
	assert.deepEqual([...host.turns.keys()], ["b"]);

	const lone = makeHost();
	const loneProc = lone.running({ uiSessionId: "y", turnId: "turn-y", mode: "Always-approve", agentSessionId: "sid-y" });
	lone.host.onHook(loneProc, { id: 30, params: { sessionId: "sid-replaced", toolUseId: "hook-other", toolName: "run_terminal_command" } });
	assert.equal(lone.writes.at(-1).result.decision, "deny", "a request from another Grok session never borrows the one running turn");
}

// The mode chip calls setMode. Finish an Always-approve turn, change mode through that call, then a late tool call.
async function checkStaleSendMode() {
	const made = makeHost();
	const uiSessionId = "stale-window-mode";
	assert.equal((await made.host.setMode(uiSessionId, "Normal")).ok, true);
	const started = made.host.prompt({ ...input, uiSessionId, turnId: "stale", mode: "Always-approve" });
	await made.serve();
	assert.equal((await started).ok, true);
	const proc = made.host.procs.get(uiSessionId);
	assert.equal(proc.lastTurn.mode, "Normal", "a stale window cannot replace a mode the host accepted");
	const session = proc.child.writes.find((message) => message.method === "session/new");
	assert.equal(session.params._meta.yoloMode, undefined, "Grok starts with the accepted permissions too");
}

async function checkLateMode() {
	const answer = (child, id, message) => grokLine(child, { id, ...message });
	const hook = (host, proc, id, sessionId, toolId, toolName, toolInput) => {
		host.onHook(proc, { id, params: { sessionId, toolUseId: toolId, toolName, toolInput } });
		return proc.child.writes.at(-1).result;
	};
	const made = makeHost();
	const ui = "late-mode";
	const started = made.host.prompt({ ...input, uiSessionId: ui, turnId: "late-1", mode: "Always-approve" });
	await made.serve();
	assert.equal((await started).ok, true);
	const proc = made.host.procs.get(ui);
	const turn = proc.lastTurn;
	const sessionId = turn.agentSessionId;
	assert.equal(turn.finished, true);
	assert.equal(turn.mode, "Always-approve");
	assert.equal(made.host.turns.has(ui), false);
	assert.equal(hook(made.host, proc, 1, sessionId, "before", "run_terminal_command", { command: "git status" }).decision, "allow");
	assert.equal(made.events.at(-1).tool.detail, "Allowed");
	const modeCalls = () => proc.child.writes.filter((message) => message.method === "session/set_mode");
	const beforeNarrow = modeCalls().length;
	assert.equal((await made.host.setMode(ui, "Normal")).ok, true);
	assert.equal(turn.mode, "Normal");
	assert.equal(modeCalls().length, beforeNarrow, "Normal keeps Grok's default mode, so no set_mode call");
	assert.equal(made.host.procs.get(ui), proc, "the chip does not restart Grok");
	made.host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId, update: { sessionUpdate: "subagent_spawned", parent_session_id: sessionId, child_session_id: "sub-late" } } });
	const narrowed = hook(made.host, proc, 2, "sub-late", "after-command", "run_terminal_command", { command: "git status" });
	assert.equal(narrowed.decision, "deny");
	assert.match(narrowed.reason, /already finished/);
	assert.equal(made.events.at(-1).type, "tool");
	assert.equal(made.events.at(-1).tool.id, "after-command");
	assert.equal(made.events.at(-1).tool.detail, "Not run · the reply already finished");
	assert.equal(made.events.at(-1).uiSessionId, ui);
	assert.equal(made.events.at(-1).turnId, "late-1");
	assert.equal(hook(made.host, proc, 3, sessionId, "after-read", "read_file", { path: "a.txt" }).decision, "allow");
	assert.equal(made.events.at(-1).tool.id, "after-read");
	const planning = made.host.setMode(ui, "Plan");
	const planCall = modeCalls().at(-1);
	assert.equal(planCall.params.modeId, "plan");
	answer(proc.child, planCall.id, { result: {} });
	assert.equal((await planning).ok, true);
	assert.equal(turn.mode, "Plan");
	const planned = hook(made.host, proc, 4, sessionId, "plan-edit", "write", { file_path: "a.txt" });
	assert.equal(planned.decision, "deny");
	assert.match(planned.reason, /plan file/);
	assert.equal(made.events.at(-1).tool.detail, "Not run · plan mode");

	const failed = makeHost();
	const failUi = "fail-mode";
	const failStart = failed.host.prompt({ ...input, uiSessionId: failUi, turnId: "fail-1", mode: "Always-approve" });
	await failed.serve();
	assert.equal((await failStart).ok, true);
	const failProc = failed.host.procs.get(failUi);
	const failTurn = failProc.lastTurn;
	const changing = failed.host.setMode(failUi, "Plan");
	const rejected = failProc.child.writes.filter((message) => message.method === "session/set_mode").at(-1);
	answer(failProc.child, rejected.id, { error: { message: "mode rejected" } });
	const refusal = await changing;
	assert.equal(refusal.ok, false);
	assert.match(refusal.error, /mode rejected/);
	assert.equal(failTurn.mode, "Always-approve");
	assert.equal(hook(failed.host, failProc, 5, failTurn.agentSessionId, "still-allowed", "run_terminal_command", { command: "git status" }).decision, "allow");

	const stopped = makeHost();
	const stopUi = "stop-mode";
	const stopStart = stopped.host.prompt({ ...input, uiSessionId: stopUi, turnId: "stop-1", mode: "Always-approve" });
	await stopped.serve("session/prompt");
	const stopProc = stopped.host.procs.get(stopUi);
	const stopTurn = stopped.host.turns.get(stopUi);
	stopped.host.cancel(stopUi);
	assert.equal(stopTurn.cancelled, true);
	const prompt = stopProc.child.writes.find((message) => message.method === "session/prompt");
	answer(stopProc.child, prompt.id, { result: { stopReason: "end_turn" } });
	assert.equal((await stopStart).ok, true);
	assert.equal(stopProc.lastTurn.cancelled, true);
	assert.equal(hook(stopped.host, stopProc, 6, stopTurn.agentSessionId, "stopped", "read_file", { path: "a.txt" }).decision, "deny");

	const asked = makeHost();
	const askUi = "ask-mode";
	const askStart = asked.host.prompt({ ...input, uiSessionId: askUi, turnId: "ask-1", mode: "Normal" });
	await asked.serve();
	assert.equal((await askStart).ok, true);
	const askProc = asked.host.procs.get(askUi);
	const askSession = askProc.lastTurn.agentSessionId;
	asked.host.onMessage(askProc, { method: "_x.ai/session_notification", params: { sessionId: askSession, update: { sessionUpdate: "subagent_spawned", parent_session_id: askSession, child_session_id: "sub-ask" } } });
	const bad = await asked.host.prompt({ ...input, uiSessionId: askUi, turnId: "ask-bad", mode: "Normal", model: "no-such-model" });
	assert.equal(bad.ok, false);
	assert.match(bad.error, /does not support/);
	assert.equal(asked.host.turns.has(askUi), false);
	assert.equal(askProc.lastTurn.finished, false);
	const late = hook(asked.host, askProc, 8, "sub-ask", "late-push", "run_terminal_command", { command: "git push" });
	assert.equal(late.decision, "deny");
	assert.equal(asked.host.gates.size, 0, "a send that fails after the session is known leaves no approval card");

	const live = makeHost();
	const liveUi = "live-mode";
	const liveStart = live.host.prompt({ ...input, uiSessionId: liveUi, turnId: "live-1", mode: "Always-approve" });
	await live.serve("session/prompt");
	const liveProc = live.host.procs.get(liveUi);
	const liveTurn = live.host.turns.get(liveUi);
	assert.equal(liveTurn.finished, false);
	const liveModes = liveProc.child.writes.filter((message) => message.method === "session/set_mode").length;
	const during = await live.host.setMode(liveUi, "Normal");
	assert.equal(during.ok, false);
	assert.match(during.error, /Stop or finish this turn/);
	assert.equal(liveTurn.mode, "Always-approve");
	assert.equal(liveProc.child.writes.filter((message) => message.method === "session/set_mode").length, liveModes, "a live turn does not send a mode change");
	const livePrompt = liveProc.child.writes.find((message) => message.method === "session/prompt");
	answer(liveProc.child, livePrompt.id, { result: { stopReason: "end_turn" } });
	assert.equal((await liveStart).ok, true);

	const overlap = makeHost();
	const overlapUi = "overlap-mode";
	const overlapStart = overlap.host.prompt({ ...input, uiSessionId: overlapUi, turnId: "overlap-1", mode: "Plan" });
	await overlap.serve();
	assert.equal((await overlapStart).ok, true);
	const overlapProc = overlap.host.procs.get(overlapUi);
	const overlapTurn = overlapProc.lastTurn;
	const overlapBefore = overlapProc.child.writes.filter((message) => message.method === "session/set_mode").length;
	const narrow = overlap.host.setMode(overlapUi, "Normal");
	const wider = overlap.host.setMode(overlapUi, "Always-approve");
	const overlapCalls = overlapProc.child.writes.filter((message) => message.method === "session/set_mode").slice(overlapBefore);
	assert.equal(overlapCalls.length, 2);
	answer(overlapProc.child, overlapCalls[1].id, { result: {} });
	answer(overlapProc.child, overlapCalls[0].id, { result: {} });
	assert.equal((await narrow).ok, false, "the older mode change does not win");
	assert.equal((await wider).ok, true);
	assert.equal(overlapTurn.mode, "Always-approve", "the later click is the mode late calls use");
	assert.equal(hook(overlap.host, overlapProc, 9, overlapTurn.agentSessionId, "overlap-command", "run_terminal_command", { command: "echo hi" }).decision, "allow");

	const folder = makeHost();
	const folderUi = "folder-mode";
	const folderStart = folder.host.prompt({ ...input, uiSessionId: folderUi, turnId: "folder-1", mode: "Always-approve" });
	await folder.serve();
	assert.equal((await folderStart).ok, true);
	const folderProc = folder.host.procs.get(folderUi);
	folder.host.forgetSession(folderUi);
	assert.equal(folder.host.sessions.has(folderUi), false);
	assert.equal((await folder.host.setMode(folderUi, "Normal")).ok, true);
	assert.equal(folderProc.lastTurn.mode, "Normal");
	const afterFolder = hook(folder.host, folderProc, 10, folderProc.lastTurn.agentSessionId, "folder-command", "run_terminal_command", { command: "git push" });
	assert.equal(afterFolder.decision, "deny");
	assert.match(afterFolder.reason, /already finished/);
	console.log("PASS a finished Always-approve turn follows the mode chip, including a refused change");
}

// Real start, session and prompt traffic through fake Grok processes.
async function checkProcesses() {
	const { host, spawns, kills, children, events, serve } = makeHost();
	const root = path.resolve(__dirname, "..");
	const scripts = path.join(root, "scripts");
	const electron = path.join(root, "electron");
	const grokSpawns = () => spawns.filter((item) => item[0] !== "taskkill");
	const opened = (child) => child.writes.find((message) => message.method === "session/new" || message.method === "session/load");
	const results = await Promise.all([
		host.prompt({ ...input, uiSessionId: "a", turnId: "a1", cwd: root, mode: "Always-approve" }),
		host.prompt({ ...input, uiSessionId: "b", turnId: "b1", cwd: scripts, mode: "Auto-review" }),
		host.prompt({ ...input, uiSessionId: "side-a", turnId: "s1", cwd: root, mode: "Normal" }),
		serve(),
	]);
	assert.deepEqual(results.slice(0, 3).map((result) => result.ok), [true, true, true]);
	await serve();
	assert.equal(grokSpawns().length, 3, "each session, side chat included, starts its own Grok");
	assert.deepEqual(grokSpawns().map((item) => item[2].cwd), [root, scripts, root], "in its own folder");
	const [childA, childB, childSide] = children;
	assert.equal(opened(childA).params._meta.yoloMode, true, "Always-approve opens the session with yoloMode");
	assert.equal(opened(childA).params._meta.autoMode, undefined);
	assert.equal(opened(childB).params._meta.autoMode, true, "Auto-review opens it with autoMode");
	assert.equal(opened(childB).params._meta.yoloMode, undefined);
	assert.equal(opened(childSide).params._meta.yoloMode, undefined, "a side chat runs in Normal");
	assert.equal(opened(childSide).params._meta.autoMode, undefined);
	assert.equal(events.filter((event) => event.type === "done").length, 3);
	assert.equal(host.turns.size, 0);

	// A mode change restarts that session's Grok and reloads the conversation with the new permission.
	const savedA = results[0].agentSessionId;
	const changed = host.prompt({ ...input, uiSessionId: "a", turnId: "a2", cwd: root, mode: "Normal", agentSessionId: savedA });
	assert.deepEqual(taskkills(spawns), [String(childA.pid)], "the old Grok of that session is stopped");
	await serve();
	assert.equal((await changed).ok, true);
	const childA2 = children[3];
	assert.equal(grokSpawns().length, 4);
	assert.equal(opened(childA2).method, "session/load");
	assert.equal(opened(childA2).params.sessionId, savedA);
	assert.equal(opened(childA2).params._meta.yoloMode, undefined, "Normal reloads without yoloMode");
	assert.equal(opened(childA2).params._meta.autoMode, undefined);
	assert.equal(host.procs.get("b").child, childB, "other sessions keep their Grok");
	const again = host.prompt({ ...input, uiSessionId: "a", turnId: "a3", cwd: root, mode: "Plan", agentSessionId: savedA });
	await serve();
	assert.equal((await again).ok, true);
	assert.equal(grokSpawns().length, 4, "Plan keeps Normal's permission, so the same Grok answers");
	assert.equal(childA2.writes.filter((message) => message.method === "session/set_mode").at(-1).params.modeId, "plan");

	// A folder change starts a new Grok in the new folder.
	const moved = host.prompt({ ...input, uiSessionId: "b", turnId: "b2", cwd: electron, mode: "Auto-review" });
	await serve();
	assert.equal((await moved).ok, true);
	const childB2 = children[4];
	assert.equal(grokSpawns()[4][2].cwd, electron);
	assert.equal(opened(childB2).method, "session/new");
	assert.equal(taskkills(spawns).at(-1), String(childB.pid));
	const restarts = events.filter((event) => event.type === "chunk" && /^Grok restarted/.test(event.text));
	assert.deepEqual(restarts.map((event) => event.turnId), ["a2", "b2"], "only a replaced Grok is announced, not a reused or first one");
	assert.match(restarts[0].text, /^Grok restarted to apply the new permission mode\. Commands it left running in the background were stopped\./);
	assert.match(restarts[1].text, /^Grok restarted in the new folder\. /);

	// Removing a worktree first stops the Grok processes started in it, and waits for them to exit.
	const stopping = host.stopFolder(`${electron.toUpperCase()}\\`);
	assert.deepEqual(kills.map((item) => item[1][1]), [String(childB2.pid)], "only the Grok inside that folder is stopped, synchronously");
	let released = false;
	stopping.then(() => { released = true; });
	await ticks();
	assert.equal(released, false, "removal waits until that Grok has exited");
	childB2.emit("exit", 1);
	await ticks();
	assert.equal(released, true);
	assert.equal(host.procs.has("b"), false);
	assert.equal(host.procs.get("a").child, childA2);
	await host.stopFolder(scripts);
	assert.equal(kills.length, 1, "a folder with no running Grok stops nothing");

	// Quit stops every remaining Grok and its child processes, in one taskkill, before the app exits.
	host.kill();
	assert.equal(kills.length, 2);
	assert.deepEqual(plain(kills[1][1]), ["/PID", String(childSide.pid), "/PID", String(childA2.pid), "/T", "/F"]);
	assert.equal(host.procs.size, 0);
}

// An idle Grok stops and the next message reloads it; a busy one, or one with a background command still running, keeps running.
async function checkIdle() {
	const idle = (made) => [...made.timers.values()].filter((timer) => timer.ms === 1234);
	const update = (sessionId, value) => Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })}\n`);
	const notify = (sessionId, value) => Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId, update: value } })}\n`);
	const chunk = { sessionUpdate: "agent_message_chunk", content: { text: "working" } };

	const quiet = makeHost({ idleMs: 1234 });
	const first = quiet.host.prompt({ ...input, uiSessionId: "a", turnId: "a1" });
	await quiet.serve();
	const saved = (await first).agentSessionId;
	assert.equal(idle(quiet).length, 1);
	idle(quiet)[0].callback();
	assert.deepEqual(taskkills(quiet.spawns), [String(quiet.children[0].pid)], "an idle Grok is stopped");
	assert.equal(quiet.host.procs.has("a"), false);
	assert.equal(idle(quiet).length, 0);
	const next = quiet.host.prompt({ ...input, uiSessionId: "a", turnId: "a2" });
	await quiet.serve();
	assert.equal((await next).ok, true);
	const loaded = quiet.children[1].writes.find((message) => message.method === "session/load");
	assert.equal(loaded && loaded.params.sessionId, saved, "the next message reloads the conversation in a new Grok");
	assert.equal(quiet.events.some((event) => event.type === "error" || /^Grok restarted/.test(event.text || "")), false, "an idle stop says nothing");

	const busy = makeHost({ idleMs: 1234 });
	const proc = busy.running({ uiSessionId: "b", agentSessionId: "sid-b" });
	proc.child.stdout.emit("data", update("sid-b", chunk));
	busy.host.onHook(proc, { id: 40, params: { sessionId: "sid-b", toolUseId: "hook-b", toolName: "write" } });
	assert.equal(busy.host.gates.has("hook-b"), true);
	idle(busy)[0].callback();
	assert.equal(taskkills(busy.spawns).length, 0, "a Grok with a turn running and an approval card open is kept");
	assert.equal(idle(busy).length, 1, "and its idle clock starts again");
	busy.host.finishPrompt(busy.host.turns.get("b"), 2, { stopReason: "end_turn" }, "");
	const before = idle(busy)[0];
	proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "sub-b", update: { sessionUpdate: "response_completed" } } })}\n`));
	assert.equal(idle(busy).length, 1);
	assert.notEqual(idle(busy)[0], before, "a background subagent's message restarts the idle clock");
	idle(busy)[0].callback();
	assert.deepEqual(taskkills(busy.spawns), [String(proc.child.pid)], "once nothing is running, it stops");

	const background = makeHost({ idleMs: 1234 });
	const side = background.running({ uiSessionId: "side-c", agentSessionId: "sid-c" });
	side.child.stdout.emit("data", update("sid-c", chunk));
	assert.equal(idle(background).length, 1);
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t1", status: "running" }] }));
	assert.equal(idle(background).length, 0, "a Grok that started a background command has no idle clock");
	background.host.finishPrompt(background.host.turns.get("side-c"), 2, { stopReason: "end_turn" }, "");
	side.child.stdout.emit("data", update("sid-c", chunk));
	assert.equal(idle(background).length, 0, "so the command keeps running");
	assert.equal(background.host.procs.get("side-c"), side);
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [] }));
	assert.equal(idle(background).length, 1, "once no background command runs, the idle clock starts again");
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t2", status: "running" }] }));
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t2", status: "completed" }] }));
	assert.equal(idle(background).length, 1, "Grok keeps a finished command in its list, so only a running one holds the idle clock");
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t3", status: "running" }] }));
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t3", status: "failed" }] }));
	assert.equal(idle(background).length, 1, "a failed command does not hold the idle clock");
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t4", status: "running" }] }));
	assert.equal(idle(background).length, 0);
	side.child.stdout.emit("data", notify("sid-c", { sessionUpdate: "subagent_spawned", child_session_id: "kid", parent_session_id: "sid-c" }));
	side.child.stdout.emit("data", notify("kid", { sessionUpdate: "background_tasks", tasks: [] }));
	assert.equal(idle(background).length, 0, "a subagent's list never clears the main session's hold");

	// Deleting or archiving a session stops its Grok and its side chat's; other sessions keep theirs.
	const gone = makeHost();
	const mainChat = gone.running({ uiSessionId: "d", agentSessionId: "sid-d" });
	const sideChat = gone.running({ uiSessionId: "side-d", agentSessionId: "sid-sd" });
	const other = gone.running({ uiSessionId: "e", agentSessionId: "sid-e" });
	gone.host.stopSession("d");
	assert.deepEqual(taskkills(gone.spawns), [String(mainChat.child.pid), String(sideChat.child.pid)]);
	assert.equal(gone.host.procs.get("e"), other);
	assert.deepEqual(gone.events.filter((event) => event.type === "done" || event.type === "error").map((event) => event.stopReason), ["cancelled", "cancelled"], "their turns end as cancelled, not as errors");
}

async function checkUnattended() {
	const test = makeHost();
	const fired = { ...input, mode: "Auto-review", unattended: true };
	const typed = { ...input, mode: "Auto-review" };
	assert.equal(test.host.inputProblem({ ...input, unattended: "yes" }), "Unattended must be on or off.");
	assert.equal(test.host.inputProblem(fired), "");
	const proc = test.host.procFor(fired, { ...fired, turnId: "fired" });
	proc.ready.catch(() => {});
	assert.equal(test.host.procFor(fired, { ...fired, turnId: "fired" }), proc, "the same kind of turn keeps its Grok");
	const requests = [];
	test.host.request = (_proc, method, params) => { requests.push({ method, params }); return { promise: Promise.resolve({ sessionId: "run-session" }) }; };
	await test.host.ensureSession(proc, fired);
	assert.equal(requests[0].method, "session/new");
	assert.deepEqual(plain(requests[0].params._meta.startupHints), { nonInteractive: true }, "Grok hears that nobody is watching");
	assert.equal(requests[0].params._meta.autoMode, true);
	const reopened = test.host.procFor(typed, { ...typed, turnId: "typed" });
	reopened.ready.catch(() => {});
	assert.notEqual(reopened, proc, "a message typed after the run gets a Grok that can ask");
	assert.ok(test.events.some((event) => /^Grok restarted so it can ask you for approvals\./.test(event.text || "")));
	await test.host.ensureSession(reopened, typed);
	const reload = requests.find((request) => request.method === "session/load");
	assert.equal(reload.params.sessionId, "run-session");
	assert.equal(reload.params._meta.startupHints, undefined, "and that Grok no longer hears it");
	const failedCard = (toolCallId, text) => test.host.toolCard({ toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text } }] }, proc).detail;
	assert.equal(failedCard("review", "Tool `run_terminal_command` was not executed: No user is available to approve this command in this non-interactive session."), "Denied · not run", "a call Grok's review refused counts as denied");
	assert.equal(failedCard("rule", "Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash."), "Denied · not run");
	assert.equal(failedCard("hook", "Hook denied: Blocked by the Claude Code safety hook."), "Denied · not run");
	test.host.outcomes.set("broke", "allow");
	assert.equal(failedCard("broke", "exit 1: No such host is known."), "Failed", "a command that ran and failed does not");
	test.host.kill();
	console.log("PASS unattended: a routine's Auto-review turn is non-interactive, and a typed message restarts Grok so it can ask");
}

async function checkRoutineInteractionTimeout() {
	for (const [method, fields, outcome] of [
		["_x.ai/ask_user_question", { questions: [{ question: "Which report?" }] }, "cancelled"],
		["_x.ai/exit_plan_mode", { planContent: "Prepare the report." }, "abandoned"],
	]) {
		const test = makeHost();
		const sent = test.host.prompt({ ...input, turnId: "scheduled" }, { routine: true });
		await test.serve("session/prompt");
		const started = await sent;
		assert.equal(started.ok, true);
		const interaction = (child, sessionId) => grokLine(child, { id: 500, method, params: { sessionId, toolCallId: "routine-card", ...fields } });
		interaction(test.children[0], started.agentSessionId);
		const gate = test.host.gates.get("routine-card");
		const deadline = test.timers.get(gate.timer);
		assert.equal(deadline.ms, 8 * 60 * 1000);
		deadline.callback();
		assert.deepEqual(test.writes.find((message) => message.id === 500).result, { outcome });
		assert.equal(test.events.at(-1).tool.detail, "Denied · timed out");
		assert.equal(test.events.at(-1).tool.waiting, false);
		assert.ok(test.writes.some((message) => message.method === "session/cancel"));
		assert.equal(test.timers.has(gate.timer), false);
		[...test.timers.values()].find((timer) => timer.ms === 5000).callback();
		assert.equal(test.host.turns.has(input.uiSessionId), false, "a Grok that ignores cancel cannot hold the routine open");
		assert.equal(test.events.at(-1).stopReason, "cancelled");

		const typed = test.host.prompt({ ...input, turnId: "typed", routine: true });
		await test.serve("session/prompt");
		interaction(test.children.at(-1), (await typed).agentSessionId);
		assert.equal(test.host.gates.get("routine-card").timer, null, "a later typed turn waits, even with a routine flag in its input");
		test.host.kill();
	}
	console.log("PASS routine questions and plans time out after 8 minutes and end the run; typed turns still wait");
}

async function checkBrowserControl() {
	const entry = { type: "http", name: "browser_pane", url: "http://127.0.0.1:12345/mcp", headers: [{ name: "Authorization", value: "Bearer test-token" }] };
	const test = makeHost({ browserServer: async () => entry }, { env: { NO_PROXY: "example.test", no_proxy: "internal.test" } });
	assert.equal(test.host.inputProblem({ ...input, browser: "yes" }), "Browser control must be on or off.");
	assert.equal(test.host.inputProblem({ ...input, browser: true }), "");
	const proc = test.host.start({ ...input, browser: true }, "ask");
	proc.ready.catch(() => {});
	assert.equal(proc.browser, true);
	assert.equal(test.spawns[0][2].env.NO_PROXY, "example.test,127.0.0.1,localhost");
	assert.equal(test.spawns[0][2].env.no_proxy, "internal.test,127.0.0.1,localhost");
	const requests = [];
	test.host.request = (_proc, method, params) => { requests.push({ method, params }); return { promise: Promise.resolve({ sessionId: "browser-session" }) }; };
	await test.host.ensureSession(proc, { ...input, browser: true });
	assert.equal(requests[0].method, "session/new");
	assert.deepEqual(plain(requests[0].params.mcpServers), [entry]);
	assert.equal(proc.browserReady, true);
	const reloaded = { browser: true, lost: false, sandboxKey: "" };
	await test.host.ensureSession(reloaded, { ...input, browser: true });
	assert.equal(requests[1].method, "session/load");
	assert.deepEqual(plain(requests[1].params.mcpServers), [entry]);
	const side = test.host.start({ ...input, uiSessionId: "side-chat", browser: true }, "ask");
	side.ready.catch(() => {});
	assert.equal(side.browser, false, "side chats never get browser tools");
	await test.host.ensureSession(side, { ...input, uiSessionId: "side-chat", browser: true });
	assert.deepEqual(plain(requests.findLast((request) => request.method === "session/new").params.mcpServers), []);
	const restarted = test.host.procFor({ ...input, browser: false }, { ...input, turnId: "restart" });
	restarted.ready.catch(() => {});
	assert.notEqual(restarted, proc);
	assert.equal(restarted.browser, false);
	assert.ok(test.events.some((event) => /Grok restarted to turn browser control off/.test(event.text || "")));
	test.host.kill();
	const failed = makeHost({ browserServer: async () => { throw new Error("private startup detail"); } });
	const failedRequests = [];
	failed.host.request = (_proc, method, params) => { failedRequests.push({ method, params }); return { promise: Promise.resolve({ sessionId: "without-browser" }) }; };
	const failedProc = { browser: true, lost: false };
	await failed.host.ensureSession(failedProc, input);
	assert.deepEqual(plain(failedRequests[0].params.mcpServers), []);
	assert.equal(failedProc.browserReady, false);
	assert.equal(failed.events.filter((event) => /Browser control could not start/.test(event.text || "")).length, 1);
	assert.equal(JSON.stringify(failed.events).includes("private startup detail"), false);

	const hooks = makeHost();
	const live = hooks.running({ uiSessionId: "chat", agentSessionId: "browser-session", mode: "Plan" });
	live.browser = true;
	live.browserReady = true;
	for (const toolName of ["browser_pane__click", "use_tool"]) {
		const id = `browser-hook-${toolName}`;
		hooks.host.onHook(live, { id, params: { toolUseId: id, toolName, toolInput: { tool_name: "browser_pane__click", tool_input: { ref: "e1" } } } });
		assert.equal(hooks.writes.at(-1).result.decision, "allow", "the browser module owns action-time approval even in Plan mode");
		assert.equal(hooks.host.gates.has(id), false);
	}
	for (const [id, toolInput] of [["browser-file", { tool_name: "browser_pane__click", file: "calls.json" }], ["other-tool", { tool_name: "other__click" }]]) {
		hooks.host.onHook(live, { id, params: { toolUseId: id, toolName: "use_tool", toolInput } });
		assert.equal(hooks.host.gates.has(id), true, "file-backed and other MCP calls keep their normal cards");
		hooks.host.decide({ uiSessionId: "chat", toolId: id, decision: "deny" });
	}
	live.browserReady = false;
	hooks.host.onHook(live, { id: "browser-unavailable", params: { toolUseId: "browser-unavailable", toolName: "browser_pane__click", toolInput: {} } });
	assert.equal(hooks.host.gates.has("browser-unavailable"), true);
	hooks.host.decide({ uiSessionId: "chat", toolId: "browser-unavailable", decision: "deny" });

	for (const decision of ["allow", "always", "deny"]) {
		const pending = hooks.host.ask("chat", { title: "Browser site access", summary: "https://example.test", always: true });
		const gate = [...hooks.host.gates.values()].find((item) => item.resolve);
		assert.equal(gate.always, "site");
		assert.equal(hooks.host.decide({ uiSessionId: "other", toolId: gate.toolId, decision }).ok, false);
		assert.equal(hooks.host.decide({ uiSessionId: "chat", toolId: gate.toolId, decision }).ok, true);
		assert.equal(await pending, decision);
	}
	assert.equal(hooks.host.always.size, 0, "browser grants never become normal tool or folder grants");
	const sensitive = hooks.host.ask("chat", { title: "Sensitive browser field", summary: "12 characters, hidden" });
	const sensitiveGate = [...hooks.host.gates.values()].find((item) => item.resolve);
	assert.equal(sensitiveGate.always, "");
	assert.equal(hooks.host.decide({ uiSessionId: "chat", toolId: sensitiveGate.toolId, decision: "always" }).ok, false);
	assert.equal(hooks.host.decide({ uiSessionId: "chat", toolId: sensitiveGate.toolId, decision: "prefix" }).ok, false);
	hooks.host.denyBrowser("chat");
	assert.equal(await sensitive, "deny");
	const timeout = hooks.host.ask("chat", { title: "Browser timeout" });
	const timedGate = [...hooks.host.gates.values()].find((item) => item.resolve);
	assert.equal(hooks.timers.get(timedGate.timer).ms, 8 * 60 * 1000);
	hooks.timers.get(timedGate.timer).callback();
	assert.equal(await timeout, "deny");
	const cancelled = hooks.host.ask("chat", { title: "Browser cancelled" });
	hooks.host.cancel("chat");
	assert.equal(await cancelled, "deny");
	assert.equal(await hooks.host.ask("chat", { title: "No live turn" }), "deny");
	hooks.host.kill();
	console.log("PASS browser ACP integration: flag/restart, side-chat exclusion, new/load MCP entries, loopback proxy, hook routing and approval outcomes");
}

function checkCommandPrefixes() {
	const { host, writes, events, running, commandInfo } = makeHost();
	for (const [command, prefix] of [
		["npm test", "npm test"], ["npm test -- --watch", "npm test"], ["npm test && npm test", "npm test"],
		["git status; git status", "git status"], ["cargo build --release", "cargo build"], ["make test", "make test"], ["tsc --noEmit", "tsc"],
		["npm test || npm test -- --watch", "npm test"], ["GIT.EXE status --short", "git status"],
		["npm run build", "npm run"], ["gh pr view 3", "gh pr"],
	]) { assert.equal(commandInfo(command).prefix, prefix, command); }
	for (const command of [
		"git -c core.pager=x log", "./npm test", "C:\\tools\\npm test", 'node -e "x"', "npx foo", "NODE.EXE x",
		"npm test | tee log", "npm test > out", "npm test && git push", 'echo "a && b"', "$(rm -rf /)", "`x`", "npm test\nmake", "npm test\rmake",
		"npm test & make", "npm test < input", "make (x)", "echo 'x'", "npm test &&", ";npm test", "npm test;;npm test", "npm test &&& npm test", "npm test |||| npm test", "", "   ", "git", "npm --version",
		"make", "make -j4", "git status @{value=Write-Output x}", "git status {x}", "git status [x]", "npm test #x",
		"saps notepad", "icm x", "ii x", "python3.12.exe --version", "curl x", "npm install @types/x",
		"npm exe x", "npm t", "npm i", "gh ext list", "gh extensions list", "gh repo delete x", "docker container ls", "docker ps", "kubectl get pods",
		"make test:all", "make test.all", "make _test", "make 1test", "make Test", "make test/other", "make test=other",
		"git rebase -i HEAD~2", "git log --oneline", "yarn run test",
	]) { assert.equal(commandInfo(command).prefix, "", command); }
	for (const character of ["@", "{", "}", "[", "]", "(", ")", "$", "%", "#", "!", "?", "'", '"', "`", "&", "|", "<", ">", "\t", "\n", "\r", "\r\n", "\u0000", "\u000b", "\u000c", "\u0085", "\u00a0", "\u2028", "\u2029"]) {
		for (const command of [`${character}git status`, `git${character}status`, `git status${character}`]) {
			assert.equal(commandInfo(command).prefix, "", JSON.stringify(command));
			assert.equal(commandInfo(command).readsOnly, false, "invalid characters suppress display hints as well as grants");
		}
	}
	for (const program of "node deno bun python python3 py ruby perl php java powershell pwsh cmd bash sh zsh fish wsl env sudo runas xargs eval iex invoke-expression start-process start npx pnpx bunx uvx osascript open rundll32 regsvr32 mshta wscript cscript".split(" ")) {
		for (const variant of [program, program.toUpperCase(), `${program}.exe`, `${program.toUpperCase()}.EXE`]) {
			assert.equal(commandInfo(`${variant} argument`).prefix, "", variant);
		}
	}
	for (const [program, commands] of Object.entries({
		git: "status diff show branch fetch pull add commit push checkout switch restore stash merge rm mv",
		npm: "test run install ci ls outdated", pnpm: "test run install ls outdated", yarn: "test install",
		cargo: "build test check run clippy fmt", go: "build test vet run fmt", dotnet: "build test run restore", gh: "pr issue run status",
	})) {
		for (const subcommand of commands.split(" ")) {
			assert.equal(commandInfo(`${program} ${subcommand} argument`).prefix, `${program} ${subcommand}`);
			assert.equal(commandInfo(`${program.toUpperCase()}.EXE ${subcommand} argument`).prefix, `${program} ${subcommand}`);
			assert.equal(commandInfo(`${program} ${subcommand.toUpperCase()} argument`).prefix, "", "subcommands require exact names");
		}
		for (const command of [program, `${program} -option argument`, `${program} unknown argument`]) {
			assert.equal(commandInfo(command).prefix, "", "managed programs never receive a broader program-only or unknown-subcommand grant");
		}
	}
	for (const target of ["test", "build-all", "build_all", "a1"]) {
		assert.equal(commandInfo(`make ${target} -j4`).prefix, `make ${target}`);
		assert.equal(commandInfo(`MAKE.EXE ${target}`).prefix, `make ${target}`);
	}
	for (const program of "ls dir pwd cat type head tail wc rg grep findstr tree tsc eslint jest vitest pytest ruff".split(" ")) {
		assert.equal(commandInfo(`${program.toUpperCase()}.EXE argument`).prefix, program, "program-only grants use canonical names");
	}
	for (const prefix of "npm exec|npm x|pnpm exec|pnpm dlx|yarn dlx|yarn exec|git config|docker run|docker exec|kubectl exec|gh api|gh extension".split("|")) {
		assert.equal(commandInfo(`${prefix} argument`).prefix, "", prefix);
		const [program, subcommand] = prefix.split(" ");
		assert.equal(commandInfo(`${program.toUpperCase()}.EXE ${subcommand} argument`).prefix, "", "canonical spelling cannot bypass a forbidden subcommand");
	}
	for (const command of ["git status && git diff", "git log; git show", "git branch --delete topic", "ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "rg", "grep", "findstr", "Get-ChildItem", "Get-Content", "Get-Location", "Select-String", "get-content.exe file"]) {
		assert.equal(commandInfo(command).readsOnly, true, command);
	}
	assert.equal(commandInfo("git log --oneline").readsOnly, true, "git log keeps its display hint without receiving a prefix grant");
	for (const program of ["Get-ChildItem", "Get-Content", "Get-Location", "Select-String"]) {
		const info = commandInfo(`${program} x`);
		assert.equal(info.prefix, "", "display-only PowerShell cmdlets never receive a grant");
		assert.deepEqual(plain(info.prefixes), []);
		assert.equal(info.readsOnly, true);
	}
	assert.equal(commandInfo("git status && Get-Content x").readsOnly, true);
	assert.deepEqual(plain(commandInfo("git status && Get-Content x").prefixes), [], "a hint-only segment cannot be hidden inside an otherwise grantable command");
	for (const command of ["git push", "git status && npm test", "git status | cat", "npm test"]) { assert.equal(commandInfo(command).readsOnly, false, command); }

	const proc = running({ uiSessionId: "chat", agentSessionId: "prefix-session" });
	const hook = (id, command, extra = {}) => {
		host.onHook(proc, { id, params: { toolUseId: id, toolName: "run_terminal_command", toolInput: { command }, ...extra } });
		return writes.find((item) => item.id === id);
	};
	const decide = (id, decision, extra = {}) => host.decide({ uiSessionId: "chat", toolId: id, decision, ...extra });
	const card = (id) => events.find((event) => event.tool?.id === id && event.tool.waiting)?.tool;
	assert.equal(hook("prefix-first", "npm test && npm test -- --watch"), undefined);
	assert.equal(card("prefix-first").commandPrefix, "npm test");
	assert.equal(decide("prefix-first", "prefix", { prefix: "rm" }).ok, true);
	assert.equal(writes.at(-1).result.decision, "allow");
	assert.deepEqual([...host.always.values()].map((keys) => [...keys]), [["prefix:npm test"]], "the host derives the grant from its gate, never an injected prefix");
	assert.deepEqual(plain(host.listRules()), [], "conversation prefixes never become folder rules");
	assert.equal(hook("prefix-coverage", "npm test --coverage").result.decision, "allow");
	assert.equal(host.gates.has("prefix-coverage"), false);
	for (const command of ["npm run build", "npm test && rm -rf x", "npm test | make", 'npm test "argument"', "node anything"]) {
		const id = `prefix-nonmatch-${command}`;
		assert.equal(hook(id, command), undefined, command);
		assert.equal(host.gates.has(id), true);
		if (!commandInfo(command).prefix) {
			assert.equal(decide(id, "prefix").ok, false, "an injected prefix decision cannot approve an ineligible command");
			assert.equal(host.gates.has(id), true);
		}
		decide(id, "deny");
	}
	assert.equal(hook("prefix-read-only", "git status"), undefined, "Reads only is a hint and still asks");
	assert.equal(card("prefix-read-only").readsOnly, true);
	assert.equal(decide("prefix-read-only", "prefix").ok, true);
	assert.equal(hook("prefix-canonical", "GIT.EXE status --short").result.decision, "allow", "later commands match canonical program spelling");
	for (const command of ["git status @{value=Write-Output x}", "git status {x}", "git status [x]", "npm test #x", "git status\t", "\tnpm test", "git status && Get-Content x", "npm exec x", "npm exe x", "npm t", "npm i", "git config core.pager x", "docker run x", "gh ext list", "gh extensions list", "gh repo delete x", "docker container ls", "docker ps", "kubectl get pods"]) {
		const id = `prefix-revision2-${command}`;
		assert.equal(hook(id, command), undefined, "rejected syntax and subcommands never match an existing grant");
		assert.equal(card(id).commandPrefix, undefined);
		assert.equal(decide(id, "prefix").ok, false);
		decide(id, "deny");
	}
	assert.equal(hook("prefix-mixed", "npm test --coverage && git status --short").result.decision, "allow", "each segment may match a separately granted prefix");
	assert.equal(hook("prefix-read-mixed", "git status && git diff"), undefined);
	assert.equal(card("prefix-read-mixed").readsOnly, true);
	assert.equal(card("prefix-read-mixed").commandPrefix, undefined, "different prefixes do not offer one wider button");
	decide("prefix-read-mixed", "deny");
	host.turns.get("chat").mode = "Plan";
	assert.equal(hook("prefix-plan", "npm test --coverage").result.decision, "allow", "Plan preserves the existing exact-command grant policy");
	host.turns.get("chat").mode = "Auto-review";
	assert.equal(hook("prefix-auto", "npm test --coverage", { permissionMode: "default" }).result.decision, "allow", "prefix grants use the same guard as exact grants in Auto-review");
	host.turns.get("chat").mode = "Normal";
	host.turns.get("chat").agentSessionId = "new-conversation";
	assert.equal(hook("prefix-new-conversation", "npm test --coverage"), undefined, "a new conversation does not inherit a prefix");
	decide("prefix-new-conversation", "deny");
	host.turns.get("chat").agentSessionId = "prefix-session";
	host.turns.get("chat").cwd = path.join(input.cwd, "scripts");
	assert.equal(hook("prefix-other-folder", "npm test --coverage"), undefined, "prefix grants do not follow a conversation into another folder");
	decide("prefix-other-folder", "deny");
	host.turns.get("chat").cwd = input.cwd;
	host.onHook(proc, { id: "prefix-edit", params: { toolUseId: "prefix-edit", toolName: "write", toolInput: { file_path: path.join(input.cwd, ".git", "config"), command: "npm test" } } });
	assert.equal(decide("prefix-edit", "prefix").ok, false, "command text on an edit never creates a command grant");
	decide("prefix-edit", "deny");
	host.onPermission(proc, { id: "prefix-native", params: { toolCall: { toolCallId: "native-command", title: "run_terminal_command", kind: "command", rawInput: { command: "npm test" } }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] } });
	assert.equal(decide("native-permission:chat:prefix-native", "prefix").ok, false, "native permission cards cannot accept injected prefix grants");
	decide("native-permission:chat:prefix-native", "deny");
	assert.equal(host.toolCard({ toolCallId: "read-hint", kind: "command", status: "completed", rawInput: { command: "git status && git diff" } }).readsOnly, true, "ordinary command updates carry the hint too");
	assert.equal(host.toolCard({ toolCallId: "read-hint", rawInput: { command: "git push" } }).readsOnly, false, "a changed command clears the hint");
	assert.equal(host.gates.size, 0);
	console.log("PASS command prefix grants: strict splitting and allowlists, display hints, real-hook matching, scope and injected-decision checks");
}

async function checkParityFeatures() {
	const { host, writes, events, running } = makeHost();
	const cwd = path.resolve(__dirname, "..");
	const proc = running({ uiSessionId: "chat", turnId: "turn-p", cwd });
	// Returns this hook's own reply, so a call that opens a card returns nothing.
	const hook = (id, toolName, toolInput) => { host.onHook(proc, { id, params: { toolUseId: id, toolName, toolInput } }); return writes.find((item) => item.id === id); };

	assert.equal(hook("cmd-1", "run_terminal_command", { command: "npm test -- --watch=false" }), undefined, "Normal asks first");
	assert.equal(host.decide({ uiSessionId: "chat", toolId: "cmd-1", decision: "always" }).ok, true);
	assert.equal(writes.at(-1).result.decision, "allow");
	assert.equal(hook("cmd-2", "run_terminal_command", { command: "npm test -- --watch=false " }).result.decision, "allow", "Always allow covers the same command");
	const beforeVariant = writes.length;
	hook("cmd-2b", "run_terminal_command", { command: "npm  TEST" });
	assert.equal(writes.length, beforeVariant, "Always allow never covers a command that differs in case, spacing or arguments");
	assert.equal(host.gates.has("cmd-2b"), true);
	host.decide({ uiSessionId: "chat", toolId: "cmd-2b", decision: "deny" });
	for (const command of ["npm test -- --watch=true", "npm test -- --WATCH=false", "npm test  -- --watch=false"]) {
		const id = `variant-${command}`;
		const beforeOne = writes.length;
		hook(id, "run_terminal_command", { command });
		assert.equal(writes.length, beforeOne, `Always allow never covers a command that differs in one way: ${command}`);
		assert.equal(host.gates.has(id), true);
		host.decide({ uiSessionId: "chat", toolId: id, decision: "deny" });
	}
	assert.equal(hook("cmd-3", "run_terminal_command", { command: "npm publish" }), undefined, "another npm command still asks");
	assert.equal(host.gates.has("cmd-3"), true);
	host.decide({ uiSessionId: "chat", toolId: "cmd-3", decision: "deny" });
	const before = writes.length;
	hook("cmd-4", "run_terminal_command", { command: "npm test && curl example.com" });
	assert.equal(writes.length, before, "a chained command is never covered by Always allow");
	host.decide({ uiSessionId: "chat", toolId: "cmd-4", decision: "always" });
	const afterChain = writes.length;
	hook("cmd-5", "run_terminal_command", { command: "npm test && curl example.com" });
	assert.equal(writes.length, afterChain, "Always allow on a chained command allows that call only");
	host.decide({ uiSessionId: "chat", toolId: "cmd-5", decision: "deny" });
	hook("edit-1", "write", { file_path: path.join(cwd, "notes.md") });
	host.decide({ uiSessionId: "chat", toolId: "edit-1", decision: "always" });
	assert.equal(hook("edit-2", "write", { file_path: path.join(cwd, "other.md") }).result.decision, "allow", "Always allow covers later edits in the session folder");
	for (const target of [[".git", "hooks", "post-checkout"], [".grok", "config.toml"], [".mcp.json"], [".GIT", "hooks", "post-checkout"], [".mcp.json."], [".mcp.json:x"], ["GIT~1", "hooks", "post-checkout"], ["GROK~1", "config.toml"], ["MCP~1.JSO"], [".mcp.json "], [".mcp.json.."], ["repo", ".git", "hooks", "post-checkout"], [".cursor", "mcp.json"], [".claude", "settings.json"]]) {
		const id = `meta-${target.join("/")}`;
		const beforeMeta = writes.length;
		hook(id, "write", { file_path: path.join(cwd, ...target) });
		assert.equal(writes.length, beforeMeta, `Always allow never covers a write into repository or Grok metadata: ${target.join("/")}`);
		assert.equal(host.gates.has(id), true);
		host.decide({ uiSessionId: "chat", toolId: id, decision: "deny" });
	}
	// Off Windows the folder check keeps letter case, and macOS still writes ".GIT" into ".git".
	const mac = makeHost({}, { platform: "darwin" });
	const macProc = mac.running({ uiSessionId: "chat", cwd });
	const macWrite = (id, ...parts) => { mac.host.onHook(macProc, { id, params: { toolUseId: id, toolName: "write", toolInput: { file_path: path.join(cwd, ...parts) } } }); return mac.writes.find((item) => item.id === id); };
	macWrite("mac-1", "notes.md");
	assert.equal(mac.host.decide({ uiSessionId: "chat", toolId: "mac-1", decision: "always" }).ok, true);
	assert.equal(macWrite("mac-2", "other.md").result.decision, "allow");
	assert.equal(macWrite("mac-3", ".GIT", "hooks", "post-checkout"), undefined, "Always allow never covers .GIT on a platform that keeps letter case");
	const beforeOutside = writes.length;
	hook("edit-3", "write", { file_path: path.join(os.homedir(), "outside-grokcode.md") });
	assert.equal(writes.length, beforeOutside, "Always allow never covers an edit outside the session's folders");
	host.decide({ uiSessionId: "chat", toolId: "edit-3", decision: "deny" });
	hook("mcp-1", "use_tool", { tool_name: "chrome__read_page", tool_input: { tabId: 1 } });
	host.decide({ uiSessionId: "chat", toolId: "mcp-1", decision: "always" });
	assert.equal(hook("mcp-2", "use_tool", { tool_name: "chrome__read_page", tool_input: { tabId: 2 } }).result.decision, "allow", "Always allow on an MCP call covers that MCP tool");
	const beforeMcp = writes.length;
	hook("mcp-3", "use_tool", { tool_name: "chrome__navigate", tool_input: { url: "https://example.com" } });
	assert.equal(writes.length, beforeMcp, "Always allow on one MCP tool never covers another");
	host.decide({ uiSessionId: "chat", toolId: "mcp-3", decision: "deny" });
	hook("mcp-4", "use_tool", { file: "C:/x/call.json" });
	host.decide({ uiSessionId: "chat", toolId: "mcp-4", decision: "always" });
	const beforeFile = writes.length;
	hook("mcp-5", "use_tool", { file: "C:/x/call.json" });
	assert.equal(writes.length, beforeFile, "an MCP call named inside a file is never remembered");
	host.decide({ uiSessionId: "chat", toolId: "mcp-5", decision: "deny" });
	hook("ps-1", "run_terminal_command", { command: "powershell -Command Get-Date" });
	host.decide({ uiSessionId: "chat", toolId: "ps-1", decision: "always" });
	assert.equal(hook("ps-2", "run_terminal_command", { command: "powershell -Command Get-Date" }).result.decision, "allow", "Always allow covers the same interpreter command");
	const beforePs = writes.length;
	hook("ps-3", "run_terminal_command", { command: "powershell -Command Remove-Item -Recurse -Force C:/x" });
	assert.equal(writes.length, beforePs, "Always allow after an interpreter flag never covers other code");
	host.decide({ uiSessionId: "chat", toolId: "ps-3", decision: "deny" });
	host.turns.get("chat").mode = "Auto-review";
	const nativeOptions = [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }];
	const beforeNative = writes.length;
	host.onPermission(proc, { id: "perm-out", params: { toolCall: { toolCallId: "out-1", title: "write", kind: "edit", rawInput: { file_path: path.join(os.homedir(), "outside-grokcode.md") } }, options: nativeOptions } });
	assert.equal(writes.length, beforeNative, "Auto-review shows Grok's own prompt when the safety check will not allow the call");
	host.decide({ uiSessionId: "chat", toolId: "native-permission:chat:perm-out", decision: "deny" });
	host.onPermission(proc, { id: "perm-in", params: { toolCall: { toolCallId: "in-1", title: "write", kind: "edit", rawInput: { file_path: path.join(cwd, "inside.md") } }, options: nativeOptions } });
	assert.equal(writes.length, beforeNative + 1, "Auto-review asks for an in-folder edit too");
	host.decide({ uiSessionId: "chat", toolId: "native-permission:chat:perm-in", decision: "allow" });
	host.turns.get("chat").mode = "Normal";
	host.turns.get("chat").agentSessionId = "sid-c";
	const procOther = running({ uiSessionId: "other", turnId: "turn-o", cwd, agentSessionId: "sid-o", promptId: 3 });
	const beforeOther = writes.length;
	host.onHook(procOther, { id: "mcp-6", params: { sessionId: "sid-o", toolUseId: "mcp-6", toolName: "use_tool", toolInput: { tool_name: "chrome__read_page", tool_input: { tabId: 3 } } } });
	assert.equal(writes.length, beforeOther, "Always allow on a tool belongs to one conversation");
	host.decide({ uiSessionId: "other", toolId: "mcp-6", decision: "deny" });
	host.onHook(procOther, { id: "cmd-6", params: { sessionId: "sid-o", toolUseId: "cmd-6", toolName: "run_terminal_command", toolInput: { command: "npm test -- --watch=false" } } });
	assert.equal(writes.find((item) => item.id === "cmd-6").result.decision, "allow", "Always allow on an exact command covers every session in its folder");
	assert.deepEqual(plain(host.listRules()), [{ folder: cwd, commands: ["npm test -- --watch=false", "powershell -Command Get-Date"] }], "only exact commands are saved for the folder");
	const cards = events.filter((event) => event.type === "tool" && event.tool.waiting);
	const cardFor = (id) => cards.find((event) => event.tool.id === id).tool;
	assert.deepEqual([cardFor("cmd-1").always, cardFor("mcp-1").always, cardFor("edit-1").always, cardFor("cmd-4").always], ["folder", "conversation", "conversation", undefined], "each card says what Always allow would remember");

	// A saved command belongs to its folder: Choose a folder leaves it behind, and it applies again back in the first folder.
	const moved = makeHost();
	const turnIn = async (turnId, folder, agentSessionId) => {
		const sent = moved.host.prompt({ ...input, turnId, cwd: folder, ...(agentSessionId ? { agentSessionId } : {}) });
		await moved.serve("session/prompt");
		const result = await sent;
		assert.equal(result.ok, true, turnId);
		return result.agentSessionId;
	};
	const ask = (id, sessionId) => {
		moved.host.onHook(moved.host.procs.get("chat"), { id, params: { sessionId, toolUseId: id, toolName: "run_terminal_command", toolInput: { command: "npm test -- --watch=false" } } });
		return moved.writes.find((item) => item.id === id);
	};
	const firstChat = await turnIn("move-a", cwd);
	ask("move-1", firstChat);
	assert.equal(moved.host.decide({ uiSessionId: "chat", toolId: "move-1", decision: "always" }).ok, true);
	await moved.serve();
	assert.equal(await turnIn("move-b", cwd, firstChat), firstChat);
	assert.equal(ask("move-2", firstChat).result.decision, "allow", "a rule covers the next turn of the same conversation");
	await moved.serve();
	assert.equal(ask("move-3", await turnIn("move-c", path.join(cwd, "scripts"))), undefined, "Choose a folder starts with no Always allow rules");
	assert.equal(moved.host.gates.has("move-3"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-3", decision: "deny" });
	await moved.serve();
	const backChat = await turnIn("move-d", cwd);
	assert.notEqual(backChat, firstChat, "the fake Grok gives each new conversation its own id");
	assert.equal(ask("move-4", backChat).result.decision, "allow", "back in the first folder, its saved command applies to the new conversation");
	// A turn that keeps its conversation id in another folder still gets no rule from the first folder.
	await moved.serve();
	assert.equal(await turnIn("move-e", path.join(cwd, "scripts"), firstChat), firstChat);
	assert.equal(ask("move-5", firstChat), undefined, "the same conversation in another folder starts with no Always allow rules");
	assert.equal(moved.host.gates.has("move-5"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-5", decision: "deny" });
	// Choose a folder and back with no message in between: the app tells the host to forget the cached conversation and its tool rules.
	await moved.serve();
	const askTool = (id, sessionId) => {
		moved.host.onHook(moved.host.procs.get("chat"), { id, params: { sessionId, toolUseId: id, toolName: "use_tool", toolInput: { tool_name: "chrome__read_page", tool_input: {} } } });
		return moved.writes.find((item) => item.id === id);
	};
	assert.equal(await turnIn("move-g", cwd, backChat), backChat);
	askTool("move-6", backChat);
	assert.equal(moved.host.decide({ uiSessionId: "chat", toolId: "move-6", decision: "always" }).ok, true);
	await moved.serve();
	moved.host.forgetSession("chat");
	const freshChat = await turnIn("move-f", cwd);
	assert.notEqual(freshChat, backChat, "after forgetSession the same folder starts a new conversation");
	assert.equal(askTool("move-7", freshChat), undefined, "after forgetSession the old conversation's tool rules do not apply");
	assert.equal(moved.host.gates.has("move-7"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-7", decision: "deny" });
	assert.equal(ask("move-8", freshChat).result.decision, "allow", "the folder's saved command still applies");

	host.onUpdate(proc, { sessionId: "sid-c", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review changes", input: { hint: "branch" } }, { name: "bad name" }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "commands", commands: [{ name: "review", description: "Review changes", hint: "branch" }] });
	host.onMessage(proc, { method: "_x.ai/models/update", params: { availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7", description: "Best", _meta: { totalContextTokens: 500000, reasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "turbo" }] } }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "models", models: [{ id: "grok-4.7", name: "Grok 4.7", description: "Best", efforts: ["low", "high"], contextWindow: 500000 }] });
	host.onMessage(proc, { method: "_x.ai/mcp/servers_updated", params: { mcpServers: [{ name: "github", source: "user" }, { source: "nameless" }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "mcp", servers: [{ name: "github", source: "user", status: "" }] });
	host.onMessage(proc, { method: "_x.ai/mcp/server_status", params: { name: "github", status: "connected" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mcp-status", name: "github", status: "connected" });

	host.onUpdate(proc, { sessionId: "sid-c", update: { sessionUpdate: "tool_call", toolCallId: "todo-1", title: "todo_write", rawInput: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }, { content: " ", status: "pending" }] } } });
	assert.deepEqual(plain(events.at(-1).tool.todos), [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }]);
	host.onMessage(proc, { id: 90, method: "_x.ai/ask_user_question", params: { sessionId: "sid-c", toolCallId: "q-h", questions: [{ header: "Color", question: "Which?", options: [{ label: "Red" }] }] } });
	assert.equal(events.at(-1).tool.questions[0].header, "Color");

	const turn = host.turns.get("chat");
	host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "response_completed", usage: { input_tokens: 659, output_tokens: 102, cache_read_input_tokens: 25216, cache_creation_input_tokens: 0 } } } });
	assert.deepEqual(plain(events.at(-1)), { type: "context", contextTokens: 25977, contextWindow: 256000, uiSessionId: "chat", turnId: "turn-p" }, "each model call reports the context in use");
	proc.parents.set("sid-sub", "sid-c");
	const beforeSub = events.length;
	host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId: "sid-sub", update: { sessionUpdate: "response_completed", usage: { input_tokens: 999999 } } } });
	assert.equal(events.length, beforeSub, "a subagent's model calls do not change the session's context");
	host.finishPrompt(turn, 2, { stopReason: "end_turn", _meta: { modelId: "grok-4.7", usage: { inputTokens: 40000, outputTokens: 1000, cachedReadTokens: 30000, reasoningTokens: 200, modelCalls: 4, costUsdTicks: 2500000000 } } });
	const usage = events.find((event) => event.type === "usage");
	assert.deepEqual(plain(usage.usage), { model: "grok-4.7", inputTokens: 40000, outputTokens: 1000, cachedReadTokens: 30000, reasoningTokens: 200, modelCalls: 4, contextTokens: 25977, contextWindow: 500000, costUsd: 0.25 }, "the turn's usage keeps the last model call's context size");
	assert.equal(usage.turnId, "turn-p");
	assert.equal(events.at(-1).type, "done");

	const slashTurn = { uiSessionId: "chat", turnId: "turn-s", cwd, allowedFolders: [], mode: "Normal", agentSessionId: "sid-c", promptId: 4, finished: false, cancelled: false, slash: true, said: false, proc };
	host.turns.set("chat", slashTurn);
	host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "memory_files", files: [{ path: "C:\\Users\\me\\.grok\\MEMORY.md", source: "global" }, { path: "C:\\Users\\me\\.grok\\w\\observations/_inbox\\a.md", source: "workspace" }] } } });
	assert.equal(events.at(-1).text, "Memory files:\n- `C:\\Users\\me\\.grok\\MEMORY.md` (global)\n\n1 raw observation note not shown.", "/memory lists Grok's memory files");
	host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "auto_compact_completed", tokens_before: 26433, tokens_after: 9000 } } });
	assert.equal(events.at(-2).text, "Compacted the conversation: 26433 to 9000 tokens.", "/compact reports its result");
	assert.equal(events.at(-1).contextTokens, 9000, "compaction updates the context in use");
	host.finishPrompt(slashTurn, 4, { stopReason: "end_turn" });
	assert.equal(events.filter((event) => event.turnId === "turn-s" && event.type === "chunk").length, 2, "a command that said something gets no fallback line");
	const quietTurn = { uiSessionId: "chat", turnId: "turn-q", cwd, allowedFolders: [], mode: "Normal", agentSessionId: "sid-c", promptId: 5, finished: false, cancelled: false, slash: true, said: false, proc };
	host.turns.set("chat", quietTurn);
	host.finishPrompt(quietTurn, 5, { stopReason: "end_turn" });
	assert.equal(events.find((event) => event.turnId === "turn-q" && event.type === "chunk").text, "Grok ran the command. It sent no output.", "a silent command still answers");
	const plainTurn = { uiSessionId: "chat", turnId: "turn-n", cwd, allowedFolders: [], mode: "Normal", agentSessionId: "sid-c", promptId: 6, finished: false, cancelled: false, slash: false, said: false, proc };
	host.turns.set("chat", plainTurn);
	host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "auto_compact_completed", tokens_before: 1, tokens_after: 1 } } });
	host.finishPrompt(plainTurn, 6, { stopReason: "end_turn" });
	assert.equal(events.some((event) => event.turnId === "turn-n" && event.type === "chunk"), false, "automatic compaction during a normal turn adds no text");
	for (const stopReason of ["max_tokens", "max_turn_requests", "end_turn", "other_reason"]) {
		const limited = { ...plainTurn, turnId: stopReason, finished: false };
		host.turns.set("chat", limited);
		const before = events.length;
		host.finishPrompt(limited, 6, { stopReason });
		const added = events.slice(before);
		const expected = ["max_tokens", "max_turn_requests"].includes(stopReason) ? [`\n\nGrok stopped early (${stopReason.replace(/_/g, " ")}).`] : [];
		assert.deepEqual(added.filter((event) => event.type === "chunk").map((event) => event.text), expected);
		assert.equal(added.at(-1).type, "done", "the early-stop notice precedes completion");
	}
	const cancelled = { ...plainTurn, turnId: "turn-cancelled", finished: false, cancelled: true };
	host.turns.set("chat", cancelled);
	const beforeCancelled = events.length;
	const cancelledResult = { stopReason: "end_turn", _meta: { modelId: "grok-4.7", usage: { inputTokens: 500, outputTokens: 20, costUsdTicks: 1000000000 } } };
	host.finishPrompt(cancelled, 6, cancelledResult);
	host.finishPrompt(cancelled, 6, cancelledResult);
	assert.deepEqual(events.slice(beforeCancelled).map((event) => event.type), ["usage", "done"], "a cancelled turn emits its usage once before completion");
	assert.equal(events.at(-2).usage.inputTokens, 500);
	assert.equal(events.at(-2).usage.costUsd, 0.1);
	assert.equal(events.at(-1).stopReason, "cancelled");

	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "grokcode-attach-"));
	const image = path.join(folder, "shot.png");
	const note = path.join(folder, "note.md");
	fs.writeFileSync(image, Buffer.from([137, 80, 78, 71]));
	fs.writeFileSync(note, "hello");
	try {
		assert.equal(host.inputProblem({ ...input, turnId: "t", attachments: [image, note] }), "");
		assert.match(host.inputProblem({ ...input, turnId: "t", attachments: ["relative.png"] }), /absolute/);
		assert.match(host.inputProblem({ ...input, turnId: "t", attachments: [path.join(folder, "missing.png")] }), /not on this computer/);
		assert.match(host.inputProblem({ ...input, turnId: "t", attachments: [folder] }), /not a file/);
		assert.match(host.inputProblem({ ...input, turnId: "t", attachments: Array(21).fill(image) }), /at most 20/);
		const sent = makeHost();
		sent.host.procFor = () => ({ ready: Promise.resolve(), pending: new Map(), promptTurns: new Map() });
		sent.host.ensureSession = async () => ({ sessionId: "agent-chat" });
		sent.host.applyConfig = async () => {};
		sent.host.applyMode = async () => {};
		const prompts = [];
		sent.host.request = (_proc, method, params) => { prompts.push({ method, params }); return { id: 1, promise: method === "_x.ai/rewind/points" ? Promise.resolve({ rewind_points: [] }) : new Promise(() => {}) }; };
		void sent.host.prompt({ ...input, turnId: "t", attachments: [image, note] });
		for (let i = 0; i < 5 && !prompts.some((item) => item.method === "session/prompt"); i++) { await new Promise((resolve) => setImmediate(resolve)); }
		const blocks = prompts.find((item) => item.method === "session/prompt").params.prompt;
		assert.equal(blocks[0].type, "text");
		assert.ok(blocks[0].text.endsWith(`Attached files:\n${image}\n${note}`));
		assert.deepEqual(plain(blocks[1]), { type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") });
		assert.equal(blocks[2].type, "resource_link");
		assert.equal(blocks[2].name, "note.md");
		assert.ok(blocks[2].uri.startsWith("file:///"));
		void sent.host.prompt({ ...input, uiSessionId: "ctx", turnId: "t2", text: "/context" });
		for (let i = 0; i < 5 && prompts.filter((item) => item.method === "session/prompt").length < 2; i++) { await new Promise((resolve) => setImmediate(resolve)); }
		assert.equal(prompts.filter((item) => item.method === "session/prompt")[1].params.prompt[0].text, "/session-info", "/context asks Grok for the session's context numbers");
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
}

async function checkPermissionMeta() {
	const { host } = makeHost();
	const proc = { uiSessionId: "n", lost: false };
	const requests = [];
	host.request = (_proc, method, params) => {
		requests.push({ method, params });
		return { promise: Promise.resolve({ sessionId: `sid-${requests.length}` }) };
	};
	await host.ensureSession(proc, { ...input, uiSessionId: "n", mode: "Normal" });
	assert.equal(requests[0].method, "session/new");
	assert.equal(requests[0].params._meta.yoloMode, undefined);
	assert.equal(requests[0].params._meta.autoMode, undefined);
	await host.ensureSession(proc, { ...input, uiSessionId: "a", mode: "Auto-review" });
	assert.equal(requests[1].params._meta.autoMode, true);
	assert.equal(requests[1].params._meta.yoloMode, undefined);
	await host.ensureSession(proc, { ...input, uiSessionId: "y", mode: "Always-approve" });
	assert.equal(requests[2].params._meta.yoloMode, true);
	assert.equal(requests[2].params._meta.autoMode, undefined);
	const before = requests.length;
	await host.ensureSession(proc, { ...input, uiSessionId: "y", mode: "Always-approve" });
	assert.equal(requests.length, before, "a session already open in this Grok is not opened again");
}

// With no Grok running, a one-shot Grok reads the limit: initialize, authenticate with the saved token, billing, then it is killed.
async function checkBillingOnce() {
	const resetsAt = "2026-11-11T22:56:56.873+00:00";
	const answer = (child, id, body) => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`));
	const saved = { result: { authMethods: [{ id: "cached_token" }] } };
	const run = makeHost();
	run.host.procs.set("lost", { lost: true });
	const pending = run.host.billing();
	const child = run.children[0];
	assert.deepEqual(plain(run.spawns[0][1]), ["--permission-mode", "default", "agent", "--no-leader", "stdio"], "a lost process cannot serve billing, so a one-shot Grok starts");
	assert.equal(run.spawns[0][2].cwd, os.homedir());
	answer(child, 1, saved);
	answer(child, 2, { result: { _meta: { email: "someone@example.com" } } });
	answer(child, 3, { result: { config: { creditUsagePercent: 28, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: resetsAt } }, subscription_tier: "SuperGrok" } });
	const shown = { ok: true, percent: 28, period: "weekly", resetsAt, tier: "SuperGrok" };
	assert.deepEqual(plain(await pending), shown);
	assert.deepEqual(run.writes.map((message) => message.method), ["initialize", "authenticate", "_x.ai/billing"]);
	assert.deepEqual(plain(run.writes[1].params), { methodId: "cached_token" });
	assert.deepEqual(taskkills(run.spawns), [String(child.pid)], "the one-shot Grok is always killed");
	assert.equal(run.timers.size, 0);
	assert.deepEqual(plain(await run.host.billing()), shown, "a second read within a minute reuses the answer");
	assert.equal(run.children.length, 1, "and starts no second Grok");
	run.host.limitProbe.at -= 61000;
	const later = run.host.billing();
	assert.equal(run.children.length, 2, "after a minute a new one-shot Grok starts");
	answer(run.children[1], 1, { error: { message: "private failure" } });
	assert.deepEqual(plain(await later), { ok: false, error: "Grok did not return usage." });
	const failed = { ok: false, error: "Grok did not return usage." };
	for (const [name, act] of [
		["signed out", (item) => answer(item, 1, { result: { authMethods: [{ id: "grok.com" }] } })],
		["authenticate error", (item) => { answer(item, 1, saved); answer(item, 2, { error: { message: "expired" } }); }],
		["exit", (item) => item.emit("exit", 1)],
		["spawn error", (item) => item.emit("error", Object.assign(new Error("secret"), { code: "ENOENT" }))],
	]) {
		const each = makeHost({}, { env: { XAI_API_KEY: "key" } });
		const result = each.host.billing();
		act(each.children[0]);
		assert.deepEqual(plain(await result), failed, name);
		if (name === "signed out") { assert.deepEqual(each.writes.map((message) => message.method), ["initialize"], "without a saved sign-in, authenticate is not tried"); }
		assert.deepEqual(taskkills(each.spawns), [String(each.children[0].pid)], `${name}: the one-shot Grok is killed`);
	}
	const slow = makeHost();
	const timedOut = slow.host.billing();
	assert.equal([...slow.timers.values()][0].ms, 15000);
	[...slow.timers.values()][0].callback();
	assert.deepEqual(plain(await timedOut), failed, "a one-shot Grok that never answers times out");
}

async function checkBilling() {
	const { host, writes, running } = makeHost();
	const proc = running({ uiSessionId: "chat", agentSessionId: "sid-1" });
	proc.ready = Promise.resolve();
	async function reply(result, error) {
		const pending = host.billing();
		await ticks();
		const request = writes.at(-1);
		assert.equal(request.method, "_x.ai/billing");
		assert.deepEqual(plain(request.params), {});
		host.onMessage(proc, { id: request.id, ...(error ? { error } : { result }) });
		return plain(await pending);
	}
	const resetsAt = "2026-11-04T22:56:56.873+00:00";
	assert.deepEqual(await reply({ config: { creditUsagePercent: 90, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: resetsAt }, prepaidBalance: { val: 5 } }, subscription_tier: "SuperGrok", private: "hidden" }), { ok: true, percent: 90, period: "weekly", resetsAt, tier: "SuperGrok" }, "only normalized display fields cross the bridge");
	assert.deepEqual(await reply({}), { ok: true, percent: null, period: "", resetsAt: "", tier: "" }, "a missing config gives no invented usage");
	assert.deepEqual(await reply({ config: { creditUsagePercent: Infinity, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" } }, subscription_tier: "x".repeat(70) }), { ok: true, percent: null, period: "monthly", resetsAt: "", tier: "x".repeat(60) });
	assert.deepEqual(await reply({ config: { creditUsagePercent: "90", currentPeriod: { type: "unknown", end: 1 } }, subscription_tier: 5 }), { ok: true, percent: null, period: "", resetsAt: "", tier: "" });
	assert.deepEqual(await reply(null, { message: "private failure" }), { ok: false, error: "Grok did not return usage." });
}

async function checkAccount() {
	const { host, writes, events, spawns } = makeHost();
	void host.prompt(input).catch(() => {});
	const proc = host.procs.get("chat");
	host.onMessage(proc, { id: writes[0].id, result: { _meta: { agentVersion: "1.0.70", hostname: "box", currentWorkingDirectory: "C:/private" } } });
	await ticks();
	assert.equal(writes[1].method, "authenticate");
	host.onMessage(proc, { id: writes[1].id, result: { _meta: { email: "someone@example.com", subscription_tier: "SuperGrok", team_name: null, team_id: "team-secret", auth_mode: "Oidc" } } });
	await ticks();
	const shown = { email: "someone@example.com", plan: "SuperGrok", team: "", version: "1.0.70" };
	assert.deepEqual(plain(host.account), shown);
	assert.deepEqual(plain(events.find((event) => event.type === "account").account), shown, "the menu gets only the email, plan, team and version");
	host.signedOut();
	assert.equal(host.account, null);
	assert.deepEqual(plain(events.filter((event) => event.type === "account").pop()), { type: "account", account: null });
	assert.equal(host.procs.size, 0, "after signing out the next message starts a new Grok, which asks to sign in");
	assert.equal(spawns.some((item) => item[0] === "taskkill"), true);
}

async function checkBackgroundToolCompletion() {
	const made = makeHost();
	const { host, events } = made;
	const tasks = [
		{ taskId: "a72d7aff-77e8-4df9-8a2b-835d6042dc73", toolId: "call-fd585c80-1d23-4de1-9af6-1ce6ed750b4e-2", promptId: "eadf337a-ac02-40a5-b363-613f9303479a" },
		{ taskId: "60d680f7-9646-4e94-99ee-a1c9969dc63d", toolId: "call-1a987f3e-4367-4aa3-8cc1-7d17af2a3f44-3", promptId: "d5995042-1465-4e44-ba08-762d3bc9cbd0" },
	];
	for (const [index, task] of tasks.entries()) {
		const turnId = `background-owner-${index}`;
		const text = `Start background task ${index}`;
		const sent = host.prompt({ ...input, turnId, text });
		await made.serve("session/prompt");
		const { agentSessionId } = await sent;
		assert.ok(agentSessionId);
		const proc = host.procs.get("chat");
		const rpcId = host.turns.get("chat").promptId;
		const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
		const notify = (update) => line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update } });
		const stream = (update) => line({ method: "session/update", params: { sessionId: agentSessionId, update, _meta: { promptId: task.promptId } } });
		const command = "ping -n 6 127.0.0.1";
		const outputFile = path.join(input.cwd, "terminal", `${task.toolId}.log`);
		line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: task.promptId, runningText: text, runningKind: "prompt" } });
		stream({ sessionUpdate: "tool_call", toolCallId: task.toolId, title: "run_terminal_command", rawInput: { command, description: "Ping localhost six times in background", block_until_ms: 0 } });
		notify({ sessionUpdate: "task_backgrounded", tool_call_id: task.toolId, task_id: task.taskId, command, cwd: input.cwd, output_file: outputFile, description: "Ping localhost six times in background", background_reason: "requested" });
		const snapshot = { task_id: task.taskId, command, description: "Ping localhost six times in background", cwd: input.cwd, kind: "bash", status: "running", started_at: "2026-11-10T02:49:46.307490300+00:00", output_file: outputFile };
		notify({ sessionUpdate: "background_tasks", tasks: [snapshot] });
		stream({ sessionUpdate: "tool_call_update", toolCallId: task.toolId, kind: "execute", title: `Execute ${command}`, content: [{ type: "content", content: { type: "text", text: "Ping localhost six times in background" } }], rawInput: { variant: "Bash", command, is_background: false, block_until_ms: 0 } });
		stream({ sessionUpdate: "tool_call_update", toolCallId: task.toolId, status: "completed", title: `[bg] ${command}`, content: [{ type: "content", content: { type: "text", text: `Background task ${task.taskId} started` } }], rawOutput: { type: "BackgroundTaskStarted", task_id: task.taskId, task_type: "bash", output_file: outputFile, status: "running", command, summary: `Background task ${task.taskId} started`, pid: 1234 + index } });
		assert.ok(events.some((event) => event.type === "tool" && event.turnId === turnId && event.tool.id === task.toolId), "the ordinary tool stream created the original row before the command finished");
		line({ id: rpcId, result: { stopReason: "end_turn", _meta: { sessionId: agentSessionId, promptId: task.promptId } } });
		assert.equal(host.turns.has("chat"), false, "the parent app turn ends before the background task completes");
		let newerRpcId;
		if (index === 1) {
			const newer = host.prompt({ ...input, turnId: "newer-background-turn", text: "A newer foreground prompt" });
			await made.serve("session/prompt");
			assert.equal((await newer).ok, true);
			newerRpcId = host.turns.get("chat").promptId;
		}
		const before = events.length;
		const reportText = "Background command report must remain suppressed";
		if (index === 0) {
			notify({ sessionUpdate: "task_completed", task_snapshot: { task_id: task.taskId, command, cwd: input.cwd, start_time: { secs_since_epoch: 1794278986, nanos_since_epoch: 307490300 }, end_time: { secs_since_epoch: 1794278991, nanos_since_epoch: 637032000 }, output: reportText, output_file: outputFile, truncated: false, output_total_bytes: reportText.length, exit_code: 0, signal: null, completed: true, kind: "bash", owner_session_id: agentSessionId, is_backgrounded: true }, will_wake: true });
		} else {
			notify({ sessionUpdate: "background_tasks", tasks: [{ ...snapshot, status: "completed", ended_at: "2026-11-10T02:49:51.637032+00:00", exit_code: 0 }] });
		}
		const completed = events.slice(before).filter((event) => event.type === "tool");
		assert.deepEqual(completed.map((event) => [event.uiSessionId, event.turnId, event.tool.id, event.tool.detail, event.tool.waiting, event.tool.backgroundTask]), [
			["chat", turnId, task.toolId, "Ran", false, true],
		], index === 0 ? "task_completed finishes the original tool row after its app turn ended" : "a terminal background_tasks snapshot finishes the original row even when its completion notice is missing and a newer turn is active");
		assert.equal(JSON.stringify(events.slice(before)).includes(reportText), false, "the task's command report is not reprinted into the conversation");
		if (index === 1) {
			assert.equal(host.turns.get("chat").turnId, "newer-background-turn", "the old command's status cannot finish or replace the newer foreground turn");
			line({ id: newerRpcId, result: { stopReason: "end_turn" } });
		}
	}
}

async function startBackgroundFixtureTurn(made, turnId) {
	const text = `Prompt for ${turnId}`;
	const sent = made.host.prompt({ ...input, turnId, text });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId);
	const proc = made.host.procs.get("chat");
	const rpcId = made.host.turns.get("chat").promptId;
	const promptId = `${turnId}-provider-prompt`;
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: promptId, runningText: text, runningKind: "prompt" } });
	return { agentSessionId, proc, rpcId, promptId, line };
}

function linkBackgroundFixtureTask(line, sessionId, promptId, taskId, toolId) {
	const command = "echo background work";
	line({ method: "session/update", params: { sessionId, _meta: { promptId }, update: { sessionUpdate: "tool_call", toolCallId: toolId, title: "run_terminal_command", rawInput: { command, block_until_ms: 0 } } } });
	line({ method: "_x.ai/session_notification", params: { sessionId, update: { sessionUpdate: "task_backgrounded", tool_call_id: toolId, task_id: taskId, command } } });
	line({ method: "session/update", params: { sessionId, _meta: { promptId }, update: { sessionUpdate: "tool_call_update", toolCallId: toolId, status: "completed", rawOutput: { type: "BackgroundTaskStarted", task_id: taskId, status: "running" } } } });
}

async function checkBackgroundReportAfterStop(stopSource) {
	const made = makeHost();
	const { host, events } = made;
	const source = await startBackgroundFixtureTurn(made, "background-source");
	const { line, agentSessionId, proc, promptId } = source;
	linkBackgroundFixtureTask(line, agentSessionId, promptId, "surviving-command", "original-command");
	if (stopSource) { host.cancel("chat"); }
	line({ id: source.rpcId, result: { stopReason: stopSource ? "cancelled" : "end_turn" } });
	if (!stopSource) {
		const unrelated = await startBackgroundFixtureTurn(made, "unrelated-source");
		host.cancel("chat");
		line({ id: unrelated.rpcId, result: { stopReason: "cancelled" } });
	}
	assert.equal(proc.lost, false, "stopping an app prompt leaves its surviving background command's process available");
	const before = events.length;
	const reportPromptId = "task-completed-surviving-command";
	const reportId = `task-report-${reportPromptId}`;
	const notify = (update) => line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update } });
	const stream = (update) => line({ method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId: reportPromptId }, update } });
	notify({ sessionUpdate: "task_completed", task_snapshot: { task_id: "surviving-command", completed: true, exit_code: 1, owner_session_id: agentSessionId }, will_wake: true });
	notify({ sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: reportPromptId, runs: [] });
	assert.deepEqual(events.slice(before).filter((event) => event.type === "turn-start").map((event) => [event.turnId, event.background, event.parallel]), [[reportId, true, true]], "the report has an identity before its first tool or text event");
	stream({ sessionUpdate: "tool_call", toolCallId: "read-report-output", title: "get_command_or_subagent_output", rawInput: {} });
	stream({ sessionUpdate: "tool_call_update", toolCallId: "read-report-output", status: "completed" });
	stream({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The background command failed." } });
	notify({ sessionUpdate: "turn_completed", prompt_id: reportPromptId, stop_reason: "end_turn" });
	assert.deepEqual(events.slice(before).filter((event) => ["tool", "chunk", "done"].includes(event.type)).map((event) => [event.type, event.turnId, event.tool?.id || event.text || event.stopReason]), [
		["tool", "background-source", "original-command"],
		["tool", reportId, "read-report-output"],
		["tool", reportId, "read-report-output"],
		["chunk", reportId, "The background command failed."],
		["done", reportId, "end_turn"],
	], `${stopSource ? "source" : "unrelated"} Stop leaves the command report and its own tool rows visible`);
	assert.equal(host.turns.has("chat"), false, "the report does not become a new active app prompt");
}

async function checkBackgroundToolProcessLoss() {
	const made = makeHost();
	const { events } = made;
	const { line, agentSessionId, proc, rpcId, promptId } = await startBackgroundFixtureTurn(made, "lost-background-owner");
	linkBackgroundFixtureTask(line, agentSessionId, promptId, "lost-task", "lost-tool");
	const linked = events.filter((event) => event.tool?.id === "lost-tool").at(-1);
	assert.equal(linked.tool.detail, "Running");
	line({ id: rpcId, result: { stopReason: "end_turn" } });
	const before = events.length;
	proc.child.emit("exit");
	assert.deepEqual(events.slice(before).filter((event) => event.type === "tool").map((event) => [event.uiSessionId, event.turnId, event.tool.id, event.tool.detail, event.tool.waiting, event.tool.backgroundTask]), [
		["chat", "lost-background-owner", "lost-tool", "Stopped", false, true],
	], "losing Grok settles the original linked Running tool row as Stopped");
}

async function checkChildBackgroundTaskStatus() {
	const made = makeHost();
	const { events } = made;
	const { line, agentSessionId, proc, rpcId } = await startBackgroundFixtureTurn(made, "child-task-owner");
	const childSessionId = "child-background-session";
	const notify = (sessionId, update) => line({ method: "_x.ai/session_notification", params: { sessionId, update } });
	notify(agentSessionId, { sessionUpdate: "subagent_spawned", subagent_id: "child", child_session_id: childSessionId, parent_session_id: agentSessionId });
	notify(agentSessionId, { sessionUpdate: "background_tasks", tasks: [{ task_id: "still-running-parent-task", status: "running" }] });
	linkBackgroundFixtureTask(line, childSessionId, "child-provider-prompt", "child-notified-task", "child-notified-tool");
	linkBackgroundFixtureTask(line, childSessionId, "child-provider-prompt", "child-snapshot-task", "child-snapshot-tool");
	line({ id: rpcId, result: { stopReason: "end_turn" } });
	const before = events.length;
	notify(childSessionId, { sessionUpdate: "task_completed", task_snapshot: { task_id: "child-notified-task", completed: true, exit_code: 0, owner_session_id: childSessionId }, will_wake: true });
	notify(childSessionId, { sessionUpdate: "background_tasks", tasks: [{ task_id: "child-snapshot-task", status: "completed", exit_code: 0 }] });
	assert.deepEqual(events.slice(before).filter((event) => event.type === "tool").map((event) => [event.uiSessionId, event.turnId, event.tool.id, event.tool.detail, event.tool.backgroundTask]), [
		["chat", "child-task-owner", "child-notified-tool", "Ran", true],
		["chat", "child-task-owner", "child-snapshot-tool", "Ran", true],
	], "child completion and snapshots settle linked tool rows on the parent reply");
	assert.equal(proc.background, true, "the child snapshot cannot clear the parent process's own background-task idle hold");
	assert.equal(events.slice(before).some((event) => event.type === "bg-tasks"), false, "child snapshots cannot replace the parent background-task list");
}

async function checkSessionEnhancements() {
	const { host, running, events, writes } = makeHost();
	const proc = running({ uiSessionId: "a", agentSessionId: "sid-a" });
	const session = { sessionId: "sid-a", cwd: input.cwd, proc, model: input.model, effort: input.effort };
	host.sessions.set("a", session);
	const notify = (sessionId, update) => host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId, update } });
	const title = (sessionId, text) => host.onUpdate(proc, { sessionId, update: { sessionUpdate: "session_info_update", title: text } });
	notify("sid-a", { sessionUpdate: "background_tasks", tasks: [{ task_id: "t1", description: "Build preview", command: "npm run dev", output_file: "C:/grok/sessions/project/terminal/output.log", kind: "bash", status: "running", started_at: "2026-10-30T13:41:54.657262600+00:00" }] });
	assert.deepEqual(plain(events.at(-1)), { type: "bg-tasks", uiSessionId: "a", tasks: [{ id: "t1", label: "Build preview", command: "npm run dev", outputFile: "C:/grok/sessions/project/terminal/output.log", kind: "bash", status: "running", startedAt: Date.parse("2026-10-30T13:41:54.657Z"), endedAt: 0, exitCode: null }] });
	title("sid-a", "  Fix   login bug ");
	assert.deepEqual(plain(events.at(-1)), { type: "title", uiSessionId: "a", title: "Fix login bug" });
	host.turns.delete("a");
	title("sid-a", "Refined title");
	assert.equal(events.at(-1).title, "Refined title", "a late title does not need a live turn");
	let before = events.length;
	title("unrelated", "Wrong title");
	title("sid-a", "   ");
	assert.equal(events.length, before, "foreign and empty titles do not rename the app session");
	notify("sid-a", { sessionUpdate: "subagent_spawned", subagent_id: "kid", child_session_id: "kid", parent_session_id: "sid-a", description: "Review the parser", subagent_type: "reviewer", model: "grok-4.7" });
	assert.deepEqual(plain(events.at(-1)), { type: "subagent", uiSessionId: "a", subagent: { id: "kid", childSessionId: "kid", label: "Review the parser", agentType: "reviewer", model: "grok-4.7", status: "running" } });
	before = events.length;
	notify("kid", { sessionUpdate: "background_tasks", tasks: [] });
	title("kid", "Child title");
	assert.equal(events.length, before, "a child neither replaces the task snapshot nor renames the parent");
	notify("sid-a", { sessionUpdate: "subagent_finished", subagent_id: "kid", child_session_id: "kid", status: "completed", output: "Finished review", duration_ms: 2500, tokens_used: 300, tool_calls: 4 });
	assert.deepEqual(plain(events.at(-1).subagent), { id: "kid", childSessionId: "kid", label: "", agentType: "", model: "", status: "completed", output: "Finished review", durationMs: 2500, tokensUsed: 300, toolCalls: 4 });
	notify("sid-a", { sessionUpdate: "subagent_finished", subagent_id: "kid", output: "x".repeat(9000), duration_ms: "bad", tokens_used: null });
	assert.equal(events.at(-1).subagent.output.length, 8001, "large final results are bounded");
	assert.equal(Object.hasOwn(events.at(-1).subagent, "durationMs"), false);
	assert.equal(Object.hasOwn(events.at(-1).subagent, "tokensUsed"), false);
	notify("sid-a", { sessionUpdate: "background_tasks", tasks: [{ task_id: "fallback", command: "echo done", status: "completed", exit_code: 0 }] });
	assert.equal(events.at(-1).tasks[0].label, "echo done", "commands remain visible after the parent turn ends");
	const many = Array.from({ length: 60 }, (_, index) => ({ task_id: `done-${index}`, status: "completed" }));
	notify("sid-a", { sessionUpdate: "background_tasks", tasks: [{ task_id: "still-running", status: "running" }, ...many] });
	assert.equal(events.at(-1).tasks.length, 51);
	assert.equal(events.at(-1).tasks[0].id, "still-running", "only completed task history is bounded");
	assert.equal(events.at(-1).tasks[1].id, "done-0", "the newest completed entries retain the producer's order");
	let killed = host.killTask("a", "still-running");
	let killRequest = writes.at(-1);
	assert.equal(killRequest.method, "_x.ai/task/kill");
	assert.deepEqual(plain(killRequest.params), { sessionId: "sid-a", taskId: "still-running" });
	host.onMessage(proc, { id: killRequest.id, result: { result: { taskId: "still-running", outcome: "killed" } } });
	assert.deepEqual(plain(await killed), { ok: true, outcome: "killed" });
	killed = host.killTask("a", "missing");
	killRequest = writes.at(-1);
	host.onMessage(proc, { id: killRequest.id, result: { result: { taskId: "missing", outcome: "not_found" } } });
	assert.equal((await killed).ok, false, "a missing task never reports a successful stop");
	killed = host.killTask("a", "t1");
	killRequest = writes.at(-1);
	host.onMessage(proc, { id: killRequest.id, result: { result: { outcome: "" } } });
	assert.equal((await killed).ok, false, "an unrecognized outcome never reports a successful stop");
	killed = host.killTask("a", "t1");
	killRequest = writes.at(-1);
	host.onMessage(proc, { id: killRequest.id, error: { code: -32601, message: "method not found" } });
	assert.equal((await killed).ok, false);
	before = writes.length;
	assert.equal((await host.killTask("missing", "t1")).ok, false);
	assert.equal((await host.killTask("a", "")).ok, false);
	assert.equal(writes.length, before, "missing sessions and task ids make no stop request");
	const requestSuggestion = () => {
		const promise = host.suggestPrompt("a");
		const request = writes.at(-1);
		assert.equal(request.method, "_x.ai/suggestPrompt");
		assert.equal(request.params.sessionId, "sid-a");
		assert.equal(typeof request.params.generation, "number");
		return { promise, request };
	};
	let pending = requestSuggestion();
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: "  Yes,  start ", generation: pending.request.params.generation } });
	assert.equal(await pending.promise, "Yes, start");
	pending = requestSuggestion();
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: `  Use ${fakeKey} `, generation: pending.request.params.generation } });
	const suggestion = await pending.promise;
	assertNoKey(suggestion, "direct prompt suggestions mask keys");
	assert.equal(suggestion, "Use [redacted]");
	pending = requestSuggestion();
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: null, generation: pending.request.params.generation } });
	assert.equal(await pending.promise, "");
	pending = requestSuggestion();
	host.onMessage(proc, { id: pending.request.id, error: { code: -32601, message: "method not found" } });
	assert.equal(await pending.promise, "");
	pending = requestSuggestion();
	proc.promptGeneration = (proc.promptGeneration || 0) + 1;
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: "stale", generation: pending.request.params.generation } });
	assert.equal(await pending.promise, "", "a suggestion from before another turn stays discarded after that turn ends");
	pending = requestSuggestion();
	host.turns.set("a", { proc });
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: "too late", generation: pending.request.params.generation } });
	assert.equal(await pending.promise, "");
	before = writes.length;
	assert.equal(await host.suggestPrompt("a"), "");
	assert.equal(await host.suggestPrompt("missing"), "");
	assert.equal(writes.length, before, "busy and missing sessions make no prediction request");
	host.turns.delete("a");
	pending = requestSuggestion();
	host.procs.set("a", { lost: false });
	host.onMessage(proc, { id: pending.request.id, result: { suggestion: "old process", generation: pending.request.params.generation } });
	assert.equal(await pending.promise, "");
	before = events.length;
	host.loseProc(proc, "Replaced");
	assert.equal(events.length, before, "a replaced process never clears the current process's task rows");
	const current = running({ uiSessionId: "a", agentSessionId: "sid-a", promptId: null });
	host.loseProc(current, "Idle");
	assert.deepEqual(plain(events.filter((event) => event.type === "bg-tasks").at(-1)), { type: "bg-tasks", uiSessionId: "a", tasks: [], reset: true });
}

async function checkPromptIndexes() {
	for (const choice of ["two", "empty", "failed", "timeout", "slash", "side"]) {
		const { host, timers } = makeHost();
		const proc = { ready: Promise.resolve(), pending: new Map(), promptTurns: new Map() };
		host.procFor = () => proc;
		host.ensureSession = async () => ({ sessionId: "indexed" });
		host.applyConfig = async () => {};
		host.applyMode = async () => {};
		const methods = [];
		host.request = (_proc, method) => {
			methods.push(method);
			const promise = method !== "_x.ai/rewind/points" || choice === "timeout" ? new Promise(() => {})
				: choice === "failed" ? Promise.reject(new Error("Method not found"))
					: Promise.resolve({ rewind_points: choice === "two" ? [{ prompt_index: 0 }, { prompt_index: 1 }] : [] });
			proc.pending.set(methods.length, {});
			return { id: methods.length, promise };
		};
		const sent = host.prompt({ ...input, ...(choice === "slash" ? { text: "/status" } : {}), ...(choice === "side" ? { uiSessionId: "side-chat" } : {}) });
		await ticks();
		await ticks();
		if (choice === "timeout") {
			assert.equal(methods.includes("session/prompt"), false);
			[...timers.values()].find((timer) => timer.ms === 5000).callback();
		}
		const result = await sent;
		assert.equal(result.ok, true, choice);
		assert.equal(result.promptIndex, choice === "two" ? 2 : choice === "empty" ? 0 : undefined, choice);
		assert.equal(methods.at(-1), "session/prompt", choice);
		assert.equal(methods.includes("_x.ai/rewind/points"), !["slash", "side"].includes(choice), choice);
		if (choice === "timeout") { assert.equal(proc.pending.has(1), false, "a timed-out points request is dropped"); }
	}
}

function branchHost() {
	const test = makeHost();
	const proc = { uiSessionId: "chat", cwd: input.cwd, permission: "ask", ready: Promise.resolve(), pending: new Map() };
	const session = { sessionId: "branch-agent", cwd: input.cwd, proc };
	const calls = [];
	const request = { ...input, agentSessionId: session.sessionId, index: 1, text: "Change this file\nThen explain.", rewindMode: "all", force: false };
	const reply = { points: { rewind_points: [{ prompt_index: 1, prompt_preview: "Change this file" }] }, preview: { success: false, clean_files: ["one.txt"], conflicts: [{ path: "two.txt" }], error: "External modifications detected." }, forced: { success: true, reverted_files: ["one.txt", "two.txt"], conflicts: [{ path: "two.txt" }] }, fork: { newSessionId: "fork-agent" } };
	test.host.procs.set("chat", proc);
	test.host.sessions.set("chat", session);
	test.host.procFor = () => { throw new Error("An existing Grok must not restart."); };
	test.host.ensureSession = async () => session;
	test.host.request = (_proc, method, params) => {
		calls.push({ method, params });
		return { id: calls.length, promise: Promise.resolve(method === "_x.ai/rewind/points" ? reply.points : method === "_x.ai/session/fork" ? reply.fork : params.force ? reply.forced : reply.preview) };
	};
	return { ...test, proc, session, calls, request, reply };
}

async function checkBranches() {
	const test = branchHost();
	const { host, calls, request, reply } = test;
	let result = await host.rewind(request);
	assert.deepEqual(plain(result), { ok: true, done: false, revertedFiles: [], cleanFiles: ["one.txt"], conflicts: ["two.txt"], error: "External modifications detected." });
	assert.deepEqual(plain(calls.at(-1)), { method: "_x.ai/rewind/execute", params: { sessionId: "branch-agent", targetPromptIndex: 1, mode: "all", force: false } });
	for (const mode of ["all", "conversation_only", "files_only"]) {
		calls.length = 0;
		result = await host.rewind({ ...request, mode: "Always-approve", rewindMode: mode, force: true, seen: ["two.txt"] });
		assert.equal(result.done, true);
		assert.deepEqual(calls.map((call) => call.method), ["_x.ai/rewind/points", "_x.ai/rewind/execute", "_x.ai/rewind/execute"]);
		assert.deepEqual(calls.slice(1).map((call) => [call.params.mode, call.params.force]), [[mode, false], [mode, true]], "a forced rewind previews again, reusing Grok despite a permission change");
	}
	calls.length = 0;
	result = await host.rewind({ ...request, force: true, seen: [] });
	assert.equal(result.ok, false);
	assert.match(result.error, /after the preview/);
	assert.equal(calls.some((call) => call.params.force), false, "a newly conflicting file cannot be overwritten");
	reply.preview.conflicts = Array.from({ length: 201 }, (_, index) => ({ path: `conflict-${index}` }));
	result = await host.rewind(request);
	assert.equal(result.conflicts.length, 201, "every conflict must be visible in the dialog");
	calls.length = 0;
	result = await host.rewind({ ...request, force: true, seen: result.conflicts.slice(0, 200) });
	assert.equal(result.ok, false, "a conflict after path 200 must also block the forced rewind");
	assert.equal(calls.some((call) => call.params.force), false);
	for (const points of [[{ prompt_index: 1, prompt_preview: "Another prompt" }], [{ prompt_index: 0, prompt_preview: "Change this file" }]]) {
		reply.points = { rewind_points: points };
		for (const action of ["rewind", "fork"]) {
			calls.length = 0;
			result = await host[action](request);
			assert.equal(result.ok, false);
			assert.match(result.error, /no longer matches/);
			assert.equal(calls.length, 1, "a mismatch sends only the points query");
		}
	}
	for (const update of [{ agentSessionId: undefined }, { index: -1 }, { rewindMode: "other" }, { cwd: path.join(input.cwd, "missing-branch-folder") }]) {
		calls.length = 0;
		assert.equal((await host.rewind({ ...request, ...update })).ok, false);
		assert.equal(calls.length, 0, "invalid branch input sends nothing");
	}
	const other = branchHost();
	other.session.sessionId = "earlier-agent";
	assert.match((await other.host.rewind(other.request)).error, /earlier Grok conversation/);
	assert.equal(other.calls.length, 0);
	other.session.sessionId = other.request.agentSessionId;
	other.proc.cwd = path.join(input.cwd, "moved");
	assert.match((await other.host.rewind(other.request)).error, /another folder/);
	assert.equal(other.calls.length, 0);
	const fork = branchHost();
	result = await fork.host.fork(fork.request);
	assert.deepEqual(plain(result), { ok: true, agentSessionId: "fork-agent" });
	assert.deepEqual(plain(fork.calls.at(-1)), { method: "_x.ai/session/fork", params: { sourceSessionId: "branch-agent", sourceCwd: input.cwd, newCwd: input.cwd, targetPromptIndex: 1 } });
	fork.reply.fork = {};
	assert.equal((await fork.host.fork(fork.request)).ok, false, "a missing fork id cannot report success");
	for (const fails of [false, true]) {
		const locked = branchHost();
		const waiting = deferred();
		const requestNormally = locked.host.request;
		locked.host.request = (proc, method, params) => method === "_x.ai/rewind/points" ? { id: 99, promise: waiting.promise } : requestNormally(proc, method, params);
		const first = locked.host.rewind(locked.request);
		await ticks();
		assert.match((await locked.host.rewind(locked.request)).error, /Wait for Grok to finish/);
		assert.match((await locked.host.prompt(input)).error, /rewind or fork to finish/);
		assert.equal(locked.calls.length, 0);
		waiting.resolve(fails ? { rewind_points: [] } : locked.reply.points);
		assert.equal((await first).ok, !fails);
		assert.equal(locked.host.branching.size, 0, "the lock clears on success and failure");
		locked.host.request = requestNormally;
		assert.equal((await locked.host.rewind(locked.request)).ok, true);
		locked.host.turns.set("chat", {});
		const before = locked.calls.length;
		assert.match((await locked.host.rewind(locked.request)).error, /Wait for Grok to finish/);
		assert.equal(locked.calls.length, before, "a running turn blocks rewind before any request");
		locked.host.turns.delete("chat");
		assert.equal((await locked.host.fork(locked.request)).ok, true);
	}
}

// Always allow on an exact command is saved for its folder, survives a restart, and can be removed; the file is checked when read.
function checkSavedRules() {
	const folder = path.resolve(__dirname, "..");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rules-"));
	const file = path.join(dir, "always-allow.json");
	try {
		const ask = (made, id, uiSessionId, command) => {
			const proc = made.running({ uiSessionId, cwd: folder });
			made.host.onHook(proc, { id, params: { toolUseId: id, toolName: "run_terminal_command", toolInput: { command } } });
			return made.writes.find((item) => item.id === id);
		};
		const first = makeHost({ rulesFile: () => file });
		assert.equal(ask(first, "c1", "chat", "npm test"), undefined);
		assert.deepEqual(plain(first.host.decide({ uiSessionId: "chat", toolId: "c1", decision: "always" })), { ok: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, folders: [{ folder, commands: ["npm test"] }] }, "the rule is written to the rules file");
		assert.equal(ask(first, "prefix-persist", "chat", "npm run build"), undefined);
		assert.equal(first.host.decide({ uiSessionId: "chat", toolId: "prefix-persist", decision: "prefix" }).ok, true);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, folders: [{ folder, commands: ["npm test"] }] }, "prefix grants never alter the saved JSON rules");
		const restarted = makeHost({ rulesFile: () => file });
		assert.equal(ask(restarted, "c2", "later", "npm test").result.decision, "allow", "a saved command applies after a restart, in any session in its folder");
		assert.deepEqual(plain(restarted.host.removeRule(folder.toUpperCase(), "npm test")), { ok: true }, "folders match as Windows does");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, folders: [] });
		assert.equal(ask(restarted, "c3", "again", "npm test"), undefined, "a removed rule asks again");
		assert.equal(restarted.host.removeRule(folder, "npm test").ok, false);
		fs.writeFileSync(file, JSON.stringify({ version: 1, folders: [{ folder, commands: ["npm test && curl example.com", "git status", 5, "git status", "echo $HOME"] }, { folder: "relative/folder", commands: ["git status"] }, null] }));
		assert.deepEqual(plain(makeHost({ rulesFile: () => file }).host.listRules()), [{ folder, commands: ["git status"] }], "a rules file is checked like a click");
		fs.writeFileSync(file, "not json");
		assert.deepEqual(plain(makeHost({ rulesFile: () => file }).host.listRules()), [], "an unreadable rules file is no rules");
		const blocked = makeHost({ rulesFile: () => path.join(file, "nested.json") });
		assert.equal(ask(blocked, "c4", "chat", "git status"), undefined);
		assert.match(blocked.host.decide({ uiSessionId: "chat", toolId: "c4", decision: "always" }).warning, /until the app closes/, "a rule that cannot be saved says so");
		assert.equal(ask(blocked, "c5", "chat", "git status").result.decision, "allow", "and still applies for now");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function checkSteer() {
	const { host, writes, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", agentSessionId: "steer-agent" });
	host.sessions.set("chat", { sessionId: "steer-agent", proc });
	let result = host.steer("chat", "  Keep this text  ");
	let sent = writes.at(-1);
	assert.deepEqual(plain(sent.params), { sessionId: "steer-agent", text: "Keep this text" });
	assert.equal(sent.method, "_x.ai/interject");
	host.onMessage(proc, { id: sent.id, result: { result: { status: "queued" } } });
	assert.equal((await result).ok, true);
	host.onMessage(proc, { id: 800, method: "_x.ai/session/interjection", params: { sessionId: "steer-agent", text: "Keep this text" } });
	assert.deepEqual(plain(events.at(-1)), { type: "steer", text: "Keep this text", uiSessionId: "chat", turnId: "turn" });
	assert.equal(writes.at(-1).id, 800, "request-style interjection notifications are acknowledged");
	const beforeEvents = events.length;
	host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: "different-agent", text: "Wrong session" } });
	assert.equal(events.length, beforeEvents);
	const turn = host.turns.get("chat");
	for (const [key, value] of [["finished", true], ["cancelled", true], ["slash", true], ["promptId", null]]) {
		const previous = turn[key];
		turn[key] = value;
		const before = writes.length;
		assert.equal((await host.steer("chat", "text")).ok, false, key);
		assert.equal(writes.length, before, key);
		turn[key] = previous;
	}
	for (const text of ["", "  ", "/status", " /compact ", "x".repeat(100001)]) {
		const before = writes.length;
		assert.equal((await host.steer("chat", text)).ok, false);
		assert.equal(writes.length, before);
	}
	assert.equal((await host.steer("missing", "text")).ok, false);
	result = host.steer("chat", "No reply");
	sent = writes.at(-1);
	host.onMessage(proc, { id: sent.id, result: {} });
	assert.equal((await result).ok, false);
	result = host.steer("chat", "Failure");
	sent = writes.at(-1);
	host.onMessage(proc, { id: sent.id, error: { message: "Failed interject" } });
	assert.match((await result).error, /Failed interject/);
	assert.equal(events.filter((event) => event.type === "steer").length, 1, "refused steers never appear as accepted messages");

	// A steer that reaches Grok after the turn ended runs as Grok's own turn, which joins the app as a new turn.
	const late = makeHost();
	const extraFolder = path.join(input.cwd, "extra");
	const lateInput = { ...input, turnId: "original", mode: "Auto-review", allowedFolders: [extraFolder] };
	const firstSend = late.host.prompt(lateInput);
	await late.serve("session/prompt");
	const { agentSessionId } = await firstSend;
	assert.ok(agentSessionId);
	const lateProc = late.host.procs.get("chat");
	const notify = (update) => late.host.onMessage(lateProc, { method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update } });
	const update = (update, meta) => late.host.onMessage(lateProc, { method: "session/update", params: { sessionId: agentSessionId, update, ...(meta ? { _meta: meta } : {}) } });
	const steered = late.host.steer("chat", "Also add tests");
	const interject = late.writes.at(-1);
	assert.equal((await late.host.steer("chat", "Queue this instead")).ok, false, "only one unresolved steer can claim a fallback");
	assert.equal(late.writes.at(-1), interject, "the second steer stays with the app queue");
	const original = late.host.turns.get("chat");
	late.host.onMessage(lateProc, { id: original.promptId, result: { stopReason: "end_turn" } });
	assert.equal(late.host.turns.has("chat"), false, "the original completion releases the session without waiting for a steer notice");
	late.host.onMessage(lateProc, { id: interject.id, result: { status: "queued" } });
	// Grok can write the reply and the fallback start in a single stdout chunk.
	notify({ sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: "interject-fallback-1" });
	const adopted = late.host.turns.get("chat");
	assert.ok(adopted && adopted.fallback, "Grok's own turn for a late steer joins the app");
	assert.equal((await steered).ok, true);
	assert.deepEqual(plain({ mode: adopted.mode, allowedFolders: adopted.allowedFolders, agentSessionId: adopted.agentSessionId, promptId: adopted.promptId }), { mode: "Auto-review", allowedFolders: [extraFolder], agentSessionId, promptId: "interject-fallback-1" }, "it keeps the last turn's mode and folders");
	assert.equal(late.events.at(-1).type, "turn-start");
	assert.equal(late.events.at(-1).turnId, adopted.turnId);
	assert.equal(late.events.at(-1).text, "Also add tests");
	notify({ sessionUpdate: "turn_completed", prompt_id: "interject-fallback-other", stop_reason: "end_turn" });
	assert.equal(late.events.some((event) => event.type === "done" && event.turnId === adopted.turnId), false, "a different fallback's completion cannot finish this steer");
	update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also add tests" } });
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Added." } }, { promptId: "interject-fallback-1" });
	assert.deepEqual(plain(late.events.at(-1)), { type: "chunk", text: "Added.", uiSessionId: "chat", turnId: adopted.turnId });
	assert.equal(late.events.filter((event) => event.type === "turn-start" && event.turnId === adopted.turnId && !event.resume).length, 1, "the echoed steer does not create another transcript entry for this fallback");
	notify({ sessionUpdate: "turn_completed", prompt_id: "interject-fallback-1", stop_reason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, modelCalls: 1, costUsdTicks: 0, modelUsage: { "grok-4.7": {} } } });
	assert.equal(late.host.turns.has("chat"), false, "turn_completed ends Grok's own turn");
	assert.deepEqual(late.events.slice(-2).map((event) => event.type), ["usage", "done"]);
	assert.equal(late.events.at(-1).turnId, adopted.turnId);
	update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also add tests" } });
	assert.equal(late.host.turns.has("chat"), false, "the finished steer's echo cannot start another reply");
	const nextSend = late.host.prompt({ ...lateInput, turnId: "newer" });
	await late.serve("session/prompt");
	assert.equal((await nextSend).ok, true);
	const beforeStale = late.events.length;
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stale steer reply" } }, { promptId: "interject-fallback-1" });
	assert.equal(late.events.length, beforeStale, "tagged fallback chunks cannot spill into a new prompt");

	// The echo of the steer starts the turn too; a replayed prompt does not.
	const echo = makeHost();
	const echoProc = echo.running({ uiSessionId: "chat", agentSessionId: "echo-agent" });
	echo.host.sessions.set("chat", { sessionId: "echo-agent", proc: echoProc });
	echoProc.lastTurn = echo.host.turns.get("chat");
	const echoSteer = echo.host.steer("chat", "Use the other file");
	echo.host.onMessage(echoProc, { id: echo.writes.at(-1).id, result: { status: "queued" } });
	await echoSteer;
	echo.host.finishPrompt(echo.host.turns.get("chat"), 2, { stopReason: "end_turn" }, "");
	const echoed = (text, meta) => echo.host.onMessage(echoProc, { method: "session/update", params: { sessionId: "echo-agent", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text }, ...(meta ? { _meta: meta } : {}) } } });
	echoed("Use the other file", { isReplay: true });
	echoed("Something else");
	assert.equal(echo.host.turns.has("chat"), false, "a replay or another untagged text starts nothing");
	assert.equal(echo.events.some((event) => event.type === "turn-start"), false);
	echoed("Use the other file");
	assert.equal(echo.host.turns.get("chat").fallback, true);
	assert.equal(echo.events.at(-1).text, "Use the other file");
	echo.host.onMessage(echoProc, { method: "session/update", params: { sessionId: "echo-agent", update: { sessionUpdate: "turn_completed", prompt_id: "interject-fallback-9", stop_reason: "cancelled" } } });
	assert.equal(echo.host.turns.has("chat"), false, "turn_completed ends it on either channel");
	assert.equal(echo.events.at(-1).stopReason, "cancelled");

	const stopped = makeHost();
	const stoppedProc = stopped.running({ uiSessionId: "chat", agentSessionId: "stopped-agent", mode: "Always-approve" });
	stopped.host.sessions.set("chat", { sessionId: "stopped-agent", proc: stoppedProc });
	const stoppedTurn = stopped.host.turns.get("chat");
	stoppedProc.lastTurn = stoppedTurn;
	const stoppedSteer = stopped.host.steer("chat", "Write a new file");
	const stoppedInterject = stopped.writes.at(-1);
	stopped.host.onMessage(stoppedProc, { id: stoppedInterject.id, result: { status: "queued" } });
	stopped.host.finishPrompt(stoppedTurn, 2, { stopReason: "end_turn" }, "");
	stopped.host.cancel("chat");
	assert.deepEqual(plain(await stoppedSteer), { ok: false, error: "Stopped." }, "a queued acknowledgement racing Stop returns the text to the renderer queue");
	stopped.host.onMessage(stoppedProc, { method: "_x.ai/session_notification", params: { sessionId: "stopped-agent", update: { sessionUpdate: "hook_execution", prompt_id: "interject-fallback-1" } } });
	assert.equal(stopped.host.turns.has("chat"), false, "Stop prevents a pending steer from starting a fallback");
	assert.equal(stoppedProc.lost, true, "the process cannot start work for the cancelled steer later");
}

async function checkAbsorbedSteerLifecycle(action) {
	const made = makeHost();
	const { host, writes, events } = made;
	const first = host.prompt({ ...input, turnId: "absorbing-original" });
	await made.serve("session/prompt");
	const { agentSessionId } = await first;
	const proc = host.procs.get("chat");
	const original = host.turns.get("chat");
	const originalPromptId = "469b570d-6483-49c8-ad21-3c3ae38ed5ab";
	host.onMessage(proc, { method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: originalPromptId, runningText: input.text } });
	const earlierText = "An instruction absorbed into the earlier reply";
	const earlier = host.steer("chat", earlierText);
	host.onMessage(proc, { id: writes.at(-1).id, result: { status: "queued" } });
	assert.equal((await earlier).ok, true);
	if (action !== "running-cancel") {
		host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: agentSessionId, text: earlierText } });
	}
	if (action === "cancel" || action === "fallback") {
		host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId: originalPromptId }, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: `The user sent a message while you were working: <user_query>${earlierText}</user_query>` } } } });
	}
	host.onMessage(proc, { id: original.promptId, result: { stopReason: "end_turn" } });
	const next = host.prompt({ ...input, turnId: "after-absorbed-steer", text: "A later ordinary prompt" });
	await made.serve("session/prompt");
	assert.equal((await next).ok, true);
	const nextTurn = host.turns.get("chat");
	if (action === "submitted-fallback") {
		const promptId = "interject-fallback-c895346e-05db-446c-8b1a-e5c31af4a18c";
		host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The earlier steer's reply." } } } });
		const started = events.find((event) => event.type === "turn-start" && !event.resume);
		assert.equal(started?.text, earlierText, "submitting a newer prompt preserves the earlier steer's fallback candidate until the newer prompt runs");
		assert.deepEqual(plain(events.at(-1)), { type: "chunk", uiSessionId: "chat", turnId: started.turnId, text: "The earlier steer's reply." });
		return;
	}
	const nextPromptId = "2fb28c4e-fad6-4d87-88e1-74f07c59a51f";
	host.onMessage(proc, { method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: nextPromptId, runningText: "A later ordinary prompt" } });
	if (action === "running-cancel") {
		host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: agentSessionId, text: earlierText } });
		assert.equal(events.filter((event) => event.type === "steer" && event.text === earlierText).length, 1, "retiring a steer preserves its text once when the queue notice arrives late");
	}
	if (action === "cancel" || action === "running-cancel") {
		host.cancel("chat");
		assert.equal(proc.lost, false, "an earlier absorbed steer does not make a later ordinary Stop kill Grok");
		assert.equal(writes.at(-1).method, "session/cancel", "ordinary cancellation still uses the session cancel request");
		host.onMessage(proc, { id: nextTurn.promptId, result: { stopReason: "cancelled" } });
		assert.equal(host.turns.has("chat"), false);
		assert.equal(proc.lost, false, "Grok remains reusable after the cancelled prompt ends");
		return;
	}
	const laterText = "A new steer that needs its own reply";
	const later = host.steer("chat", laterText);
	host.onMessage(proc, { id: writes.at(-1).id, result: { status: "queued" } });
	assert.equal((await later).ok, true);
	host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: agentSessionId, text: laterText } });
	host.onMessage(proc, { id: nextTurn.promptId, result: { stopReason: "end_turn" } });
	const fallbackPromptId = "interject-fallback-f9fb81aa-30d0-4b2f-84c5-195a914c3af8";
	host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId: fallbackPromptId }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The later steer's answer." } } } });
	const started = events.filter((event) => event.type === "turn-start" && !event.resume).at(-1);
	assert.equal(started?.text, laterText, "the later fallback uses its sole remaining steer candidate without provider text");
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", uiSessionId: "chat", turnId: started.turnId, text: "The later steer's answer." });
}

async function checkLateSteerOrdering(noticeBefore, withHook) {
	const label = `interjection ${noticeBefore ? "before" : "after"} prompt response, ${withHook ? "hook line" : "tagged chunk only"}`;
	const made = makeHost();
	const { host, events, writes } = made;
	const firstSend = host.prompt({ ...input, turnId: "original" });
	await made.serve("session/prompt");
	const { agentSessionId } = await firstSend;
	assert.ok(agentSessionId, label);
	const proc = host.procs.get("chat");
	const original = host.turns.get("chat");
	const text = "Answer this late steer";
	const steer = host.steer("chat", text);
	host.onMessage(proc, { id: writes.at(-1).id, result: { status: "queued" } });
	assert.equal((await steer).ok, true, label);
	const interjection = () => host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: agentSessionId, text } });
	if (noticeBefore) { interjection(); }
	host.onMessage(proc, { id: original.promptId, result: { stopReason: "end_turn" } });
	if (!noticeBefore) { interjection(); }
	const newer = host.prompt({ ...input, turnId: "newer", text: "A newer prompt" });
	await made.serve("session/prompt");
	assert.equal((await newer).ok, true, `${label}: normal completion admits the next prompt immediately`);
	const newerTurn = host.turns.get("chat");
	assert.equal(newerTurn.turnId, "newer", label);
	const promptId = "interject-fallback-ordering";
	const update = (method, update) => host.onMessage(proc, { method, params: { sessionId: agentSessionId, _meta: { promptId: update.prompt_id || promptId }, update } });
	if (withHook) { update("_x.ai/session_notification", { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId }); }
	update("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The steer's reply." } });
	const fallback = host.turns.get("chat");
	assert.ok(fallback?.fallback, `${label}: the first tagged chunk starts the steer's turn`);
	assert.notEqual(fallback.turnId, original.turnId, label);
	const started = events.find((event) => event.type === "turn-start" && event.turnId === fallback.turnId);
	assert.equal(started?.text, text, `${label}: the new transcript entry keeps the steer text`);
	assert.equal(started?.parallel, true, `${label}: the steer opens beside the newer normal prompt`);
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", uiSessionId: "chat", turnId: fallback.turnId, text: "The steer's reply." }, `${label}: the first reply chunk belongs to the steer`);
	const toolId = "late-steer-write";
	host.onMessage(proc, { id: 9001, method: "hooks/run", params: { sessionId: agentSessionId, toolUseId: toolId, toolName: "write", toolInput: { file_path: "late-steer.txt", content: "From the steer" } } });
	assert.equal(host.gates.get(toolId)?.turnId, fallback.turnId, `${label}: the first tool approval belongs to the steer`);
	assert.equal(events.at(-1).turnId, fallback.turnId, label);
	assert.equal(host.decide({ uiSessionId: "chat", toolId, decision: "deny" }).ok, true, label);
	assert.equal((await host.prompt({ ...input, turnId: "third" })).ok, false, `${label}: a second new prompt cannot replace either running reply`);
	update("session/update", { sessionUpdate: "turn_completed", prompt_id: "interject-fallback-another", stop_reason: "end_turn" });
	assert.equal(events.some((event) => event.type === "done" && event.turnId === fallback.turnId), false, `${label}: a different prompt's completion cannot finish the steer`);
	update(withHook ? "_x.ai/session_notification" : "session/update", { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" });
	assert.equal(events.some((event) => event.type === "done" && event.turnId === newerTurn.turnId), false, `${label}: the steer's completion cannot finish the newer prompt`);
	assert.equal(events.filter((event) => event.type === "done").at(-1).turnId, fallback.turnId, `${label}: the completion names the steer even when the newer prompt resumes`);
	host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId: String(newerTurn.promptId) }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The newer reply." } } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", uiSessionId: "chat", turnId: newerTurn.turnId, text: "The newer reply." }, `${label}: the newer reply keeps its own transcript target`);
	host.onMessage(proc, { id: newerTurn.promptId, result: { stopReason: "end_turn" } });
	assert.equal(host.turns.has("chat"), false, `${label}: only the newer prompt's RPC response finishes that reply`);
	assert.equal(events.at(-1).turnId, newerTurn.turnId, label);

	const nextSend = host.prompt({ ...input, turnId: "stoppable" });
	await made.serve("session/prompt");
	assert.equal((await nextSend).ok, true, label);
	const stoppedTurn = host.turns.get("chat");
	const stoppedSteer = host.steer("chat", text);
	host.onMessage(proc, { id: writes.at(-1).id, result: { status: "queued" } });
	assert.equal((await stoppedSteer).ok, true, label);
	if (noticeBefore) { interjection(); }
	host.cancel("chat");
	host.onMessage(proc, { id: stoppedTurn.promptId, result: { stopReason: "cancelled" } });
	if (!noticeBefore) { interjection(); }
	const stoppedEvents = events.length;
	if (withHook) { update("_x.ai/session_notification", { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId }); }
	update("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After Stop" } });
	host.onMessage(proc, { id: 9002, method: "hooks/run", params: { sessionId: agentSessionId, toolUseId: "stopped-write", toolName: "write", toolInput: { file_path: "stopped.txt", content: "Stopped" } } });
	assert.equal(host.turns.has("chat"), false, `${label}: Stop prevents the late fallback`);
	assert.equal(events.slice(stoppedEvents).some((event) => event.type === "turn-start" || event.text === "After Stop"), false, `${label}: no fallback reply starts after Stop`);
	assert.equal(host.gates.has("stopped-write"), false, `${label}: Stop cannot open a late tool approval`);
	assert.equal(writes.some((message) => message.id === 9002 && message.result?.decision === "allow"), false, `${label}: the stopped tool never gains authorization`);
}

async function checkLateSteerText(kind) {
	const made = makeHost();
	const { host, writes, events } = made;
	const sent = host.prompt({ ...input, turnId: "original" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	const proc = host.procs.get("chat");
	const original = host.turns.get("chat");
	const texts = kind === "single" ? ["The only retained steer"] : ["The first retained steer", "The second retained steer"];
	for (const text of texts) {
		const steered = host.steer("chat", text);
		host.onMessage(proc, { id: writes.at(-1).id, result: { status: "queued" } });
		assert.equal((await steered).ok, true, kind);
		if (kind !== "single") { host.onMessage(proc, { method: "_x.ai/session/interjection", params: { sessionId: agentSessionId, text } }); }
	}
	host.onMessage(proc, { id: original.promptId, result: { stopReason: "end_turn" } });
	assert.equal(host.turns.has("chat"), false, `${kind}: accepted steers never hold a completed normal turn open`);
	const promptId = "interject-fallback-text";
	const expected = kind === "unknown" ? "A provider prompt absent from the retained steers" : texts[0];
	if (kind === "runningText" || kind === "unknown") {
		host.onMessage(proc, { method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: promptId, runningText: expected } });
	}
	if (kind === "echo") {
		host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId }, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: expected } } } });
	}
	host.onMessage(proc, { method: "session/update", params: { sessionId: agentSessionId, _meta: { promptId }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply for the reported prompt." } } } });
	const started = events.find((event) => event.type === "turn-start");
	assert.equal(started?.text, expected, `${kind}: the fallback transcript uses the reported text without substituting another steer`);
	const fallback = host.turns.get("chat");
	assert.equal(fallback?.turnId, started.turnId, kind);
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", uiSessionId: "chat", turnId: started.turnId, text: "Reply for the reported prompt." }, `${kind}: the first tagged chunk is retained`);
	host.onMessage(proc, { method: kind === "runningText" ? "_x.ai/session_notification" : "session/update", params: { sessionId: agentSessionId, _meta: { promptId }, update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } });
	assert.equal(host.turns.has("chat"), false, `${kind}: completion metadata finishes the matching fallback`);
	assert.equal(events.at(-1).type, "done", kind);
	assert.equal(events.at(-1).turnId, started.turnId, kind);
}

async function checkProviderPromptUuids(kind) {
	const made = makeHost();
	const { host, events } = made;
	const uiSessionId = kind === "side" ? "side-uuid" : `uuid-${kind}`;
	const turnId = `turn-${kind}`;
	const text = `Prompt for ${kind}`;
	const sent = host.prompt({ ...input, uiSessionId, turnId, text, ...(kind === "routine" ? { unattended: true } : {}) }, { routine: kind === "routine" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId, kind);
	const proc = host.procs.get(uiSessionId);
	const rpcId = host.turns.get(uiSessionId).promptId;
	const promptId = "3f6c2a10-1111-4222-8333-444455556666";
	assert.equal(typeof rpcId, "number", kind);
	assert.notEqual(String(rpcId), promptId, kind);
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: promptId, runningText: text, runningKind: "prompt" } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId, runs: [] }, _meta: { eventId: "uuid-start", agentTimestampMs: 1 } } });
	for (const update of [
		{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking through the prompt." } },
		{ sessionUpdate: "tool_call", toolCallId: "uuid-read", kind: "read", title: "read_file", status: "pending", rawInput: { path: "a.txt" } },
		{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The normal reply." } },
	]) {
		line({ method: "session/update", params: { sessionId: agentSessionId, update, _meta: { promptId } } });
	}
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" }, _meta: { eventId: "uuid-end", agentTimestampMs: 2 } } });
	line({ id: rpcId, result: { stopReason: "end_turn", _meta: { sessionId: agentSessionId, promptId } } });
	await ticks();
	const routed = events.filter((event) => ["thought", "tool", "chunk", "done"].includes(event.type));
	assert.deepEqual(routed.map((event) => [event.type, event.uiSessionId, event.turnId, event.text || event.tool?.id || event.stopReason]), [
		["thought", uiSessionId, turnId, "Thinking through the prompt."],
		["tool", uiSessionId, turnId, "uuid-read"],
		["chunk", uiSessionId, turnId, "The normal reply."],
		["done", uiSessionId, turnId, "end_turn"],
	], `${kind}: recorded Grok UUID metadata routes every normal prompt event to its app turn`);
	assert.equal(host.turns.has(uiSessionId), false, `${kind}: the numeric RPC response finishes the UUID-tagged normal reply once`);
}

async function checkProviderPromptUuidOverlap() {
	const made = makeHost();
	const { host, events, writes } = made;
	const sent = host.prompt({ ...input, turnId: "uuid-original", text: "Original normal prompt" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId);
	const proc = host.procs.get("chat");
	const originalRpcId = host.turns.get("chat").promptId;
	const originalUuid = "3f6c2a10-1111-4222-8333-444455556666";
	const normalUuid = "c7de4210-aaaa-4bbb-8ccc-ddddeeeeffff";
	const fallbackId = "interject-fallback-uuid-overlap";
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: originalUuid, runningText: "Original normal prompt", runningKind: "prompt" } });
	const steerText = "A late steer for the original prompt";
	const steered = host.steer("chat", steerText);
	line({ id: writes.at(-1).id, result: { status: "queued" } });
	assert.equal((await steered).ok, true);
	line({ id: originalRpcId, result: { stopReason: "end_turn", _meta: { sessionId: agentSessionId, promptId: originalUuid } } });
	const newer = host.prompt({ ...input, turnId: "uuid-newer", text: "The next normal prompt" });
	await made.serve("session/prompt");
	assert.equal((await newer).ok, true);
	const normalRpcId = host.turns.get("chat").promptId;
	assert.notEqual(String(normalRpcId), normalUuid);
	const before = events.length;
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: fallbackId, runningText: steerText } });
	const stream = (promptId, update) => line({ method: "session/update", params: { sessionId: agentSessionId, update, _meta: { promptId } } });
	stream(fallbackId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about the steer." } });
	stream(fallbackId, { sessionUpdate: "tool_call", toolCallId: "fallback-read", kind: "read", title: "read_file", status: "pending" });
	stream(fallbackId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The steer reply." } });
	const fallback = events.slice(before).find((event) => event.type === "turn-start" && event.text === steerText);
	assert.ok(fallback, "the late steer keeps its own transcript entry while the newer native prompt is pending");
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: normalUuid, runningText: "The next normal prompt", runningKind: "prompt" } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: normalUuid, runs: [] }, _meta: { eventId: "uuid-new-start", agentTimestampMs: 3 } } });
	stream(normalUuid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about the next prompt." } });
	stream(normalUuid, { sessionUpdate: "tool_call", toolCallId: "normal-read", kind: "read", title: "read_file", status: "pending" });
	stream(normalUuid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The newer normal reply." } });
	stream(fallbackId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The steer ending." } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "turn_completed", prompt_id: normalUuid, stop_reason: "end_turn" } } });
	line({ id: normalRpcId, result: { stopReason: "end_turn", _meta: { sessionId: agentSessionId, promptId: normalUuid } } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "turn_completed", prompt_id: fallbackId, stop_reason: "end_turn" } } });
	await ticks();
	const routed = events.slice(before).filter((event) => ["thought", "tool", "chunk", "done"].includes(event.type));
	assert.deepEqual(routed.map((event) => [event.type, event.uiSessionId, event.turnId, event.text || event.tool?.id || event.stopReason]), [
		["thought", "chat", fallback.turnId, "Thinking about the steer."],
		["tool", "chat", fallback.turnId, "fallback-read"],
		["chunk", "chat", fallback.turnId, "The steer reply."],
		["thought", "chat", "uuid-newer", "Thinking about the next prompt."],
		["tool", "chat", "uuid-newer", "normal-read"],
		["chunk", "chat", "uuid-newer", "The newer normal reply."],
		["chunk", "chat", fallback.turnId, "The steer ending."],
		["done", "chat", "uuid-newer", "end_turn"],
		["done", "chat", fallback.turnId, "end_turn"],
	], "Grok's normal UUID and the late fallback retain their own thought, tool, text and completion events");
	assert.equal(host.turns.has("chat"), false, "both replies finish without leaving a registered active turn");
}

async function checkAutonomousToolUpdates(kind, state) {
	const made = makeHost();
	const { host, events } = made;
	const sent = host.prompt({ ...input, turnId: "autonomous-owner" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId);
	const proc = host.procs.get("chat");
	const original = host.turns.get("chat");
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	if (state === "stopped") { host.cancel("chat"); }
	line({ id: original.promptId, result: { stopReason: state === "stopped" ? "cancelled" : "end_turn" } });
	assert.equal(host.turns.has("chat"), false, "the app prompt has finished before Grok wakes itself");
	if (state === "lost") { host.loseProc(proc, "Grok exited."); }
	const sessionId = state === "foreign" ? "another-grok-session" : agentSessionId;
	const promptId = kind === "subagent" ? "subagent-completed-01a19cec-61d6-7ad2-a450-308fdc959e6e" : "task-completed-90833f75-824d-445d-a32d-f5ba1d820cdb";
	const before = events.length;
	const wake = kind === "subagent"
		? { sessionUpdate: "subagent_finished", subagent_id: "background-agent", child_session_id: "01a19cec-61d6-7ad2-a450-308fdc959e6e", status: "completed", will_wake: true }
		: { sessionUpdate: "task_completed", task_snapshot: { task_id: "90833f75-824d-445d-a32d-f5ba1d820cdb", completed: true, exit_code: 0, owner_session_id: agentSessionId }, will_wake: true };
	line({ method: "_x.ai/session_notification", params: { sessionId, update: wake } });
	line({ method: "_x.ai/session_notification", params: { sessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId, runs: [] } } });
	for (const update of [
		{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Autonomous thinking" } },
		{ sessionUpdate: "tool_call", toolCallId: "autonomous-command", title: "run_terminal_command", rawInput: { command: "echo background" } },
		{ sessionUpdate: "tool_call_update", toolCallId: "autonomous-command", status: "failed", content: [{ type: "content", content: { type: "text", text: "Background command failed." } }] },
		{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Autonomous response" } },
	]) {
		line({ method: "session/update", params: { sessionId, update, _meta: { promptId } } });
	}
	line({ method: "_x.ai/session_notification", params: { sessionId, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } } });
	const routed = events.slice(before).filter((event) => ["tool", "thought", "chunk", "done", "turn-start"].includes(event.type));
	const showReport = kind === "task" && (state === "finished" || state === "stopped");
	const turnId = showReport ? `task-report-${promptId}` : "autonomous-owner";
	const expected = [];
	if (showReport) { expected.push(["turn-start", "chat", turnId, undefined, undefined]); }
	if (state === "finished" || showReport) {
		expected.push(["tool", "chat", turnId, "autonomous-command", "Running"], ["tool", "chat", turnId, "autonomous-command", "Not run · failed"]);
	}
	if (showReport) {
		expected.push(["chunk", "chat", turnId, undefined, undefined], ["done", "chat", turnId, undefined, undefined]);
		assert.equal(routed.find((event) => event.type === "chunk")?.text, "Autonomous response", "the background command's response appears in its own report");
	}
	assert.deepEqual(routed.map((event) => [event.type, event.uiSessionId, event.turnId, event.tool?.id, event.tool?.detail]), expected, `${kind}/${state}: tool ownership and background-command report visibility follow the wake type`);
	assert.equal(host.turns.has("chat"), false, `${kind}/${state}: the wake does not take over the app's active prompt`);
}

async function checkAutonomousPromptOverlap(kind, observedIdle) {
	const label = `${kind}/${observedIdle ? "seen while idle" : "first seen after send"}`;
	const made = makeHost();
	const { host, events, writes } = made;
	const sent = host.prompt({ ...input, turnId: "wake-owner" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId, label);
	const proc = host.procs.get("chat");
	const originalRpcId = host.turns.get("chat").promptId;
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	const autonomousId = kind === "subagent" ? "subagent-completed-01a19cec-61d6-7ad2-a450-308fdc959e6e" : "task-completed-90833f75-824d-445d-a32d-f5ba1d820cdb";
	const reportId = `task-report-${autonomousId}`;
	const wakeToolTurnId = kind === "task" ? reportId : "wake-owner";
	const stream = (promptId, update) => line({ method: "session/update", params: { sessionId: agentSessionId, update, _meta: { promptId } } });
	const wake = () => line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: autonomousId, runs: [] } } });
	const writeHook = (id, toolUseId) => line({ id, method: "hooks/run", params: { sessionId: agentSessionId, toolUseId, toolName: "write", toolInput: { file_path: "example.txt", content: "Mock file contents" } } });
	line({ id: originalRpcId, result: { stopReason: "end_turn" } });
	if (observedIdle) {
		wake();
		stream(autonomousId, { sessionUpdate: "tool_call", toolCallId: "wake-read", kind: "read", title: "read_file", status: "pending" });
	}
	const userText = "The user's next regular prompt";
	const newer = host.prompt({ ...input, turnId: "new-user-turn", text: userText });
	await made.serve("session/prompt");
	assert.equal((await newer).ok, true, label);
	const newerRpcId = host.turns.get("chat").promptId;
	const before = events.length;
	const reportOtherPrompt = () => {
		const otherId = "00000000-1111-4222-8333-444455556666";
		line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: otherId, runningText: "A different provider prompt", runningKind: "prompt" } });
		line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: otherId, runs: [] } } });
		stream(otherId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Mismatched provider thinking" } });
		stream(otherId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Mismatched provider reply" } });
	};
	if (observedIdle) { reportOtherPrompt(); }
	wake();
	writeHook(9301, "wake-write");
	assert.equal(host.gates.has("wake-write"), false, `${label}: an untagged wake hook cannot open approval in the pending app turn`);
	assert.equal(writes.find((message) => message.id === 9301)?.result?.decision, "deny", `${label}: the finished wake owner cannot approve a new write`);
	assert.equal(events.at(-1).tool?.detail, "Not run · the reply already finished", `${label}: the wake write appears as a closed tool card`);
	stream(autonomousId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about background work" } });
	stream(autonomousId, { sessionUpdate: "tool_call", toolCallId: "wake-read", kind: "read", title: "read_file", status: "pending" });
	stream(autonomousId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Background continuation" } });
	if (!observedIdle) { reportOtherPrompt(); }
	const promptId = "c7de4210-aaaa-4bbb-8ccc-ddddeeeeffff";
	line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: promptId, runningText: userText, runningKind: "prompt" } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId, runs: [] } } });
	writeHook(9302, "user-write");
	assert.equal(host.gates.get("user-write")?.turnId, "new-user-turn", `${label}: an untagged hook uses the confirmed normal prompt's approval gate`);
	assert.equal(host.decide({ uiSessionId: "chat", toolId: "user-write", decision: "deny" }).ok, true, label);
	assert.equal(writes.find((message) => message.id === 9302)?.result?.decision, "deny", `${label}: the user's gate accepts its own decision`);
	stream(promptId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about the user prompt" } });
	stream(promptId, { sessionUpdate: "tool_call", toolCallId: "user-read", kind: "read", title: "read_file", status: "pending" });
	stream(promptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The user's own reply" } });
	stream(autonomousId, { sessionUpdate: "tool_call_update", toolCallId: "wake-read", status: "completed" });
	stream(autonomousId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "More background continuation" } });
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "turn_completed", prompt_id: autonomousId, stop_reason: "end_turn" } } });
	assert.equal(events.slice(before).some((event) => event.type === "done" && event.turnId === "new-user-turn"), false, `${label}: the autonomous completion cannot finish the admitted user prompt`);
	line({ method: "_x.ai/session_notification", params: { sessionId: agentSessionId, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } } });
	line({ id: newerRpcId, result: { stopReason: "end_turn", _meta: { sessionId: agentSessionId, promptId } } });
	await ticks();
	const routed = events.slice(before).filter((event) => ["thought", "tool", "chunk", "done"].includes(event.type) && event.tool?.id !== "user-write");
	assert.deepEqual(routed.map((event) => [event.type, event.uiSessionId, event.turnId, event.text || event.tool?.id || event.stopReason]), [
		["tool", "chat", wakeToolTurnId, "wake-write"],
		...(kind === "task" ? [["thought", "chat", reportId, "Thinking about background work"]] : []),
		["tool", "chat", wakeToolTurnId, "wake-read"],
		...(kind === "task" ? [["chunk", "chat", reportId, "Background continuation"]] : []),
		["thought", "chat", "new-user-turn", "Thinking about the user prompt"],
		["tool", "chat", "new-user-turn", "user-read"],
		["chunk", "chat", "new-user-turn", "The user's own reply"],
		["tool", "chat", wakeToolTurnId, "wake-read"],
		...(kind === "task" ? [["chunk", "chat", reportId, "More background continuation"], ["done", "chat", reportId, "end_turn"]] : []),
		["done", "chat", "new-user-turn", "end_turn"],
	], `${label}: matching queue text binds the user's UUID and the wake retains its own reply identity`);
	assert.equal(host.turns.has("chat"), false, `${label}: the user's matching numeric RPC response closes its reply`);
}

async function checkBackgroundCommandReports(overlap) {
	const made = makeHost();
	const { host, events, writes } = made;
	const sent = host.prompt({ ...input, turnId: "report-source" });
	await made.serve("session/prompt");
	const { agentSessionId } = await sent;
	assert.ok(agentSessionId);
	const proc = host.procs.get("chat");
	const line = (message) => proc.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	const notify = (update, sessionId = agentSessionId) => line({ method: "_x.ai/session_notification", params: { sessionId, update } });
	const stream = (promptId, update, meta = {}, sessionId = agentSessionId) => line({ method: "session/update", params: { sessionId, update, _meta: { promptId, ...meta } } });
	line({ id: host.turns.get("chat").promptId, result: { stopReason: "end_turn" } });
	let newerRpcId;
	const normalId = "c7de4210-aaaa-4bbb-8ccc-ddddeeeeffff";
	if (overlap) {
		const newer = host.prompt({ ...input, turnId: "report-overlap", text: "A foreground prompt beside the command reports" });
		await made.serve("session/prompt");
		assert.equal((await newer).ok, true);
		newerRpcId = host.turns.get("chat").promptId;
		line({ method: "_x.ai/queue/changed", params: { sessionId: agentSessionId, entries: [], runningPromptId: normalId, runningText: "A foreground prompt beside the command reports", runningKind: "prompt" } });
	}
	const before = events.length;
	const taskIds = ["a72d7aff-77e8-4df9-8a2b-835d6042dc73", "60d680f7-9646-4e94-99ee-a1c9969dc63d"];
	for (const [index, taskId] of taskIds.entries()) {
		const promptId = `task-completed-${taskId}`;
		notify({ sessionUpdate: "task_completed", task_snapshot: { task_id: taskId, completed: true, exit_code: 0, kind: "bash", is_backgrounded: true, owner_session_id: agentSessionId, output: "Raw task snapshot stays out of the report" }, will_wake: true });
		notify({ sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: promptId, runs: [] });
		stream(promptId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thought before the report starts" } }, { eventId: `before-${index}` });
		stream(promptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Restored report text" } }, { eventId: `restore-${index}`, isReplay: true });
		stream(promptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Restored report text" }, _meta: { isReplay: true } }, { eventId: `restore-update-${index}` });
		const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Command report ${index + 1}.` } };
		stream(promptId, update, { eventId: `live-report-${index}` });
		stream(promptId, update, { eventId: `live-report-${index}` });
		assert.equal(host.turns.get("chat")?.turnId, overlap ? "report-overlap" : undefined, "the report presentation never becomes the active app prompt");
	}
	const reportIds = taskIds.map((taskId) => `task-report-task-completed-${taskId}`);
	const starts = events.slice(before).filter((event) => event.type === "turn-start");
	assert.deepEqual(starts.map((event) => [event.turnId, event.background, event.parallel, event.text]), reportIds.map((turnId) => [turnId, true, true, undefined]), "two close command completions open exactly two Grok-only messages");
	line({ id: 9401, method: "hooks/run", params: { sessionId: agentSessionId, toolUseId: "report-write", toolName: "write", toolInput: { file_path: "example.txt", content: "Mock report write" } } });
	assert.equal(host.gates.has("report-write"), false, "report presentation cannot authorize a write under the foreground prompt");
	assert.equal(writes.find((message) => message.id === 9401)?.result?.decision, "deny", "report tool calls retain the finished source turn's permission policy");
	if (overlap) {
		stream(normalId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Foreground thought" } }, { eventId: "foreground-thought" });
		stream(normalId, { sessionUpdate: "tool_call", toolCallId: "foreground-read", kind: "read", title: "read_file" }, { eventId: "foreground-tool" });
		stream(normalId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Foreground reply" } }, { eventId: "foreground-message" });
	}
	notify({ sessionUpdate: "turn_completed", prompt_id: `task-completed-${taskIds[1]}`, stop_reason: overlap ? "cancelled" : "end_turn" });
	notify({ sessionUpdate: "turn_completed", prompt_id: `task-completed-${taskIds[1]}`, stop_reason: overlap ? "cancelled" : "end_turn" });
	stream(`task-completed-${taskIds[0]}`, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First command follow-up." } }, { eventId: "first-follow-up" });
	if (overlap) {
		assert.equal(proc.lost, false, "a cancelled report cannot stop the foreground prompt's Grok");
		assert.equal(host.turns.get("chat")?.turnId, "report-overlap", "report cancellation leaves the normal prompt active");
		const beforeCancel = writes.length;
		host.cancel("chat");
		assert.equal(writes.slice(beforeCancel).some((message) => message.method === "session/cancel"), true, "Stop uses native cancellation while a presentation report is incomplete");
		assert.equal(proc.lost, false, "an incomplete presentation report cannot force Stop to kill Grok");
		line({ id: newerRpcId, result: { stopReason: "cancelled", _meta: { sessionId: agentSessionId, promptId: normalId } } });
		assert.equal(proc.lost, false, "the normal prompt's cancellation result also leaves the report's Grok alive");
	}
	notify({ sessionUpdate: "turn_completed", prompt_id: `task-completed-${taskIds[0]}`, stop_reason: "end_turn" });
	notify({ sessionUpdate: "turn_completed", prompt_id: `task-completed-${taskIds[0]}`, stop_reason: "end_turn" });
	for (const taskId of taskIds) {
		const promptId = `task-completed-${taskId}`;
		stream(promptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Duplicate completed report" } }, { eventId: `late-${taskId}` });
		stream(promptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Restored completed report" } }, { eventId: `restore-late-${taskId}`, isReplay: true });
	}
	const childSessionId = "child-own-background-task";
	proc.parents.set(childSessionId, agentSessionId);
	const childPromptId = "task-completed-11111111-2222-4333-8444-555555555555";
	notify({ sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: childPromptId, runs: [] }, childSessionId);
	stream(childPromptId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Child report must stay out of the parent chat" } }, { eventId: "child-report" }, childSessionId);
	notify({ sessionUpdate: "turn_completed", prompt_id: childPromptId, stop_reason: "end_turn" }, childSessionId);
	const shown = events.slice(before);
	assert.deepEqual(shown.filter((event) => event.type === "chunk").map((event) => [event.turnId, event.text]), [
		[reportIds[0], "Command report 1."],
		[reportIds[1], "Command report 2."],
		...(overlap ? [["report-overlap", "Foreground reply"]] : []),
		[reportIds[0], "First command follow-up."],
	], "live reports stay separate from foreground output and ignore event, restore, finished and child duplicates");
	assert.deepEqual(shown.filter((event) => event.type === "done").map((event) => event.turnId), [reportIds[1], ...(overlap ? ["report-overlap"] : []), reportIds[0]], "each completion closes only its own report or foreground reply once");
	assert.deepEqual(shown.filter((event) => event.type === "thought").map((event) => [event.turnId, event.text]), overlap ? [["report-overlap", "Foreground thought"]] : [], "thinking before report presentation stays hidden");
	assert.equal(shown.filter((event) => event.type === "turn-start").length, 2, "replay and child activity cannot open another parent report");
	assert.equal(host.turns.has("chat"), false, "the presentation reports leave the app prompt slot idle when the foreground reply finishes");
}

function checkChunkBatching() {
	const turn = () => ({ uiSessionId: "chat", turnId: "turn", promptId: 2, finished: false, cancelled: false, said: true });
	const flush = (made) => {
		const pending = [...made.timers.values()].filter((timer) => timer.ms === 30);
		assert.ok(pending.length);
		for (const timer of pending) { timer.callback(); }
	};
	const chunks = makeHost({ chunkMs: 30 });
	for (const text of ["one", "two", "three"]) { chunks.host.emitTurn(turn(), { type: "chunk", text }); }
	assert.deepEqual(chunks.events, [], "consecutive text waits for the batching timer");
	assert.equal([...chunks.timers.values()].filter((timer) => timer.ms === 30).length, 1);
	flush(chunks);
	assert.deepEqual(plain(chunks.events), [{ type: "chunk", text: "onetwothree", uiSessionId: "chat", turnId: "turn" }]);
	assert.equal(chunks.timers.size, 0);

	const split = makeHost({ chunkMs: 30 });
	const splitAt = "xai-".length + 25;
	split.host.emitTurn(turn(), { type: "chunk", text: `Key: ${fakeKey.slice(0, splitAt)}` });
	flush(split);
	assert.ok(split.events.length === 1 && split.events[0].text === "Key: ", "the first timed flush sends only the safe prefix");
	assert.equal(split.timers.size, 0, "an idle candidate does not rearm the timer");
	split.host.emitTurn(turn(), { type: "chunk", text: `${fakeKey.slice(splitAt)}\n` });
	flush(split);
	assert.ok(split.events.length === 2 && split.events[1].text === "[redacted]\n", "the second flush masks the whole key at once");
	assert.equal(split.host.heldText.size, 0);

	const candidate = makeHost({ chunkMs: 30 });
	candidate.host.emitTurn(turn(), { type: "chunk", text: "x" });
	flush(candidate);
	assert.equal(candidate.events.length, 0);
	assert.equal(candidate.timers.size, 0);
	candidate.host.emitTurn(turn(), { type: "chunk", text: " " });
	flush(candidate);
	assert.equal(candidate.events[0].text, "x ", "a delimiter releases a bare candidate");

	const tool = makeHost({ chunkMs: 30 });
	tool.host.emitTurn(turn(), { type: "chunk", text: "x" });
	flush(tool);
	tool.host.emitTurn(turn(), { type: "tool", tool: { id: "read", kind: "read", detail: "Ran" } });
	assert.deepEqual(tool.events.map((event) => event.type), ["chunk", "tool"], "tool updates flush text without waiting");
	assert.equal(tool.events[0].text, "x");
	assert.equal(tool.timers.size, 0);

	const alternate = makeHost({ chunkMs: 30 });
	alternate.host.emitTurn(turn(), { type: "chunk", text: "x" });
	flush(alternate);
	alternate.host.emitTurn(turn(), { type: "thought", text: "xa" });
	flush(alternate);
	alternate.host.emitTurn(turn(), { type: "chunk", text: "last" });
	flush(alternate);
	assert.deepEqual(alternate.events.map((event) => [event.type, event.text]), [["chunk", "x"], ["thought", "xa"], ["chunk", "last"]], "a new stream kind forces the prior candidate out first");

	const nextTurn = makeHost({ chunkMs: 30 });
	nextTurn.host.emitTurn(turn(), { type: "chunk", text: "xai" });
	flush(nextTurn);
	nextTurn.host.emitTurn({ ...turn(), turnId: "next" }, { type: "chunk", text: "next reply" });
	assert.deepEqual(nextTurn.events.map((event) => [event.turnId, event.text]), [["turn", "xai"]], "a new turn forces the previous turn's candidate out");
	flush(nextTurn);
	assert.deepEqual(nextTurn.events.map((event) => [event.turnId, event.text]), [["turn", "xai"], ["next", "next reply"]]);

	const done = makeHost({ chunkMs: 30 });
	const finishing = turn();
	done.host.turns.set("chat", finishing);
	done.host.emitTurn(finishing, { type: "chunk", text: fakeKey });
	flush(done);
	assert.equal(done.events.length, 0);
	done.host.finishPrompt(finishing, 2, { stopReason: "end_turn" }, "");
	assert.deepEqual(done.events.map((event) => event.type), ["chunk", "done"], "completion flushes the final text before retiring the turn");
	assert.ok(done.events[0].text === "[redacted]", "completion masks a key with no trailing delimiter");
	assert.equal(done.timers.size, 0);

	const approval = makeHost({ chunkMs: 30 });
	approval.host.emitTurn(turn(), { type: "chunk", text: "before approval" });
	approval.host.openGate({ type: "question", toolId: "question", uiSessionId: "chat", turnId: "turn", kind: "question", toolName: "Question", detail: "Waiting for your answer" });
	assert.deepEqual(approval.events.map((event) => event.type), ["chunk", "tool"], "direct approval emission also flushes text first");
	assert.equal(approval.events[1].tool.waiting, true);

	const steer = makeHost({ chunkMs: 30 });
	steer.host.emitTurn(turn(), { type: "chunk", text: "before steer" });
	steer.host.emitTurn(turn(), { type: "steer", text: "new direction" });
	assert.deepEqual(steer.events.map((event) => event.type), ["chunk", "steer"]);

	const parallel = makeHost({ chunkMs: 30 });
	parallel.host.emitTurn(turn(), { type: "chunk", text: "a1" });
	parallel.host.emitTurn({ ...turn(), uiSessionId: "other", turnId: "other-turn" }, { type: "chunk", text: "b1" });
	parallel.host.emitTurn(turn(), { type: "chunk", text: "a2" });
	assert.deepEqual(parallel.events, []);
	flush(parallel);
	assert.deepEqual(parallel.events.map((event) => [event.uiSessionId, event.turnId, event.text]), [["chat", "turn", "a1a2"], ["other", "other-turn", "b1"]]);

	const quitting = makeHost({ chunkMs: 30 });
	quitting.host.emitTurn(turn(), { type: "chunk", text: "xai-" });
	flush(quitting);
	quitting.host.kill();
	assert.equal(quitting.events[0].text, "xai-", "quitting flushes a held candidate");
	assert.equal(quitting.timers.size, 0);
}

async function checkLoops() {
	const { readSessionLoops } = require("../electron/loops.cjs");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-loops-"));
	try {
		const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const folder = path.join(root, "C%3A%5Cwork", id);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "chat_history.jsonl"), "{}\n");
		const write = (state) => fs.writeFileSync(path.join(folder, "resources_state.json"), JSON.stringify({ state }));
		write({ "grok_build.Scheduler": { tasks: { "loop-1": { intervalSecs: 300, durable: true, expiresAt: "2026-11-13T00:00:00.000Z", prompt: `  ${"p".repeat(210)}` } } } });
		const dotted = readSessionLoops(id, root);
		assert.equal(dotted.ok, true);
		assert.equal(dotted.loops.length, 1);
		assert.equal(dotted.loops[0].id, "loop-1");
		assert.equal(dotted.loops[0].prompt.length, 200);
		assert.equal(dotted.loops[0].schedule, "every 300s");
		assert.equal(dotted.loops[0].nextFireAt, "", "the file has no next run, so it stays unknown");
		assert.equal(dotted.loops[0].durable, true);
		assert.equal(dotted.loops[0].expiresAt, "2026-11-13T00:00:00.000Z");
		write({ grok_build: { Scheduler: { tasks: [{ id: "loop-2", humanSchedule: "every 5 minutes", prompt: "nested", nextFireAt: "2026-11-06T15:04:00.000Z" }] } } });
		const nested = readSessionLoops(id, root);
		assert.equal(nested.loops.length, 1);
		assert.equal(nested.loops[0].id, "loop-2");
		assert.equal(nested.loops[0].schedule, "every 5 minutes");
		assert.equal(nested.loops[0].nextFireAt, "2026-11-06T15:04:00.000Z", "a next run is shown only when the file actually has one");
		write({ "grok_build.Scheduler": { tasks: { bad: { prompt: 5 }, huge: { prompt: "x".repeat(9000) }, later: { prompt: "keep" } } } });
		assert.deepEqual(readSessionLoops(id, root).loops.map((loop) => loop.id), ["later"], "a task with a bad prompt is skipped");
		fs.writeFileSync(path.join(folder, "resources_state.json"), "{");
		assert.deepEqual(readSessionLoops(id, root).loops, [], "a broken file shows no loops");
		fs.rmSync(path.join(folder, "resources_state.json"));
		assert.deepEqual(readSessionLoops(id, root).loops, [], "a missing file shows no loops");
		assert.deepEqual(readSessionLoops("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", root).loops, []);
		assert.deepEqual(readSessionLoops("not-an-id", root).loops, []);
		fs.rmSync(path.join(folder, "chat_history.jsonl"));
		write({ "grok_build.Scheduler": { tasks: { "loop-1": { prompt: "hidden" } } } });
		assert.deepEqual(readSessionLoops(id, root).loops, [], "a folder without the session transcript is not that session");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}

	const { host, events, running } = makeHost();
	const proc = running({ uiSessionId: "a", agentSessionId: "sid-a" });
	const notify = (sessionId, update) => host.onMessage(proc, { method: "_x.ai/session_notification", params: { sessionId, update } });
	const loops = () => events.filter((event) => event.type === "loops");
	notify("sid-a", { sessionUpdate: "scheduled_task_created", task_id: "loop-1", prompt: "  watch the build  ", human_schedule: "every minute", next_fire_at: "2026-11-06T15:04:00.000Z" });
	assert.deepEqual(plain(loops().at(-1)), { type: "loops", uiSessionId: "a", loops: [{ id: "loop-1", prompt: "watch the build", schedule: "every minute", nextFireAt: "2026-11-06T15:04:00.000Z" }] });
	const before = events.length;
	notify("sid-a", { sessionUpdate: "scheduled_task_created", prompt: "missing id" });
	notify("sid-a", { sessionUpdate: "scheduled_task_created", task_id: "bad", human_schedule: 5, prompt: "bad schedule" });
	notify("sid-a", { sessionUpdate: "scheduled_task_created", task_id: "bad", prompt: "bad time", next_fire_at: "tomorrow" });
	notify("sid-a", { sessionUpdate: "scheduled_task_created", task_id: "bad", prompt: "x".repeat(9000) });
	notify("sid-a", { sessionUpdate: "scheduled_task_fired", task_id: "missing", next_fire_at: "2026-11-06T16:00:00.000Z" });
	assert.equal(events.length, before, "malformed loop updates are ignored");
	notify("sid-a", { sessionUpdate: "scheduled_task_created", task_id: "long", prompt: "y".repeat(250), human_schedule: "every hour" });
	assert.equal(loops().at(-1).loops.find((loop) => loop.id === "long").prompt.length, 200, "a long prompt is clipped");
	notify("sid-a", { sessionUpdate: "scheduled_task_fired", task_id: "loop-1", next_fire_at: "2026-11-06T15:05:00.000Z" });
	assert.equal(loops().at(-1).loops.find((loop) => loop.id === "loop-1").prompt, "watch the build", "a fire keeps the prompt");
	assert.equal(loops().at(-1).loops.find((loop) => loop.id === "loop-1").nextFireAt, "2026-11-06T15:05:00.000Z");
	host.onMessage(proc, { method: "x.ai/scheduled_task_created", params: { sessionId: "sid-a", update: { sessionUpdate: "scheduled_task_created", taskId: "loop-ext", prompt: "from the ext method", humanSchedule: "every 5 minutes", nextFireAt: "2026-11-06T15:10:00.000Z" } } });
	assert.equal(loops().at(-1).loops.some((loop) => loop.id === "loop-ext" && loop.schedule === "every 5 minutes"), true, "the x.ai notification carries the same loop");
	notify("sid-a", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-ext", reason: "shutdown" });
	assert.equal(loops().at(-1).loops.some((loop) => loop.id === "loop-ext"), true, "shutdown keeps the loop; it is still on disk");
	notify("sid-a", { sessionUpdate: "subagent_spawned", child_session_id: "kid", parent_session_id: "sid-a" });
	const held = loops().length;
	notify("kid", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-1", reason: "deleted" });
	assert.equal(loops().length, held, "a child session does not change the parent's loops");
	notify("sid-a", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-1", reason: "deleted" });
	assert.equal(loops().at(-1).loops.some((loop) => loop.id === "loop-1"), false);
	host.loseProc(proc, "Stopped.");
	assert.deepEqual(plain(loops().at(-1)), { type: "loops", uiSessionId: "a", loops: [], reset: true });

	const idle = (made) => [...made.timers.values()].filter((timer) => timer.ms === 1234);
	const note = (sessionId, update) => Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId, update } })}\n`);
	const made = makeHost({ idleMs: 1234 });
	const side = made.running({ uiSessionId: "side-c", agentSessionId: "sid-c" });
	side.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sid-c", update: { sessionUpdate: "agent_message_chunk", content: { text: "working" } } } })}\n`));
	assert.equal(idle(made).length, 1);
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "scheduled_task_created", task_id: "loop-1", prompt: "keep me up", human_schedule: "every minute", next_fire_at: "2026-11-06T15:04:00.000Z" }));
	assert.equal(idle(made).length, 0, "a live loop has no idle clock");
	made.host.finishPrompt(made.host.turns.get("side-c"), 2, { stopReason: "end_turn" }, "");
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "scheduled_task_fired", task_id: "loop-1", next_fire_at: "nope" }));
	assert.equal(idle(made).length, 0, "a malformed fire does not release the loop");
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-1", reason: "shutdown" }));
	assert.equal(idle(made).length, 0, "shutdown does not release the idle hold");
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "subagent_spawned", child_session_id: "kid", parent_session_id: "sid-c" }));
	side.child.stdout.emit("data", note("kid", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-1", reason: "deleted" }));
	assert.equal(idle(made).length, 0, "a child's delete does not release the parent's loop");
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "scheduled_task_deleted", task_id: "loop-1", reason: "deleted" }));
	assert.equal(idle(made).length, 1, "deleting the loop starts the idle clock");
	side.child.stdout.emit("data", note("sid-c", { sessionUpdate: "scheduled_task_created", task_id: "gone", prompt: "already over", expires_at: "2000-01-01T00:00:00.000Z" }));
	assert.equal(idle(made).length, 1, "a loop that has already expired does not hold the clock");
	assert.equal(made.events.filter((event) => event.type === "loops").at(-1).loops.length, 0);
	console.log("PASS scheduled loops: notifications, malformed updates, cold read, and the idle hold");
}

// A sandboxed Grok names its own paths, so the app tells it those and reads them back. A sandbox that can't be used never runs Grok unsandboxed.
async function checkSandbox() {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-agent-sandbox-"));
	sandboxModule.setDataDir(path.join(scratch, "data"));
	const profile = { option: "profile", profile: "workspace" };
	const linux = makeHost({}, { platform: "linux", env: { GROK_HOME: path.join(scratch, "home") } });
	const boxed = linux.host.start({ ...input, uiSessionId: "boxed", sandbox: profile, browser: true }, "ask");
	boxed.ready.catch(() => {});
	assert.deepEqual(plain(linux.spawns[0][1]).slice(0, 3), ["--sandbox", "grok-desktop", "--permission-mode"], "Mac and Linux run Grok with the app's profile");
	assert.equal(boxed.browser, false, "the browser server can't be reached from inside a sandbox");
	assert.ok(fs.readFileSync(path.join(scratch, "home", "sandbox.toml"), "utf8").includes("[profiles.grok-desktop]"));
	const windows = makeHost({});
	assert.match(windows.host.inputProblem({ ...input, sandbox: profile }), /Windows build/, "the Windows build would ignore --sandbox");
	assert.match(windows.host.inputProblem({ ...input, sandbox: { option: "wsl" } }), /distribution/);
	assert.equal(windows.host.inputProblem({ ...input, sandbox: { option: "docker" } }), "");
	assert.equal(windows.host.inputProblem(input), "");

	for (const signedIn of [false, true]) {
		const home = path.join(scratch, signedIn ? "unenforced" : "signed-out");
		const blocked = makeHost({}, { platform: "linux", env: { GROK_HOME: home } });
		const pending = blocked.host.prompt({ ...input, turnId: "blocked", sandbox: profile });
		const child = blocked.children[0];
		grokLine(child, {
			id: child.writes[0].id,
			result: { authMethods: [{ id: signedIn ? "cached_token" : "grok.com" }] },
		});
		if (signedIn) {
			await ticks();
			assert.deepEqual(child.writes.map(({ method }) => method), ["initialize", "authenticate"]);
			fs.writeFileSync(path.join(home, "sandbox-events.jsonl"), `${JSON.stringify({ event_type: "ApplyFailed", profile: "grok-desktop" })}\n`);
		}
		await blocked.serve("initialize");
		const refused = await pending;
		assert.match(refused.error || "", signedIn ? /couldn't apply the sandbox/ : /isn't signed in inside the sandbox/);
		assert.equal(refused.ok, false);
		assert.deepEqual(child.writes.map(({ method }) => method), signedIn ? ["initialize", "authenticate"] : ["initialize"]);
		assert.equal(blocked.host.procs.size, 0, "the refused sandbox is stopped");
		assert.equal(blocked.children.length, 1, "a refused sandbox never starts a fallback process");
	}

	const docker = makeHost({}, { env: { XAI_API_KEY: fakeKey } });
	const choice = { option: "docker", image: "me/grok" };
	const request = { ...input, uiSessionId: "box", turnId: "t1", sandbox: choice };
	const sent = docker.host.prompt(request);
	await docker.serve();
	await sent;
	assert.equal(docker.spawns[0][0], "docker", "Windows runs Grok through Docker, never the Windows build");
	assert.ok(!plain(docker.spawns[0][1]).join(" ").includes(fakeKey), "the key isn't on the command line");
	const opened = docker.writes.find((message) => message.method === "session/new");
	const proc = docker.host.procs.get("box");
	assert.equal(opened.params.cwd, proc.target.guestCwd, "Grok gets the folder's path inside the container");
	assert.ok(opened.params.cwd.startsWith("/workspace/"));
	const card = docker.host.toolCard({ toolCallId: "tool", kind: "edit", title: "Edit", rawInput: { file_path: proc.target.toGuest(path.join(input.cwd, "a.txt")) } }, proc);
	assert.equal(card.path, path.win32.join(input.cwd, "a.txt"), "a tool card names the file on this computer");
	const stays = docker.host.procFor(request, { mode: "Normal" });
	assert.equal(stays, proc, "the same sandbox keeps the running Grok");
	sandboxModule.wsbClients.add({ spec: { owner: "other" } });
	assert.throws(() => docker.host.procFor({ ...request, sandbox: { option: "windows-sandbox" } }, { mode: "Normal", uiSessionId: "box", turnId: "t1" }), /Another session is using Windows Sandbox/, "a second session can't take Windows Sandbox");
	assert.equal(docker.host.procs.get("box"), proc, "a refused change leaves the session's Grok running");
	assert.equal(docker.host.procs.get("box").lost, false);
	const refusedSend = await docker.host.prompt({ ...input, uiSessionId: "second", turnId: "t9", sandbox: { option: "windows-sandbox" } });
	assert.match(refusedSend.error || "", /Another session is using Windows Sandbox/, "the session is told why");
	sandboxModule.wsbClients.clear();
	proc.child.stopRemote = () => {};
	const moved = docker.host.procFor({ ...request, sandbox: undefined }, { mode: "Normal", uiSessionId: "box", turnId: "t1" });
	assert.notEqual(moved, proc, "a change of sandbox never reuses a Grok");
	assert.equal(moved.target, null);
	moved.ready.catch(() => {});
	const reopened = docker.host.ensureSession(moved, { ...request, sandbox: undefined, agentSessionId: undefined });
	await docker.serve();
	const fresh = await reopened;
	assert.equal(docker.writes.filter((message) => message.method === "session/load").length, 0, "Grok can't change a session's sandbox, so the old session isn't reopened");
	assert.equal(fresh.sessionId, `sid-${moved.child.pid}`, "a change of sandbox opens a new Grok session");

	// An attachment is named by the path Grok can reach. One it can't reach is refused, unless its bytes travel in the prompt.
	const attach = makeHost({}, { env: { XAI_API_KEY: fakeKey } });
	const inside = path.join(input.cwd, "package.json");
	const outside = path.join(scratch, "outside.txt");
	fs.writeFileSync(outside, "x");
	const image = path.join(scratch, "picture.png");
	fs.writeFileSync(image, Buffer.from([1, 2, 3]));
	const withFiles = attach.host.prompt({ ...input, uiSessionId: "files", turnId: "t2", sandbox: choice, attachments: [inside, image] });
	await attach.serve();
	await withFiles;
	const blocks = plain(attach.writes.find((message) => message.method === "session/prompt").params.prompt);
	const guestFile = attach.host.procs.get("files").target.toGuest(inside);
	assert.ok(blocks[0].text.includes(guestFile) && !blocks[0].text.includes(image), "the text lists only what Grok can reach");
	assert.equal(blocks.find((block) => block.type === "resource_link").uri, `file://${guestFile}`);
	assert.equal(blocks.find((block) => block.type === "image").data, "AQID", "an image outside the folder still arrives");
	const refused = attach.host.prompt({ ...input, uiSessionId: "files", turnId: "t3", sandbox: choice, attachments: [outside] });
	await attach.serve();
	const refusal = await refused;
	assert.match(refusal.error || "", /can't reach this attachment/);

	fs.rmSync(scratch, { recursive: true, force: true });
	console.log("PASS sandboxed sessions: profile on Mac and Linux, refusals on Windows, path mapping, and no key on a command line");
}

function checkWindowsSandboxWorktreeRefusal() {
	const { parse } = require("@babel/parser");
	const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
	const { program } = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	const app = program.body.find((node) => node.declaration?.id?.name === "App")?.declaration;
	const send = app?.body.body.find((node) => node.type === "FunctionDeclaration" && node.id?.name === "send");
	const guard = send?.body.body.find((node) => node.type === "IfStatement" &&
		source.slice(node.consequent.start, node.consequent.end).includes("WINDOWS_SANDBOX_WORKTREE"));
	assert.ok(guard, "send refuses a sandboxed Windows worktree");
	const dispatch = vm.runInNewContext("(function(sandbox, target, PLATFORM, setNotice, WINDOWS_SANDBOX_WORKTREE) {\n" +
		source.slice(guard.start, guard.end) + "\nreturn true;\n})");
	const notices = [];
	const report = (notice) => notices.push(notice);
	const choice = { option: "docker" };
	const worktree = { worktreeFolder: "worktree" };
	assert.equal(dispatch(choice, worktree, "win32", report, "sandbox and worktree"), false);
	assert.deepEqual(notices, ["sandbox and worktree"]);
	assert.equal(dispatch(choice, worktree, "linux", report), true);
	assert.equal(dispatch(undefined, worktree, "win32", report), true);
	console.log("PASS renderer dispatch refuses a sandboxed Windows worktree");
}

(async () => {
	checkPosixProcessGroups();
	await checkProbeGrok();
	await checkSignInSpawns();
	checkKeyMasking();
	checkEditDiffs();
	checkChunkBatching();
	await checkPromptIndexes();
	await checkBranches();
	await checkSteer();
	for (const action of ["cancel", "fallback", "running-cancel", "submitted-fallback"]) { await checkAbsorbedSteerLifecycle(action); }
	for (const noticeBefore of [true, false]) {
		for (const withHook of [true, false]) { await checkLateSteerOrdering(noticeBefore, withHook); }
	}
	for (const kind of ["runningText", "echo", "single", "unknown"]) { await checkLateSteerText(kind); }
	for (const kind of ["main", "side", "routine"]) { await checkProviderPromptUuids(kind); }
	await checkProviderPromptUuidOverlap();
	for (const kind of ["subagent", "task"]) {
		for (const state of ["finished", "stopped", "lost", "foreign"]) { await checkAutonomousToolUpdates(kind, state); }
		for (const observedIdle of [true, false]) { await checkAutonomousPromptOverlap(kind, observedIdle); }
	}
	for (const overlap of [false, true]) { await checkBackgroundCommandReports(overlap); }
	await checkSessionEnhancements();
	await checkBackgroundToolCompletion();
	for (const stopSource of [true, false]) { await checkBackgroundReportAfterStop(stopSource); }
	await checkBackgroundToolProcessLoss();
	await checkChildBackgroundTaskStatus();
	await checkBillingOnce();
	await checkBilling();
	await checkAccount();
	await checkSessions();
	await checkStaleSendMode();
	await checkLateMode();
	await checkProcesses();
	await checkIdle();
	await checkLoops();
	await checkPermissionMeta();
	await checkCancellation();
	await checkRestore();
	await checkConfig();
	checkPermissions();
	await checkAllowedFolders();
	await checkProcessFailures();
	checkToolPolicy();
	await checkInteractions();
	await checkModesAndCards();
	await checkParityFeatures();
	checkCommandPrefixes();
	await checkBrowserControl();
	await checkUnattended();
	await checkRoutineInteractionTimeout();
	checkSavedRules();
	await checkSandbox();
	checkWindowsSandboxWorktreeRefusal();
	console.log("Agent regression checks passed: one Grok per session (own folder, permission at launch, mode-change restart and its notice, folder change, Stop and crash isolation, worktree release, quit cleanup, idle stop that keeps busy and background Groks), parallel sessions, cancellation, restoration, configuration, Auto-review fail-safe, edit-folder/home boundaries, process failure cleanup/diagnostics, stdin errors, tool policy, questions, plan approval, plan mode sync, tool rows, Always allow scope, Grok commands/models/MCP, todos, usage and attachments.");
	process.exitCode = 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
