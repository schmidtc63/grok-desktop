const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// A check whose promise never settles ends the run without the success line, so that run fails.
process.exitCode = 1;
const source = fs.readFileSync(path.join(__dirname, "../electron/agent.cjs"), "utf8");
const input = { uiSessionId: "chat", cwd: path.resolve(__dirname, ".."), text: "Hello", model: "grok-4.7", effort: "high", mode: "Normal" };

function makeHost(options, { tmpdir, platform = "win32" } = {}) {
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
		} : (name === "os" && tmpdir ? { ...os, tmpdir: () => tmpdir } : require(name)),
		process: { platform, env: {} },
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	};
	vm.runInNewContext(source, sandbox, { filename: "agent.cjs" });
	const host = new sandbox.module.exports.AgentHost((event) => events.push(event), options);
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
	return { host, timers, writes, spawns, kills, events, children, running, serve };
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
		host.procFor = () => ({ uiSessionId: "chat", parents: new Map(), ready: stage === "ready" ? waiting.promise : Promise.resolve() });
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
	host.cancel(input.uiSessionId);
	[...timers.values()].filter((timer) => timer.ms === 5000).at(-1).callback();
	assert.deepEqual(plain(await sent), { ok: false, error: "Stopped." });
	assert.deepEqual(taskkills(spawns), [String(children[0].pid)], "a Stop during a hung start ends that session's Grok, once");
	assert.equal(host.procs.size, 0);
}

async function checkRestore() {
	const { host, events, running } = makeHost();
	const proc = running({ uiSessionId: "chat", promptId: null });
	host.sessions.set("chat", { sessionId: "persisted", cwd: input.cwd, proc, model: "grok-4.7", effort: "high" });
	host.loseProc(proc, "Exited");
	assert.equal(host.sessions.get("chat").proc, null);
	assert.equal(host.sessions.get("chat").model, "");
	const next = { uiSessionId: "chat", lost: false, parents: new Map() };
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
	host.sessions.set("chat", { sessionId: "in-memory", cwd: input.cwd, proc: null });
	await assert.rejects(host.ensureSession(next, input), (error) => error.lostSession === true, "after a Grok restart, a session Grok cannot reload is reported as lost");
	assert.equal(host.sessions.has("chat"), false, "the stale session is dropped so the next send starts a new one");
	const lost = makeHost().host;
	lost.procFor = () => ({ ready: Promise.resolve() });
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
	host.onPermission(proc, { id: 900, params: { toolCall: { title: "Read `x`", kind: "read" }, options: [{ kind: "allow_once", optionId: "yes" }] } });
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
	assert.equal(writes.at(-1).result.decision, "allow", "reads never ask");
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
		for (const folder of [project, outside, extra, sibling]) { fs.mkdirSync(folder); }
		const insideFile = path.join(project, "file.txt");
		const outsideFile = path.join(outside, "file.txt");
		fs.writeFileSync(insideFile, "inside");
		fs.writeFileSync(outsideFile, "outside");
		fs.symlinkSync(outside, path.join(project, "escape"), "junction");
		fs.symlinkSync(path.join(fixture, "missing-outside"), path.join(project, "broken"), "junction");
		// The fixture is in the temp folder, where edits are always allowed, so this host's temp folder is elsewhere.
		const { host, writes, events, running } = makeHost({}, { tmpdir: path.join(taskTemp, "grokcode-other-temp") });
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
		check({ path: outsideFile }, "allow", "read_file");
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
	privateFailure.children[0].stderr.emit("data", Buffer.from('Authentication failed. Authorization: Basic dummy-credential\n{"api_key":"dummy-api-key"} token=another-dummy password=private-value xai-examplecredential\n'));
	privateFailure.children[0].emit("exit", 1);
	const privateResult = await privateSent;
	assert.match(privateResult.error, /Authentication failed/);
	assert.equal(/dummy-credential|dummy-api-key|another-dummy|private-value|xai-examplecredential/.test(privateResult.error), false);
	assert.match(privateResult.error, /\[redacted\]/);

	const rpc = makeHost();
	const rpcSent = rpc.host.prompt(input);
	rpc.children[0].stderr.emit("data", Buffer.from("Unrelated stderr warning.\n"));
	rpc.host.onMessage(rpc.host.procs.get("chat"), { id: rpc.writes[0].id, error: { message: "Authentication rejected by RPC." } });
	assert.equal((await rpcSent).error, "Authentication rejected by RPC.");
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
	host.finishPrompt(turnA, 2, { stopReason: "end_turn" }, "");
	assert.deepEqual(plain(events.at(-1)), { type: "done", stopReason: "end_turn", uiSessionId: "a", turnId: "turn-a" });
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
	host.onHook(procOther, { id: "cmd-6", params: { sessionId: "sid-o", toolUseId: "cmd-6", toolName: "run_terminal_command", toolInput: { command: "npm test -- --watch=false" } } });
	assert.equal(writes.length, beforeOther, "Always allow belongs to one session");

	// Choose a folder starts a new conversation, so a rule never follows it, even back to the first folder.
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
	assert.equal(ask("move-4", backChat), undefined, "back in the first folder, the new conversation starts with no Always allow rules");
	assert.equal(moved.host.gates.has("move-4"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-4", decision: "deny" });
	// A turn that keeps its conversation id in another folder still gets no rule from the first folder.
	await moved.serve();
	assert.equal(await turnIn("move-e", path.join(cwd, "scripts"), firstChat), firstChat);
	assert.equal(ask("move-5", firstChat), undefined, "the same conversation in another folder starts with no Always allow rules");
	assert.equal(moved.host.gates.has("move-5"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-5", decision: "deny" });
	// Choose a folder and back with no message in between: the app tells the host to forget the cached conversation.
	await moved.serve();
	assert.equal(await turnIn("move-g", cwd, backChat), backChat);
	ask("move-6", backChat);
	assert.equal(moved.host.decide({ uiSessionId: "chat", toolId: "move-6", decision: "always" }).ok, true);
	await moved.serve();
	moved.host.forgetSession("chat");
	const freshChat = await turnIn("move-f", cwd);
	assert.notEqual(freshChat, backChat, "after forgetSession the same folder starts a new conversation");
	assert.equal(ask("move-7", freshChat), undefined, "after forgetSession the old conversation's rules do not apply");
	assert.equal(moved.host.gates.has("move-7"), true);
	moved.host.decide({ uiSessionId: "chat", toolId: "move-7", decision: "deny" });

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
		sent.host.procFor = () => ({ ready: Promise.resolve() });
		sent.host.ensureSession = async () => ({ sessionId: "agent-chat" });
		sent.host.applyConfig = async () => {};
		sent.host.applyMode = async () => {};
		const prompts = [];
		sent.host.request = (_proc, method, params) => { prompts.push({ method, params }); return { id: 1, promise: new Promise(() => {}) }; };
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

(async () => {
	await checkAccount();
	await checkSessions();
	await checkProcesses();
	await checkIdle();
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
	console.log("Agent regression checks passed: one Grok per session (own folder, permission at launch, mode-change restart and its notice, folder change, Stop and crash isolation, worktree release, quit cleanup, idle stop that keeps busy and background Groks), parallel sessions, cancellation, restoration, configuration, Auto-review fail-safe, edit-folder/home boundaries, process failure cleanup/diagnostics, stdin errors, tool policy, questions, plan approval, plan mode sync, tool rows, Always allow scope, Grok commands/models/MCP, todos, usage and attachments.");
	process.exitCode = 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
