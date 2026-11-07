// Read-only look at a stopped session's scheduled loops. Grok keeps them in that session's resources_state.json.
// ponytail: no captured task yet, so both key forms and both field styles are accepted; a shape that does not parse shows nothing.
const fs = require("fs");
const path = require("path");

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_CAP = 2 * 1024 * 1024;

function sessionFolder(agentSessionId, root) {
	if (!root || !SESSION_ID.test(String(agentSessionId || ""))) { return ""; }
	let names;
	try { names = fs.readdirSync(root); } catch { return ""; }
	for (const name of names) {
		const folder = path.join(root, name, agentSessionId);
		try {
			if (fs.existsSync(path.join(folder, "chat_history.jsonl"))) { return folder; }
		} catch { /* keep looking */ }
	}
	return "";
}

function fileTime(value) {
	if (value == null || value === "") { return ""; }
	if (typeof value !== "string" || value.length > 80 || !Number.isFinite(Date.parse(value))) { return null; }
	return value;
}

function scheduleOf(task) {
	const human = task.human_schedule ?? task.humanSchedule ?? task.schedule;
	if (typeof human === "string" && human.trim()) { return human.trim().slice(0, 200); }
	const secs = task.intervalSecs ?? task.interval_secs;
	if (typeof secs === "number" && Number.isFinite(secs) && secs > 0 && secs < 10 * 365 * 24 * 3600) { return `every ${secs}s`; }
	return "";
}

function taskLoop(id, task) {
	if (!id || id.length > 200 || !task || typeof task !== "object" || Array.isArray(task)) { return null; }
	const promptRaw = task.prompt;
	if (promptRaw !== undefined && (typeof promptRaw !== "string" || promptRaw.length > 8000)) { return null; }
	const human = task.human_schedule ?? task.humanSchedule ?? task.schedule;
	if (human !== undefined && typeof human !== "string") { return null; }
	const next = fileTime(task.next_fire_at ?? task.nextFireAt);
	const expires = fileTime(task.expires_at ?? task.expiresAt);
	if (next === null || expires === null) { return null; }
	if (task.durable !== undefined && typeof task.durable !== "boolean") { return null; }
	const loop = {
		id,
		prompt: typeof promptRaw === "string" && promptRaw.trim() ? promptRaw.trim().slice(0, 200) : "Scheduled loop",
		schedule: scheduleOf(task),
		nextFireAt: next,
	};
	if (typeof task.durable === "boolean") { loop.durable = task.durable; }
	if (expires) { loop.expiresAt = expires; }
	return loop;
}

function schedulerOf(state) {
	if (!state || typeof state !== "object") { return null; }
	const dotted = state["grok_build.Scheduler"];
	const nested = state.grok_build && typeof state.grok_build === "object" ? state.grok_build.Scheduler : null;
	if (dotted && typeof dotted === "object") { return dotted; }
	if (nested && typeof nested === "object") { return nested; }
	return null;
}

function taskEntries(tasks) {
	if (Array.isArray(tasks)) {
		return tasks.map((task) => {
			const raw = task && (task.id || task.task_id || task.taskId);
			return [typeof raw === "string" ? raw.trim() : "", task];
		}).filter(([id]) => id);
	}
	if (tasks && typeof tasks === "object") { return Object.entries(tasks); }
	return [];
}

function readSessionLoops(agentSessionId, root) {
	try {
		const folder = sessionFolder(agentSessionId, root);
		if (!folder) { return { ok: true, loops: [] }; }
		const file = path.join(folder, "resources_state.json");
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > FILE_CAP) { return { ok: true, loops: [] }; }
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		const state = parsed && parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;
		const scheduler = schedulerOf(state);
		if (!scheduler) { return { ok: true, loops: [] }; }
		const loops = [];
		for (const [key, task] of taskEntries(scheduler.tasks)) {
			const id = String(key || "").trim();
			const loop = taskLoop(id, task);
			if (loop) { loops.push(loop); }
			if (loops.length >= 50) { break; }
		}
		return { ok: true, loops };
	} catch {
		return { ok: true, loops: [] };
	}
}

module.exports = { readSessionLoops };
