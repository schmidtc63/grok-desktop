const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { CloudHost, createCursorApi, createCursorKey, createSseParser, mapEvent } = require("../electron/cloud.cjs");

const fakeKey = "test-not-a-key";
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "cloud", name), "utf8");

function parse(text, width = text.length) {
	const events = [];
	const parser = createSseParser((event) => events.push(event));
	for (let index = 0; index < text.length; index += width) { parser.push(text.slice(index, index + width)); }
	parser.end();
	return events;
}

function checkParser() {
	const source = fixture("run.sse.txt");
	const events = parse(source);
	const counts = {};
	for (const { event } of events) { counts[event] = (counts[event] ?? 0) + 1; }
	assert.deepEqual(counts, { assistant: 206, thinking: 13, tool_call: 17, interaction_update: 414, status: 2, result: 1, done: 1 });
	for (const width of [1, 7, 4096]) { assert.deepEqual(parse(source, width), events, `SSE fragments of ${width} characters replay identically`); }
	assert.deepEqual(parse(source.replace(/\r?\n/g, "\r\n"), 7), events, "CRLF framing also works across fragments");
	const multiline = ': keepalive\r\nevent: assistant\r\nid: 7\r\ndata: {"text":\r\ndata: "hello"}\r\n\r\nevent: custom\ndata: plain\ndata: text\n\n';
	assert.deepEqual(parse(multiline, 1), [{ event: "assistant", id: "7", data: { text: "hello" } }, { event: "custom", data: "plain\ntext" }]);
	console.log("PASS cloud SSE parser replays recorded counts across fragment widths, CRLF, comments and multiline data");
	return events;
}

function checkMapping(events) {
	const state = {};
	const mapped = events.flatMap((event) => mapEvent(event, state));
	const assistantText = events.filter(({ event }) => event === "assistant").map(({ data }) => data.text).join("");
	assert.equal(mapped.filter(({ type }) => type === "chunk").map(({ text }) => text).join(""), assistantText, "a question-only result adds neither duplicate text nor a link");
	const tools = new Map();
	for (const { type, tool } of mapped) {
		if (type !== "tool") { continue; }
		assert.equal(tool.waiting, false);
		assert.ok(tool.id);
		tools.set(tool.id, tool);
	}
	assert.equal(tools.size, 7, "running and completed events update the same row");
	for (const tool of tools.values()) { assert.match(tool.detail, /^Completed(?: ·|$)/); }
	assert.equal(mapped.at(-1).type, "done");
	assert.equal(mapped.at(-1).text, undefined);

	const apiEvents = fixture("api-run.jsonl").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
	const result = apiEvents.find(({ event }) => event === "result");
	const done = apiEvents.find(({ event }) => event === "done");
	assert.ok(result && done);
	const decode = ({ event, data }) => ({ event, data: typeof data === "string" && data ? JSON.parse(data) : data });
	const final = decode(result);
	const branch = final.data.git.branches.find((entry) => entry.branch && entry.prUrl);
	assert.ok(branch);
	const finalState = {};
	const output = [...mapEvent(final, finalState), ...mapEvent(decode(done), finalState)];
	assert.ok(output.some(({ type, text }) => type === "chunk" && text.includes(branch.branch) && text.includes(branch.prUrl)), "the branch and PR reach the reply before done");
	assert.equal(output.at(-1).type, "done");
	assert.equal(output.at(-1).text, undefined);

	const credit = mapEvent({ event: "error", data: { code: "usage_limit_exceeded", message: "Prepaid balance exhausted." } }, {});
	assert.deepEqual(credit.map(({ type }) => type), ["chunk"], "an SSE error adds text without ending the turn");
	assert.equal(credit[0].text.trim(), "Cursor reported an error: Cursor refused to start the agent: your Cursor credit is used up. Add credit on your [Cursor usage page](https://cursor.com/dashboard?tab=usage).");
	console.log("PASS cloud mapping preserves deltas, completes seven tool rows, emits result links before done and reports exhausted credit");
}

async function bounded(promise, label) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle.`)), 5000); })]);
	} finally { clearTimeout(timer); }
}

async function withServer(handle, test) {
	const requests = [];
	const server = http.createServer((request, response) => {
		requests.push({ method: request.method, url: request.url, headers: request.headers });
		request.resume();
		handle(request, response);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	try {
		const api = createCursorApi({
			getKey: () => fakeKey, baseUrl, timeoutMs: 100, createTimeoutMs: 200,
			fetch: (url, options) => {
				assert.ok(new URL(url).origin === baseUrl, "cloud test requests stay on loopback");
				return fetch(url, { ...options, redirect: "error" });
			},
		});
		await test(api, requests);
		assert.ok(requests.every(({ headers }) => headers.authorization === `Bearer ${fakeKey}`), "every request sends the expected fake bearer header");
	} finally {
		await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
	}
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function collectStream(api, scenario, onEvent = () => {}) {
	const events = [];
	let stream;
	try {
		await bounded(new Promise((resolve) => {
			stream = api.stream("agent", scenario, (event) => {
				events.push(event);
				onEvent(event);
				if (["closed", "expired", "done"].includes(event.event)) { resolve(); }
			}, { idleMs: scenario === "idle" ? 200 : 1000 });
		}), `Stream ${scenario}`);
		assert.ok(!JSON.stringify(events).includes(fakeKey), "stream events omit the fake bearer key");
		return events;
	} finally { stream?.stop(); }
}

async function checkStream() {
	let cut;
	let stopped;
	const stopClosed = new Promise((resolve) => { stopped = resolve; });
	await withServer((request, response) => {
		const scenario = /^\/v1\/agents\/agent\/runs\/([^/]+)\/stream$/.exec(request.url)?.[1];
		if (scenario === "headers") { return; }
		if (scenario === "expired" || scenario === "unavailable") {
			response.writeHead(scenario === "expired" ? 410 : 503, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { code: scenario, message: fakeKey } }));
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.flushHeaders();
		if (scenario === "drop") {
			cut = () => response.destroy();
			response.write(frame("status", { status: "FINISHED" }) + frame("assistant", { text: `hello ${fakeKey}` }));
		} else if (scenario === "body") {
			response.write(frame("heartbeat", {}));
			const timer = setTimeout(() => response.end(frame("done", {})), 150);
			response.once("close", () => clearTimeout(timer));
		} else if (scenario === "stop") {
			response.once("close", stopped);
			response.write(frame("status", { status: "RUNNING" }));
		}
	}, async (api, requests) => {
		const dropped = await collectStream(api, "drop", ({ event }) => { if (event === "assistant") { cut(); } });
		assert.deepEqual(dropped.map(({ event }) => event), ["status", "assistant", "closed"], "FINISHED followed by a socket loss is still a dropped stream");
		assert.match(dropped[1].data.text, /hello \[redacted\]/);
		const idle = await collectStream(api, "idle");
		assert.deepEqual(idle.map(({ event, reason }) => [event, reason]), [["closed", "idle"]]);
		assert.deepEqual((await collectStream(api, "expired")).map(({ event }) => event), ["expired"]);
		assert.deepEqual((await collectStream(api, "unavailable")).map(({ event }) => event), ["closed"], "503 is a dropped connection");
		assert.deepEqual((await collectStream(api, "headers")).map(({ event }) => event), ["closed"], "header timeout is a dropped connection");
		assert.deepEqual((await collectStream(api, "body")).map(({ event }) => event), ["heartbeat", "done"], "the body can outlive the response-header timeout");

		const stopEvents = [];
		let first;
		const received = new Promise((resolve) => { first = resolve; });
		const stream = api.stream("agent", "stop", (event) => { stopEvents.push(event); first(); }, { idleMs: 200 });
		try {
			await bounded(received, "Stopped stream's first event");
			stream.stop();
			await bounded(stopClosed, "Stopped stream connection close");
			assert.deepEqual(stopEvents.map(({ event }) => event), ["status"], "stopping the client quietly aborts the connection");
		} finally { stream.stop(); }
		assert.equal(requests.length, 7, "the stream client never retries by itself");
		assert.ok(requests.every(({ headers }) => headers.accept === "text/event-stream" && !Object.hasOwn(headers, "last-event-id")), "streams replay without Last-Event-ID");
	});
	console.log("PASS cloud stream handles drops, idle, expiry, HTTP and header failures, long bodies, quiet stop and masked replay");
}

async function checkApi() {
	let creates = 0;
	let createBody = "";
	await withServer((request, response) => {
		if (request.method === "POST" && request.url === "/v1/agents" && creates++ === 0) {
			request.setEncoding("utf8");
			request.on("data", (chunk) => { createBody += chunk; });
			request.once("end", () => {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { code: "usage_limit_exceeded", message: `Prepaid balance exhausted. ${fakeKey}` } }));
			});
		} else if (request.url === "/v1/models") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write('{"models":');
		} else if (request.url === "/v1/agents/slow/runs") {
			const timer = setTimeout(() => response.end('{"run":{"id":"run-slow"}}'), 150);
			response.once("close", () => clearTimeout(timer));
		}
	}, async (api, requests) => {
		const model = { id: "grok-4.7", params: [{ id: "effort", value: "low" }] };
		const create = { name: "Example", prompt: "Add an example", model, repoUrl: "https://github.com/example/repo", ref: "feature/example", autoCreatePR: false };
		const denied = await bounded(api.create(create), "Credit refusal");
		assert.deepEqual(JSON.parse(createBody), {
			name: "Example",
			prompt: { text: "Add an example\n\nDon't open a pull request; push your branch only." },
			model,
			repos: [{ url: "https://github.com/example/repo", startingRef: "feature/example" }],
			autoCreatePR: false,
		});
		assert.equal(denied.ok, false);
		assert.equal(denied.status, 400);
		assert.equal(denied.code, "usage_limit_exceeded");
		assert.ok(!JSON.stringify(denied).includes(fakeKey));
		assert.equal(denied.error, "Prepaid balance exhausted. [redacted]");
		for (const [label, request] of [["API header timeout", () => api.me()], ["API body timeout", () => api.models()]]) {
			const result = await bounded(request(), label);
			assert.equal(result.ok, false);
			assert.equal(result.code, "timeout");
			assert.ok(!JSON.stringify(result).includes(fakeKey));
		}
		const timed = await bounded(api.create(create), "Create timeout");
		assert.equal(timed.ok, false);
		assert.equal(timed.code, "timeout");
		assert.equal(timed.error, "Cursor didn't answer in time. The agent may have started anyway; check cursor.com/agents before sending again.");
		assert.ok(!JSON.stringify(timed).includes(fakeKey));
		const followUp = await bounded(api.followUp("slow", "Follow up"), "Follow-up timeout");
		assert.deepEqual(followUp, {
			ok: false, status: 0, code: "timeout",
			error: "Cursor didn't answer in time. The run may have started anyway; check cursor.com/agents before sending again.",
		});
		assert.equal(requests.length, 5, "ordinary and start requests do not retry");
	});
	console.log("PASS cloud API preserves sanitized provider errors and bounds headers, bodies and uncertain creates without retries");
}

async function checkStartConnectionLoss() {
	await withServer((_request, response) => {
		response.writeHead(201, { "Content-Type": "application/json" });
		response.flushHeaders();
		response.write('{"run":');
		const timer = setTimeout(() => response.destroy(), 20);
		response.once("close", () => clearTimeout(timer));
	}, async (api, requests) => {
		const create = await bounded(api.create({ ...cloudRecord, name: "Example", prompt: "Add an example" }), "Dropped create response");
		const followUp = await bounded(api.followUp("agent", "Follow up"), "Dropped follow-up response");
		assert.deepEqual(create, {
			ok: false, status: 0, code: "connection",
			error: "Couldn't connect to Cursor. The agent may have started anyway; check cursor.com/agents before sending again.",
		});
		assert.deepEqual(followUp, {
			ok: false, status: 0, code: "connection",
			error: "Couldn't connect to Cursor. The run may have started anyway; check cursor.com/agents before sending again.",
		});
		assert.deepEqual(requests.map(({ method, url }) => [method, url]), [["POST", "/v1/agents"], ["POST", "/v1/agents/agent/runs"]]);
	});
	console.log("PASS cloud create and follow-up warn of an uncertain start when a 201 response body drops");
}

function checkKeyStore() {
	const file = "cursor-key.json";
	const files = new Map();
	const ciphertext = Buffer.from("test sealed bytes");
	const storage = {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "kwallet",
		encryptString(key) { assert.ok(key === fakeKey); return ciphertext; },
		decryptString(value) { assert.ok(value.equals(ciphertext)); return fakeKey; },
	};
	const missing = () => Object.assign(new Error("Test file missing"), { code: "ENOENT" });
	const fileSystem = {
		mkdirSync() {},
		openSync: (target) => target,
		writeFileSync: (target, text) => files.set(target, text),
		fsyncSync() {},
		closeSync() {},
		renameSync(source, target) { files.set(target, files.get(source)); files.delete(source); },
		readFileSync(target) { if (!files.has(target)) { throw missing(); } return files.get(target); },
		unlinkSync(target) { if (!files.delete(target)) { throw missing(); } },
	};
	const keyStore = (platform = "win32", overrides = {}, fileOverrides = {}) => createCursorKey({ file, platform, safeStorage: { ...storage, ...overrides }, fs: { ...fileSystem, ...fileOverrides } });
	const store = keyStore();
	const empty = { hasKey: false, keyReadable: false, keyring: true, name: "" };
	assert.deepEqual(store.status(), empty);
	for (const bad of ["", "two words", "x".repeat(513), "a\0b", undefined]) { assert.equal(store.save(bad, "Test").ok, false); }
	const noKeyring = keyStore("linux", { getSelectedStorageBackend: () => "basic_text" });
	assert.deepEqual(noKeyring.save(fakeKey, "Test"), { ok: false, error: "This computer has no keyring the app can use, so the Cursor key can't be saved." });
	assert.equal(noKeyring.status().keyring, false);
	assert.equal(files.size, 0);
	assert.equal(store.save(fakeKey, `Test ${fakeKey}`).ok, true);
	const saved = files.get(file);
	assert.ok(!saved.includes(fakeKey));
	assert.deepEqual(JSON.parse(saved), { key: ciphertext.toString("base64"), name: "Test [redacted]" });
	assert.ok(store.key() === fakeKey);
	assert.deepEqual(store.status(), { hasKey: true, keyReadable: true, keyring: true, name: "Test [redacted]" });
	const badDecrypt = keyStore("win32", { decryptString() { throw new Error(fakeKey); } });
	assert.deepEqual(badDecrypt.status(), { hasKey: true, keyReadable: false, keyring: true, name: "Test [redacted]" });
	assert.equal(badDecrypt.key(), "");
	for (const badStore of [keyStore("win32", { encryptString() { throw new Error(fakeKey); } }), keyStore("win32", {}, { renameSync() { throw new Error(fakeKey); } })]) {
		const failure = badStore.save(fakeKey, "Test");
		assert.equal(failure.ok, false);
		assert.ok(!JSON.stringify(failure).includes(fakeKey));
		assert.ok(files.get(file) === saved);
	}
	assert.equal(store.remove().ok, true);
	assert.equal(store.remove().ok, true);
	assert.deepEqual(store.status(), empty);
	files.set(file, "{");
	assert.deepEqual(store.status(), empty);
	console.log("PASS Cursor key store writes ciphertext only, shares keyring rules, and handles removal and unreadable storage");
}

const cloudRecord = {
	repoUrl: "https://github.com/example/repo", ref: "main", autoCreatePR: false,
	model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "low" }] },
};
const sendInput = { uiSessionId: "cloud-chat", turnId: "turn-one", text: "Add an example", name: "Example", cloud: cloudRecord };
const savedRun = { ...cloudRecord, agentId: "bc-example", runId: "run-example", active: true };
const createdRun = { ok: true, agent: { id: savedRun.agentId }, run: { id: savedRun.runId } };
const followUpRun = { ok: true, run: { id: "run-follow-up" } };
const sampleBranch = { repoUrl: "github.com/Example/Repo", branch: "cursor/example", prUrl: "https://github.com/example/repo/pull/7" };

function deferred() {
	let resolve;
	const promise = new Promise((finish) => { resolve = finish; });
	return { promise, resolve };
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `${label} did not arrive.`);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

function fakeHost({ getKey = () => fakeKey, retryDelays = [0, 0, 0, 0, 0], waitNoticeMs, ...overrides } = {}) {
	const events = [];
	const calls = { create: [], followUp: [], cancel: [], run: [] };
	const streams = [];
	const defaults = { create: createdRun, followUp: followUpRun, cancel: { ok: true }, run: { ok: true, status: "RUNNING" } };
	const api = Object.fromEntries(Object.keys(defaults).map((method) => [method, async (...args) => {
		calls[method].push(args);
		return overrides[method] ? overrides[method](...args) : defaults[method];
	}]));
	api.stream = (agentId, runId, onEvent) => {
		const stream = { agentId, runId, stops: 0, send: (event, data = {}, id) => onEvent({ event, data, ...(id === undefined ? {} : { id }) }), stop() { this.stops += 1; } };
		streams.push(stream);
		return stream;
	};
	const host = new CloudHost((event) => events.push(event), { api, getKey, retryDelays, waitNoticeMs });
	return { host, events, calls, streams, send: (patch) => host.send({ ...sendInput, ...patch }), resume: (patch) => host.resume({ ...sendInput, cloud: savedRun, ...patch }) };
}

const chatText = (events) => events.filter(({ type }) => type === "chunk").map(({ text }) => text).join("");

async function checkHostSend() {
	const f = fakeHost();
	for (const cloud of [{ ...cloudRecord, agentId: ".." }, { ...cloudRecord, runId: "." }, { ...cloudRecord, repoUrl: "https://github.com/example/.." }, { ...cloudRecord, repoUrl: "https://other.test/example/repo" }, { ...cloudRecord, model: { id: "default", params: [{ id: "effort", value: false }] } }]) {
		assert.equal(f.send({ cloud }).ok, false);
	}
	assert.equal(f.send({ text: " " }).ok, false);
	assert.match(f.send({ cloud: savedRun }).error, /Resume the active Cloud run/);
	assert.equal(f.resume({ cloud: { ...savedRun, runId: "../other" } }).ok, false);
	assert.equal(f.calls.create.length, 0);
	assert.equal(f.send().ok, true);
	assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId);
	assert.equal(f.send({ turnId: "second" }).ok, false);
	await waitFor(() => f.streams.length === 1, "Initial Cloud stream");
	assert.deepEqual(f.calls.create, [[{ name: sendInput.name, prompt: sendInput.text, ...cloudRecord }]]);
	assert.deepEqual(f.events.map(({ type, active }) => [type, active]), [["cloud-state", true]]);
	f.streams[0].send("status", { status: "FINISHED" });
	assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId);
	f.streams[0].send("assistant", { text: "The answer" });
	f.streams[0].send("result", { text: "Duplicated result", git: { branches: [{ ...sampleBranch, repoUrl: "github.com/another/repo" }, sampleBranch] } });
	f.streams[0].send("done");
	assert.deepEqual(f.events.slice(-2).map(({ type, active }) => [type, active]), [["cloud-state", false], ["done", undefined]]);
	assert.equal(f.events.at(-2).branch, sampleBranch.branch);
	assert.equal(f.events.at(-2).prUrl, sampleBranch.prUrl);
	assert.match(chatText(f.events), /The answer/);
	assert.ok(!chatText(f.events).includes("Duplicated result"));
	assert.equal(f.host.turnOf(sendInput.uiSessionId), undefined);
	assert.equal(f.streams[0].stops, 1);
	assert.equal(f.send({ turnId: "turn-two", text: "Follow up", cloud: { ...savedRun, active: false } }).ok, true);
	await waitFor(() => f.streams.length === 2, "Follow-up Cloud stream");
	assert.deepEqual(f.calls.followUp, [[savedRun.agentId, "Follow up"]]);
	assert.equal(f.streams[1].runId, followUpRun.run.id);
	f.streams[1].send("done");
	assert.ok(f.events.every((event) => event.uiSessionId === sendInput.uiSessionId && typeof event.turnId === "string"));
	console.log("PASS CloudHost validates sends and IDs, creates and follows up, and publishes state before done");
}

async function checkHostMasking() {
	const endingX = "test-cursor-key-ending-x";
	const xai = `xai-${"p".repeat(36)}`;
	let keyReads = 0;
	const f = fakeHost({ getKey: () => { keyReads += 1; return endingX; } });
	f.send();
	await waitFor(() => f.streams.length === 1, "Masked Cloud stream");
	const stream = f.streams[0];
	stream.send("assistant", { text: `Saved key ${endingX}` });
	stream.send("assistant", { text: ` and xAI key ${xai.slice(0, 14)}` });
	stream.send("interaction_update", { type: "assistant.delta" });
	stream.send("heartbeat");
	stream.send("assistant", { text: `${xai.slice(14)}.` });
	stream.send("tool_call", { callId: "call-one", name: "run_terminal_cmd", status: "running", args: { command: `${"a".repeat(172)} ${xai}` } });
	stream.send("done");
	assert.equal(keyReads, 1, "masking reuses the turn's key through every event");
	assert.ok(!JSON.stringify(f.events).includes(endingX) && !JSON.stringify(f.events).includes(xai));
	assert.equal(chatText(f.events), "Saved key [redacted] and xAI key [redacted].");
	assert.ok(!f.events.find(({ type }) => type === "tool").tool.summary.includes("xai-"));
	const empty = fakeHost({ getKey: () => "" });
	empty.send();
	await waitFor(() => empty.streams.length === 1, "Empty-key test stream");
	empty.streams[0].send("assistant", { text: "ordinary text ends in x" });
	empty.streams[0].send("done");
	assert.equal(chatText(empty.events), "ordinary text ends in x");
	console.log("PASS CloudHost masks the Cursor key, split xAI deltas and clipped tool text, with an empty-key guard");
}

async function checkHostCancel() {
	for (const followUp of [false, true]) {
		const pending = deferred();
		const f = fakeHost(followUp ? { followUp: () => pending.promise } : { create: () => pending.promise });
		f.send(followUp ? { cloud: { ...savedRun, active: false } } : undefined);
		assert.equal(f.host.cancel(sendInput.uiSessionId).ok, true);
		assert.equal(f.host.cancel(sendInput.uiSessionId).ok, true);
		assert.equal(f.calls.cancel.length, 0);
		pending.resolve(followUp ? followUpRun : createdRun);
		await waitFor(() => f.events.some(({ type }) => type === "done"), "Queued Cloud cancel");
		assert.deepEqual(f.calls.cancel, [[savedRun.agentId, followUp ? followUpRun.run.id : savedRun.runId]]);
		assert.equal(f.events.at(-1).stopReason, "cancelled");
		assert.deepEqual(f.events.filter(({ type }) => type === "cloud-state").map(({ active }) => active), [true, false]);
	}
	const f = fakeHost({ cancel: async () => ({ ok: false, error: `Provider declined ${fakeKey}` }) });
	f.send();
	await waitFor(() => f.streams.length === 1, "Cancellable Cloud stream");
	f.host.cancel(sendInput.uiSessionId);
	await waitFor(() => f.events.some(({ type }) => type === "chunk"), "Cancellation refusal");
	assert.ok(!JSON.stringify(f.events).includes(fakeKey));
	assert.match(chatText(f.events), /Provider declined \[redacted\].*cursor.com\/agents/);
	assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId);
	assert.equal(f.streams[0].stops, 0);
	assert.equal(f.events.some(({ type }) => type === "done" || type === "error"), false);
	f.streams[0].send("assistant", { text: "Still working." });
	f.streams[0].send("done");
	assert.equal(f.events.at(-1).stopReason, undefined);
	console.log("PASS CloudHost queues Stop through create and follow-up and keeps streaming if cancel fails");
}

async function checkHostReplay() {
	const f = fakeHost();
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before replay");
	const first = f.streams[0];
	first.send("assistant", { text: "Original partial" });
	first.send("status", { status: "FINISHED" });
	first.send("closed");
	await waitFor(() => f.streams.length === 2, "Reconnected Cloud stream");
	assert.deepEqual(f.events.map(({ type }) => type), ["cloud-state", "chunk"]);
	first.send("assistant", { text: "Stale callback" });
	f.streams[1].send("status", { status: "FINISHED" });
	assert.deepEqual(f.events.at(-1), { type: "turn-start", resume: true, uiSessionId: sendInput.uiSessionId, turnId: sendInput.turnId });
	f.streams[1].send("assistant", { text: "Replayed answer" });
	assert.equal(f.resume({ turnId: "unrelated-turn" }).ok, false);
	assert.equal(f.streams.length, 2);
	assert.equal(f.resume().ok, true);
	assert.equal(f.streams.length, 3);
	assert.equal(f.streams[1].stops, 1);
	f.streams[1].send("done");
	assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId);
	f.streams[2].send("assistant", { text: "Owner reloaded" });
	f.streams[2].send("done");
	assert.equal(f.events.filter(({ type }) => type === "turn-start").length, 2);
	assert.equal(chatText(f.events), "Original partialReplayed answerOwner reloaded");
	assert.equal(f.events.at(-1).type, "done");
	console.log("PASS CloudHost replays on first real event, rejects stale callbacks and preserves one live stream on resume");
}

async function checkHostRecovery() {
	const f = fakeHost();
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before failures");
	f.streams[0].send("assistant", { text: "Retain this partial answer" });
	for (let index = 0; index < 6; index++) {
		await waitFor(() => f.streams.length === index + 1, "Cloud retry attempt");
		f.streams[index].send("closed");
	}
	await waitFor(() => f.events.at(-1)?.type === "error", "Retry exhaustion result");
	assert.deepEqual(f.calls.run, [[savedRun.agentId, savedRun.runId]]);
	assert.equal(f.events.at(-2).active, true);
	assert.match(f.events.at(-1).message, /still be working.*cursor.com\/agents/);
	assert.equal(f.events.some(({ type }) => type === "turn-start"), false);
	assert.equal(chatText(f.events), "Retain this partial answer");
	assert.equal(f.host.turnOf(sendInput.uiSessionId), undefined);

	const recovered = fakeHost({ retryDelays: [0], run: async () => ({ ok: true, status: "FINISHED", result: "Complete result", git: { branches: [sampleBranch] } }) });
	recovered.send();
	await waitFor(() => recovered.streams.length === 1, "Cloud stream before recovery");
	recovered.streams[0].send("assistant", { text: "Obsolete partial" });
	recovered.streams[0].send("closed");
	await waitFor(() => recovered.streams.length === 2, "First recovery replay");
	recovered.streams[1].send("expired");
	await waitFor(() => recovered.events.at(-1)?.type === "done", "Expired stream run lookup");
	const lastReset = recovered.events.findLastIndex(({ type }) => type === "turn-start");
	assert.match(chatText(recovered.events.slice(lastReset + 1)), /^Complete result[\s\S]*cursor\/example[\s\S]*pull\/7/);
	assert.equal(recovered.events.at(-2).active, false);
	assert.equal(recovered.events.at(-2).prUrl, sampleBranch.prUrl);
	console.log("PASS CloudHost retries five times, retains live runs and fills terminal fallback results");
}

async function checkStatusRetryBudget() {
	const f = fakeHost({ retryDelays: [0, 0] });
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before status-only drops");
	for (let index = 0; index < 3; index++) {
		await waitFor(() => f.streams.length === index + 1, "Status-only retry");
		f.streams[index].send("status", { status: "RUNNING" });
		f.streams[index].send("closed");
	}
	await waitFor(() => f.events.at(-1)?.type === "error", "Status-only reconnects stop at the retry limit");
	assert.equal(f.streams.length, 3, "status frames do not buy extra reconnects");
	assert.equal(f.calls.run.length, 1);
	console.log("PASS Cloud status frames do not reset the reconnect budget");
}

async function checkHeartbeatRetryBudget() {
	const f = fakeHost({ retryDelays: [0, 0] });
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before heartbeat drops");
	for (let index = 0; index < 3; index++) {
		await waitFor(() => f.streams.length === index + 1, "Heartbeat retry");
		f.streams[index].send("heartbeat");
		f.streams[index].send("closed");
	}
	await waitFor(() => f.events.at(-1)?.type === "error", "Heartbeat reconnects stop at the retry limit");
	assert.equal(f.streams.length, 3, "heartbeats do not buy extra reconnects");
	assert.equal(f.calls.run.length, 1);
	console.log("PASS Cloud heartbeats do not reset the reconnect budget");
}

async function checkResendRetryBudget() {
	const f = fakeHost({ retryDelays: [0] });
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before a resent frame");
	f.streams[0].send("assistant", { text: "Partial answer" }, "evt-1");
	f.streams[0].send("closed");
	await waitFor(() => f.streams.length === 2, "Reconnect after the first drop");
	f.streams[1].send("assistant", { text: "Partial answer" }, "evt-1");
	f.streams[1].send("closed");
	await waitFor(() => f.events.at(-1)?.type === "error", "A resent frame does not buy another reconnect");
	assert.equal(f.streams.length, 2, "resent frames do not reset the reconnect budget");
	assert.equal(f.calls.run.length, 1);
	console.log("PASS Cloud resent frames do not reset the reconnect budget");
}

async function checkProgressResetsRetryBudget() {
	const f = fakeHost({ retryDelays: [0] });
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before new progress");
	f.streams[0].send("assistant", { text: "One" }, "evt-1");
	f.streams[0].send("closed");
	await waitFor(() => f.streams.length === 2, "Retry before new progress");
	f.streams[1].send("assistant", { text: "Two" }, "evt-2");
	f.streams[1].send("closed");
	await waitFor(() => f.streams.length === 3, "New run progress resets the reconnect budget");
	assert.equal(f.calls.run.length, 0);
	f.streams[2].send("closed");
	await waitFor(() => f.events.at(-1)?.type === "error", "Drops after the reset still stop at the limit");
	assert.equal(f.streams.length, 3);
	assert.equal(f.calls.run.length, 1);
	console.log("PASS Cloud new run progress resets the reconnect budget");
}

async function checkHostDetachAndErrors() {
	const f = fakeHost();
	f.send();
	await waitFor(() => f.streams.length === 1, "Cloud stream before detach");
	f.host.stop(sendInput.uiSessionId);
	assert.equal(f.host.turnOf(sendInput.uiSessionId), undefined);
	assert.equal(f.streams[0].stops, 1);
	assert.equal(f.calls.cancel.length, 0);
	f.streams[0].send("done");
	assert.deepEqual(f.events.map(({ type, active }) => [type, active]), [["cloud-state", true]]);
	assert.equal(f.resume().ok, true);
	f.streams[1].send("error", { code: "provider_error", message: "Cursor had a problem" });
	assert.match(chatText(f.events), /Cursor reported an error: Cursor had a problem/);
	assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId);
	f.streams[1].send("done");
	assert.equal(f.events.at(-1).type, "done");

	const pending = deferred();
	const detached = fakeHost({ create: () => pending.promise });
	detached.send();
	detached.host.stop(sendInput.uiSessionId);
	pending.resolve(createdRun);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(detached.calls.cancel.length, 0);
	assert.equal(detached.streams.length, 0);
	assert.equal(detached.events.length, 0);

	const credit = fakeHost({ create: async () => ({ ok: false, code: "usage_limit_exceeded", error: fakeKey }) });
	credit.send();
	await waitFor(() => credit.events.length === 1, "Cloud credit error");
	assert.equal(credit.events[0].type, "error");
	assert.match(credit.events[0].message, /Cursor credit is used up/);
	assert.equal(credit.host.turnOf(sendInput.uiSessionId), undefined);
	console.log("PASS CloudHost detaches without cancelling, preserves resumability and distinguishes stream errors from failed starts");
}

const machineRecord = { ...cloudRecord, machine: "laptop" };
const savedMachineRun = { ...savedRun, machine: machineRecord.machine };
const machineHint = " Check that Cursor's worker is running on laptop, in a clone of this repository.";
const detachedRefusal = (machine) => ({ ok: false, error: `A run this app started on ${machine} may still be working, so the app won't start another there until it restarts. Check cursor.com/agents.` });

async function checkMachineCreateBody() {
	const bodies = [];
	const followUpPath = `/v1/agents/${savedRun.agentId}/runs`;
	await withServer((request, response) => {
		if (request.method === "GET" && request.url.endsWith("/stream")) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(frame("result", { status: "FINISHED", git: { branches: [sampleBranch] } }) + frame("done", {}));
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.once("end", () => {
			bodies.push(body);
			response.writeHead(201, { "Content-Type": "application/json" });
			response.end(JSON.stringify(request.url === followUpPath ? { run: followUpRun.run } : { agent: createdRun.agent, run: createdRun.run }));
		});
	}, async (api, requests) => {
		const common = { ...cloudRecord, name: sendInput.name, prompt: sendInput.text, ref: "feature/example" };
		const branch = "grok/machine-0123abcd";
		const note = `Before you start, run git fetch and switch to the branch ${branch}. If it doesn't exist yet, create it from origin/feature/example. Don't push and don't open a pull request; commit your work on that branch.`;
		const uiSessionId = "new-0123abcd-4567-489a-8123-0123456789ab";
		const cloud = { ...machineRecord, ref: common.ref, autoCreatePR: true };
		const followUp = "Continue the task";
		const events = [];
		const host = new CloudHost((event) => events.push(event), { api, getKey: () => fakeKey, retryDelays: [] });
		try {
			assert.equal(host.send({ ...sendInput, uiSessionId, cloud }).ok, true);
			await waitFor(() => events.at(-1)?.type === "done", "Loopback machine create");
			const first = events.at(-2);
			assert.equal(first.branch, sampleBranch.branch, "the final state retains the branch Cursor reports");
			assert.equal(events.at(-1).machine, "laptop");
			assert.equal(host.send({ ...sendInput, uiSessionId, turnId: "turn-two", text: followUp, cloud: { ...cloud, agentId: first.agentId, runId: first.runId, branch: first.branch, active: false } }).ok, true);
			await waitFor(() => events.at(-1)?.type === "done" && events.at(-1).turnId === "turn-two", "Loopback machine follow-up");
			assert.deepEqual(events.filter((event) => event.type === "cloud-state" && event.active).map((event) => event.branch), [branch, branch]);
			assert.equal(events.at(-1).machine, "laptop");
		} finally {
			host.stop(uiSessionId);
		}
		assert.equal((await bounded(api.create(common), "Ordinary Cloud create")).ok, true);
		assert.equal((await bounded(api.followUp(savedRun.agentId, followUp), "Ordinary Cloud follow-up")).ok, true);
		assert.deepEqual(requests.filter(({ method }) => method === "POST").map(({ url }) => url), ["/v1/agents", followUpPath, "/v1/agents", followUpPath]);
		const expected = { name: common.name, model: common.model, repos: [{ url: common.repoUrl, startingRef: common.ref }], autoCreatePR: false };
		assert.deepEqual(JSON.parse(bodies[0]), {
			...expected,
			env: { type: "machine", name: "laptop" },
			prompt: { text: `${common.prompt}\n\n${note}` },
		});
		assert.deepEqual(JSON.parse(bodies[1]), { prompt: { text: `${followUp}\n\n${note}` } });
		assert.deepEqual(JSON.parse(bodies[2]), {
			...expected,
			prompt: { text: `${common.prompt}\n\nDon't open a pull request; push your branch only.` },
		});
		assert.deepEqual(JSON.parse(bodies[3]), { prompt: { text: followUp } });
	});
	console.log("PASS machine create and follow-up use the same derived branch and saved ref, and ordinary Cloud bodies stay unchanged");
}

async function checkMachineValidation() {
	const f = fakeHost();
	for (const machine of ["", " laptop", "a b", "a\nb", "x;y", "-laptop", ".laptop", "laptop.", "a".repeat(65)]) {
		assert.deepEqual(f.send({ cloud: { ...cloudRecord, machine } }), { ok: false, error: "Enter the machine's name as its worker shows it." });
	}
	const ref = "topic;example";
	assert.deepEqual(f.send({ cloud: { ...machineRecord, ref } }), {
		ok: false,
		error: "A machine session can't use this branch name. Switch the folder to a branch whose name has only letters, digits, dots, dashes, underscores and slashes.",
	});
	assert.equal(f.calls.create.length, 0);
	for (const machine of ["a", "a.b", "laptop-2_", "a".repeat(64)]) {
		const count = f.streams.length;
		assert.equal(f.send({ cloud: { ...cloudRecord, machine } }).ok, true);
		await waitFor(() => f.streams.length > count, `Accepted machine ${machine}`);
		assert.equal(f.calls.create.at(-1)[0].machine, machine);
		f.streams.at(-1).send("done");
	}
	assert.equal(f.send({ cloud: { ...cloudRecord, ref } }).ok, true);
	await waitFor(() => f.streams.length === 5, "Ordinary Cloud accepts the same branch");
	assert.equal(f.calls.create.at(-1)[0].ref, ref);
	f.streams.at(-1).send("done");
	console.log("PASS machine names enforce safe endpoints and branch restrictions leave ordinary Cloud sends unchanged");
}

async function checkMachineClaims() {
	const f = fakeHost({ retryDelays: [] });
	const other = { uiSessionId: "other-cloud-chat", turnId: "other-turn", cloud: { ...machineRecord, machine: "LAPTOP" } };
	const liveRefusal = { ok: false, error: "Another session is using LAPTOP. Wait for it to finish or stop it." };
	assert.equal(f.send({ cloud: machineRecord }).ok, true);
	assert.deepEqual(f.send(other), liveRefusal);
	await waitFor(() => f.streams.length === 1, "First machine stream");
	assert.equal(f.calls.create[0][0].machine, "laptop");
	f.streams[0].send("closed");
	await waitFor(() => f.events.at(-1)?.type === "error", "Lost machine connection");
	assert.equal(f.events.at(-2).active, true);
	assert.equal(f.host.turnOf(sendInput.uiSessionId), undefined);
	assert.deepEqual(f.send(other), detachedRefusal("LAPTOP"));
	assert.equal(f.resume({ cloud: savedMachineRun }).ok, true, "the session that owns the machine can resume it");
	f.host.stop(sendInput.uiSessionId);
	assert.equal(f.streams[1].stops, 1);
	assert.deepEqual(f.calls.cancel, []);
	assert.deepEqual(f.send(other), detachedRefusal("LAPTOP"));

	const restarted = fakeHost();
	assert.equal(restarted.resume({ cloud: savedMachineRun }).ok, true);
	assert.deepEqual(restarted.send(other), liveRefusal);
	restarted.streams[0].send("done");
	assert.equal(restarted.events.at(-2).active, false);
	assert.equal(restarted.send(other).ok, true, "an inactive finish releases the machine for another session");
	await waitFor(() => restarted.streams.length === 2, "Next machine turn");
	restarted.streams[1].send("done");

	const pending = deferred();
	const creating = fakeHost({ create: () => pending.promise });
	assert.equal(creating.send({ cloud: machineRecord }).ok, true);
	await waitFor(() => creating.calls.create.length === 1, "Machine create before detach");
	creating.host.stop(sendInput.uiSessionId);
	assert.equal(creating.host.turnOf(sendInput.uiSessionId), undefined);
	assert.deepEqual(creating.send({ cloud: machineRecord, turnId: "retry-turn" }), detachedRefusal("laptop"));
	assert.equal(creating.calls.create.length, 1);
	pending.resolve(createdRun);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(creating.streams.length, 0, "a detached create does not open a stream when ids arrive");
	assert.equal(creating.resume({ cloud: savedMachineRun }).ok, true, "the claimant can resume using saved ids");
	creating.streams[0].send("done");
	console.log("PASS machine claims block overlapping and detached sends, including the claimant's create retry, until an inactive finish");
}

async function checkMachineCreateErrors() {
	for (const [status, code, error, hasHint] of [
		[400, "invalid_machine", "Cursor refused this machine.", true],
		[404, "machine_not_found", "The worker wasn't found.", true],
		[409, "conflict", "The worker can't take this run.", true],
		[400, "usage_limit_exceeded", "Prepaid balance exhausted.", false],
		[500, "http_error", "Cursor returned HTTP 500.", false],
		[0, "timeout", "Cursor didn't answer in time. The agent may have started anyway; check cursor.com/agents before sending again.", false],
		[0, "missing_key", "Add a Cursor key in Settings.", false],
	]) {
		const f = fakeHost({ create: async () => ({ ok: false, status, code, error }) });
		assert.equal(f.send({ cloud: machineRecord }).ok, true);
		await waitFor(() => f.events.at(-1)?.type === "error", `Machine create ${code}`);
		const message = f.events.at(-1).message;
		if (code === "usage_limit_exceeded") {
			assert.match(message, /Cursor credit is used up/);
			assert.ok(!message.includes(machineHint));
		} else {
			assert.equal(message, error + (hasHint ? machineHint : ""));
		}
		assert.equal(f.streams.length, 0);
		assert.equal(f.calls.create.length, 1, "the failed start is not retried");
		const next = f.send({ cloud: machineRecord, turnId: "next" });
		if (code === "timeout") { assert.deepEqual(next, detachedRefusal("laptop")); }
		else { assert.equal(next.ok, true, "a clear refusal releases the machine"); }
	}
	console.log("PASS machine create hints are limited to eligible provider refusals");
}

async function checkUncertainMachineStarts() {
	for (const [label, method, start] of [
		["connection", "create", () => ({ ok: false, status: 0, code: "connection" })],
		["thrown", "create", () => { throw new Error("Connection dropped."); }],
		["absent", "create", () => undefined],
		["invalid reply", "create", () => ({ ok: false, status: 200, code: "invalid_reply" })],
		["HTTP 502", "create", () => ({ ok: false, status: 502, code: "http_error" })],
		["HTTP 504", "followUp", () => ({ ok: false, status: 504, code: "http_error" })],
		["invalid run details", "followUp", () => ({ ok: true, run: { id: ".." } })],
	]) {
		const f = fakeHost({ [method]: start });
		const cloud = method === "create" ? machineRecord : { ...savedMachineRun, active: false };
		assert.equal(f.send({ cloud }).ok, true);
		await waitFor(() => f.events.at(-1)?.type === "error", label);
		assert.deepEqual(f.send({ uiSessionId: "other-window", cloud: { ...machineRecord, machine: "LAPTOP" } }), detachedRefusal("LAPTOP"));
		assert.deepEqual(f.resume({ cloud: savedMachineRun }), detachedRefusal("laptop"), "an old run cannot release the uncertain claim");
		assert.equal(f.events.some(({ type }) => type === "cloud-state"), false, "the unknown run is not saved as active");
		assert.equal(f.calls[method].length, 1);
	}
	const pending = deferred();
	const f = fakeHost({ create: () => pending.promise });
	assert.equal(f.send({ cloud: machineRecord }).ok, true);
	f.host.stop(sendInput.uiSessionId);
	assert.deepEqual(f.resume({ cloud: savedMachineRun }), detachedRefusal("laptop"));
	pending.resolve({ ok: false, status: 409, code: "conflict" });
	await new Promise(setImmediate);
	assert.equal(f.send({ cloud: machineRecord }).ok, true, "a refusal also releases a machine after its starting window closes");
	console.log("PASS uncertain machine starts block sends and stale resumes without saving or retrying an unknown run");
}

async function checkMachineResults() {
	for (const machine of [undefined, "laptop"]) {
		for (const source of ["stream", "recovery"]) {
			for (const status of ["ERROR", "FAILED", "FINISHED", "CANCELLED"]) {
				const f = fakeHost({ run: async () => ({ ok: true, status }) });
				assert.equal(f.resume({ cloud: { ...savedRun, machine } }).ok, true);
				if (source === "stream") {
					f.streams[0].send("result", { status });
					assert.equal(f.host.turnOf(sendInput.uiSessionId), sendInput.turnId, "a result waits for done");
					f.streams[0].send("done");
				} else {
					f.streams[0].send("expired");
				}
				const failedRun = status === "ERROR" || status === "FAILED";
				await waitFor(() => f.events.at(-1)?.type === (failedRun ? "error" : "done"), `Cloud ${source} ${status}`);
				const expected = ["ERROR", "FAILED"].includes(status) ? `Cursor ended the run with an error.${machine ? machineHint : ""}` : "";
				assert.equal(chatText(f.events).trim(), expected);
				assert.equal(f.events.at(-2).active, false);
				const done = f.events.at(-1);
				if (machine && status === "FINISHED") { assert.equal(done.machine, machine); }
				else { assert.equal(Object.hasOwn(done, "machine"), false, `${source} ${status} must not mark a machine successful`); }
				if (failedRun) { assert.equal(done.type, "error", `${source} ${status} ends the turn as a failure`); }
			}
		}
	}
	for (const pendingStop of [false, true]) {
		const cancel = deferred();
		const f = fakeHost({ cancel: () => cancel.promise });
		assert.equal(f.resume({ cloud: savedMachineRun }).ok, true);
		f.streams[0].send("result", { status: "FINISHED" });
		assert.equal(f.host.cancel(sendInput.uiSessionId).ok, true);
		if (pendingStop) { f.streams[0].send("done"); }
		cancel.resolve({ ok: true });
		await waitFor(() => f.events.at(-1)?.type === "done", "Stopped machine run");
		assert.equal(Object.hasOwn(f.events.at(-1), "machine"), false);
		if (!pendingStop) { assert.equal(f.events.at(-1).stopReason, "cancelled"); }
	}
	console.log("PASS machine success is reported only for eligible done events in stream and recovery, with errors and Stop excluded");
}

async function checkMachineNotes() {
	const waitNoticeMs = 50;
	const starting = "_Starting on laptop. Cursor takes about a minute to start a session on a machine._\n\n";
	const waiting = "_Waiting for laptop to pick up this run. If its worker isn't running, start it or press Stop._\n\n";
	const pending = deferred();
	const f = fakeHost({ waitNoticeMs, create: () => pending.promise });
	assert.equal(f.send({ cloud: machineRecord }).ok, true);
	await waitFor(() => f.calls.create.length === 1, "Machine create is pending");
	assert.equal(chatText(f.events), starting);
	assert.equal(f.streams.length, 0);
	pending.resolve(createdRun);
	await waitFor(() => f.streams.length === 1, "Waiting machine stream");
	f.streams[0].send("heartbeat");
	await waitFor(() => chatText(f.events).includes(waiting), "Waiting note after an idle machine stream");
	assert.equal(chatText(f.events), starting + waiting);
	f.streams[0].send("closed");
	await waitFor(() => f.streams.length === 2, "Machine reconnect after waiting");
	f.streams[1].send("heartbeat");
	await new Promise((resolve) => setTimeout(resolve, 2 * waitNoticeMs));
	assert.equal(chatText(f.events), starting + waiting, "neither notice repeats on reconnect");
	f.streams[1].send("done");

	const ordinary = fakeHost({ waitNoticeMs });
	assert.equal(ordinary.send().ok, true);
	await waitFor(() => ordinary.streams.length === 1, "Ordinary Cloud stream");
	assert.equal(chatText(ordinary.events), "");
	ordinary.streams[0].send("done");
	const followUp = fakeHost({ waitNoticeMs });
	assert.equal(followUp.send({ cloud: { ...savedMachineRun, active: false } }).ok, true);
	await waitFor(() => followUp.streams.length === 1, "Machine follow-up stream");
	assert.equal(followUp.calls.followUp[0][0], savedRun.agentId);
	assert.equal(chatText(followUp.events), "", "a machine follow-up gets no starting note");
	followUp.streams[0].send("thinking", { text: "Checking the task." });
	await new Promise((resolve) => setTimeout(resolve, 2 * waitNoticeMs));
	assert.equal(chatText(followUp.events), "", "early content suppresses the waiting note");
	followUp.streams[0].send("done");
	console.log("PASS machine notices precede create, wait for first content, and stay quiet on Cloud creates, timely content and replay");
}

async function main() {
	checkMapping(checkParser());
	await checkStream();
	await checkApi();
	await checkStartConnectionLoss();
	checkKeyStore();
	await checkHostSend();
	await checkHostMasking();
	await checkHostCancel();
	await checkHostReplay();
	await checkHostRecovery();
	await checkStatusRetryBudget();
	await checkHeartbeatRetryBudget();
	await checkResendRetryBudget();
	await checkProgressResetsRetryBudget();
	await checkHostDetachAndErrors();
	await checkMachineCreateBody();
	await checkMachineValidation();
	await checkMachineClaims();
	await checkMachineCreateErrors();
	await checkUncertainMachineStarts();
	await checkMachineResults();
	await checkMachineNotes();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
