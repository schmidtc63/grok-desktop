// Context breakdown and recent spend, read from the files Grok keeps for each session under ~/.grok/sessions.
// ponytail: these are Grok's internal files, not a documented interface; any change there makes both reads fail soft.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Measured on a Grok 1.0.70 session: 92k characters of stored context were 25.2k tokens.
const CHARS_PER_TOKEN = 3.7;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function sessionsRoot() {
	return path.join(os.homedir(), ".grok", "sessions");
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
function autoCompactPercent(file = path.join(os.homedir(), ".grok", "config.toml")) {
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

module.exports = { contextBreakdown, recentSpend, autoCompactPercent };
