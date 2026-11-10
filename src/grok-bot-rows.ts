export type GrokBotConnection = "off" | "live" | "reconnecting" | "expired" | "problem";
export type GrokBotLive = {
	running?: boolean;
	composing?: boolean;
	retrying?: boolean;
	waiting?: boolean;
	detail?: string;
	outcome?: string;
	turnId?: string;
	settledAtMs?: number;
};
export type GrokBotStatus = {
	ok?: boolean;
	signedIn: boolean;
	keyring: boolean;
	signingIn: boolean;
	until?: number;
	connection: GrokBotConnection;
	bots: { agentId: string; name: string }[];
	live: Record<string, GrokBotLive>;
};
export type GrokBotRow = {
	seq: string;
	updatedSeq: string;
	entryId?: string;
	entryKind: string;
	body?: Record<string, unknown>;
	stored?: boolean;
};
export type GrokBotPending = { messageId: string; text: string; at: number; error?: string };
export type GrokBotState = {
	status: GrokBotStatus;
	rows: Record<string, GrokBotRow[]>;
	pending: Record<string, GrokBotPending[]>;
	lastSend: Record<string, GrokBotPending>;
	notes: Record<string, string>;
	beforeSeq: Record<string, string | undefined>;
	failedTurns: Record<string, string>;
};
export type GrokBotEvent =
	| { type: "grokbot-status"; status: GrokBotStatus }
	| { type: "grokbot-rows"; agentId: string; rows: GrokBotRow[]; deletes?: string[] }
	| { type: "grokbot-reset" | "grokbot-history"; agentId: string; rows: GrokBotRow[] }
	| ({ type: "grokbot-live"; agentId: string } & GrokBotLive)
	| { type: "grokbot-failed"; agentId: string; summary: string }
	| { type: "grokbot-send"; agentId: string; messageId: string; text: string; at: number }
	| { type: "grokbot-send-result"; agentId: string; messageId: string; ok: boolean; error?: string }
	| { type: "grokbot-tick"; now: number };
export type GrokBotDescription = {
	kind: "message" | "note" | "attachment" | "widget";
	side: "user" | "grok";
	text: string;
	label?: string;
	note?: string;
	options?: { label: string; value: string; style?: string }[];
	closed?: boolean;
	answer?: string;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const set = (value: unknown): boolean => value !== undefined && value !== null && value !== false;
const sequence = (value: string): bigint => /^\d+$/.test(value) ? BigInt(value) : 0n;
const rowKey = (row: GrokBotRow): string => row.entryId ?? row.seq;
const cardTypes = new Set(["secret-request", "auto-review-approval", "local-tool-permission", "connector-grant", "user-form", "credential-request", "virtual-card-approval", "cookie-origin-approval", "meeting-join-consent", "mobile-tool-permission", "appearance-picker", "email-offer"]);
const cardDetail = (value: unknown): string => text(value).trim().replace(/\s+/g, " ");

function siteHost(value: unknown): string {
	const site = text(value).trim();
	if (!site || /^[\\/]/.test(site)) { return ""; }
	try {
		const url = new URL(site.includes("://") ? site : `https://${site}`);
		return url.protocol === "https:" || url.protocol === "http:" ? url.host : "";
	} catch { return ""; }
}

function cardRequest(kind: string, message: Record<string, unknown>): string {
	switch (kind) {
		case "secret-request": {
			const label = cardDetail(record(message.secretRequest).label);
			return `Provide a secret${label ? `: ${label}` : ""}`;
		}
		case "auto-review-approval": {
			const approval = record(message.approval);
			const copy = record(approval.summaryCopy);
			if (copy.kind === "phone_call") {
				const params = record(copy.params);
				const request = cardDetail(params.request);
				return `Approve a phone call to ${cardDetail(params.destination) || "a phone number"}${request ? `: ${request}` : ""}`;
			}
			if (approval.surface === "bot_share") {
				let share: Record<string, unknown> = {};
				try { share = record(JSON.parse(text(approval.command))); } catch {}
				const name = cardDetail(share.name);
				const visibility = cardDetail(share.visibility);
				return `Share a Bot template${name ? ` "${name}"` : ""}${visibility ? ` (${visibility})` : ""}`;
			}
			const summary = cardDetail(approval.summary) || cardDetail(approval.reason);
			return summary ? `Review request: ${summary}` : "Review an approval request";
		}
		case "local-tool-permission": {
			const ask = record(message.ask);
			const details = [cardDetail(ask.action), cardDetail(ask.target)].filter(Boolean).join(": ");
			return `Allow a local action${details ? `: ${details}` : ""}`;
		}
		case "connector-grant":
			return `Allow ${cardDetail(record(message.ask).serverName) || "a connected app"} for this turn`;
		case "user-form": {
			const form = record(message.formRequest);
			const title = cardDetail(form.title);
			const fields = Array.isArray(form.fields) ? `, ${form.fields.length} ${form.fields.length === 1 ? "field" : "fields"}` : "";
			return `Secure form${title ? ` "${title}"` : ""}${fields}`;
		}
		case "credential-request": {
			const request = record(message.credentialRequest);
			if (request.kind === "brokered-login") {
				const sites = Array.isArray(request.entries) ? request.entries.map((entry) => siteHost(record(entry).website)).filter(Boolean) : [];
				return `${cardDetail(request.goal) || "Use saved logins"}${sites.length ? ` (${sites.join(", ")})` : ""}`;
			}
			const site = siteHost(request.targetSite);
			const purpose = cardDetail(request.purpose);
			return `Use a saved login${site ? ` for ${site}` : ""}${purpose ? `: ${purpose}` : ""}`;
		}
		case "virtual-card-approval": {
			const title = cardDetail(record(message.approval).title);
			return `Virtual card purchase${title ? `: ${title}` : ""}`;
		}
		case "cookie-origin-approval":
			return "Use your browser sign-ins";
		case "meeting-join-consent":
			return "Ask meeting participants before the Bot joins";
		case "mobile-tool-permission": {
			const permission = record(message.permission);
			const tool = cardDetail(permission.toolId);
			const phone = cardDetail(permission.machineLabel);
			return `Allow phone access${tool ? `: ${tool}` : ""}${phone ? ` (${phone})` : ""}`;
		}
		case "appearance-picker":
			return "Choose the Bot's appearance";
		case "email-offer": {
			const email = cardDetail(message.email);
			const site = siteHost(message.site);
			return `Use an email address for the Bot${email ? `: ${email}` : ""}${site ? ` (for ${site})` : ""}`;
		}
		case "widget": {
			const widget = record(message.widget);
			const change = record(widget.ruleChange);
			const action = change.kind === "add" ? "Add" : change.kind === "delete" ? "Remove" : change.kind === "update" ? "Update" : "Change";
			const effect = change.effect === "allow" ? "Allow without asking: " : change.effect === "ask_first" ? "Ask first: " : "";
			const rule = cardDetail(change.text) || cardDetail(widget.prompt);
			const previous = change.kind === "update" ? cardDetail(change.replaces) : "";
			return `${action} approval rule${rule ? `: ${effect}${rule}` : ""}${previous ? ` (replaces "${previous}")` : ""}`;
		}
		default:
			return "Review this request";
	}
}

function cardClosed(kind: string, body: Record<string, unknown>, message: Record<string, unknown>): boolean {
	if (kind === "widget" && (set(body.respondedValue) || set(body.widgetDismissed) || set(body.widgetSkipped))) { return true; }
	if (kind === "secret-request" && set(body.secretProvided)) { return true; }
	if (kind === "user-form" && (set(body.formResolution) || set(body.widgetDismissed))) { return true; }
	if (kind === "credential-request" && ["approved", "denied", "failed"].includes(text(body.credentialResolution))) { return true; }
	if (kind === "appearance-picker" && set(body.respondedValue)) { return true; }
	if (kind === "email-offer" && (set(body.respondedValue) || set(message.replaced))) { return true; }
	const status = message.status ?? Object.values(message).map((value) => record(value).status).find((value) => value !== undefined && value !== null);
	if (status !== undefined && status !== null && status !== "pending") { return true; }
	return false;
}

export function describeRow(row: GrokBotRow): GrokBotDescription {
	const body = record(row.body);
	const message = record(body.message);
	const kind = row.entryKind || text(body.kind);
	const type = text(message.type);
	if (row.stored) { return { kind: "note", side: "grok", text: "This message is stored separately and can't be shown here yet. Open Grok Bot to read it." }; }
	if (kind === "message" && body.role === "user") {
		const from = record(body.fromAgent);
		return Object.keys(from).length
			? { kind: "message", side: "grok", text: text(body.content), label: `From ${text(from.name) || "another Bot"}` }
			: { kind: "message", side: "user", text: text(body.content) };
	}
	if (kind === "message" && body.role === "assistant") {
		const to = record(body.toAgent);
		return { kind: "message", side: "grok", text: text(body.content), ...(Object.keys(to).length ? { label: `To ${text(to.name) || "another Bot"}` } : {}) };
	}
	if (kind === "user-attachment") { return { kind: "note", side: "user", text: `You attached ${text(body.file_name) || "a file"}. Open Grok Bot to see it.` }; }
	if (kind === "send-message") {
		if (type === "text") {
			return { kind: "message", side: "grok", text: text(message.content), ...(message.cards !== undefined ? { note: "This reply has cards this app can't show. Open Grok Bot to see them." } : {}) };
		}
		if (type === "attachment") { return { kind: "attachment", side: "grok", text: text(message.file_name) || "Attachment" }; }
		if (type === "visualization") { return { kind: "note", side: "grok", text: `${text(message.title) || "Visualization"}. Open Grok Bot to see it.` }; }
		if (type === "connector" || type === "scm-connect") {
			const name = type === "connector" ? text(message.connector).trim() || "an account" : text(message.provider).trim() || "a source control account";
			return { kind: "note", side: "grok", text: `Grok Bot asked you to connect ${name}. If you haven't yet, do it in the Grok Bot app. This app can't show that card.` };
		}
		const closed = cardClosed(type, body, message);
		const widget = record(message.widget);
		if (type === "widget" && !widget.ruleChange) {
			const options = Array.isArray(widget.options) ? widget.options.map(record).filter((option) => typeof option.label === "string" && typeof option.value === "string").map((option) => ({ label: text(option.label), value: text(option.value), ...(typeof option.style === "string" ? { style: option.style } : {}) })) : [];
			return {
				kind: "widget", side: "grok", text: text(widget.prompt), closed, options: closed ? [] : options,
				...(closed ? { answer: text(body.respondedValue) || (set(body.widgetDismissed) ? "Dismissed" : set(body.widgetSkipped) ? "Skipped" : "Handled in Grok Bot") } : {}),
				...(!closed && !options.length ? { note: "Open Grok Bot to answer this question." } : {}),
			};
		}
		if (type === "widget" || cardTypes.has(type)) {
			const request = cardRequest(type, message);
			return { kind: "note", side: "grok", text: `${request}${/[.!?]$/.test(request) ? "" : "."} ${closed ? "Handled in Grok Bot." : "Use the Grok Bot app to respond."}`, closed };
		}
	}
	if (kind === "event") {
		const event = record(body.event);
		return { kind: "note", side: "grok", text: event.type === "name-changed" ? `Renamed from ${text(event.from)} to ${text(event.to)}` : `Event: ${text(event.type) || "unknown"}` };
	}
	return { kind: "note", side: "grok", text: "This app can't show this item yet. Open Grok Bot to see it." };
}

export function createGrokBotState(): GrokBotState {
	return {
		status: { signedIn: false, keyring: false, signingIn: false, connection: "off", bots: [], live: {} },
		rows: {}, pending: {}, lastSend: {}, notes: {}, beforeSeq: {}, failedTurns: {},
	};
}

export function historyBeforeSeq(rows: GrokBotRow[]): string | undefined {
	return rows.reduce<string | undefined>((lowest, row) => lowest === undefined || sequence(row.seq) < sequence(lowest) ? row.seq : lowest, undefined);
}

function mergeRows(previous: GrokBotRow[], incoming: GrokBotRow[], deletes: string[] = []): GrokBotRow[] {
	const merged = new Map(previous.map((row) => [rowKey(row), row]));
	for (const row of incoming) {
		const old = merged.get(rowKey(row));
		if (!old || sequence(row.updatedSeq) >= sequence(old.updatedSeq)) { merged.set(rowKey(row), row); }
	}
	for (const id of deletes) { merged.delete(id); }
	return [...merged.values()].sort((a, b) => sequence(a.seq) < sequence(b.seq) ? -1 : sequence(a.seq) > sequence(b.seq) ? 1 : 0);
}

function reconcilePending(state: GrokBotState, agentId: string, rows: GrokBotRow[]): GrokBotState {
	const confirmed = new Set(rows.map((row) => text(record(row.body).clientNonce)).filter(Boolean));
	const lastSend = { ...state.lastSend };
	if (confirmed.has(lastSend[agentId]?.messageId)) { delete lastSend[agentId]; }
	return { ...state, lastSend, pending: { ...state.pending, [agentId]: (state.pending[agentId] || []).filter((pending) => !confirmed.has(pending.messageId)) } };
}

function recordFailure(state: GrokBotState, agentId: string, live: GrokBotLive, now: number): GrokBotState {
	if (live.running && state.notes[agentId]) { state = { ...state, notes: { ...state.notes, [agentId]: "" } }; }
	const elapsed = now - Number(live.settledAtMs);
	if (live.outcome !== "error" || !live.turnId || state.failedTurns[agentId] === live.turnId || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 60000) { return state; }
	return { ...state, notes: { ...state.notes, [agentId]: live.running ? "" : state.notes[agentId] || "That turn didn't finish." }, failedTurns: { ...state.failedTurns, [agentId]: live.turnId } };
}

export function reduceGrokBot(state: GrokBotState, event: GrokBotEvent, now = Date.now()): GrokBotState {
	if (event.type === "grokbot-status") {
		if (!event.status.signedIn) { return { ...createGrokBotState(), status: event.status }; }
		let next = { ...state, status: event.status };
		for (const [agentId, live] of Object.entries(event.status.live)) { next = recordFailure(next, agentId, live, now); }
		return next;
	}
	if (event.type === "grokbot-tick") {
		const pending = Object.fromEntries(Object.entries(state.pending).map(([agentId, messages]) => [agentId, messages.map((message) => !message.error && event.now - message.at >= 60000 ? { ...message, error: "Not confirmed yet. Check Grok Bot before sending again." } : message)]));
		return { ...state, pending };
	}
	const agentId = event.agentId;
	if (event.type === "grokbot-rows" || event.type === "grokbot-reset" || event.type === "grokbot-history") {
		const rows = mergeRows(event.type === "grokbot-reset" ? [] : state.rows[agentId] || [], event.rows, event.type === "grokbot-rows" ? event.deletes : []);
		const next = { ...state, rows: { ...state.rows, [agentId]: rows }, ...(event.type === "grokbot-history" || event.type === "grokbot-reset" ? { beforeSeq: { ...state.beforeSeq, [agentId]: historyBeforeSeq(event.rows) } } : {}) };
		return reconcilePending(next, agentId, event.rows);
	}
	if (event.type === "grokbot-live") {
		const { type: _type, agentId: _agentId, ...live } = event;
		return recordFailure({ ...state, status: { ...state.status, live: { ...state.status.live, [agentId]: live } } }, agentId, live, now);
	}
	if (event.type === "grokbot-failed") { return { ...state, notes: { ...state.notes, [agentId]: `That turn didn't finish.${event.summary ? ` ${event.summary}` : ""}` } }; }
	if (event.type === "grokbot-send") {
		const current = state.pending[agentId] || [];
		const pending = { messageId: event.messageId, text: event.text, at: current.find((item) => item.messageId === event.messageId)?.at ?? event.at };
		return { ...state, pending: { ...state.pending, [agentId]: [...current.filter((item) => item.messageId !== event.messageId), pending] }, lastSend: { ...state.lastSend, [agentId]: pending }, notes: { ...state.notes, [agentId]: "" } };
	}
	if (event.type === "grokbot-send-result") {
		return { ...state, pending: { ...state.pending, [agentId]: (state.pending[agentId] || []).map((pending) => pending.messageId === event.messageId ? { ...pending, error: event.ok ? undefined : event.error || "Not sent." } : pending) } };
	}
	return state;
}

export function messageIdFor(state: GrokBotState, agentId: string, value: string, makeId: () => string = () => crypto.randomUUID()): string {
	const previous = state.lastSend[agentId];
	return previous && previous.text === value ? previous.messageId : makeId();
}

export function connectionText(connection: GrokBotConnection): string {
	if (connection === "expired") { return "Your Grok Bot sign-in ended. Sign in again in Settings."; }
	if (connection === "problem") { return "Grok Bot's connection isn't working. Cursor may have changed something. If this keeps happening, sign out and back in from Settings."; }
	if (connection === "reconnecting") { return "Reconnecting to Grok Bot…"; }
	return "";
}

export function statusLine(live: GrokBotLive | undefined, connection: GrokBotConnection): string {
	if (connection !== "live") { return connectionText(connection); }
	if (live?.waiting) { return "Waiting for you in Grok Bot."; }
	if (live?.retrying) { return "Retrying…"; }
	if (live?.composing) { return "Writing…"; }
	return live?.running ? live.detail || "Working…" : "";
}

export function showStop(live: GrokBotLive | undefined, connection: GrokBotConnection): boolean {
	return connection === "problem" || (connection === "live" && live?.running === true);
}
