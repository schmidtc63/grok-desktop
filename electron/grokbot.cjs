const crypto = require("node:crypto");
const path = require("node:path");
const { keyringAvailable } = require("./sign-in.cjs");
const { redactDeep } = require("./redact.cjs");
const { writeAtomic } = require("../scripts/update-helper.cjs");

const METHODS = new Set(["ListGrokBotAgents", "ListGrokBotTranscriptEntries", "SendGrokBotUserMessage", "GetGrokBotSendStatus", "InterruptGrokBotAgentRun", "RespondGrokBotWidget", "ResolveGrokBotAttachmentReads", "WatchGrokBotTranscripts"]);
const RETRY_CODES = new Set(["unavailable", "deadline_exceeded", "aborted", "canceled", "internal", "unknown", "resource_exhausted"]);
const IGNORED_FRAMES = new Set(["heartbeat", "boxState", "computerActions", "agentStateChanged", "pageTitleChanged"]);
const CARDS = new Set(["text", "attachment", "visualization", "widget", "connector", "secret-request", "auto-review-approval", "local-tool-permission", "scm-connect", "connector-grant", "user-form", "credential-request", "virtual-card-approval", "cookie-origin-approval", "meeting-join-consent", "mobile-tool-permission", "appearance-picker", "email-offer"]);
const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const uuidOk = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const digits = (value) => /^(0|[1-9][0-9]*)$/.test(String(value ?? ""));
const tokenOk = (value) => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\s\0]/.test(value);
const methodAllowed = (method) => METHODS.has(method);
const expiry = (token) => {
	try {
		const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
	} catch { return undefined; }
};
function classify(status, code, until) {
	if (status === 401 || status === 403 || code === "unauthenticated" || code === "permission_denied") { return Date.now() >= (until ?? Infinity) ? "expired" : "problem"; }
	if (status === 408 || status === 429 || status >= 500) { return "retry"; }
	if (!status && (!code || RETRY_CODES.has(code))) { return "retry"; }
	return "problem";
}
function fault(status = 0, code = "", format = false) {
	return Object.assign(new Error("Grok Bot request failed."), { status, code, format });
}
function wait(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}
function createFrameParser(onFrame) {
	let buffered = Buffer.alloc(0);
	return {
		async push(chunk) {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			while (buffered.length >= 5) {
				const flags = buffered[0];
				const length = buffered.readUInt32BE(1);
				if (flags & ~2 || length > 16 * 1024 * 1024) { throw fault(0, "unsupported_frame", true); }
				if (buffered.length < 5 + length) { return; }
				let value;
				try { value = JSON.parse(buffered.subarray(5, 5 + length).toString("utf8")); } catch { throw fault(0, "invalid_json", true); }
				buffered = buffered.subarray(5 + length);
				if (flags & 2) { throw fault(0, typeof value?.error?.code === "string" ? value.error.code : ""); }
				await onFrame(value);
			}
		},
		end() { if (buffered.length) { throw fault(0, "incomplete_frame", true); } },
	};
}

function createGrokBot({ file, healthFile, safeStorage, platform, fs, emit: sendEvent = () => {}, openExternal, version, fetch = globalThis.fetch, apiBase = "https://api2.cursor.sh", webBase = "https://cursor.com", retryDelays = [1000, 2000, 4000, 8000, 16000, 30000], silenceMs = 60000, signInLimitMs = 600000, requestTimeoutMs = 30000, signInPollMs = 1000 }) {
	let current = null;
	let signingIn = false;
	let connection = "off";
	let bots = [];
	let live = {};
	let health = freshHealth();
	const emit = (event) => sendEvent(clean(event, current));
	const active = (ctx) => current === ctx && !ctx.controller.signal.aborted;
	function freshHealth() { return { appVersion: version, signedIn: false, connection: "off", lastOkAt: 0, problem: null, unknownFrames: [], unknownRows: [], storedRows: 0, threadFrames: 0 }; }
	function cleanString(value, ctx = current) {
		let result = typeof value === "string" ? value : "";
		const hidden = [ctx?.token, ctx?.verifier, ...(ctx?.secrets ?? []), ...(ctx?.links ?? [])].filter(Boolean);
		for (const secret of hidden) { result = result.split(secret).join("[redacted]"); }
		return redactDeep(result);
	}
	function clean(value, ctx) {
		if (typeof value === "string") { return cleanString(value, ctx); }
		if (Array.isArray(value)) { return value.map((item) => clean(item, ctx)); }
		if (value && typeof value === "object") { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "url").map(([key, item]) => [key, clean(item, ctx)])); }
		return value;
	}
	function label(value, ctx = current) {
		const text = cleanString(value, ctx);
		return /^[A-Za-z0-9_.:\/-]{1,64}$/.test(text) ? text : "<other>";
	}
	function status() { return clean({ ok: true, signedIn: Boolean(current?.token), keyring: keyringAvailable(safeStorage, platform), signingIn, until: current?.until, connection, bots: bots.map((bot) => ({ ...bot })), live }, current); }
	function publishStatus() { emit({ type: "grokbot-status", status: status() }); }
	function writeHealth(ctx = current) {
		if (ctx && !active(ctx)) { return; }
		health.signedIn = Boolean(current?.token);
		health.connection = connection;
		try { fs.mkdirSync(path.dirname(healthFile), { recursive: true }); writeAtomic(healthFile, health, fs); } catch {}
	}
	function changeConnection(next, problem, ctx = current) {
		if (ctx && !active(ctx)) { return; }
		if (connection === "live" && next !== "live") {
			live = {};
			for (const bot of bots) { emit({ type: "grokbot-live", agentId: bot.agentId, running: false, composing: false, retrying: false, waiting: false, detail: "" }); }
		}
		connection = next;
		health.problem = next === "problem" ? { at: Date.now(), kind: problem?.format ? "protocol" : "connection", status: Number(problem?.status) || 0, code: label(problem?.code || "unknown", ctx) } : null;
		if (next === "live") { health.lastOkAt = Date.now(); }
		writeHealth(ctx);
		publishStatus();
	}
	function record(field, value, ctx) {
		const name = label(value, ctx);
		if (!health[field].includes(name)) { health[field].push(name); writeHealth(ctx); }
	}
	function makeContext(token = "") {
		const ctx = { controller: new AbortController(), token, until: expiry(token), verifier: "", secrets: new Set(), cursors: new Map(), attachments: new Map(), widgets: new Map(), links: new Set(), stored: new Set(), initialized: false, loop: null, stream: null };
		return ctx;
	}
	function headers(ctx, stream = false) {
		return { "user-agent": `codewomplers-grok-desktop/${version}`, ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}), "content-type": stream ? "application/connect+json" : "application/json", "connect-protocol-version": "1" };
	}
	async function rpc(ctx, method, body) {
		if (!METHODS.has(method)) { throw fault(0, "method_not_allowed", true); }
		if (!active(ctx)) { throw fault(0, "aborted"); }
		let response;
		try { response = await fetch(`${apiBase}/aiserver.v1.GrokBotService/${method}`, { method: "POST", headers: headers(ctx), redirect: "error", body: JSON.stringify(body), signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(requestTimeoutMs)]) }); }
		catch { throw fault(); }
		if (!active(ctx)) { throw fault(0, "aborted"); }
		if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fault(response.status); }
		let data;
		try { data = await response.json(); } catch { throw fault(0, "invalid_json", true); }
		if (!active(ctx)) { throw fault(0, "aborted"); }
		return data;
	}
	function allowed(ctx, agentId) { return active(ctx) && idOk(agentId) && bots.some((bot) => bot.agentId === agentId); }
	function decodeRows(ctx, agentId, entries) {
		if (!Array.isArray(entries)) { throw fault(0, "invalid_rows", true); }
		return entries.map((raw) => {
			if (!digits(raw.seq) || !digits(raw.updatedSeq ?? raw.seq)) { throw fault(0, "invalid_sequence", true); }
			let body;
			if (typeof raw.body === "string" && raw.body) {
				try { body = JSON.parse(Buffer.from(raw.body, "base64").toString("utf8")); } catch { throw fault(0, "invalid_body", true); }
			}
			const key = `${agentId}:${raw.entryId ?? raw.seq}`;
			const message = body?.message;
			if (message?.type === "attachment" && typeof message.url === "string") {
				ctx.attachments.set(key, message.url);
				if (URL.canParse(message.url) || message.url.startsWith("//")) { ctx.links.add(message.url); }
			}
			if (message?.type === "widget" && message.widget && !message.widget.ruleChange && !Object.hasOwn(body, "respondedValue") && !body.widgetDismissed && !body.widgetSkipped) { ctx.widgets.set(key, message.widget); }
			else { ctx.widgets.delete(key); }
			const stored = !body && Boolean(raw.blobHash || raw.bodyOmitted);
			if (stored && !ctx.stored.has(key)) { ctx.stored.add(key); health.storedRows++; writeHealth(ctx); }
			const kind = raw.entryKind || body?.kind || "unknown";
			if (!["message", "event", "user-attachment", "send-message"].includes(kind) || (kind === "send-message" && !CARDS.has(message?.type))) { record("unknownRows", `${kind}/${message?.type || "unknown"}`, ctx); }
			return clean({ seq: String(raw.seq), updatedSeq: String(raw.updatedSeq ?? raw.seq), entryId: typeof raw.entryId === "string" ? raw.entryId : undefined, entryKind: kind, body, stored }, ctx);
		});
	}
	async function readHistory(ctx, agentId, beforeSeq) {
		const data = await rpc(ctx, "ListGrokBotTranscriptEntries", { agentId, limit: 100, ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) });
		const rows = decodeRows(ctx, agentId, data.entries ?? []);
		const oldest = rows.reduce((value, row) => value === undefined || BigInt(row.seq) < BigInt(value) ? row.seq : value, undefined);
		return { rows, beforeSeq: oldest, generation: data.generation ?? 0 };
	}
	async function seed(ctx, agentId) {
		const result = await readHistory(ctx, agentId);
		if (!active(ctx)) { return; }
		const newest = result.rows.reduce((value, row) => BigInt(row.updatedSeq) > BigInt(value) ? row.updatedSeq : value, "0");
		ctx.cursors.set(agentId, { agentId, generation: result.generation, afterUpdatedSeq: newest, sessionId: "" });
		emit({ type: "grokbot-reset", agentId, rows: result.rows });
	}
	async function listBots(ctx) {
		const data = await rpc(ctx, "ListGrokBotAgents", {});
		if (data.agents !== undefined && !Array.isArray(data.agents)) { throw fault(0, "invalid_roster", true); }
		const next = (data.agents ?? []).filter((bot) => idOk(bot.agentId) && bot.viewerIsOwner !== false && !String(bot.kind || "").includes("ROOM")).map((bot) => ({ agentId: bot.agentId, name: cleanString(typeof bot.name === "string" ? bot.name : "Grok Bot", ctx) }));
		const changed = JSON.stringify(next) !== JSON.stringify(bots);
		bots = next;
		for (const id of ctx.cursors.keys()) { if (!bots.some((bot) => bot.agentId === id)) { ctx.cursors.delete(id); delete live[id]; emit({ type: "grokbot-reset", agentId: id, rows: [] }); } }
		publishStatus();
		for (const bot of bots) { if (!ctx.cursors.has(bot.agentId)) { await seed(ctx, bot.agentId); } }
		return changed;
	}
	async function handleFrame(ctx, frame) {
		if (!active(ctx)) { return; }
		const names = Object.keys(frame ?? {});
		if (names.length !== 1) { throw fault(0, "invalid_frame", true); }
		const type = names[0];
		const payload = frame[type];
		if (!payload || typeof payload !== "object") { throw fault(0, "invalid_frame", true); }
		if (payload.sessionId) { health.threadFrames++; writeHealth(ctx); return; }
		if (type === "rosterChanged") { if (await listBots(ctx)) { throw fault(0, "aborted"); } return; }
		if (payload.agentId && !allowed(ctx, payload.agentId)) { return; }
		if (type === "connected") { ctx.connectedAt = Date.now(); changeConnection("live", null, ctx); return; }
		if (type === "agentState") {
			if (payload.live !== undefined && !Array.isArray(payload.live)) { throw fault(0, "invalid_live", true); }
			if (payload.snapshot) { live = {}; }
			for (const item of payload.live ?? []) {
				if (item.sessionId) { health.threadFrames++; writeHealth(ctx); continue; }
				if (!allowed(ctx, item.agentId)) { continue; }
				const settled = item.lastTurnSettlement;
				const state = { running: item.isRunning === true, composing: item.isComposingMessage === true, retrying: item.isRetrying === true, waiting: Boolean(item.awaiting || item.boxHandoffRequestId), detail: item.isRunning ? cleanString(item.activity?.detail, ctx) : "", outcome: typeof settled?.outcome === "string" ? cleanString(settled.outcome, ctx) : undefined, turnId: typeof settled?.turnId === "string" ? cleanString(settled.turnId, ctx) : undefined, settledAtMs: Number(settled?.settledAtMs) || undefined };
				live[item.agentId] = state;
				emit({ type: "grokbot-live", agentId: item.agentId, ...state });
			}
			publishStatus();
			return;
		}
		if (type === "rows") {
			if (!allowed(ctx, payload.agentId)) { return; }
			const rows = decodeRows(ctx, payload.agentId, payload.entries ?? []);
			const deletes = Array.isArray(payload.deletes) ? payload.deletes : [];
			const cursor = ctx.cursors.get(payload.agentId);
			if (cursor) {
				for (const item of [...rows, ...deletes]) { if (digits(item.updatedSeq) && BigInt(item.updatedSeq) > BigInt(cursor.afterUpdatedSeq)) { cursor.afterUpdatedSeq = String(item.updatedSeq); } }
				if (payload.generation !== undefined) { cursor.generation = payload.generation; }
			}
			for (const item of deletes) { ctx.attachments.delete(`${payload.agentId}:${item.entryId ?? item.seq}`); ctx.widgets.delete(`${payload.agentId}:${item.entryId ?? item.seq}`); }
			emit({ type: "grokbot-rows", agentId: payload.agentId, rows, deletes: deletes.map((item) => item.entryId ?? String(item.seq)) });
			return;
		}
		if (type === "cursorTooOld" || type === "cleared") { if (allowed(ctx, payload.agentId)) { await seed(ctx, payload.agentId); throw fault(0, "aborted"); } return; }
		if (type === "turnFailed") { if (allowed(ctx, payload.agentId)) { emit({ type: "grokbot-failed", agentId: payload.agentId, summary: cleanString(payload.summary, ctx) }); } return; }
		if (!IGNORED_FRAMES.has(type)) { record("unknownFrames", type, ctx); }
		if (connection === "live" && Date.now() - health.lastOkAt >= 600000) { health.lastOkAt = Date.now(); writeHealth(ctx); }
	}
	async function watch(ctx) {
		const child = new AbortController();
		ctx.stream = child;
		let timer;
		const arm = () => { clearTimeout(timer); timer = setTimeout(() => { if (active(ctx)) { child.abort(); } }, silenceMs); };
		arm();
		let reader;
		try {
			const request = JSON.stringify({ cursors: [...ctx.cursors.values()], includeUnlistedAgents: true, inlineBodyMaxBytes: 65536 });
			const encoded = Buffer.from(request);
			const envelope = Buffer.alloc(5 + encoded.length);
			envelope.writeUInt32BE(encoded.length, 1); encoded.copy(envelope, 5);
			const response = await fetch(`${apiBase}/aiserver.v1.GrokBotService/WatchGrokBotTranscripts`, { method: "POST", headers: headers(ctx, true), body: envelope, redirect: "error", signal: AbortSignal.any([ctx.controller.signal, child.signal]) });
			if (!active(ctx)) { return; }
			if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fault(response.status); }
			if (!response.body) { throw fault(0, "missing_body", true); }
			reader = response.body.getReader();
			const parser = createFrameParser((frame) => handleFrame(ctx, frame));
			while (active(ctx)) {
				const chunk = await reader.read();
				if (chunk.done) { parser.end(); break; }
				arm();
				await parser.push(chunk.value);
			}
		} finally {
			clearTimeout(timer);
			child.abort();
			await reader?.cancel().catch(() => {});
			if (ctx.stream === child) { ctx.stream = null; }
		}
	}
	function launch(ctx) {
		if (!active(ctx) || ctx.loop) { return; }
		ctx.loop = (async () => {
			let retryCount = 0;
			while (active(ctx)) {
				ctx.connectedAt = 0;
				try {
					if (!ctx.initialized) { await listBots(ctx); ctx.initialized = true; }
					await watch(ctx);
					if (!active(ctx)) { return; }
					throw fault();
				} catch (error) {
					if (!active(ctx)) { return; }
					const action = error.format ? "problem" : classify(error.status || 0, error.status === undefined ? "" : error.code || "", ctx.until);
					changeConnection(action === "retry" ? "reconnecting" : action, error, ctx);
					if (action !== "retry") { return; }
					if (ctx.connectedAt && Date.now() - ctx.connectedAt >= silenceMs) { retryCount = 0; }
					const delay = retryDelays[Math.min(retryCount++, retryDelays.length - 1)] ?? 30000;
					await wait(delay, ctx.controller.signal);
				}
			}
		})().finally(() => { ctx.loop = null; });
	}
	async function history(agentId, beforeSeq) {
		const ctx = current;
		if (!ctx || !allowed(ctx, agentId) || (beforeSeq !== undefined && !digits(beforeSeq))) { return { ok: false, error: "Choose one of your Grok Bots." }; }
		try { const result = await readHistory(ctx, agentId, beforeSeq); return active(ctx) ? { ok: true, rows: result.rows, beforeSeq: result.beforeSeq } : { ok: false }; }
		catch { return { ok: false, error: "The conversation couldn't be loaded. Try again." }; }
	}
	async function send(input) {
		const ctx = current;
		if (!ctx || !allowed(ctx, input?.agentId) || !uuidOk(input?.messageId) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100000) { return { ok: false, error: "Choose a Bot and enter a message of up to 100000 characters." }; }
		try {
			const result = await rpc(ctx, "SendGrokBotUserMessage", { agentId: input.agentId, messageId: input.messageId, text: input.text, sentAtMs: String(Date.now()), initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER", sendSource: "GROK_BOT_SEND_SOURCE_CHAT" });
			const delivery = String(result.delivery || "").replace(/^GROK_BOT_USER_MESSAGE_DELIVERY_/, "");
			if (["ACCEPTED_TEMPORAL", "ACCEPTED_BOX", "DUPLICATE"].includes(delivery)) { return { ok: true, accepted: true, delivery }; }
			if (delivery === "REFUSED") { return { ok: false, error: cleanString(result.refusal?.message, ctx) || "Grok Bot refused this message." }; }
			return { ok: false, unknown: true, error: "It may have been sent. Check the chat before sending again." };
		} catch (error) {
			if (!active(ctx)) { return { ok: false }; }
			if (!error.status || error.status >= 500) {
				try {
					const result = await rpc(ctx, "GetGrokBotSendStatus", { agentId: input.agentId, messageId: input.messageId });
					const outcome = String(result.status || "").replace(/^GROK_BOT_SEND_STATUS_/, "");
					if (["ACCEPTED", "PENDING"].includes(outcome)) { return { ok: true, accepted: true, delivery: outcome }; }
					if (["NOT_FOUND", "REJECTED"].includes(outcome)) { return { ok: false, error: "Not sent" }; }
				} catch {}
				return active(ctx) ? { ok: false, unknown: true, error: "It may have been sent. Check the chat before sending again." } : { ok: false };
			}
			return { ok: false, error: "Grok Bot couldn't accept this message." };
		}
	}
	async function stop(agentId) {
		const ctx = current;
		if (!ctx || !allowed(ctx, agentId)) { return { ok: false, error: "Choose one of your Grok Bots." }; }
		try { const result = await rpc(ctx, "InterruptGrokBotAgentRun", { agentId, reason: "user_interrupt" }); return active(ctx) ? { ok: true, hadActiveRun: result.hadActiveRun === true } : { ok: false }; }
		catch { return { ok: false, error: "Stop wasn't confirmed. Check Grok Bot." }; }
	}
	async function answer(input) {
		const ctx = current;
		if (!ctx || !allowed(ctx, input?.agentId) || !idOk(input?.entryId)) { return { ok: false, error: "This question is unavailable." }; }
		const key = `${input.agentId}:${input.entryId}`;
		const widget = ctx.widgets.get(key);
		if (!widget || !Array.isArray(widget.options) || !widget.options.some((option) => typeof option.value === "string" && option.value === input.value)) { return { ok: false, error: "Open Grok Bot to answer this request." }; }
		try {
			const result = await rpc(ctx, "RespondGrokBotWidget", { agentId: input.agentId, entryId: input.entryId, value: input.value });
			if (result.accepted === true) { ctx.widgets.delete(key); return { ok: true }; }
			return { ok: false, error: "That answer wasn't accepted. Check Grok Bot." };
		} catch { return { ok: false, error: "That answer wasn't confirmed. Check Grok Bot before trying again." }; }
	}
	async function openFile(input) {
		const ctx = current;
		if (!ctx || !allowed(ctx, input?.agentId) || !idOk(input?.entryId)) { return { ok: false, error: "Open Grok Bot to get this file." }; }
		let link = ctx.attachments.get(`${input.agentId}:${input.entryId}`);
		if (!link) { return { ok: false, error: "Open Grok Bot to get this file." }; }
		try {
			if (!link.startsWith("https:")) {
				const result = await rpc(ctx, "ResolveGrokBotAttachmentReads", { agentId: input.agentId, paths: [link] });
				const read = result.reads?.find((item) => item.path === link);
				const outcome = String(read?.outcome || "");
				link = outcome.includes("STORE") && !outcome.includes("NOT_IN_STORE") && !outcome.includes("NO_STORAGE") ? read?.url : null;
			}
			if (typeof link === "string") { ctx.links.add(link); }
			if (!active(ctx) || typeof link !== "string" || new URL(link).protocol !== "https:") { return { ok: false, error: "Open Grok Bot to get this file." }; }
			await openExternal(link);
			return active(ctx) ? { ok: true } : { ok: false };
		} catch { return { ok: false, error: "Open Grok Bot to get this file." }; }
	}
	function reset() {
		current?.controller.abort();
		current = null; signingIn = false; bots = []; live = {}; connection = "off"; health = freshHealth();
	}
	async function signOut() {
		reset();
		let removed = true;
		try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") { removed = false; } }
		writeHealth(); publishStatus();
		return removed ? { ok: true } : { ok: false, error: "The saved Grok Bot sign-in couldn't be removed." };
	}
	async function signIn() {
		if (!keyringAvailable(safeStorage, platform)) { return { ok: false, error: "This computer has no keyring the app can use, so the Grok Bot sign-in can't be saved." }; }
		const removed = await signOut();
		if (!removed.ok) { return removed; }
		const ctx = makeContext(); current = ctx; signingIn = true; publishStatus();
		ctx.verifier = crypto.randomBytes(32).toString("base64url");
		ctx.secrets.add(ctx.verifier);
		const challenge = crypto.createHash("sha256").update(ctx.verifier).digest("base64url");
		const uuid = crypto.randomUUID();
		const query = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
		try {
			await openExternal(`${webBase}/loginDeepControl?${query}`);
			const deadline = Date.now() + signInLimitMs;
			while (active(ctx) && Date.now() < deadline) {
				const poll = new URLSearchParams({ uuid, verifier: ctx.verifier });
				const response = await fetch(`${apiBase}/auth/poll?${poll}`, { headers: headers(ctx), redirect: "error", signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())))]) });
				if (!active(ctx)) { return { ok: false }; }
				if (response.status === 404) { await response.body?.cancel().catch(() => {}); await wait(signInPollMs, ctx.controller.signal); continue; }
				if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fault(response.status); }
				const result = await response.json();
				if (!active(ctx)) { return { ok: false }; }
				if (!tokenOk(result.accessToken)) { throw fault(0, "invalid_sign_in", true); }
				const encrypted = safeStorage.encryptString(result.accessToken).toString("base64");
				fs.mkdirSync(path.dirname(file), { recursive: true });
				writeAtomic(file, { token: encrypted }, fs);
				ctx.token = result.accessToken; ctx.until = expiry(ctx.token); ctx.verifier = ""; signingIn = false;
				changeConnection("reconnecting", null, ctx); launch(ctx);
				return { ok: true };
			}
			if (!active(ctx)) { return { ok: false }; }
			throw fault(0, "sign_in_timeout");
		} catch {
			if (!active(ctx)) { return { ok: false }; }
			reset(); writeHealth(); publishStatus();
			return { ok: false, error: "Grok Bot sign-in didn't finish. Try again." };
		}
	}
	async function cancelSignIn() { if (signingIn) { reset(); writeHealth(); publishStatus(); } return { ok: true }; }
	async function start() {
		if (current) { return status(); }
		let token = "";
		if (keyringAvailable(safeStorage, platform)) {
			try { const saved = JSON.parse(fs.readFileSync(file, "utf8")); const value = safeStorage.decryptString(Buffer.from(saved.token, "base64")); if (tokenOk(value)) { token = value; } } catch {}
		}
		if (token) { const ctx = makeContext(token); current = ctx; changeConnection("reconnecting", null, ctx); launch(ctx); }
		else { writeHealth(); publishStatus(); }
		return status();
	}
	async function close() { current?.controller.abort(); return { ok: true }; }
	async function retry() { const ctx = current; if (!ctx?.token || !active(ctx)) { return { ok: false }; } if (!ctx.loop) { changeConnection("reconnecting", null, ctx); launch(ctx); } return { ok: true }; }
	return { status, signIn, cancelSignIn, signOut, start, close, retry, history, send, stop, answer, openFile };
}

module.exports = { createGrokBot, createFrameParser, classify, methodAllowed };
