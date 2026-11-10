// Context breakdown and recent spend, read from the files Grok keeps for each session under ~/.grok/sessions.
// ponytail: these are Grok's internal files, not a documented interface; any change there makes both reads fail soft.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { grokHome } = require("./agent.cjs");
const { redactDeep, redactKeys } = require("./redact.cjs");

// Measured on a Grok 1.0.70 session: 92k characters of stored context were 25.2k tokens.
const CHARS_PER_TOKEN = 3.7;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const outputLimit = 200 * 1024;
const transcriptLimit = 5 * 1024 * 1024;

function sessionsRoot() {
	return path.join(grokHome(), "sessions");
}

// Grok names each folder after the session's working directory, so the session is found by its id.
function sessionFolder(agentSessionId, root = sessionsRoot()) {
	if (!SESSION_ID.test(String(agentSessionId || ""))) { return ""; }
	for (const name of fs.readdirSync(root)) {
		const folder = path.join(root, name, agentSessionId);
		if (fs.existsSync(path.join(folder, "chat_history.jsonl"))) { return folder; }
	}
	return "";
}

// A sandboxed session's files are in that sandbox's own Grok home, so the first root is only the fallback.
function rootOf(agentSessionId, roots) {
	for (const root of roots) {
		try { if (sessionFolder(agentSessionId, root)) { return root; } } catch { /* That sandbox hasn't been used. */ }
	}
	return roots[0];
}

function entryText(entry) {
	return typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content || "");
}

// The fixed parts of the context, in estimated tokens. Messages are whatever the live total leaves.
function contextBreakdown(agentSessionId, root = sessionsRoot()) {
	try {
		const folder = sessionFolder(agentSessionId, root);
		if (!folder) { return { ok: false, error: "Grok has not saved this session yet." }; }
		const chars = { systemPrompt: 0, rules: 0, skills: 0, workflows: 0, mcp: 0, tools: 0 };
		for (const line of fs.readFileSync(path.join(folder, "chat_history.jsonl"), "utf8").split("\n")) {
			if (!line.trim()) { continue; }
			const entry = JSON.parse(line);
			const text = entryText(entry);
			// The last copy of each fixed part is the one in context.
			if (entry.type === "system") { chars.systemPrompt = line.length; }
			if (entry.type === "user" && !entry.synthetic_reason && text.includes("<user_info>")) { chars.rules = line.length; }
			if (entry.synthetic_reason === "system_reminder" && text.includes("The following skills are available")) {
				const split = text.indexOf("The following workflows are available");
				chars.workflows = split < 0 ? 0 : text.length - split;
				chars.skills = line.length - chars.workflows;
			}
			if (entry.synthetic_reason === "system_reminder" && text.includes("MCP servers connected")) { chars.mcp = line.length; }
		}
		const tools = path.join(folder, "tool_definitions.json");
		// The file is indented; the model sees the tools without that whitespace.
		if (fs.existsSync(tools)) { chars.tools = JSON.stringify(JSON.parse(fs.readFileSync(tools, "utf8"))).length; }
		const parts = Object.fromEntries(Object.entries(chars).map(([key, value]) => [key, Math.round(value / CHARS_PER_TOKEN)]));
		return { ok: true, parts, autoCompactPercent: autoCompactPercent() };
	} catch {
		return { ok: false, error: "Grok's session files could not be read." };
	}
}

// `[session] auto_compact_threshold_percent` in ~/.grok/config.toml, 85 when unset.
function autoCompactPercent(file = path.join(grokHome(), "config.toml")) {
	try {
		const text = fs.readFileSync(file, "utf8");
		const section = /^\[session\][^\S\n]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
		const value = section && /^\s*auto_compact_threshold_percent\s*=\s*(\d+)/m.exec(section[1]);
		const percent = value ? Number(value[1]) : 85;
		return percent > 0 && percent <= 100 ? percent : 85;
	} catch {
		return 85;
	}
}

// What Grok recorded as spent in the last seven days, across every session on this computer.
function recentSpend(now = Date.now(), root = sessionsRoot()) {
	let ticks = 0;
	try {
		for (const name of fs.readdirSync(root)) {
			let sessions;
			try { sessions = fs.readdirSync(path.join(root, name)); } catch { continue; }
			for (const id of sessions) {
				const file = path.join(root, name, id, "usage.json");
				// Grok rewrites usage.json at each turn end, so a file untouched for a week holds no turn from it.
				try { if (now - fs.statSync(file).mtimeMs > WEEK_MS) { continue; } } catch { continue; }
				let usage;
				try { usage = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
				for (const turn of Array.isArray(usage.turns) ? usage.turns : []) {
					const ended = Date.parse(String((turn && turn.endedAt) || "").replace(/(\.\d{3})\d+/, "$1"));
					if (ended && now - ended <= WEEK_MS) { ticks += Number(turn.costUsdTicks) || 0; }
				}
			}
		}
	} catch {
		return { ok: false, error: "Grok's usage files could not be read." };
	}
	return { ok: true, usd: ticks / 1e10 };
}

function readTail(file, limit, lookbehind = 0) {
	const handle = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(handle).size;
		const start = Math.max(0, size - limit - lookbehind);
		const buffer = Buffer.alloc(size - start);
		const read = fs.readSync(handle, buffer, 0, buffer.length, start);
		return { text: buffer.subarray(0, read).toString("utf8"), truncated: size > limit };
	} finally {
		fs.closeSync(handle);
	}
}

function taskOutput(file, root = sessionsRoot()) {
	try {
		const base = fs.realpathSync(root);
		const real = fs.realpathSync(String(file || ""));
		if (!real.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`) || path.extname(real).toLowerCase() !== ".log") { return { ok: false, error: "That output is not available." }; }
		const { text, truncated } = readTail(real, outputLimit, 1024);
		return { ok: true, text: redactKeys(text).slice(-outputLimit), truncated };
	} catch {
		return { ok: false, error: "Grok's output file for that command is gone." };
	}
}

function subagentTranscript(childSessionId, root = sessionsRoot()) {
	try {
		const folder = sessionFolder(childSessionId, root);
		if (!folder) { return { ok: false, error: "Grok has not saved this subagent's work." }; }
		const base = fs.realpathSync(root);
		const file = fs.realpathSync(path.join(folder, "updates.jsonl"));
		if (!file.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) { return { ok: false, error: "Grok's record of this subagent could not be read." }; }
		const tail = readTail(file, transcriptLimit);
		const prompt = { id: "subagent-prompt", role: "user", text: "" };
		const work = { id: "subagent-work", role: "grok", text: "", thought: "", tools: [], parts: [] };
		const cards = new Map();
		for (const line of tail.text.split("\n")) {
			let entry;
			try { entry = JSON.parse(line); } catch { continue; }
			const params = entry && entry.params;
			const update = params && params.update;
			if (!update || (params.sessionId && String(params.sessionId).toLowerCase() !== String(childSessionId).toLowerCase())) { continue; }
			const text = update.content && typeof update.content.text === "string" ? update.content.text : "";
			if (update.sessionUpdate === "user_message_chunk") { prompt.text += text; }
			if (update.sessionUpdate === "agent_thought_chunk") { work.thought += text; }
			if (update.sessionUpdate === "agent_message_chunk" && text) {
				work.text += text;
				const previous = work.parts[work.parts.length - 1];
				if (previous && previous.kind === "text") { previous.text += text; } else { work.parts.push({ kind: "text", text }); }
			}
			if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") { continue; }
			const id = String(update.toolCallId || "");
			if (!id) { continue; }
			let card = cards.get(id);
			if (!card) {
				card = { id, kind: "other", title: "Tool", detail: "Running" };
				cards.set(id, card);
				work.tools.push(card);
				work.parts.push({ kind: "tool", id });
			}
			if (update.kind) { card.kind = String(update.kind); }
			if (update.title) { card.title = String(update.title); }
			const meta = update._meta && update._meta["x.ai/tool"];
			if (meta && typeof meta.label === "string" && meta.label.trim()) { card.label = redactKeys(meta.label).slice(0, 80); }
			const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
			if (typeof input.description === "string" && input.description.trim()) { card.description = redactKeys(input.description).slice(0, 300); }
			if (typeof input.command === "string" && input.command.trim()) { card.command = redactKeys(input.command).slice(0, 4000); }
			const location = Array.isArray(update.locations) && update.locations[0] && update.locations[0].path;
			const target = location || input.target_file || input.file_path || input.target_directory || input.path;
			if (typeof target === "string" && target.trim()) { card.path = redactKeys(target).slice(0, 1000); }
			if (update.status === "completed") { card.detail = "Ran"; } else if (update.status === "failed") { card.detail = "Failed"; }
			const content = Array.isArray(update.content) ? update.content : [];
			const output = content.map((part) => part && part.type === "content" && part.content && typeof part.content.text === "string" ? part.content.text : "").filter(Boolean).join("\n");
			if (output.trim()) { card.output = redactKeys(output).slice(0, 1500); }
		}
		work.thought = redactKeys(work.thought).slice(0, 20000);
		return redactDeep({ ok: true, messages: [prompt, work], truncated: tail.truncated });
	} catch {
		return { ok: false, error: "Grok's record of this subagent could not be read." };
	}
}

// shortcut: a transcript over 2 MiB or 400k characters keeps its newest part, raise the caps if a long CLI session opens incomplete.
const CLI_FILE_LIMIT = 2 * 1024 * 1024;
const CLI_MESSAGE_CAP = 20000;
const CLI_TOTAL_CAP = 400000;
const CLI_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function decodeFolder(name) {
	try { return decodeURIComponent(name); } catch { return name; }
}

function readSummary(folder) {
	try { return JSON.parse(fs.readFileSync(path.join(folder, "summary.json"), "utf8")); } catch { return {}; }
}

function messageText(content) {
	if (typeof content === "string") { return content; }
	if (Array.isArray(content)) { return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join(""); }
	return content && typeof content.text === "string" ? content.text : "";
}

// The first user entry also carries Grok's rules. The person's words are the user_query.
function personText(entry) {
	if (!entry || entry.synthetic_reason) { return ""; }
	const text = messageText(entry.content);
	const queries = [];
	for (const match of text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)) {
		const value = match[1].trim();
		if (value) { queries.push(value); }
	}
	if (queries.length) { return queries.join("\n\n"); }
	if (/<user_info>|<rules>|<user_rules>/.test(text)) { return ""; }
	return text.trim();
}

function cliTitle(summary) {
	const raw = typeof summary.generated_title === "string" && summary.generated_title.trim() ? summary.generated_title : (typeof summary.session_summary === "string" ? summary.session_summary : "");
	return redactKeys(raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 80) || "CLI session";
}

function activeAt(summary, file) {
	const parsed = Date.parse(String(summary.last_active_at || summary.updated_at || "").replace(/(\.\d{3})\d+/, "$1"));
	if (parsed) { return parsed; }
	try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function cwdOf(sessionDir, summary) {
	const named = summary.info && typeof summary.info.cwd === "string" ? summary.info.cwd : "";
	return named || decodeFolder(path.basename(path.dirname(sessionDir)));
}

// Sessions the app already has, archived ones included, are left out. Newest first.
function listCliSessions(knownIds = [], root = sessionsRoot()) {
	const known = new Set((Array.isArray(knownIds) ? knownIds : []).map((id) => String(id).toLowerCase()));
	const sessions = [];
	const seen = new Set();
	let entries;
	try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { ok: false, error: "Grok's sessions could not be read." }; }
	for (const cwdEntry of entries) {
		if (!cwdEntry.isDirectory()) { continue; }
		let children;
		try { children = fs.readdirSync(path.join(root, cwdEntry.name), { withFileTypes: true }); } catch { continue; }
		for (const child of children) {
			const id = child.name;
			if (!child.isDirectory() || !SESSION_ID.test(id) || known.has(id.toLowerCase()) || seen.has(id.toLowerCase())) { continue; }
			const folder = path.join(root, cwdEntry.name, id);
			const history = path.join(folder, "chat_history.jsonl");
			if (!fs.existsSync(history)) { continue; }
			seen.add(id.toLowerCase());
			const summary = readSummary(folder);
			sessions.push({ id, title: redactKeys(cliTitle(summary)), folder: cwdOf(folder, summary), lastActive: activeAt(summary, history) });
		}
	}
	sessions.sort((a, b) => b.lastActive - a.lastActive || a.title.localeCompare(b.title));
	return { ok: true, sessions };
}

function listCliProjectFolders(root = sessionsRoot(), temporary = os.tmpdir()) {
	const { sessions = [] } = listCliSessions([], root);
	const folders = [];
	const seen = new Set();
	const temporaryPart = /(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)/i;
	let tempRoot = temporary;
	try { tempRoot = fs.realpathSync(temporary); } catch { /* The configured temp root may not exist. */ }
	for (const { folder } of sessions) {
		if (!path.isAbsolute(folder) || temporaryPart.test(folder)) { continue; }
		try {
			const real = fs.realpathSync(folder);
			if (temporaryPart.test(real)) { continue; }
			const relative = path.relative(tempRoot, real);
			if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) { continue; }
			const key = process.platform === "win32" ? real.toLowerCase() : real;
			if (seen.has(key) || real === path.parse(real).root || !path.relative(os.homedir(), real) || !fs.statSync(real).isDirectory()) { continue; }
			seen.add(key);
			folders.push(folder);
			if (folders.length === 5) { break; }
		} catch { /* Session folders can have moved since the CLI last opened them. */ }
	}
	return folders;
}

function historyText(file, fileLimit) {
	const size = fs.statSync(file).size;
	if (size <= fileLimit) { return { text: fs.readFileSync(file, "utf8"), truncated: false }; }
	const tail = readTail(file, fileLimit);
	const skip = tail.text.indexOf("\n");
	return { text: skip < 0 ? "" : tail.text.slice(skip + 1), truncated: true };
}

function openCliSession(agentSessionId, root = sessionsRoot(), limits = {}) {
	const fileLimit = limits.fileLimit || CLI_FILE_LIMIT;
	const messageCap = limits.messageCap || CLI_MESSAGE_CAP;
	const totalCap = limits.totalCap || CLI_TOTAL_CAP;
	let folder = "";
	try { folder = sessionFolder(agentSessionId, root); } catch { return { ok: false, error: "Grok's sessions could not be read." }; }
	if (!folder) { return { ok: false, error: "That Grok session is gone." }; }
	const summary = readSummary(folder);
	const cwd = cwdOf(folder, summary);
	let directory = false;
	try { directory = path.isAbsolute(cwd) && !cwd.includes("\0") && fs.statSync(cwd).isDirectory(); } catch { directory = false; }
	if (!directory) { return { ok: false, error: "That session's folder is gone." }; }
	let read;
	try { read = historyText(path.join(folder, "chat_history.jsonl"), fileLimit); } catch { return { ok: false, error: "That Grok session could not be read." }; }
	const messages = [];
	let total = 0;
	let truncated = read.truncated;
	for (const line of read.text.split("\n")) {
		if (!line.trim()) { continue; }
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const role = entry.type === "user" ? "user" : entry.type === "assistant" ? "grok" : "";
		if (!role) { continue; }
		let text = redactKeys(role === "user" ? personText(entry) : messageText(entry.content).trim());
		if (!text) { continue; }
		if (text.length > messageCap) { text = `${text.slice(0, messageCap)}…`; truncated = true; }
		messages.push({ role, text });
		total += text.length;
	}
	while (messages.length > 1 && total > totalCap) {
		total -= messages[0].text.length;
		messages.shift();
		truncated = true;
	}
	const branch = typeof summary.head_branch === "string" ? summary.head_branch.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) : "";
	const model = typeof summary.current_model_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(summary.current_model_id) ? summary.current_model_id : "";
	const effort = CLI_EFFORTS.has(summary.reasoning_effort) ? summary.reasoning_effort : "";
	return redactDeep({
		ok: true,
		truncated,
		session: { id: String(agentSessionId), title: cliTitle(summary), folder: cwd, branch, model, effort, lastActive: activeAt(summary, path.join(folder, "chat_history.jsonl")) },
		messages,
	});
}

module.exports = { rootOf, contextBreakdown, recentSpend, autoCompactPercent, taskOutput, subagentTranscript, listCliSessions, listCliProjectFolders, openCliSession };
