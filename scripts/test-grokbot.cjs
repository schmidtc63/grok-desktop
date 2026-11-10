const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createGrokBot, createFrameParser, classify, methodAllowed } = require("../electron/grokbot.cjs");
const { startFakeServer, envelope } = require("./grokbot-fake-server.cjs");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message = "condition", limit = 2500) {
	const deadline = Date.now() + limit;
	while (!check()) { if (Date.now() > deadline) { throw new Error(`Timed out: ${message}`); } await pause(5); }
}
function memoryFs() {
	const files = new Map();
	return {
		files, mkdirSync() {}, openSync(file) { return file; }, fsyncSync() {}, closeSync() {},
		writeFileSync(file, value) { files.set(file, String(value)); },
		renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
		readFileSync(file) { if (!files.has(file)) { throw Object.assign(new Error("Missing"), { code: "ENOENT" }); } return files.get(file); },
		unlinkSync(file) { if (!files.delete(file)) { throw Object.assign(new Error("Missing"), { code: "ENOENT" }); } },
	};
}
const safeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 90)),
	decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 90)).toString(),
};
async function fixture(options = {}) {
	const fake = await startFakeServer({ heartbeatMs: 20, ...options.server });
	const fs = options.fs || memoryFs();
	const events = [], returns = [], opened = [], requests = [];
	const bot = createGrokBot({
		file: "/profile/grok-bot.json", healthFile: "/profile/grok-bot-health.json", fs, safeStorage, platform: "win32", version: "1.2.3", apiBase: fake.url, webBase: fake.url,
		retryDelays: [15, 30, 60], silenceMs: 200, requestTimeoutMs: 300, signInPollMs: 10, signInLimitMs: 500,
		emit: (event) => events.push(event), openExternal: (url) => { opened.push(url); if (url.includes("loginDeepControl") && options.approve !== false) { fake.approveSignIn(url); } },
		fetch: (url, init) => { assert.equal(new URL(url).origin, fake.url); requests.push({ url, init }); return (options.transport || fetch)(url, init); },
		...options.client,
	});
	const call = async (method, ...args) => { const result = await bot[method](...args); returns.push(result); return result; };
	return { fake, bot, fs, events, returns, opened, requests, call, health: () => JSON.parse(fs.files.get("/profile/grok-bot-health.json")), async ready() { assert.equal((await call("signIn")).ok, true); await until(() => bot.status().connection === "live", "live stream"); }, async close() { await bot.close(); await fake.close(); } };
}
async function withFixture(options, test) { const f = await fixture(options); try { await test(f); } finally { await f.close(); } }
const send = (f, text = "Hello", messageId = crypto.randomUUID()) => f.call("send", { agentId: "fake-bot-one", messageId, text });
const requestsFor = (f, method) => f.fake.state.requests.filter((request) => request.method === method);
function rawRow(seq, body, entryId = `entry-${seq}`) { return { seq: String(seq), updatedSeq: String(seq), entryId, entryKind: body.kind, body: Buffer.from(JSON.stringify(body)).toString("base64") }; }

async function main() {
	const frames = [], parser = createFrameParser((frame) => frames.push(frame));
	const bytes = Buffer.concat([envelope({ connected: {} }), envelope({ heartbeat: {} })]);
	for (const byte of bytes) { await parser.push(Buffer.from([byte])); }
	parser.end(); assert.equal(frames.length, 2);
	for (const bad of [envelope({}, 1), envelope({}, 4), envelope("{"), envelope({ error: { code: "unimplemented" } }, 2)]) { await assert.rejects(createFrameParser(() => {}).push(bad)); }
	const partial = createFrameParser(() => {}); await partial.push(bytes.subarray(0, 4)); assert.throws(() => partial.end());
	for (const [status, code, untilMs, expected] of [[401, "", Date.now() + 100000, "problem"], [403, "", Date.now() + 100000, "problem"], [401, "", 1, "expired"], [403, "", 1, "expired"], [404, "", 0, "problem"], [400, "", 0, "problem"], [429, "", 0, "retry"], [503, "", 0, "retry"], [0, "", 0, "retry"], ...["unavailable", "deadline_exceeded", "aborted", "canceled", "internal", "unknown", "resource_exhausted"].map((code) => [0, code, 0, "retry"]), [0, "unimplemented", 0, "problem"], [0, "permission_denied", 1, "expired"], [0, "unauthenticated", Date.now() + 100000, "problem"]]) { assert.equal(classify(status, code, untilMs), expected, `${status}/${code}`); }
	assert.equal(methodAllowed("SendGrokBotUserMessage"), true); assert.equal(methodAllowed("DeleteGrokBotAgent"), false);
	console.log("PASS Grok Bot framed parsing, method allow-list and connection classification");

	await withFixture({ approve: false }, async (f) => {
		await f.call("start"); assert.equal(f.requests.length, 0);
		const signing = f.call("signIn"); await until(() => requestsFor(f, "poll").length > 0);
		assert.equal(f.bot.status().signingIn, true); f.fake.approveSignIn(f.opened[0]); assert.equal((await signing).ok, true);
		await until(() => f.bot.status().connection === "live");
		assert.ok(requestsFor(f, "poll").length >= 2);
		const saved = f.fs.files.get("/profile/grok-bot.json"); assert.ok(!saved.includes(f.fake.state.token)); assert.ok(!saved.includes("refresh"));
		for (const { init } of f.requests) {
			assert.equal(init.redirect, "error");
			assert.deepEqual(Object.keys(init.headers).sort(), (init.headers.authorization ? ["authorization", "connect-protocol-version", "content-type", "user-agent"] : ["connect-protocol-version", "content-type", "user-agent"]));
			assert.equal(init.headers["user-agent"], "codewomplers-grok-desktop/1.2.3");
		}
	});
	await withFixture({ client: { safeStorage: { isEncryptionAvailable: () => false } } }, async (f) => { assert.equal((await f.call("signIn")).ok, false); assert.equal(f.requests.length, 0); });
	for (const mode of ["refused", "timeout", "cancelled"]) {
		await withFixture({ approve: false, client: { signInLimitMs: 45 } }, async (f) => {
			if (mode === "refused") { f.fake.queue("poll", { status: 403 }); }
			const pending = f.call("signIn");
			if (mode === "cancelled") { await until(() => requestsFor(f, "poll").length > 0); await f.call("cancelSignIn"); }
			assert.equal((await pending).ok, false); assert.equal(f.bot.status().signedIn, false); assert.equal(f.bot.status().signingIn, false);
		});
	}
	await withFixture({ server: { token: "t".repeat(2000) } }, async (f) => {
		await f.ready(); await f.bot.close();
		const again = createGrokBot({ file: "/profile/grok-bot.json", healthFile: "/profile/grok-bot-health.json", fs: f.fs, safeStorage, platform: "win32", version: "1.2.3", apiBase: f.fake.url, openExternal() {}, silenceMs: 1000 });
		try { assert.equal((await again.start()).signedIn, true); await until(() => again.status().connection === "live"); } finally { await again.close(); }
	});
	console.log("PASS Grok Bot sign-in polling, refusal, timeout, cancellation, keyring and long-token restart");

	await withFixture({}, async (f) => {
		await f.ready(); await until(() => Object.keys(f.bot.status().live).length === 2);
		f.fake.setLive("fake-bot-one", { isRunning: true, isComposingMessage: true, activity: { detail: "Reviewing the example" } });
		await until(() => f.bot.status().live["fake-bot-one"].composing);
		assert.equal(f.bot.status().live["fake-bot-one"].detail, "Reviewing the example");
		const id = crypto.randomUUID(); assert.equal((await send(f, "A local test", id)).accepted, true);
		const body = requestsFor(f, "SendGrokBotUserMessage")[0].body;
		assert.deepEqual({ ...body, sentAtMs: "timestamp" }, { agentId: "fake-bot-one", messageId: id, text: "A local test", sentAtMs: "timestamp", initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER", sendSource: "GROK_BOT_SEND_SOURCE_CHAT" });
		assert.match(body.sentAtMs, /^\d+$/); assert.equal((await send(f, "A local test", id)).delivery, "DUPLICATE");
		await send(f, "no");
		f.fake.queue("SendGrokBotUserMessage", { body: { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED", refusal: { message: `You cannot send more messages on this plan. ${f.fake.state.token}` } } });
		const refused = await send(f, "A local test", id); assert.equal(refused.ok, false); assert.equal(refused.error, "You cannot send more messages on this plan. [redacted]");
		for (const kind of ["timeout", "503"]) {
			for (const status of ["ACCEPTED", "PENDING", "NOT_FOUND", "REJECTED", "UNKNOWN_DURABILITY"]) {
				f.fake.queue("SendGrokBotUserMessage", kind === "timeout" ? { hold: true } : { status: 503 });
				f.fake.queue("GetGrokBotSendStatus", { body: { status: `GROK_BOT_SEND_STATUS_${status}` } });
				const before = requestsFor(f, "SendGrokBotUserMessage").length;
				const result = await send(f);
				assert.equal(result.ok, ["ACCEPTED", "PENDING"].includes(status));
				assert.equal(result.unknown === true, status === "UNKNOWN_DURABILITY");
				if (["NOT_FOUND", "REJECTED"].includes(status)) { assert.equal(result.error, "Not sent"); }
				assert.equal(requestsFor(f, "SendGrokBotUserMessage").length, before + 1);
			}
		}
		await send(f, "long task"); assert.equal((await f.call("stop", "fake-bot-one")).hadActiveRun, true);
		const count = f.requests.length;
		for (const [method, arg] of [["history", "unlisted"], ["stop", "unlisted"], ["send", { agentId: "unlisted", messageId: id, text: "No" }], ["answer", { agentId: "unlisted", entryId: "entry-1", value: "yes" }], ["openFile", { agentId: "unlisted", entryId: "entry-1" }]]) { assert.equal((await f.call(method, arg)).ok, false); }
		assert.equal(f.requests.length, count);
	});
	console.log("PASS Grok Bot send bodies, idempotency, uncertain delivery, single status check, Stop and owner validation");

	await withFixture({}, async (f) => {
		await f.ready();
		const token = f.fake.state.token, verifier = new URL(requestsFor(f, "poll")[0].url, f.fake.url).searchParams.get("verifier"), link = "https://files.example.test/private?signature=demo-secret";
		const ordinaryText = "See https://example.test/page and https://example.test/page/two for details.";
		const card = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "text", content: ordinaryText, cards: [{ type: "place", url: "https://example.test/page" }] } });
		await until(() => f.events.some((event) => event.type === "grokbot-rows" && event.rows.some((row) => row.entryId === card.entryId)));
		assert.equal(f.events.filter((event) => event.type === "grokbot-rows").flatMap((event) => event.rows).find((row) => row.entryId === card.entryId).body.message.content, ordinaryText);
		assert.equal((await f.call("history", "fake-bot-one")).rows.find((row) => row.entryId === card.entryId).body.message.content, ordinaryText);
		const attachment = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "attachment", url: link, file_name: "sample.txt", nested: { url: link }, caption: `Safe ${token} ${verifier} ${link}` } });
		await until(() => f.events.some((event) => event.type === "grokbot-rows" && event.rows.some((row) => row.entryId === attachment.entryId)));
		assert.equal((await f.call("openFile", { agentId: "fake-bot-one", entryId: attachment.entryId, url: "https://attacker.example.test" })).ok, true); assert.equal(f.opened.at(-1), link);
		const storedPath = "store/private-sample";
		const stored = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "attachment", url: storedPath, file_name: "stored.txt" } });
		const storedHistory = await f.call("history", "fake-bot-one");
		assert.ok(!JSON.stringify(storedHistory.rows.find((row) => row.entryId === stored.entryId)).includes(storedPath), "the attachment path itself stays in main");
		assert.equal((await f.call("openFile", { agentId: "fake-bot-one", entryId: stored.entryId })).ok, true); assert.match(f.opened.at(-1), /^https:/);
		f.fake.queue("ResolveGrokBotAttachmentReads", { body: { reads: [{ path: storedPath, outcome: "STORE", url: "http://unsafe.example.test" }] } });
		assert.equal((await f.call("openFile", { agentId: "fake-bot-one", entryId: stored.entryId })).ok, false);
		const reference = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "text", content: `Stored as ${storedPath}.` } });
		assert.equal((await f.call("history", "fake-bot-one")).rows.find((row) => row.entryId === reference.entryId).body.message.content, `Stored as ${storedPath}.`);
		const widget = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "widget", widget: { prompt: "Choose", options: [{ label: "Yes", value: "yes" }] } } });
		const rule = f.fake.addRow("fake-bot-one", { kind: "send-message", message: { type: "widget", widget: { ruleChange: { permission: "allow" }, options: [{ label: "Yes", value: "yes" }] } } });
		await f.call("history", "fake-bot-one");
		assert.equal((await f.call("answer", { agentId: "fake-bot-one", entryId: widget.entryId, value: "unknown" })).ok, false);
		assert.equal((await f.call("answer", { agentId: "fake-bot-one", entryId: rule.entryId, value: "yes" })).ok, false);
		assert.equal((await f.call("answer", { agentId: "fake-bot-one", entryId: widget.entryId, value: "yes" })).ok, true);
		f.fake.emit({ futureFrame: {} }); f.fake.emit({ [token]: {} });
		f.fake.addRow("fake-bot-one", { kind: "message", content: "no" });
		f.fake.addRow("fake-bot-one", { kind: "new-shape", content: "private row content" });
		f.fake.emit({ rows: { agentId: "fake-bot-one", entries: [{ seq: "800", updatedSeq: "800", entryId: "stored-entry", blobHash: "sample-hash" }] } });
		await until(() => f.health().storedRows === 1);
		assert.ok(f.health().unknownFrames.includes("futureFrame")); assert.ok(f.health().unknownFrames.includes("<other>"));
		assert.ok(f.health().unknownRows.includes("new-shape/unknown"));
		const surfaced = JSON.stringify([f.events, f.returns, f.bot.status(), f.health()]);
		for (const secret of [token, verifier, link, "https://files.example.test/resolved-example.txt"]) { assert.ok(!surfaced.includes(secret), `leaked ${secret.slice(0, 10)}`); }
		assert.ok(!surfaced.includes('"url":'));
		const healthText = JSON.stringify(f.health());
		for (const privateValue of ["fake-bot-one", "Demo Bot", "private row content", attachment.entryId]) { assert.ok(!healthText.includes(privateValue)); }
	});
	console.log("PASS Grok Bot plain questions, main-only attachment links, stored rows, sanitized events and health");

	await withFixture({}, async (f) => {
		await f.ready(); await until(() => f.bot.status().live["fake-bot-one"]);
		const initial = f.events.length, historyCount = requestsFor(f, "ListGrokBotTranscriptEntries").length;
		for (const type of ["rows", "agentState", "cursorTooOld", "cleared", "turnFailed", "rosterChanged", "connected", "futureFrame"]) {
			f.fake.emit({ [type]: { agentId: "fake-bot-one", sessionId: "thread-one", live: [{ agentId: "fake-bot-one", isRunning: true }], entries: [rawRow(99, { kind: "message", content: "Thread secret" })] } });
			f.fake.emit({ [type]: { agentId: "unlisted", live: [{ agentId: "unlisted", isRunning: true }], entries: [] } });
		}
		f.fake.emit({ agentState: { live: [{ agentId: "fake-bot-one", sessionId: "thread-one", isRunning: true }, { agentId: "unlisted", isRunning: true }] } });
		await until(() => f.health().threadFrames === 9); assert.equal(requestsFor(f, "ListGrokBotTranscriptEntries").length, historyCount); assert.ok(!JSON.stringify(f.events.slice(initial)).includes("Thread secret")); assert.equal(f.bot.status().live["fake-bot-one"].running, false);
		assert.ok(!JSON.stringify(f.health()).includes("thread-one")); assert.ok(!JSON.stringify(f.health()).includes("Thread secret"));
		const high = "9007199254740997";
		f.fake.emit({ rows: { agentId: "fake-bot-one", entries: [rawRow(high, { kind: "message", content: "High sequence" })], deletes: [{ seq: "1", updatedSeq: "9007199254740999", entryId: "entry-1" }] } });
		await until(() => f.events.some((event) => event.type === "grokbot-rows" && event.deletes.includes("entry-1")));
		f.fake.setLive("fake-bot-one", { isRunning: true }); await until(() => f.bot.status().live["fake-bot-one"].running);
		f.fake.endStreams(); await until(() => f.fake.state.streamCount >= 2);
		assert.equal(requestsFor(f, "WatchGrokBotTranscripts").at(-1).body.cursors.find((cursor) => cursor.agentId === "fake-bot-one").afterUpdatedSeq, "9007199254740999");
		assert.ok(f.events.some((event) => event.type === "grokbot-live" && event.agentId === "fake-bot-one" && !event.running));
		await until(() => f.bot.status().live["fake-bot-one"]?.running);
		for (const type of ["cursorTooOld", "cleared"]) {
			const streams = f.fake.state.streamCount, resets = f.events.filter((event) => event.type === "grokbot-reset").length;
			f.fake.emit({ [type]: { agentId: "fake-bot-one", newGeneration: 2 } });
			await until(() => f.fake.state.streamCount > streams);
			assert.ok(f.events.filter((event) => event.type === "grokbot-reset").length > resets);
		}
		const streams = f.fake.state.streamCount;
		f.fake.state.bots.push({ agentId: "fake-bot-three", name: "Third Bot", kind: "GROK_BOT_AGENT_KIND_AGENT", viewerIsOwner: true });
		f.fake.emit({ rosterChanged: { agentId: "fake-bot-three", kind: "GROK_BOT_ROSTER_CHANGE_KIND_CREATED" } });
		await until(() => f.bot.status().bots.some((bot) => bot.agentId === "fake-bot-three") && f.fake.state.streamCount > streams);
		assert.ok(requestsFor(f, "WatchGrokBotTranscripts").at(-1).body.cursors.some((cursor) => cursor.agentId === "fake-bot-three"));
	});
	console.log("PASS Grok Bot thread isolation, deletes, large cursors, reconnect snapshots and reset frames");

	for (const failure of [{ status: 404 }, { raw: envelope({ error: { code: "unimplemented" } }, 2) }, { raw: envelope({}, 1) }]) {
		await withFixture({}, async (f) => {
			f.fake.queue("WatchGrokBotTranscripts", failure); assert.equal((await f.call("signIn")).ok, true);
			await until(() => f.bot.status().connection === "problem"); assert.ok(f.health().problem);
			const count = f.requests.length; await pause(80); assert.equal(f.requests.length, count);
			await f.call("retry"); await until(() => f.bot.status().connection === "live"); assert.equal(f.health().problem, null);
		});
	}
	await withFixture({ client: { retryDelays: [20, 45], silenceMs: 1000 } }, async (f) => {
		for (let index = 0; index < 4; index++) { f.fake.queue("WatchGrokBotTranscripts", { raw: envelope({ connected: {} }) }); }
		await f.ready(); await until(() => requestsFor(f, "WatchGrokBotTranscripts").length >= 5);
		const times = requestsFor(f, "WatchGrokBotTranscripts").map((request) => request.at);
		for (let index = 1; index < 5; index++) { assert.ok(times[index] - times[index - 1] >= (index === 1 ? 17 : 40)); }
	});
	await withFixture({ server: { heartbeatMs: 10000 }, client: { silenceMs: 35 } }, async (f) => { await f.ready(); await until(() => f.fake.state.streamCount >= 2); });
	console.log("PASS Grok Bot protocol problems stop retrying, recovery clears health, close backs off and silence reconnects");
	for (const connection of ["live", "problem"]) {
		await withFixture({}, async (f) => {
			if (connection === "problem") { f.fake.queue("WatchGrokBotTranscripts", { status: 404 }); }
			assert.equal((await f.call("signIn")).ok, true); await until(() => f.bot.status().connection === connection);
			const savedHealth = f.fs.files.get("/profile/grok-bot-health.json");
			await f.call("close"); await until(() => f.fake.state.streams.size === 0);
			assert.equal(f.fs.files.get("/profile/grok-bot-health.json"), savedHealth);
			assert.equal(f.requests.find((request) => request.url.endsWith("/WatchGrokBotTranscripts")).init.signal.aborted, true);
		});
	}
	console.log("PASS Grok Bot shutdown preserves the last connection and problem health record");

	let holdHistory = false, releaseHistory, heldSignal;
	await withFixture({ transport: (url, init) => {
		if (holdHistory && url.endsWith("/ListGrokBotTranscriptEntries")) {
			holdHistory = false; heldSignal = init.signal;
			return new Promise((resolve) => { releaseHistory = resolve; });
		}
		return fetch(url, init);
	} }, async (f) => {
		await f.ready(); holdHistory = true; let settled = false;
		const pending = f.call("history", "fake-bot-one").then((result) => { settled = true; return result; }); await until(() => releaseHistory);
		await f.call("signOut"); const afterOut = f.events.length; assert.equal(heldSignal.aborted, true);
		f.fake.state.token = "second-account-token"; f.fake.state.bots = [{ agentId: "second-account-bot", name: "Second account" }];
		await f.ready(); assert.equal(f.bot.status().bots[0].agentId, "second-account-bot"); assert.equal(settled, false);
		releaseHistory(new Response(JSON.stringify({ entries: [rawRow(500, { kind: "message", content: "First account private row" }, "first-account-entry")] })));
		const result = await pending; assert.equal(result.ok, false);
		const surfaced = JSON.stringify([f.events.slice(afterOut), result, f.bot.status(), f.health()]);
		for (const privateValue of ["First account private row", "first-account-entry", "fake-bot-one"]) { assert.ok(!surfaced.includes(privateValue)); }
	});
	await withFixture({ client: { retryDelays: [100] } }, async (f) => {
		await f.ready(); f.fake.endStreams(); await until(() => f.bot.status().connection === "reconnecting");
		await f.call("signOut"); await f.ready(); const streams = f.fake.state.streamCount;
		await pause(140); assert.equal(f.fake.state.streamCount, streams); assert.equal(f.fake.state.streams.size, 1);
	});
	console.log("PASS Grok Bot sign-out cancels old responses and retry timers across accounts");
	require("./test-grokbot-rows.cjs");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
