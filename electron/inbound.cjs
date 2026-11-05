const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const MAX_LINE = 1048576;

function removeFile(file) {
	try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") { throw error; } }
}

function createInbound({ registryFile, deliver }) {
	let server = null;
	let listenPath = "";
	let pending = null;
	const sockets = new Set();

	async function changeEnabled(on) {
		if (!on) {
			if (!server) { return; }
			const stopping = server;
			server = null;
			const closed = new Promise((resolve) => stopping.close(resolve));
			for (const socket of sockets) { socket.destroy(); }
			removeFile(registryFile);
			if (process.platform !== "win32") { removeFile(listenPath); }
			await closed;
			return;
		}
		if (server) { return; }
		const token = crypto.randomBytes(32).toString("hex");
		const expectedToken = Buffer.from(token);
		listenPath = process.platform === "win32"
			? `\\\\.\\pipe\\LOCAL\\grok-code-inbound-${crypto.randomBytes(8).toString("hex")}`
			: path.join(path.dirname(registryFile), `inbound-${crypto.randomBytes(4).toString("hex")}.sock`);
		const starting = net.createServer((socket) => {
			socket.on("error", () => {});
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			const chunks = [];
			let size = 0;
			async function read(chunk) {
				const newline = chunk.indexOf(10);
				const part = newline < 0 ? chunk : chunk.subarray(0, newline);
				size += part.length;
				if (size > MAX_LINE) { socket.destroy(); return; }
				chunks.push(part);
				if (newline < 0) { return; }
				socket.removeListener("data", read);
				let request;
				try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
					socket.end(`${JSON.stringify({ ok: false, error: "Invalid local tool request." })}\n`);
					return;
				}
				const suppliedToken = typeof request?.token === "string" ? Buffer.from(request.token) : null;
				if (!suppliedToken || request.token.length !== token.length || suppliedToken.length !== expectedToken.length || !crypto.timingSafeEqual(suppliedToken, expectedToken)
					|| typeof request.agentSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.agentSessionId)
					|| typeof request.text !== "string" || !request.text.length || request.text.length > 100000) {
					socket.end(`${JSON.stringify({ ok: false, error: "Invalid local tool request." })}\n`);
					return;
				}
				try {
					const result = await deliver({ agentSessionId: request.agentSessionId, text: request.text });
					socket.end(`${JSON.stringify(result)}\n`);
				} catch {
					socket.end(`${JSON.stringify({ ok: false, error: "Grok Code could not take the message." })}\n`);
				}
			}
			socket.on("data", read);
		});
		await new Promise((resolve, reject) => {
			starting.once("error", reject);
			starting.listen(listenPath, () => { starting.removeListener("error", reject); resolve(); });
		});
		try {
			fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify({ version: 1, pid: process.pid, pipe: listenPath, token }), { mode: 0o600 });
			fs.renameSync(`${registryFile}.tmp`, registryFile);
			server = starting;
		} catch (error) {
			starting.close();
			removeFile(`${registryFile}.tmp`);
			if (process.platform !== "win32") { removeFile(listenPath); }
			throw error;
		}
	}

	function setEnabled(on) {
		const operation = pending ? pending.catch(() => {}).then(() => changeEnabled(on)) : changeEnabled(on);
		pending = operation;
		const settled = () => { if (pending === operation) { pending = null; } };
		operation.then(settled, settled);
		return operation;
	}

	return { setEnabled, close: () => setEnabled(false) };
}

function candidatesFor({ agentSessionId, sessions, owners, registered, focused }) {
	const candidates = [];
	function add(contents) {
		if (contents && registered.has(contents) && !contents.isDestroyed() && !candidates.includes(contents)) { candidates.push(contents); }
	}
	for (const [id, session] of sessions) {
		if (session.sessionId === agentSessionId) { add(owners.get(id)?.contents); break; }
	}
	add(focused);
	for (const contents of registered) { add(contents); }
	return candidates;
}

async function askInOrder(candidates, ask, timeoutMs) {
	let stale = false;
	for (const contents of candidates) {
		let timer;
		let result;
		try {
			result = await Promise.race([ask(contents), new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
		} finally { clearTimeout(timer); }
		if (result === null) { return { ok: false, outcome: "unknown", error: "Grok Code did not answer in time; the message may have been queued." }; }
		if (result?.accepted) { return { ok: true, status: result.status }; }
		if (result?.stale) { stale = true; }
	}
	return { ok: false, error: stale ? "That session changed in another Grok Code window; nothing was queued." : "No open Grok Code session has that ID." };
}

module.exports = { createInbound, candidatesFor, askInOrder };
