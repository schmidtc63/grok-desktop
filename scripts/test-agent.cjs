const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const source = fs.readFileSync(path.join(__dirname, "../electron/agent.cjs"), "utf8");
const input = { uiSessionId: "chat", cwd: path.resolve(__dirname, ".."), text: "Hello", model: "grok-4.7", effort: "high", mode: "Manual" };

function makeHost() {
	const timers = new Map();
	const writes = [];
	const spawns = [];
	const events = [];
	const child = new EventEmitter();
	child.pid = 123;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { writable: true, write: (line) => writes.push(JSON.parse(line)) };
	const sandbox = {
		module: { exports: {} },
		require: (name) => name === "child_process" ? { spawn: (...args) => { spawns.push(args); return child; } } : require(name),
		process: { platform: "win32", env: {} },
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	};
	vm.runInNewContext(source, sandbox, { filename: "agent.cjs" });
	const host = new sandbox.module.exports.AgentHost((event) => events.push(event));
	return { host, timers, writes, spawns, events, child };
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

async function checkCancellation() {
	for (const stage of ["ensureChild", "ensureSession", "applyConfig"]) {
		const { host } = makeHost();
		const waiting = deferred();
		const calls = [];
		host.ensureChild = async () => {};
		host.ensureSession = async () => ({ sessionId: "agent-chat" });
		host.applyConfig = async () => {};
		host[stage] = () => waiting.promise;
		host.request = (method) => { calls.push(method); return { id: 1, promise: new Promise(() => {}) }; };
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
	const { host, writes, spawns } = makeHost();
	const sent = host.prompt(input);
	assert.equal(writes[0].params._meta["x.ai/hooks"].PreToolUse[0].timeout, 600);
	host.cancel(input.uiSessionId);
	host.onMessage({ id: writes[0].id, result: {} });
	assert.equal((await sent).ok, false);
	assert.equal(writes.some((item) => item.method === "authenticate"), false);
	assert.equal(spawns.some((item) => item[0] === "taskkill"), true);
}

async function checkRestore() {
	const { host, child, events } = makeHost();
	host.child = child;
	host.sessions.set("chat", { sessionId: "persisted", cwd: input.cwd, child, model: "grok-4.7", effort: "high" });
	host.loseChild(child, "Exited");
	assert.equal(host.sessions.get("chat").child, null);
	assert.equal(host.sessions.get("chat").model, "");
	host.child = {};
	const requests = [];
	host.request = (method, params) => {
		requests.push({ method, params });
		return { promise: Promise.resolve(config()) };
	};
	const restored = await host.ensureSession(input);
	assert.equal(requests[0].method, "session/load");
	assert.equal(requests[0].params.sessionId, "persisted");
	assert.equal(restored.model, "grok-4.7");
	assert.equal(restored.child, host.child);
	host.turns.set("chat", { uiSessionId: "chat", promptId: null });
	host.onUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { text: "historical" } } });
	assert.equal(events.length, 0);
	host.sessions.clear();
	await host.ensureSession({ ...input, agentSessionId: "saved-by-renderer" });
	assert.equal(requests[1].method, "session/load");
	assert.equal(requests[1].params.sessionId, "saved-by-renderer");
	host.sessions.clear();
	host.request = () => ({ promise: Promise.reject(new Error("No saved session")) });
	await assert.rejects(host.ensureSession({ ...input, agentSessionId: "missing" }), /No saved session/);
	assert.equal(host.sessions.size, 0);
	host.request = () => ({ promise: Promise.reject(Object.assign(new Error("Path not found."), { fromGrok: true })) });
	await assert.rejects(host.ensureSession({ ...input, agentSessionId: "missing" }), (error) => error.lostSession === true && /could not reload the earlier conversation \(Path not found\.\)/.test(error.message));
	await assert.rejects(host.ensureSession(input), (error) => !error.lostSession && error.message === "Path not found.");
	host.sessions.set("chat", { sessionId: "in-memory", cwd: input.cwd, child: null });
	await assert.rejects(host.ensureSession(input), (error) => error.lostSession === true, "after a Grok restart, a session Grok cannot reload is reported as lost");
	assert.equal(host.sessions.has("chat"), false, "the stale session is dropped so the next send starts a new one");
	const lost = makeHost().host;
	lost.ensureChild = async () => {};
	lost.ensureSession = async () => { throw Object.assign(new Error("Grok could not reload the earlier conversation."), { lostSession: true }); };
	const lostResult = await lost.prompt({ ...input, agentSessionId: "missing", turnId: "turn-lost" });
	assert.equal(lostResult.ok, false);
	assert.equal(lostResult.lostSession, true);
	assert.equal(lost.turns.size, 0);
}

function checkToolPolicy() {
	const { host, child, writes, events } = makeHost();
	host.child = child;
	host.turns.set("chat", { uiSessionId: "chat", turnId: "turn-1", cwd: input.cwd, allowedFolders: [], mode: "Accept edits", agentSessionId: "sid-1", promptId: 2, finished: false, cancelled: false });
	let nextId = 500;
	function decision(toolName, toolInput) {
		const id = ++nextId;
		host.onHook({ id, params: { toolUseId: `policy-${id}`, toolName, toolInput } });
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
	for (const mode of ["Manual", "Accept edits", "Plan", "Auto"]) {
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
	assert.equal(decision("run_terminal_command", { command: "echo hi" }), "deny");
	assert.equal(decision("monitor", { command: "tail -f x" }), "deny");
	host.turns.get("chat").mode = "Manual";
	assert.equal(decision("enter_plan_mode", {}), "ask", "entering plan mode needs the user's approval");
	assert.equal(decision("search_replace", { file_path: planFile }), "allow");
	assert.equal(decision("write", { file_path: path.join(input.cwd, "x.txt") }), "ask");
	const long = `Write-Output start; ${"x".repeat(6000)}; Remove-Item -Recurse C:/data`;
	assert.equal(decision("run_terminal_command", { command: long }), "ask");
	const gateId = events.at(-1).tool.id;
	assert.equal(events.at(-1).tool.command, long, "an approval shows the whole command");
	assert.ok(events.at(-1).tool.summary.endsWith("…"), "a shortened summary is marked");
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call", toolCallId: gateId, rawInput: { command: long } } });
	assert.equal(events.at(-1).tool.command, long, "Grok's own update keeps the whole command while the approval is open");
	host.onPermission({ id: 902, params: { toolCall: { title: "Execute", kind: "execute", rawInput: { command: long } }, options: [] } });
	assert.equal(events.at(-1).tool.command, long);
	const mcp = { tool_name: "chrome__tabs_open", tool_input: { url: `https://example.com/${"a".repeat(400)}@other.example/` } };
	assert.equal(decision("use_tool", mcp), "ask");
	assert.equal(events.at(-1).tool.input, JSON.stringify(mcp, null, 2), "an approval shows the tool's complete arguments");
	assert.equal(decision("enter_plan_mode", {}), "ask");
	assert.equal(events.at(-1).tool.input, undefined);
	host.onPermission({ id: 900, params: { toolCall: { title: "Read `x`", kind: "read" }, options: [{ kind: "allow_once", optionId: "yes" }] } });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes");
	host.onPermission({ id: 901, params: { toolCall: { title: "Execute `rm x`", kind: "execute" }, options: [{ kind: "allow_once", optionId: "yes" }] } });
	assert.equal(events.at(-1).tool.kind, "command");
	assert.equal(events.at(-1).tool.waiting, true);
}

async function checkInteractions() {
	const { host, child, writes, events } = makeHost();
	host.child = child;
	host.turns.set("chat", { uiSessionId: "chat", turnId: "turn-2", mode: "Plan", agentSessionId: "sid-1", promptId: 2, finished: false, cancelled: false });
	const questions = [{ question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: null }];
	host.onMessage({ id: 50, method: "_x.ai/ask_user_question", params: { sessionId: "sid-1", toolCallId: "call-q", questions, mode: "default" } });
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
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-q", status: "completed", content: [{ type: "content", content: { type: "text", text: "User has answered" } }] } });
	assert.equal(events.at(-1).tool.detail, "Answered");
	host.onMessage({ id: 51, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q2", questions } });
	assert.equal(host.answerQuestion({ uiSessionId: "chat", toolId: "call-q2", answers: null }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "cancelled" });
	assert.equal(events.at(-1).tool.detail, "Declined");
	host.onMessage({ id: 52, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q3", questions: [] } });
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 52, result: { outcome: "cancelled" } }, "an empty question is declined at once");

	host.onMessage({ id: 60, method: "_x.ai/exit_plan_mode", params: { sessionId: "sid-1", toolCallId: "call-p", planContent: "# Plan\n1. Do it" } });
	assert.equal(events.at(-1).tool.plan, "# Plan\n1. Do it");
	assert.equal(events.at(-1).tool.kind, "plan");
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "approved" }).ok, false, "approval needs an edit mode");
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "approved", mode: "Bypass permissions" }).ok, false);
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "approved", mode: "Accept edits" }).ok, true);
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p", outcome: "abandoned" }).closed, true);
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 60, result: { outcome: "approved" } });
	assert.equal(host.turns.get("chat").mode, "Accept edits");
	assert.equal(events.at(-1).tool.detail, "Approved · Accept edits");
	host.onMessage({ id: 61, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p2", planContent: "# Plan" } });
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p2", outcome: "feedback", feedback: "  " }).ok, false);
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p2", outcome: "feedback", feedback: " Add tests. " }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "feedback", feedback: "Add tests." });
	host.onMessage({ id: 62, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p3", planContent: "# Plan" } });
	assert.equal(host.answerPlan({ uiSessionId: "chat", toolId: "call-p3", outcome: "abandoned" }).ok, true);
	assert.deepEqual(writes.at(-1).result, { outcome: "abandoned" });
	assert.equal(host.turns.get("chat").mode, "Manual");
	host.onMessage({ id: 63, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q4", questions } });
	host.onMessage({ id: 64, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p4", planContent: "# Plan" } });
	host.cancel("chat");
	assert.deepEqual(writes.find((item) => item.id === 63).result, { outcome: "cancelled" });
	assert.equal(writes.find((item) => item.id === 64).result.outcome, "feedback");
	assert.equal(events.filter((event) => event.tool && event.tool.detail === "Closed · Stopped").length, 2);
	host.onMessage({ id: 65, method: "_x.ai/ask_user_question", params: { toolCallId: "call-q5", questions } });
	assert.deepEqual(writes.at(-1), { jsonrpc: "2.0", id: 65, result: { outcome: "cancelled" } }, "no open turn declines at once");
	host.turns.clear();
	host.onMessage({ id: 66, method: "_x.ai/exit_plan_mode", params: { toolCallId: "call-p5" } });
	assert.equal(writes.at(-1).result.outcome, "feedback");
}

async function checkModesAndCards() {
	const { host, child, events } = makeHost();
	host.child = child;
	const requests = [];
	host.request = (method, params) => { requests.push({ method, params }); return { id: requests.length, promise: Promise.resolve({}) }; };
	const session = { sessionId: "sid-1", grokMode: "" };
	await host.applyMode(session, { mode: "Manual" });
	await host.applyMode(session, { mode: "Accept edits" });
	await host.applyMode(session, { mode: "Plan" });
	await host.applyMode(session, { mode: "Plan" });
	assert.deepEqual(requests.map((item) => item.params.modeId), ["default", "plan"]);
	host.request = () => ({ id: 9, promise: Promise.reject(Object.assign(new Error("Unknown mode"), { fromGrok: true })) });
	await host.applyMode({ sessionId: "sid-1", grokMode: "" }, { mode: "Plan" });
	host.sessions.set("chat", session);
	host.turns.set("chat", { uiSessionId: "chat", turnId: "turn-3", mode: "Manual", agentSessionId: "sid-1", promptId: 2, finished: false, cancelled: false });
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mode", mode: "Plan", uiSessionId: "chat", turnId: "turn-3" });
	assert.equal(host.turns.get("chat").mode, "Plan");
	assert.equal(session.grokMode, "plan");
	host.turns.get("chat").mode = "Accept edits";
	const before = events.length;
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
	assert.equal(events.length, before, "leaving plan after an approval keeps the chosen mode");
	host.turns.get("chat").mode = "Plan";
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mode", mode: "Manual", uiSessionId: "chat", turnId: "turn-3" });
	host.onUpdate({ sessionId: "other", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
	assert.equal(host.turns.get("chat").mode, "Manual", "another Grok session's mode does not move this turn");

	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "Hi" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "Hi", uiSessionId: "chat", turnId: "turn-3" });
	const command = "git status --porcelain; git log -8 --oneline";
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command", rawInput: { command, description: "Check git status" }, _meta: { "x.ai/tool": { label: "Run Command", kind: "execute" } } } });
	assert.equal(events.at(-1).tool.label, "Run Command");
	assert.equal(events.at(-1).tool.description, "Check git status");
	assert.equal(events.at(-1).tool.command, command);
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", kind: "execute", title: `Execute \`${command}\``, content: [{ type: "content", content: { type: "text", text: "Check git status" } }] } });
	assert.equal(events.at(-1).tool.output, undefined, "the description is not output");
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "?? notes.md\n9616861 fix" } }] } });
	assert.equal(events.at(-1).tool.output, "?? notes.md\n9616861 fix");
	assert.equal(events.at(-1).tool.detail, "Ran");
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", kind: "read", title: "Read `a.txt`", locations: [{ path: "C:\\project\\a.txt" }] } });
	assert.equal(events.at(-1).tool.path, "C:\\project\\a.txt");
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed", content: [{ type: "content", content: { type: "text", text: "secret file text" } }] } });
	assert.equal(events.at(-1).tool.output, undefined, "read contents are not copied into the chat");
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-3", kind: "edit", content: [{ type: "diff", path: "C:\\project\\a.txt", oldText: "one\ntwo\n", newText: "one\n2\nthree\n" }] } });
	assert.equal(events.at(-1).tool.additions, 3);
	assert.equal(events.at(-1).tool.deletions, 2);
	host.onUpdate({ sessionId: "sid-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-4", status: "completed", content: [{ type: "content", content: { type: "text", text: "x".repeat(5000) } }] } });
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
	host.request = (_method, params) => {
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
	assert.match(host.inputProblem({ ...input, model: "grok-4.5", effort: "xhigh" }), /4.5 supports/);
	await assert.rejects(host.tryConfig(session, "reasoning_effort", "xhigh"), /does not support/);
}

function checkPermissions() {
	const { host, child, writes, events, timers } = makeHost();
	host.child = child;
	host.turns.set("chat", { uiSessionId: "chat", mode: "Manual", promptId: 2, finished: false, cancelled: false });
	const options = [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }];
	host.onHook({ id: 3, params: { toolUseId: "tool-one", toolName: "write" } });
	assert.equal([...timers.values()].some((timer) => timer.ms === 480000), true);
	assert.equal(writes.length, 0);
	host.decide({ uiSessionId: "chat", toolId: "tool-one", decision: "allow" });
	assert.equal(writes[0].result.decision, "allow");
	host.onPermission({ id: 4, params: { toolCall: { toolCallId: "tool-one", title: "write", kind: "edit" }, options } });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes", "your Allow on that exact call also answers Grok's own prompt for it");
	assert.equal(events.at(-1).tool.id, "tool-one", "no second card");
	host.onHook({ id: 7, params: { toolUseId: "tool-two", toolName: "todo_write" } });
	host.onPermission({ id: 8, params: { toolCall: { toolCallId: "tool-two", title: "write", kind: "edit" }, options } });
	const nativeCard = events.at(-1).tool;
	assert.notEqual(nativeCard.id, "tool-two", "a call allowed by policy, not by your click, still gets Grok's own card");
	assert.equal(nativeCard.waiting, true);
	host.decide({ uiSessionId: "chat", toolId: nativeCard.id, decision: "allow" });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes");
	host.onPermission({ id: 5, params: { toolCall: { title: "write" }, options } });
	const deniedCard = events.at(-1).tool;
	host.decide({ uiSessionId: "chat", toolId: deniedCard.id, decision: "deny" });
	assert.equal(writes.at(-1).result.outcome.optionId, "no");
	host.onPermission({ id: 6, params: { toolCall: { title: "write" }, options } });
	host.cancel("chat");
	assert.equal(writes.find((item) => item.id === 6).result.outcome.optionId, "no");
	for (const mode of ["Auto", "Bypass permissions", "Accept edits"]) {
		host.turns.get("chat").mode = mode;
		host.onHook({ id: `hook-${mode}`, params: { toolUseId: mode, toolName: "write" } });
		assert.equal(writes.at(-1).result.decision, "deny");
		host.onPermission({ id: `permission-${mode}`, params: { toolCall: { title: "write" }, options } });
		assert.equal(writes.at(-1).result.outcome.optionId, "no");
	}
	host.turns.get("chat").cancelled = false;
	host.turns.get("chat").mode = "Plan";
	for (const toolName of ["get_command_or_subagent_output", "wait_commands_or_subagents"]) {
		host.onHook({ id: toolName, params: { toolUseId: toolName, toolName } });
		assert.equal(writes.at(-1).result.decision, "allow");
	}
}

async function checkAllowedFolders() {
	const taskTemp = path.join(__dirname, "..", ".test-temp");
	fs.mkdirSync(taskTemp, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(taskTemp, "grokdesk-edit-folders-"));
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
		const { host, child, writes, events } = makeHost();
		host.child = child;
		host.turns.set("chat", { uiSessionId: "chat", cwd: project, allowedFolders: [], mode: "Accept edits", promptId: 2, finished: false, cancelled: false });
		let nextId = 100;
		function check(toolInput, expected, toolName = "write") {
			const id = ++nextId;
			host.onHook({ id, params: { toolUseId: String(id), toolName, toolInput } });
			const reply = writes.find((item) => item.id === id);
			assert.equal(reply ? reply.result.decision : "ask", expected, JSON.stringify({ toolName, toolInput }));
			if (expected === "ask") { assert.equal(events.at(-1).tool.waiting, true); }
			return String(id);
		}
		for (const key of ["file_path", "target_file", "path"]) { check({ [key]: insideFile }, "allow"); }
		check({ path: "file.txt" }, "allow");
		check({ path: "new/deep/file.txt" }, "allow");
		check({ path: "../outside/file.txt" }, "ask");
		check({ path: path.join(sibling, "file.txt") }, "ask");
		check({ path: path.join(project, "escape/file.txt") }, "ask");
		check({ path: path.join(project, "escape/new/deep/file.txt") }, "ask");
		check({ path: path.join(project, "broken/file.txt") }, "ask");
		check({ path: path.join(os.tmpdir(), "grokcode-nonexistent/new/file.txt") }, "allow");
		check({ path: path.join(os.homedir(), ".grok/grokdesk-permission-test.txt") }, "ask");
		for (const target of ["~/.grok/example.txt", "~\\.grok\\example.txt", "~", "~other/example.txt"]) { check({ path: target }, "ask"); }
		check({ path: "./~literal.txt" }, "allow");
		if (process.platform === "win32") { check({ path: insideFile.toUpperCase() }, "allow"); }
		check({ todos: [] }, "allow", "todo_write");
		check({ path: null }, "ask");
		check({ file_path: 42, path: insideFile }, "ask");
		check({ file_path: insideFile, path: outsideFile }, "ask");
		check({ file_path: insideFile, target_file: insideFile }, "allow");
		check("malformed input", "ask");
		for (const mode of ["Manual", "Plan", "Auto", "Bypass permissions"]) {
			host.turns.get("chat").mode = mode;
			check({ path: outsideFile }, mode === "Manual" ? "ask" : mode === "Plan" ? "deny" : "allow");
		}
		host.turns.get("chat").mode = "Accept edits";
		check({ path: outsideFile }, "allow", "read_file");
		const pending = check({ path: path.join(extra, "new.txt") }, "ask");
		const beforeUpdate = writes.length;
		const allowedFolders = [extra];
		assert.equal(host.setAllowedFolders({ uiSessionId: "chat", allowedFolders }).ok, true);
		allowedFolders.push(outside);
		assert.equal(host.turns.get("chat").allowedFolders.length, 1);
		assert.equal(writes.length, beforeUpdate);
		assert.equal(host.gates.has(pending), true);
		check({ path: path.join(extra, "new.txt") }, "allow");
		assert.equal(host.setAllowedFolders({ uiSessionId: "other", allowedFolders: [outside] }).ok, true);
		check({ path: outsideFile }, "ask");
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
	const exited = makeHost();
	exited.host.child = exited.child;
	exited.host.turns.set("chat", { uiSessionId: "chat", mode: "Manual", promptId: 10, finished: false, cancelled: false });
	exited.host.onHook({ id: 1, params: { toolUseId: "hook-edit", toolName: "write" } });
	exited.host.onPermission({ id: 2, params: { toolCall: { title: "write" }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] } });
	assert.equal(exited.host.gates.size, 2);
	exited.host.loseChild(exited.child, "Grok exited.");
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
	startup.child.stderr.emit("data", Buffer.from("old warning\n".repeat(1000)));
	startup.child.stderr.emit("data", Buffer.from("Login service is unavailable.\n"));
	startup.child.emit("exit", 1);
	const failed = await sent;
	assert.equal(failed.ok, false);
	assert.match(failed.error, /Grok exited\..*Login service is unavailable/);
	assert.ok(failed.error.length < 350);

	const privateFailure = makeHost();
	const privateSent = privateFailure.host.prompt(input);
	privateFailure.child.stderr.emit("data", Buffer.from('Authentication failed. Authorization: Basic dummy-credential\n{"api_key":"dummy-api-key"} token=another-dummy password=private-value xai-examplecredential\n'));
	privateFailure.child.emit("exit", 1);
	const privateResult = await privateSent;
	assert.match(privateResult.error, /Authentication failed/);
	assert.equal(/dummy-credential|dummy-api-key|another-dummy|private-value|xai-examplecredential/.test(privateResult.error), false);
	assert.match(privateResult.error, /\[redacted\]/);

	const rpc = makeHost();
	const rpcSent = rpc.host.prompt(input);
	rpc.child.stderr.emit("data", Buffer.from("Unrelated stderr warning.\n"));
	rpc.host.onMessage({ id: rpc.writes[0].id, error: { message: "Authentication rejected by RPC." } });
	assert.equal((await rpcSent).error, "Authentication rejected by RPC.");
}

async function checkSessions() {
	const { host, child, writes, events, timers, spawns } = makeHost();
	host.child = child;
	host.sessions.set("a", { sessionId: "sid-a" });
	host.sessions.set("b", { sessionId: "sid-b" });
	const turnA = { uiSessionId: "a", turnId: "turn-a", mode: "Manual", agentSessionId: "sid-a", promptId: 2, finished: false, cancelled: false };
	const turnB = { uiSessionId: "b", turnId: "turn-b", mode: "Manual", agentSessionId: "sid-b", promptId: 3, finished: false, cancelled: false };
	host.turns.set("a", turnA);
	host.turns.set("b", turnB);
	assert.match((await host.prompt({ ...input, uiSessionId: "a" })).error, /still answering in this session/);
	host.dispatch = async () => ({ ok: true });
	assert.equal((await host.prompt({ ...input, uiSessionId: "c" })).ok, true, "another session can start while two are running");
	host.turns.delete("c");
	host.onUpdate({ sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "for b" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "for b", uiSessionId: "b", turnId: "turn-b" });
	host.onHook({ id: 20, params: { sessionId: "sid-a", toolUseId: "hook-a", toolName: "write" } });
	assert.equal(events.at(-1).uiSessionId, "a");
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-b", update: { sessionUpdate: "subagent_spawned", parent_session_id: "sid-b", child_session_id: "sub-b" } } });
	host.onHook({ id: 21, params: { sessionId: "sub-b", toolUseId: "hook-sub", toolName: "write" } });
	assert.equal(events.at(-1).uiSessionId, "b", "a subagent's approval goes to the session that started it");
	const count = events.length;
	host.onUpdate({ sessionId: "sub-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "subagent text" } } });
	assert.equal(events.length, count, "subagent text stays out of the parent reply");
	host.onUpdate({ sessionId: "sub-b", update: { sessionUpdate: "tool_call", toolCallId: "sub-call", title: "read_file", rawInput: { path: "a.txt" } } });
	assert.equal(events.at(-1).uiSessionId, "b", "subagent tool rows still show");
	host.onHook({ id: 22, params: { sessionId: "unknown", toolUseId: "hook-unknown", toolName: "write" } });
	assert.equal(writes.at(-1).result.decision, "deny", "an unknown session is not guessed while two turns run");
	host.finishPrompt(turnA, 2, { stopReason: "end_turn" }, "");
	assert.deepEqual(plain(events.at(-1)), { type: "done", stopReason: "end_turn", uiSessionId: "a", turnId: "turn-a" });
	assert.deepEqual([...host.turns.keys()], ["b"]);
	assert.equal(writes.find((item) => item.id === 20).result.decision, "deny");
	assert.equal(host.gates.has("hook-sub"), true, "ending one session leaves the other's approval open");
	const turnA2 = { ...turnA, turnId: "turn-a2", promptId: 4, finished: false };
	host.turns.set("a", turnA2);
	host.pending.set(3, { resolve() {}, reject() {} });
	host.cancel("b");
	assert.equal(writes.at(-1).method, "session/cancel");
	assert.equal(writes.at(-1).params.sessionId, "sid-b");
	[...timers.values()].filter((timer) => timer.ms === 5000).at(-1).callback();
	assert.deepEqual(plain(events.at(-1)), { type: "done", stopReason: "cancelled", uiSessionId: "b", turnId: "turn-b" });
	assert.equal(spawns.some((item) => item[0] === "taskkill"), false, "a stuck Stop does not end the other session's turn");
	assert.deepEqual([...host.turns.keys()], ["a"]);
	host.turns.set("b", { ...turnB, turnId: "turn-b2", promptId: 5, finished: false, cancelled: false });
	const beforeStale = events.length;
	host.onUpdate({ sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "from the stopped prompt" } } });
	assert.equal(events.length, beforeStale, "the stopped prompt's text stays out of the next reply");
	host.onHook({ id: 23, params: { sessionId: "sid-b", toolUseId: "hook-stale", toolName: "run_terminal_command" } });
	assert.equal(writes.at(-1).result.decision, "deny", "the stopped prompt cannot run tools under the next turn");
	host.onMessage({ id: 3, result: { stopReason: "cancelled" } });
	host.onUpdate({ sessionId: "sid-b", update: { sessionUpdate: "agent_message_chunk", content: { text: "next reply" } } });
	assert.deepEqual(plain(events.at(-1)), { type: "chunk", text: "next reply", uiSessionId: "b", turnId: "turn-b2" }, "routing resumes once Grok ends the stopped prompt");
	host.turns.delete("b");
	host.loseChild(child, "Grok exited.");
	assert.deepEqual(plain(events.at(-1)), { type: "error", message: "Grok exited.", uiSessionId: "a", turnId: "turn-a2" });
	assert.equal(host.turns.size, 0);

	const lone = makeHost();
	lone.host.child = lone.child;
	lone.host.sessions.set("x", { sessionId: "sid-x" });
	lone.host.turns.set("y", { uiSessionId: "y", turnId: "turn-y", mode: "Bypass permissions", agentSessionId: "sid-y", promptId: 2, finished: false, cancelled: false });
	lone.host.onHook({ id: 30, params: { sessionId: "sid-replaced", toolUseId: "hook-other", toolName: "run_terminal_command" } });
	assert.equal(lone.writes.at(-1).result.decision, "deny", "a request from another Grok session never borrows the one running turn");

	const starting = makeHost();
	starting.host.child = starting.child;
	starting.host.turns.set("s", { uiSessionId: "s", turnId: "turn-s", mode: "Manual", agentSessionId: "", promptId: null, finished: false, cancelled: false });
	starting.host.cancel("s");
	[...starting.timers.values()].filter((timer) => timer.ms === 5000).at(-1).callback();
	assert.equal(starting.spawns.some((item) => item[0] === "taskkill"), true, "a Stop during a hung start still ends Grok");
}

async function checkParityFeatures() {
	const { host, child, writes, events } = makeHost();
	host.child = child;
	const cwd = path.resolve(__dirname, "..");
	host.turns.set("chat", { uiSessionId: "chat", turnId: "turn-p", cwd, allowedFolders: [], mode: "Manual", promptId: 2, finished: false, cancelled: false });
	const hook = (id, toolName, toolInput) => { host.onHook({ id, params: { toolUseId: id, toolName, toolInput } }); return writes.at(-1); };

	assert.equal(hook("cmd-1", "run_terminal_command", { command: "npm test -- --watch=false" }), undefined, "Manual asks first");
	assert.equal(host.decide({ uiSessionId: "chat", toolId: "cmd-1", decision: "always" }).ok, true);
	assert.equal(writes.at(-1).result.decision, "allow");
	assert.equal(hook("cmd-2", "run_terminal_command", { command: "npm  TEST" }).result.decision, "allow", "Always allow covers the same first two words");
	assert.equal(hook("cmd-3", "run_terminal_command", { command: "npm publish" }), writes.at(-1), "another npm command still asks");
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
	assert.equal(hook("ps-2", "run_terminal_command", { command: "powershell  -Command Get-Date" }).result.decision, "allow", "Always allow covers the same interpreter command");
	const beforePs = writes.length;
	hook("ps-3", "run_terminal_command", { command: "powershell -Command Remove-Item -Recurse -Force C:/x" });
	assert.equal(writes.length, beforePs, "Always allow after an interpreter flag never covers other code");
	host.decide({ uiSessionId: "chat", toolId: "ps-3", decision: "deny" });
	host.turns.get("chat").mode = "Accept edits";
	const nativeOptions = [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }];
	const beforeNative = writes.length;
	host.onPermission({ id: "perm-out", params: { toolCall: { toolCallId: "out-1", title: "write", kind: "edit", rawInput: { file_path: path.join(os.homedir(), "outside-grokcode.md") } }, options: nativeOptions } });
	assert.equal(writes.length, beforeNative, "Grok's own prompt for an edit outside the folders asks in Accept edits");
	host.decide({ uiSessionId: "chat", toolId: "native-permission:perm-out", decision: "deny" });
	host.onPermission({ id: "perm-in", params: { toolCall: { toolCallId: "in-1", title: "write", kind: "edit", rawInput: { file_path: path.join(cwd, "inside.md") } }, options: nativeOptions } });
	assert.equal(writes.at(-1).result.outcome.optionId, "yes", "an edit inside the folder is still allowed");
	host.turns.get("chat").mode = "Manual";
	host.turns.set("other", { uiSessionId: "other", turnId: "turn-o", cwd, allowedFolders: [], mode: "Manual", agentSessionId: "sid-o", promptId: 3, finished: false, cancelled: false });
	host.turns.get("chat").agentSessionId = "sid-c";
	const beforeOther = writes.length;
	host.onHook({ id: "cmd-6", params: { sessionId: "sid-o", toolUseId: "cmd-6", toolName: "run_terminal_command", toolInput: { command: "npm test" } } });
	assert.equal(writes.length, beforeOther, "Always allow belongs to one session");

	host.onUpdate({ sessionId: "sid-c", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review changes", input: { hint: "branch" } }, { name: "bad name" }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "commands", commands: [{ name: "review", description: "Review changes", hint: "branch" }] });
	host.onMessage({ method: "_x.ai/models/update", params: { availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7", description: "Best", _meta: { totalContextTokens: 500000, reasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "turbo" }] } }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "models", models: [{ id: "grok-4.7", name: "Grok 4.7", description: "Best", efforts: ["low", "high"], contextWindow: 500000 }] });
	host.onMessage({ method: "_x.ai/mcp/servers_updated", params: { mcpServers: [{ name: "github", source: "user" }, { source: "nameless" }] } });
	assert.deepEqual(plain(events.at(-1)), { type: "mcp", servers: [{ name: "github", source: "user", status: "" }] });
	host.onMessage({ method: "_x.ai/mcp/server_status", params: { name: "github", status: "connected" } });
	assert.deepEqual(plain(events.at(-1)), { type: "mcp-status", name: "github", status: "connected" });

	host.onUpdate({ sessionId: "sid-c", update: { sessionUpdate: "tool_call", toolCallId: "todo-1", title: "todo_write", rawInput: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }, { content: " ", status: "pending" }] } } });
	assert.deepEqual(plain(events.at(-1).tool.todos), [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }]);
	host.onMessage({ id: 90, method: "_x.ai/ask_user_question", params: { sessionId: "sid-c", toolCallId: "q-h", questions: [{ header: "Color", question: "Which?", options: [{ label: "Red" }] }] } });
	assert.equal(events.at(-1).tool.questions[0].header, "Color");

	const turn = host.turns.get("chat");
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "response_completed", usage: { input_tokens: 659, output_tokens: 102, cache_read_input_tokens: 25216, cache_creation_input_tokens: 0 } } } });
	assert.deepEqual(plain(events.at(-1)), { type: "context", contextTokens: 25977, contextWindow: 256000, uiSessionId: "chat", turnId: "turn-p" }, "each model call reports the context in use");
	host.parents.set("sid-sub", "sid-c");
	const beforeSub = events.length;
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-sub", update: { sessionUpdate: "response_completed", usage: { input_tokens: 999999 } } } });
	assert.equal(events.length, beforeSub, "a subagent's model calls do not change the session's context");
	host.finishPrompt(turn, 2, { stopReason: "end_turn", _meta: { modelId: "grok-4.7", usage: { inputTokens: 40000, outputTokens: 1000, cachedReadTokens: 30000, reasoningTokens: 200, modelCalls: 4, costUsdTicks: 2500000000 } } });
	const usage = events.find((event) => event.type === "usage");
	assert.deepEqual(plain(usage.usage), { model: "grok-4.7", inputTokens: 40000, outputTokens: 1000, cachedReadTokens: 30000, reasoningTokens: 200, modelCalls: 4, contextTokens: 25977, contextWindow: 500000, costUsd: 0.25 }, "the turn's usage keeps the last model call's context size");
	assert.equal(usage.turnId, "turn-p");
	assert.equal(events.at(-1).type, "done");

	const slashTurn = { uiSessionId: "chat", turnId: "turn-s", cwd, allowedFolders: [], mode: "Manual", agentSessionId: "sid-c", promptId: 4, finished: false, cancelled: false, slash: true, said: false };
	host.turns.set("chat", slashTurn);
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "memory_files", files: [{ path: "C:\\Users\\me\\.grok\\MEMORY.md", source: "global" }, { path: "C:\\Users\\me\\.grok\\w\\observations/_inbox\\a.md", source: "workspace" }] } } });
	assert.equal(events.at(-1).text, "Memory files:\n- `C:\\Users\\me\\.grok\\MEMORY.md` (global)\n\n1 raw observation note not shown.", "/memory lists Grok's memory files");
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "auto_compact_completed", tokens_before: 26433, tokens_after: 9000 } } });
	assert.equal(events.at(-2).text, "Compacted the conversation: 26433 to 9000 tokens.", "/compact reports its result");
	assert.equal(events.at(-1).contextTokens, 9000, "compaction updates the context in use");
	host.finishPrompt(slashTurn, 4, { stopReason: "end_turn" });
	assert.equal(events.filter((event) => event.turnId === "turn-s" && event.type === "chunk").length, 2, "a command that said something gets no fallback line");
	const quietTurn = { uiSessionId: "chat", turnId: "turn-q", cwd, allowedFolders: [], mode: "Manual", agentSessionId: "sid-c", promptId: 5, finished: false, cancelled: false, slash: true, said: false };
	host.turns.set("chat", quietTurn);
	host.finishPrompt(quietTurn, 5, { stopReason: "end_turn" });
	assert.equal(events.find((event) => event.turnId === "turn-q" && event.type === "chunk").text, "Grok ran the command. It sent no output.", "a silent command still answers");
	const plainTurn = { uiSessionId: "chat", turnId: "turn-n", cwd, allowedFolders: [], mode: "Manual", agentSessionId: "sid-c", promptId: 6, finished: false, cancelled: false, slash: false, said: false };
	host.turns.set("chat", plainTurn);
	host.onMessage({ method: "_x.ai/session_notification", params: { sessionId: "sid-c", update: { sessionUpdate: "auto_compact_completed", tokens_before: 1, tokens_after: 1 } } });
	host.finishPrompt(plainTurn, 6, { stopReason: "end_turn" });
	assert.equal(events.some((event) => event.turnId === "turn-n" && event.type === "chunk"), false, "automatic compaction during a normal turn adds no text");

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
		sent.host.ensureChild = async () => {};
		sent.host.ensureSession = async () => ({ sessionId: "agent-chat" });
		sent.host.applyConfig = async () => {};
		sent.host.applyMode = async () => {};
		const prompts = [];
		sent.host.request = (method, params) => { prompts.push({ method, params }); return { id: 1, promise: new Promise(() => {}) }; };
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

(async () => {
	await checkSessions();
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
	console.log("Agent regression checks passed: parallel sessions, cancellation, restoration, configuration, independent permissions, edit-folder/home boundaries, process failure cleanup/diagnostics, tool policy, questions, plan approval, plan mode sync, tool rows, Always allow scope, Grok commands/models/MCP, todos, usage and attachments.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
