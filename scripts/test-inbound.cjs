const assert = require("assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { createInbound, candidatesFor, askInOrder } = require("../electron/inbound.cjs");

function request(pipe, message) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(pipe);
		let text = "";
		const timer = setTimeout(() => finish(new Error("No reply from the local listener.")), 2000);
		function finish(error, result) {
			clearTimeout(timer);
			socket.destroy();
			if (error) { reject(error); } else { resolve(result); }
		}
		socket.on("error", (error) => finish(error));
		socket.on("close", () => { if (!text.includes("\n")) { finish(new Error("The listener closed without a reply.")); } });
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			if (text.includes("\n")) {
				try { finish(null, JSON.parse(text.slice(0, text.indexOf("\n")))); } catch (error) { finish(error); }
			}
		});
		socket.once("connect", () => socket.write(typeof message === "string" ? message : `${JSON.stringify(message)}\n`));
	});
}

async function checkListener() {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "grok-inbound-"));
	const registryFile = path.join(folder, "inbound.json");
	const calls = [];
	let reply = { ok: true, status: "queued" };
	let gate = null;
	let arriving = null;
	let throws = false;
	const inbound = createInbound({ registryFile, deliver: async (input) => {
		calls.push(input);
		if (arriving) { arriving(); }
		if (gate) { await gate; }
		if (throws) { throw new Error("private error"); }
		return reply;
	} });
	try {
		assert.equal(fs.existsSync(registryFile), false);
		await Promise.all([inbound.setEnabled(true), inbound.setEnabled(true), inbound.setEnabled(true)]);
		const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
		assert.equal(registry.version, 1);
		assert.equal(registry.pid, process.pid);
		assert.match(registry.token, /^[a-f0-9]{64}$/);
		assert.ok(registry.pipe);
		await inbound.setEnabled(true);
		assert.deepEqual(JSON.parse(fs.readFileSync(registryFile, "utf8")), registry, "concurrent and repeated enables keep the same listener");
		if (process.platform !== "win32") { assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600); }
		const valid = { token: registry.token, agentSessionId: "session-1:part.2", text: "hello" };
		for (const invalid of [
			{ ...valid, token: "0".repeat(64) },
			{ ...valid, token: "é".repeat(64) },
			{ ...valid, text: "x".repeat(100001) },
			{ ...valid, agentSessionId: "bad id" },
			{ ...valid, text: "" },
		]) {
			assert.equal((await request(registry.pipe, invalid)).ok, false);
		}
		assert.equal((await request(registry.pipe, "not json\n")).ok, false);
		assert.equal(calls.length, 0, "invalid input never reaches a window");
		assert.deepEqual(await request(registry.pipe, valid), reply);
		assert.deepEqual(calls, [{ agentSessionId: valid.agentSessionId, text: valid.text }]);
		reply = { ok: false, outcome: "unknown", error: "A window did not answer." };
		assert.deepEqual(await request(registry.pipe, valid), reply, "an uncertain result is passed through");
		throws = true;
		assert.deepEqual(await request(registry.pipe, valid), { ok: false, error: "Grok Code could not take the message." });
		throws = false;
		const beforeCap = calls.length;
		await assert.rejects(request(registry.pipe, "x".repeat(1048577)));
		assert.equal(calls.length, beforeCap, "a line over the byte cap is destroyed before delivery");
		reply = { ok: true, status: "queued" };
		assert.deepEqual(await request(registry.pipe, { ...valid, text: "\u0000".repeat(100000) }), reply, "the maximum escaped text still fits below the byte cap");
		let release;
		gate = new Promise((resolve) => { release = resolve; });
		const arrived = new Promise((resolve) => { arriving = resolve; });
		const client = net.createConnection(registry.pipe);
		client.on("error", () => {});
		client.once("connect", () => client.write(`${JSON.stringify(valid)}\n`));
		await arrived;
		const disconnected = new Promise((resolve) => client.once("close", resolve));
		client.destroy();
		await disconnected;
		release();
		await new Promise((resolve) => setImmediate(resolve));
		gate = null;
		arriving = null;
		await inbound.setEnabled(false);
		assert.equal(fs.existsSync(registryFile), false);
		await assert.rejects(request(registry.pipe, valid), "disabling removes the listener");
		if (process.platform !== "win32") { assert.equal(fs.existsSync(registry.pipe), false); }
		await inbound.setEnabled(false);
		await Promise.all([inbound.setEnabled(true), inbound.setEnabled(false)]);
		assert.equal(fs.existsSync(registryFile), false, "disable waits for an in-progress start and then stops it");
		await inbound.setEnabled(true);
		const closing = inbound.close();
		assert.equal(fs.existsSync(registryFile), false, "close initiates registry cleanup before its Promise is awaited");
		await closing;
		fs.writeFileSync(registryFile, "another instance");
		const neverEnabled = createInbound({ registryFile, deliver: async () => reply });
		await neverEnabled.close();
		await neverEnabled.setEnabled(false);
		assert.equal(fs.readFileSync(registryFile, "utf8"), "another instance", "an inactive instance cannot remove another instance's registry");
	} finally {
		await inbound.close();
		fs.rmSync(folder, { recursive: true, force: true });
	}
}

function checkCandidates() {
	const owner = { isDestroyed: () => false };
	const focused = { isDestroyed: () => false };
	const other = { isDestroyed: () => false };
	const destroyed = { isDestroyed: () => true };
	const unregistered = { isDestroyed: () => false };
	const sessions = new Map([["ui", { sessionId: "agent" }]]);
	const owners = new Map([["ui", { contents: owner }]]);
	const registered = new Set([other, destroyed, focused, owner]);
	const options = { agentSessionId: "agent", sessions, owners, registered, focused };
	assert.deepEqual(candidatesFor(options), [owner, focused, other]);
	assert.deepEqual(candidatesFor({ ...options, focused: owner }), [owner, other, focused], "the focused owner is not repeated");
	owners.set("ui", { contents: destroyed });
	assert.deepEqual(candidatesFor(options), [focused, other, owner]);
	owners.set("ui", { contents: unregistered });
	assert.deepEqual(candidatesFor({ ...options, focused: unregistered }), [other, focused, owner], "only registered, live windows participate");
}

async function checkOrderedAnswers() {
	const asked = [];
	const success = await askInOrder([1, 2, 3], async (candidate) => {
		asked.push(candidate);
		return candidate === 1 ? { accepted: false, stale: true } : { accepted: true, status: "held" };
	}, 50);
	assert.deepEqual(success, { ok: true, status: "held" });
	assert.deepEqual(asked, [1, 2], "an acceptance stops the search");
	assert.deepEqual(await askInOrder([1], async () => ({ accepted: false, stale: true }), 50), { ok: false, error: "That session changed in another Grok Code window; nothing was queued." });
	assert.deepEqual(await askInOrder([1, 2], async () => ({ accepted: false }), 50), { ok: false, error: "No open Grok Code session has that ID." });
	assert.deepEqual(await askInOrder([], async () => { throw new Error("no candidate"); }, 50), { ok: false, error: "No open Grok Code session has that ID." });
	const afterTimeout = [];
	let late;
	const unknown = await askInOrder([1, 2], (candidate) => {
		afterTimeout.push(candidate);
		return new Promise((resolve) => { late = resolve; });
	}, 50);
	assert.deepEqual(unknown, { ok: false, outcome: "unknown", error: "Grok Code did not answer in time; the message may have been queued." });
	late({ accepted: true, status: "queued" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(afterTimeout, [1], "a timeout never tries another window, even when the first answer arrives late");
}

(async () => {
	await checkListener();
	checkCandidates();
	await checkOrderedAnswers();
	console.log("Inbound checks passed: listener lifecycle, private token, request bounds, delivery results, window ordering and uncertain timeout.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
