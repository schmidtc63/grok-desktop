const path = require("node:path");
const { writeAtomic } = require("../scripts/update-helper.cjs");
const { decrypt, keyringAvailable, validKey } = require("./sign-in.cjs");
const { heldTail, redactDeep } = require("./redact.cjs");

const CREDIT_MESSAGE = "Cursor refused to start the agent: your Cursor credit is used up. Add credit on your [Cursor usage page](https://cursor.com/dashboard?tab=usage).";
const AGENTS_LINK = "[Cursor agents](https://cursor.com/agents)";
const MACHINE_NAME_ERROR = "Enter the machine's name as its worker shows it.";
const MACHINE_REF_ERROR = "A machine session can't use this branch name. Switch the folder to a branch whose name has only letters, digits, dots, dashes, underscores and slashes.";

function createSseParser(onEvent) {
	let pending = "";
	let event;
	let id;
	let data = [];
	function line(text) {
		if (!text) {
			const frame = data.length ? { event: event || "message", ...(id === undefined ? {} : { id }), data: data.join("\n") } : null;
			event = undefined;
			id = undefined;
			data = [];
			if (frame) {
				try { frame.data = JSON.parse(frame.data); } catch {}
				onEvent(frame);
			}
			return;
		}
		if (text.startsWith(":")) { return; }
		const colon = text.indexOf(":");
		const field = colon < 0 ? text : text.slice(0, colon);
		let value = colon < 0 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) { value = value.slice(1); }
		if (field === "event") { event = value; }
		if (field === "id" && !value.includes("\0")) { id = value; }
		if (field === "data") { data.push(value); }
	}
	return {
		push(text) {
			const lines = (pending + text).split("\n");
			pending = lines.pop();
			for (const next of lines) { line(next.endsWith("\r") ? next.slice(0, -1) : next); }
		},
		end() {
			// EOF without a blank line leaves an incomplete frame.
			pending = "";
			event = undefined;
			id = undefined;
			data = [];
		},
	};
}

function maskKey(value, key) {
	if (!key) { return value; }
	if (typeof value === "string") { return value.replaceAll(key, "[redacted]"); }
	if (Array.isArray(value)) { return value.map((item) => maskKey(item, key)); }
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [maskKey(name, key), maskKey(item, key)]));
	}
	return value;
}

function requestFailureMessage(timedOut, startKind) {
	const message = timedOut ? "Cursor didn't answer in time." : "Couldn't connect to Cursor.";
	return startKind ? `${message} The ${startKind} may have started anyway; check cursor.com/agents before sending again.` : message;
}

function machinePrompt(prompt, branch, ref) {
	return `${prompt}\n\nBefore you start, run git fetch and switch to the branch ${branch}. If it doesn't exist yet, create it from origin/${ref}. Don't push and don't open a pull request; commit your work on that branch.`;
}

function createCursorApi({ getKey, fetch = globalThis.fetch, baseUrl = "https://api.cursor.com", timeoutMs = 30000, createTimeoutMs = 120000 }) {
	const base = baseUrl.replace(/\/+$/, "");
	const runPath = (agentId, runId) => ["agents", agentId, "runs", runId];
	function send(method, path, key, signal, body, accept) {
		const headers = { Authorization: `Bearer ${key}`, Accept: accept };
		if (body !== undefined) { headers["Content-Type"] = "application/json"; }
		return fetch(`${base}/v1/${path.map(encodeURIComponent).join("/")}`, { method, headers, signal, body, redirect: "error" });
	}
	async function request(method, path, buildBody, startKind) {
		const controller = new AbortController();
		let key;
		const timer = setTimeout(() => controller.abort(), startKind === "agent" ? createTimeoutMs : timeoutMs);
		try {
			key = getKey();
			if (typeof key !== "string" || !key) {
				return { ok: false, status: 0, code: "missing_key", error: "Add a Cursor key in Settings." };
			}
			const body = buildBody ? JSON.stringify(buildBody()) : undefined;
			const response = await send(method, path, key, controller.signal, body, "application/json");
			const raw = await response.text();
			let reply;
			try { reply = raw ? JSON.parse(raw) : {}; } catch {}
			if (!response.ok) {
				const { code, message } = reply?.error || {};
				return maskKey({
					ok: false,
					status: response.status,
					code: typeof code === "string" ? code : "http_error",
					error: typeof message === "string" ? message : `Cursor returned HTTP ${response.status}.`,
				}, key);
			}
			if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
				return { ok: false, status: response.status, code: "invalid_reply", error: "Cursor returned an invalid reply." };
			}
			return { ...maskKey(reply, key), ok: true };
		} catch {
			const timedOut = controller.signal.aborted;
			return { ok: false, status: 0, code: timedOut ? "timeout" : "connection", error: maskKey(requestFailureMessage(timedOut, startKind), key) };
		} finally {
			clearTimeout(timer);
		}
	}
	function stream(agentId, runId, onEvent, { idleMs = 90000 } = {}) {
		const controller = new AbortController();
		let timer;
		function stop() {
			clearTimeout(timer);
			controller.abort();
		}
		function finish(event) {
			if (controller.signal.aborted) { return; }
			stop();
			onEvent(event);
		}
		function timeout(ms, reason) {
			clearTimeout(timer);
			timer = setTimeout(() => finish({ event: "closed", reason }), ms);
		}
		async function read() {
			try {
				const key = getKey();
				if (typeof key !== "string" || !key) { finish({ event: "closed", reason: "missing_key" }); return; }
				timeout(timeoutMs, "timeout");
				const response = await send("GET", [...runPath(agentId, runId), "stream"], key, controller.signal, undefined, "text/event-stream");
				if (controller.signal.aborted) { return; }
				if (response.status === 410) { finish({ event: "expired" }); return; }
				if (response.status !== 200) { finish({ event: "closed", reason: "http" }); return; }
				timeout(idleMs, "idle");
				const parser = createSseParser((frame) => {
					if (controller.signal.aborted) { return; }
					const safe = maskKey(frame, key);
					if (frame.event === "done") { finish(safe); return; }
					timeout(idleMs, "idle");
					onEvent(safe);
				});
				const decoder = new TextDecoder();
				for await (const bytes of response.body) {
					parser.push(decoder.decode(bytes, { stream: true }));
					if (controller.signal.aborted) { return; }
				}
				parser.push(decoder.decode());
				parser.end();
				finish({ event: "closed", reason: "eof" });
			} catch {
				finish({ event: "closed", reason: "connection" });
			}
		}
		void Promise.resolve().then(() => { if (!controller.signal.aborted) { return read(); } });
		return { stop };
	}
	return {
		me: () => request("GET", ["me"]),
		repositories: () => request("GET", ["repositories"]),
		models: () => request("GET", ["models"]),
		create: (input) => request("POST", ["agents"], () => {
			const { name, prompt, model, repoUrl, ref, autoCreatePR, machine, branch } = input;
			const repos = [{ url: repoUrl, startingRef: ref }];
			if (machine !== undefined) {
				const text = machinePrompt(prompt, branch, ref);
				return { name, prompt: { text }, model, repos, autoCreatePR: false, env: { type: "machine", name: machine } };
			}
			const text = autoCreatePR === false ? `${prompt}\n\nDon't open a pull request; push your branch only.` : prompt;
			return { name, prompt: { text }, model, repos, autoCreatePR };
		}, "agent"),
		followUp: (agentId, prompt) => request("POST", ["agents", agentId, "runs"], () => ({ prompt: { text: prompt } }), "run"),
		cancel: (agentId, runId) => request("POST", [...runPath(agentId, runId), "cancel"]),
		run: (agentId, runId) => request("GET", runPath(agentId, runId)),
		stream,
	};
}

function short(value) {
	if (value === undefined || value === null) { return ""; }
	const text = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ").trim();
	return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

const failedResult = (data) => data?.status === "ERROR" || data?.status === "FAILED";
const machineHint = (machine) => ` Check that Cursor's worker is running on ${machine}, in a clone of this repository.`;

function mapEvent({ event, data }, state) {
	if (event === "assistant" || event === "thinking") {
		if (typeof data?.text !== "string" || !data.text) { return []; }
		if (event === "assistant") { state.hasAssistant = true; }
		return [{ type: event === "assistant" ? "chunk" : "thought", text: data.text }];
	}
	if (event === "tool_call") {
		if (!data?.callId || (data.status !== "running" && data.status !== "completed")) { return []; }
		state.tools ??= new Map();
		const previous = state.tools.get(data.callId);
		const args = data.args;
		const summary = short(args?.command ?? args?.path ?? args?.globPattern ?? args) || previous?.summary || "";
		const name = data.name || previous?.name || "Tool";
		const completed = data.status === "completed";
		const result = completed ? short(data.result) : "";
		const tool = {
			id: data.callId,
			kind: "tool",
			title: summary ? `${name}: ${summary}` : name,
			summary,
			detail: completed ? (result ? `Completed · ${result}` : "Completed") : "Running",
			waiting: false,
		};
		state.tools.set(data.callId, { name, summary });
		return [{ type: "tool", tool }];
	}
	if (event === "result") {
		const events = [];
		if (!state.hasAssistant && typeof data?.text === "string" && data.text) { events.push({ type: "chunk", text: data.text }); }
		if (Array.isArray(data?.git?.branches)) {
			for (const entry of data.git.branches) {
				if (typeof entry?.branch !== "string" || !entry.branch) { continue; }
				const pr = typeof entry.prUrl === "string" && /^https?:\/\/[^\s<>]+$/i.test(entry.prUrl) ? ` · <${entry.prUrl}>` : "";
				events.push({ type: "chunk", text: `\n\nBranch: ${entry.branch}${pr}` });
			}
		}
		if (failedResult(data)) { events.push({ type: "chunk", text: "\n\nCursor ended the run with an error." }); }
		return events;
	}
	if (event === "error") {
		const message = data?.code === "usage_limit_exceeded" ? CREDIT_MESSAGE : (data?.message || (typeof data === "string" ? data : "Unknown error."));
		return [{ type: "chunk", text: `\n\nCursor reported an error: ${message}` }];
	}
	if (event === "done") { return [{ type: "done" }]; }
	return [];
}

function createCursorKey({ file, safeStorage, platform, fs }) {
	function read() {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof value?.key === "string") { return value; }
		} catch {}
		return { key: "", name: "" };
	}
	function status() {
		const { key, name } = read();
		const keyring = keyringAvailable(safeStorage, platform);
		const plaintext = decrypt(key, safeStorage, platform, keyring);
		return { hasKey: Boolean(key), keyReadable: Boolean(plaintext), keyring, name: typeof name === "string" ? redactDeep(maskKey(name, plaintext)) : "" };
	}
	function save(key, name) {
		if (!validKey(key)) { return { ok: false, error: "Enter an API key of 1 to 512 characters with no spaces." }; }
		if (!keyringAvailable(safeStorage, platform)) {
			return { ok: false, error: "This computer has no keyring the app can use, so the Cursor key can't be saved." };
		}
		let ciphertext;
		try { ciphertext = safeStorage.encryptString(key).toString("base64"); }
		catch { return { ok: false, error: "The Cursor key couldn't be encrypted." }; }
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeAtomic(file, { key: ciphertext, name: typeof name === "string" ? redactDeep(maskKey(name, key)) : "" }, fs);
			return { ok: true };
		} catch { return { ok: false, error: "The Cursor key couldn't be saved." }; }
	}
	function remove() {
		try { fs.unlinkSync(file); }
		catch (error) {
			if (error.code !== "ENOENT") { return { ok: false, error: "The Cursor key couldn't be removed." }; }
		}
		return { ok: true };
	}
	return { status, save, remove, key: () => decrypt(read().key, safeStorage, platform) };
}

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validMachine = (value) => value === undefined || (typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/.test(value));
const validMachineRef = (value) => typeof value === "string" && /^[A-Za-z0-9._\/-]+$/.test(value);
const validRepo = (url) => typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(url) && ![".", ".."].includes(url.split("/").at(-1));
const repoKey = (url) => typeof url === "string" ? url.replace(/^https?:\/\//i, "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase() : "";
const terminalStatus = new Set(["FINISHED", "FAILED", "ERROR", "CANCELLED", "CANCELED"]);

class CloudHost {
	constructor(emit, { api, getKey = () => "", retryDelays = [1000, 2000, 4000, 8000, 16000], waitNoticeMs = 30000 }) {
		this.emit = emit;
		this.api = api;
		this.getKey = getKey;
		this.retryDelays = retryDelays;
		this.waitNoticeMs = waitNoticeMs;
		this.turns = new Map();
		this.machines = new Map();
	}

	turnOf(uiSessionId) { return this.turns.get(uiSessionId)?.turnId; }

	current(turn) { return this.turns.get(turn.uiSessionId) === turn; }

	machineClaimProblem(machine, uiSessionId, resume = false) {
		if (machine === undefined) { return ""; }
		const claim = this.machines.get(machine.toLowerCase());
		if (!claim || (resume && claim.uiSessionId === uiSessionId && claim.resumable)) { return ""; }
		if (this.turns.get(claim.uiSessionId)?.machineClaim === claim) { return `Another session is using ${machine}. Wait for it to finish or stop it.`; }
		return `A run this app started on ${machine} may still be working, so the app won't start another there until it restarts. Check cursor.com/agents.`;
	}

	addTurn({ uiSessionId, turnId, cloud }, runId) {
		const { repoUrl, agentId, machine } = cloud;
		const turn = { uiSessionId, turnId, repoUrl, agentId, runId, machine, key: this.getKey(), mapping: {}, failures: 0, seenEventIds: new Set(), streamVersion: 0 };
		this.turns.set(uiSessionId, turn);
		if (machine !== undefined) {
			turn.branch = { branch: `grok/machine-${uiSessionId.replace(/^new-/, "").slice(0, 8)}` };
			turn.machineClaim = { uiSessionId, resumable: Boolean(runId) };
			this.machines.set(machine.toLowerCase(), turn.machineClaim);
		}
		return turn;
	}

	send(input) {
		const { uiSessionId, turnId, text, name, cloud } = input ?? {};
		if (!validId(uiSessionId) || !validId(turnId) || typeof text !== "string" || !text.trim() || text.length > 100000) {
			return { ok: false, error: "Write a message first." };
		}
		if (this.turns.has(uiSessionId)) { return { ok: false, error: "This Cloud session is already running." }; }
		const machine = cloud?.machine;
		if (!validMachine(machine)) { return { ok: false, error: MACHINE_NAME_ERROR }; }
		if (machine !== undefined && !validMachineRef(cloud.ref)) { return { ok: false, error: MACHINE_REF_ERROR }; }
		const claimProblem = this.machineClaimProblem(machine, uiSessionId);
		if (claimProblem) { return { ok: false, error: claimProblem }; }
		if (cloud?.active === true) { return { ok: false, error: "Resume the active Cloud run before sending another message." }; }
		if (!validRepo(cloud?.repoUrl) || typeof cloud.ref !== "string" || !cloud.ref || cloud.ref.length > 1024 || /[\s\x00-\x1f\x7f]/.test(cloud.ref) || typeof cloud.autoCreatePR !== "boolean" || (cloud.agentId !== undefined && !validId(cloud.agentId)) || (cloud.runId !== undefined && !validId(cloud.runId))) {
			return { ok: false, error: "Choose a valid Cloud repository and starting branch." };
		}
		const model = cloud.model;
		if (typeof model?.id !== "string" || !model.id.trim() || !Array.isArray(model.params) || model.params.some((param) => typeof param?.id !== "string" || !param.id || typeof param.value !== "string")) {
			return { ok: false, error: "Choose a valid Cursor model variant." };
		}
		const turn = this.addTurn(input);
		const agentName = (typeof name === "string" && name.trim() ? name.trim() : text.trim()).slice(0, 80);
		const { repoUrl, ref, autoCreatePR } = cloud;
		void this.begin(turn, { name: agentName, prompt: text, model, repoUrl, ref, autoCreatePR, ...(machine === undefined ? {} : { machine, branch: turn.branch.branch }) });
		return { ok: true };
	}

	async begin(turn, input) {
		if (turn.machine && !turn.agentId) {
			this.publish(turn, { type: "chunk", text: `_Starting on ${turn.machine}. Cursor takes about a minute to start a session on a machine._\n\n` });
		}
		const prompt = turn.agentId && turn.machine ? machinePrompt(input.prompt, input.branch, input.ref) : input.prompt;
		let reply;
		try { reply = await (turn.agentId ? this.api.followUp(turn.agentId, prompt) : this.api.create(input)); }
		catch { reply = { ok: false, error: requestFailureMessage(false, turn.agentId ? "run" : "agent") }; }
		if (reply?.ok !== true) {
			let message = reply?.code === "usage_limit_exceeded" ? CREDIT_MESSAGE : reply?.error || "Cursor couldn't start this run.";
			if (turn.machine && !turn.agentId && [400, 404, 409].includes(reply?.status) && reply?.code !== "usage_limit_exceeded") {
				message += machineHint(turn.machine);
			}
			const refused = reply?.ok === false && ![408, 502, 504].includes(reply.status) && (reply.code === "missing_key" ||
				(Number.isInteger(reply.status) && reply.status >= 400 && reply.status <= 599 && !["timeout", "invalid_reply"].includes(reply.code)));
			this.finish(turn, { type: "error", message }, { keepMachine: !refused });
			return;
		}
		const agentId = turn.agentId ?? reply.agent?.id;
		const runId = reply.run?.id;
		if (!validId(agentId) || !validId(runId)) {
			this.finish(turn, { type: "error", message: `Cursor returned invalid run details. The agent may have started. Check ${AGENTS_LINK} before sending again.` }, { keepMachine: true });
			return;
		}
		turn.agentId = agentId;
		turn.runId = runId;
		if (turn.machineClaim) { turn.machineClaim.resumable = true; }
		if (!this.current(turn)) { return; }
		this.state(turn, true);
		if (turn.cancelRequested) { void this.cancelRun(turn); }
		this.open(turn, false);
	}

	resume(input) {
		const { uiSessionId, turnId, cloud } = input ?? {};
		if (!validId(uiSessionId) || !validId(turnId) || cloud?.active !== true || !validRepo(cloud.repoUrl) || !validId(cloud.agentId) || !validId(cloud.runId)) {
			return { ok: false, error: "There are no saved Cloud run details to resume." };
		}
		if (!validMachine(cloud.machine)) { return { ok: false, error: MACHINE_NAME_ERROR }; }
		const live = this.turns.get(uiSessionId);
		if (live && (live.turnId !== turnId || live.agentId !== cloud.agentId || live.runId !== cloud.runId || live.machine !== cloud.machine || repoKey(live.repoUrl) !== repoKey(cloud.repoUrl))) {
			return { ok: false, error: "This Cloud session is already running." };
		}
		const claimProblem = this.machineClaimProblem(cloud.machine, uiSessionId, true);
		if (claimProblem) { return { ok: false, error: claimProblem }; }
		const turn = live ?? this.addTurn(input, cloud.runId);
		if (!live) { turn.waitNoticeStarted = true; }
		turn.failures = 0;
		this.open(turn, true);
		return { ok: true };
	}

	stop(uiSessionId) {
		const turn = this.turns.get(uiSessionId);
		if (!turn) { return; }
		this.turns.delete(uiSessionId);
		this.clearWaitNotice(turn);
		this.closeStream(turn);
	}

	cancel(uiSessionId) {
		const turn = this.turns.get(uiSessionId);
		if (!turn) { return { ok: false, error: "There is no live Cloud run to stop." }; }
		if (!turn.cancelRequested) {
			turn.cancelRequested = true;
			if (turn.runId) { void this.cancelRun(turn); }
		}
		return { ok: true };
	}

	async cancelRun(turn) {
		let reply;
		try { reply = await this.api.cancel(turn.agentId, turn.runId); }
		catch { reply = { ok: false, error: "Couldn't connect to Cursor." }; }
		if (!this.current(turn)) { return; }
		if (reply?.ok) { this.finish(turn, { type: "done", stopReason: "cancelled" }); return; }
		turn.cancelRequested = false;
		this.flush(turn);
		this.publish(turn, { type: "chunk", text: `\n\nCouldn't stop the Cloud run: ${reply?.error || "Cursor refused the cancellation."} Check ${AGENTS_LINK}.` });
	}

	closeStream(turn) {
		turn.streamVersion += 1;
		clearTimeout(turn.retryTimer);
		turn.retryTimer = undefined;
		const stream = turn.stream;
		turn.stream = undefined;
		stream?.stop();
	}

	open(turn, replay) {
		if (!this.current(turn)) { return; }
		this.closeStream(turn);
		this.startWaitNotice(turn);
		const version = turn.streamVersion;
		const onEvent = (frame) => {
			if (!this.current(turn) || version !== turn.streamVersion) { return; }
			if (frame.event === "closed" || frame.event === "expired") {
				this.closeStream(turn);
				const closedVersion = turn.streamVersion;
				if (frame.event === "expired" || turn.failures >= this.retryDelays.length) {
					void this.recover(turn, closedVersion);
				} else {
					const delay = this.retryDelays[turn.failures++];
					turn.retryTimer = setTimeout(() => this.open(turn, true), delay);
				}
				return;
			}
			const eventId = typeof frame.id === "string" ? frame.id : "";
			const resent = eventId !== "" && turn.seenEventIds.has(eventId);
			if (eventId !== "") { turn.seenEventIds.add(eventId); }
			if (!resent && frame.event !== "status" && frame.event !== "heartbeat") { turn.failures = 0; }
			if (replay) { replay = false; this.resetReply(turn); }
			if (frame.event === "done") { this.finish(turn, { type: "done" }); return; }
			this.accept(turn, frame);
		};
		let stream;
		try { stream = this.api.stream(turn.agentId, turn.runId, onEvent); }
		catch { onEvent({ event: "closed" }); return; }
		if (this.current(turn) && version === turn.streamVersion) { turn.stream = stream; }
		else { stream.stop(); }
	}

	async recover(turn, version) {
		let reply;
		try { reply = await this.api.run(turn.agentId, turn.runId); }
		catch { reply = null; }
		if (!this.current(turn) || version !== turn.streamVersion) { return; }
		if (reply?.ok && terminalStatus.has(reply.status)) {
			this.resetReply(turn);
			this.accept(turn, { event: "result", data: { status: reply.status, text: reply.result, git: reply.git } });
			this.finish(turn, { type: "done" });
			return;
		}
		this.finish(turn, { type: "error", message: `Lost the connection to Cursor. The agent may still be working; it's on ${AGENTS_LINK}.` }, { active: true });
	}

	resetReply(turn) {
		turn.mapping = {};
		turn.held = undefined;
		this.publish(turn, { type: "turn-start", resume: true });
	}

	accept(turn, frame) {
		const masked = maskKey(frame, turn.key);
		const textDelta = frame.event === "assistant" || frame.event === "thinking";
		const safe = textDelta ? masked : redactDeep(masked);
		const failed = frame.event === "result" && failedResult(safe.data);
		if (frame.event === "result") { turn.runFailed = failed; }
		if (turn.machine && frame.event === "result" && (failed || ["CANCELLED", "CANCELED"].includes(safe.data?.status))) {
			turn.machineRunUnsuccessful = true;
		}
		if (frame.event === "result" && Array.isArray(safe.data?.git?.branches)) {
			const entry = safe.data.git.branches.find((item) => typeof item?.branch === "string" && item.branch && repoKey(item.repoUrl) === repoKey(turn.repoUrl));
			if (entry) {
				const prUrl = typeof entry.prUrl === "string" && /^https?:\/\/[^\s<>]+$/i.test(entry.prUrl) ? entry.prUrl : undefined;
				turn.branch = { branch: entry.branch, prUrl };
			}
		}
		const events = mapEvent(safe, turn.mapping);
		if (turn.machine && failed) { events.at(-1).text += machineHint(turn.machine); }
		for (const event of events) {
			if (event.type !== "chunk" && event.type !== "thought") { this.flush(turn); this.publish(turn, event); continue; }
			if (turn.held?.type !== event.type) { this.flush(turn); }
			const [text, tail] = heldTail((turn.held?.text ?? "") + event.text);
			turn.held = tail ? { type: event.type, text: tail } : undefined;
			if (text) { this.publish(turn, { ...event, text }); }
		}
	}

	flush(turn) {
		if (!turn.held) { return; }
		const event = turn.held;
		turn.held = undefined;
		this.publish(turn, event);
	}

	startWaitNotice(turn) {
		if (!turn.machine || turn.waitNoticeStarted) { return; }
		turn.waitNoticeStarted = true;
		const timer = setTimeout(() => {
			if (!this.current(turn) || turn.waitNoticeTimer !== timer) { return; }
			const text = `_Waiting for ${turn.machine} to pick up this run. If its worker isn't running, start it or press Stop._\n\n`;
			this.publish(turn, { type: "chunk", text });
		}, this.waitNoticeMs);
		turn.waitNoticeTimer = timer;
	}

	clearWaitNotice(turn) {
		clearTimeout(turn.waitNoticeTimer);
		turn.waitNoticeTimer = undefined;
	}

	publish(turn, event) {
		if (turn.waitNoticeTimer !== undefined && ["chunk", "thought", "tool"].includes(event.type)) { this.clearWaitNotice(turn); }
		this.emit(redactDeep(maskKey({ ...event, uiSessionId: turn.uiSessionId, turnId: turn.turnId }, turn.key)));
	}

	state(turn, active) {
		this.publish(turn, { type: "cloud-state", agentId: turn.agentId, runId: turn.runId, active, ...turn.branch });
	}

	finish(turn, event, { active = false, keepMachine = active } = {}) {
		const current = this.current(turn);
		if (current) {
			this.flush(turn);
			this.stop(turn.uiSessionId);
		}
		if (!keepMachine && turn.machine) {
			const name = turn.machine.toLowerCase();
			if (this.machines.get(name) === turn.machineClaim) { this.machines.delete(name); }
		}
		if (!current) { return; }
		if (turn.runId) { this.state(turn, active); }
		if (turn.runFailed && event.type === "done" && event.stopReason !== "cancelled") { event = { type: "error" }; }
		if (turn.machine && event.type === "done" && !turn.machineRunUnsuccessful && !turn.cancelRequested && event.stopReason !== "cancelled") {
			event = { ...event, machine: turn.machine };
		}
		this.publish(turn, event);
	}
}

module.exports = { CloudHost, createCursorApi, createCursorKey, createSseParser, mapEvent };
