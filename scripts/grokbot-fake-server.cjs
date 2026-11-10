const http = require("node:http");
const crypto = require("node:crypto");

function envelope(value, flags = 0) {
	const text = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
	const result = Buffer.alloc(5 + text.length);
	result[0] = flags;
	result.writeUInt32BE(text.length, 1);
	text.copy(result, 5);
	return result;
}

async function startFakeServer({ port = 0, autoApprove = false, token, bots, replyDelayMs = 120, heartbeatMs = 1000 } = {}) {
	const fakeToken = token || `fake.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60 })).toString("base64url")}.not-a-real-token`;
	const state = {
		token: fakeToken,
		requests: [],
		bots: bots ?? [{ agentId: "fake-bot-one", name: "Demo Bot", kind: "GROK_BOT_AGENT_KIND_AGENT", viewerIsOwner: true }, { agentId: "fake-bot-two", name: "Second Bot", kind: "GROK_BOT_AGENT_KIND_AGENT", viewerIsOwner: true }],
		rows: new Map(), live: new Map(), sends: new Map(), queued: new Map(), streams: new Set(), approvals: new Map(), timers: new Map(), sequence: 0n, streamCount: 0,
	};
	const pendingResponses = new Set();
	function emit(frame) { for (const response of state.streams) { if (!response.destroyed) { response.write(envelope(frame)); } } }
	function setLive(agentId, values) {
		const live = { agentId, updatedAtMs: String(Date.now()), staleAfterMs: "60000", ...values };
		state.live.set(agentId, live);
		emit({ agentState: { live: [live] } });
	}
	function addRow(agentId, body, existing) {
		const updatedSeq = String(++state.sequence);
		const row = { seq: existing?.seq ?? updatedSeq, updatedSeq, entryId: existing?.entryId ?? `entry-${updatedSeq}`, entryKind: body.kind, body: Buffer.from(JSON.stringify(body)).toString("base64") };
		const list = state.rows.get(agentId) || [];
		const index = list.findIndex((item) => item.entryId === row.entryId);
		if (index < 0) { list.push(row); } else { list[index] = row; }
		state.rows.set(agentId, list);
		emit({ rows: { agentId, generation: 0, entries: [row] } });
		return row;
	}
	for (const bot of state.bots) {
		addRow(bot.agentId, { kind: "send-message", message: { type: "text", content: "Ready to help with your work." }, timestampMs: Date.now() });
		state.live.set(bot.agentId, { agentId: bot.agentId, isRunning: false, updatedAtMs: String(Date.now()), staleAfterMs: "60000" });
	}
	function approveSignIn(loginUrl) {
		const parsed = new URL(loginUrl);
		state.approvals.set(parsed.searchParams.get("uuid"), parsed.searchParams.get("challenge"));
	}
	function queue(method, outcome) {
		const list = state.queued.get(method) || [];
		list.push(outcome); state.queued.set(method, list);
	}
	function reply(response, status, value) {
		if (response.destroyed) { return; }
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	}
	async function handle(request, response) {
		const parsed = new URL(request.url, "http://127.0.0.1");
		const chunks = [];
		for await (const chunk of request) { chunks.push(chunk); }
		const raw = Buffer.concat(chunks);
		const method = parsed.pathname.split("/").pop();
		let body = {};
		try { if (raw.length) { body = JSON.parse(raw.subarray(method === "WatchGrokBotTranscripts" ? 5 : 0).toString("utf8")); } } catch { reply(response, 400, { code: "invalid_argument" }); return; }
		state.requests.push({ method, url: request.url, headers: { ...request.headers }, body, at: Date.now() });
		const overrides = state.queued.get(method);
		if (overrides?.length) {
			const outcome = overrides.shift();
			if (typeof outcome === "function") { await outcome({ request, response, body, reply, emit, state }); return; }
			if (outcome.hold) { pendingResponses.add(response); response.on("close", () => pendingResponses.delete(response)); return; }
			if (outcome.delay) { await new Promise((resolve) => setTimeout(resolve, outcome.delay)); }
			if (outcome.raw) { response.writeHead(outcome.status || 200, { "content-type": "application/connect+json" }); response.end(outcome.raw); return; }
			reply(response, outcome.status || 200, outcome.body ?? {}); return;
		}
		if (method === "poll") {
			const uuid = parsed.searchParams.get("uuid");
			const verifier = parsed.searchParams.get("verifier") || "";
			const approved = autoApprove || state.approvals.get(uuid) === crypto.createHash("sha256").update(verifier).digest("base64url");
			reply(response, approved ? 200 : 404, approved ? { accessToken: state.token, refreshToken: "fake-refresh-discard-me", authId: "fake-account" } : {}); return;
		}
		if (request.headers.authorization !== `Bearer ${state.token}`) { reply(response, 401, {}); return; }
		if (method === "ListGrokBotAgents") { reply(response, 200, { agents: state.bots }); return; }
		if (method === "ListGrokBotTranscriptEntries") {
			const rows = (state.rows.get(body.agentId) || []).filter((row) => body.beforeSeq === undefined || BigInt(row.seq) < BigInt(body.beforeSeq)).sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : 1).slice(0, body.limit || 100);
			reply(response, 200, { entries: rows, updatedSeqLocked: true }); return;
		}
		if (method === "WatchGrokBotTranscripts") {
			state.streamCount++;
			state.streams.add(response);
			response.writeHead(200, { "content-type": "application/connect+json" });
			response.write(envelope({ connected: { streamId: `fake-stream-${state.streamCount}`, absoluteLifetimeMs: "1195000", serverTimeMs: String(Date.now()) } }));
			response.write(envelope({ agentState: { snapshot: true, live: [...state.live.values()] } }));
			for (const cursor of body.cursors || []) {
				const entries = (state.rows.get(cursor.agentId) || []).filter((row) => BigInt(row.updatedSeq) > BigInt(cursor.afterUpdatedSeq || 0));
				if (entries.length) { response.write(envelope({ rows: { agentId: cursor.agentId, generation: 0, entries } })); }
			}
			const heartbeat = setInterval(() => { if (!response.destroyed) { response.write(envelope({ heartbeat: {} })); } }, heartbeatMs);
			heartbeat.unref();
			response.on("close", () => { clearInterval(heartbeat); state.streams.delete(response); });
			return;
		}
		if (method === "SendGrokBotUserMessage") {
			if (state.sends.has(body.messageId)) { reply(response, 200, { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE" }); return; }
			state.sends.set(body.messageId, { status: "GROK_BOT_SEND_STATUS_ACCEPTED" });
			reply(response, 200, { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
			const echo = addRow(body.agentId, { kind: "message", role: "user", content: body.text, clientNonce: body.messageId, requestId: body.messageId, timestampMs: Date.now() });
			state.sends.get(body.messageId).echoEntryId = echo.entryId;
			setLive(body.agentId, { isRunning: true, activity: { kind: "thinking" } });
			clearTimeout(state.timers.get(body.agentId));
			const long = /\blong\b/i.test(body.text);
			state.timers.set(body.agentId, setTimeout(() => {
				let message = { type: "text", content: `You said: ${body.text}` };
				if (/\bquestion\b/i.test(body.text)) { message = { type: "widget", widget: { prompt: "Continue with this example?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] } }; }
				else if (/\bfile\b/i.test(body.text)) { message = { type: "attachment", file_name: "example.txt", url: "https://files.example.test/signed-example.txt" }; }
				addRow(body.agentId, { kind: "send-message", message, requestId: body.messageId, timestampMs: Date.now() });
				setLive(body.agentId, { isRunning: false, lastTurnSettlement: { turnId: body.messageId, outcome: "success", settledAtMs: String(Date.now()) } });
				state.timers.delete(body.agentId);
			}, long ? 10000 : replyDelayMs));
			return;
		}
		if (method === "GetGrokBotSendStatus") { reply(response, 200, state.sends.get(body.messageId) || { status: "GROK_BOT_SEND_STATUS_NOT_FOUND" }); return; }
		if (method === "InterruptGrokBotAgentRun") {
			const hadActiveRun = state.live.get(body.agentId)?.isRunning === true;
			clearTimeout(state.timers.get(body.agentId)); state.timers.delete(body.agentId);
			reply(response, 200, { hadActiveRun });
			setLive(body.agentId, { isRunning: false, lastTurnSettlement: { turnId: "fake-cancelled", outcome: "cancelled", settledAtMs: String(Date.now()) } }); return;
		}
		if (method === "RespondGrokBotWidget") {
			const row = (state.rows.get(body.agentId) || []).find((entry) => entry.entryId === body.entryId);
			const decoded = row ? JSON.parse(Buffer.from(row.body, "base64").toString()) : null;
			if (!decoded?.message?.widget) { reply(response, 200, { accepted: false }); return; }
			decoded.respondedValue = body.value; addRow(body.agentId, decoded, row);
			reply(response, 200, { accepted: true }); return;
		}
		if (method === "ResolveGrokBotAttachmentReads") { reply(response, 200, { reads: body.paths.map((item) => ({ path: item, outcome: "GROK_BOT_ATTACHMENT_READ_OUTCOME_STORE", url: "https://files.example.test/resolved-example.txt", expiresAtMs: String(Date.now() + 60000) })) }); return; }
		reply(response, 404, { code: "unimplemented" });
	}
	const server = http.createServer((request, response) => { handle(request, response).catch(() => { reply(response, 500, { code: "internal" }); }); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	return {
		url: `http://127.0.0.1:${server.address().port}`, state, approveSignIn, queue, emit, addRow, setLive,
		endStreams(frame) { for (const response of state.streams) { if (frame) { response.write(envelope(frame, 2)); } response.end(); } },
		async close() {
			for (const timer of state.timers.values()) { clearTimeout(timer); }
			for (const response of [...state.streams, ...pendingResponses]) { response.destroy(); }
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

module.exports = { startFakeServer, envelope };
