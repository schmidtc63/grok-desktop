// Context breakdown and recent spend, read from the files Grok keeps for each session under ~/.grok/sessions.
// ponytail: these are Grok's internal files, not a documented interface; any change there makes both reads fail soft.
const fs = require("fs");
const path = require("path");
const { grokHome } = require("./agent.cjs");

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
				if (!fs.existsSync(file)) { continue; }
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

function readTail(file, limit) {
	const handle = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(handle).size;
		const start = Math.max(0, size - limit);
		const buffer = Buffer.alloc(size - start);
		const read = fs.readSync(handle, buffer, 0, buffer.length, start);
		return { text: buffer.subarray(0, read).toString("utf8"), truncated: start > 0 };
	} finally {
		fs.closeSync(handle);
	}
}

function taskOutput(file, root = sessionsRoot()) {
	try {
		const base = fs.realpathSync(root);
		const real = fs.realpathSync(String(file || ""));
		if (!real.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`) || path.extname(real).toLowerCase() !== ".log") { return { ok: false, error: "That output is not available." }; }
		return { ok: true, ...readTail(real, outputLimit) };
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
			if (update.sessionUpdate === "agent_thought_chunk") { work.thought = (work.thought + text).slice(0, 20000); }
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
			if (meta && typeof meta.label === "string" && meta.label.trim()) { card.label = meta.label.slice(0, 80); }
			const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
			if (typeof input.description === "string" && input.description.trim()) { card.description = input.description.slice(0, 300); }
			if (typeof input.command === "string" && input.command.trim()) { card.command = input.command.slice(0, 4000); }
			const location = Array.isArray(update.locations) && update.locations[0] && update.locations[0].path;
			const target = location || input.target_file || input.file_path || input.target_directory || input.path;
			if (typeof target === "string" && target.trim()) { card.path = target.slice(0, 1000); }
			if (update.status === "completed") { card.detail = "Ran"; } else if (update.status === "failed") { card.detail = "Failed"; }
			const content = Array.isArray(update.content) ? update.content : [];
			const output = content.map((part) => part && part.type === "content" && part.content && typeof part.content.text === "string" ? part.content.text : "").filter(Boolean).join("\n");
			if (output.trim()) { card.output = output.slice(0, 1500); }
		}
		return { ok: true, messages: [prompt, work], truncated: tail.truncated };
	} catch {
		return { ok: false, error: "Grok's record of this subagent could not be read." };
	}
}

module.exports = { contextBreakdown, recentSpend, autoCompactPercent, taskOutput, subagentTranscript };
