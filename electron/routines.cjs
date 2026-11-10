const crypto = require("crypto");
const path = require("path");
const { redactKeys } = require("./redact.cjs");

const MODES = new Set(["Auto-review", "Normal", "Always-approve"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const OUTSTANDING = new Set(["dispatched", "running", "unknown"]);
const MODEL = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_NAME = 100;
const MAX_PROMPT = 32000;
const MAX_TIMES = 24;
const MAX_ENDED_RUNS = 50;
const PREVIEW_CHARS = 300;
const WALK_DAYS = 366;
const CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_AFTER_MS = 30 * 1000;
const LATE_NOTICE_MS = 5 * 60 * 1000;

function isOutstanding(run) {
	return OUTSTANDING.has(run.state);
}

function dayMatches(schedule, day) {
	if (schedule.months.length && !schedule.months.includes(day.getMonth() + 1)) { return false; }
	if (schedule.monthDay !== null) { return day.getDate() === schedule.monthDay; }
	return !schedule.weekdays.length || schedule.weekdays.includes(day.getDay());
}

// A local time the clock change skips comes back moved, so it is no occurrence that day.
// A repeated local time resolves to its earlier instant, so it counts once.
function occurrenceOn(day, time) {
	const [hours, minutes] = time.split(":").map(Number);
	const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
	return at.getHours() === hours && at.getMinutes() === minutes ? at.getTime() : null;
}

function latestOccurrence(schedule, now, floor) {
	if (schedule.kind !== "recurring") { return null; }
	const today = new Date(now);
	const times = [...schedule.times].sort().reverse();
	for (let back = 0; back <= WALK_DAYS; back += 1) {
		const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
		if (new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() <= floor) { return null; }
		if (!dayMatches(schedule, day)) { continue; }
		for (const time of times) {
			const at = occurrenceOn(day, time);
			if (at !== null && floor < at && at <= now) { return at; }
		}
	}
	return null;
}

function nextOccurrence(schedule, from) {
	if (schedule.kind === "once") { return schedule.at > from ? schedule.at : null; }
	if (schedule.kind !== "recurring") { return null; }
	const start = new Date(from);
	const times = [...schedule.times].sort();
	for (let ahead = 0; ahead <= WALK_DAYS; ahead += 1) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + ahead);
		if (!dayMatches(schedule, day)) { continue; }
		for (const time of times) {
			const at = occurrenceOn(day, time);
			if (at !== null && at > from) { return at; }
		}
	}
	return null;
}

function numbersWithin(list, low, high) {
	return Array.isArray(list) && new Set(list).size === list.length && list.every((item) => Number.isInteger(item) && item >= low && item <= high);
}

// The stored form of a schedule, or null when it breaks the shape.
function cleanSchedule(schedule) {
	if (schedule?.kind === "manual") { return { kind: "manual" }; }
	if (schedule?.kind === "once") { return Number.isFinite(schedule.at) ? { kind: "once", at: schedule.at } : null; }
	if (schedule?.kind !== "recurring") { return null; }
	const { times, weekdays, monthDay, months } = schedule;
	if (!Array.isArray(times) || !times.length || times.length > MAX_TIMES || new Set(times).size !== times.length || !times.every((time) => typeof time === "string" && TIME.test(time))) { return null; }
	if (!numbersWithin(weekdays, 0, 6) || !numbersWithin(months, 1, 12)) { return null; }
	if (monthDay !== null && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28 || weekdays.length)) { return null; }
	return { kind: "recurring", times: [...times].sort(), weekdays: [...weekdays], monthDay, months: [...months] };
}

function routineProblem(input) {
	if (typeof input?.name !== "string" || !input.name.trim() || input.name.trim().length > MAX_NAME) { return `Give the routine a name of 1 to ${MAX_NAME} characters.`; }
	if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > MAX_PROMPT) { return `Write instructions of 1 to ${MAX_PROMPT.toLocaleString("en-US")} characters.`; }
	if (!MODES.has(input.mode)) { return "Pick a permission mode from the list."; }
	if (typeof input.model !== "string" || !MODEL.test(input.model)) { return "Pick a model from the list."; }
	if (!EFFORTS.has(input.effort)) { return "Pick an effort from the list."; }
	if (typeof input.folder !== "string" || (input.folder && !path.isAbsolute(input.folder))) { return "Choose a full folder path, or no folder."; }
	if (!cleanSchedule(input.schedule)) { return "Choose a valid schedule."; }
	return "";
}

// A hand-edited file could otherwise throw inside a tick, so one bad record sets the whole file aside.
function validFile(saved) {
	return !!saved && Array.isArray(saved.routines) && Array.isArray(saved.runs)
		&& saved.routines.every((routine) => typeof routine?.id === "string" && !routineProblem(routine) && typeof routine.enabled === "boolean" && [routine.createdAt, routine.resumedAt, routine.lastScheduledFor].every((value) => Number.isFinite(value)))
		&& saved.runs.every((run) => typeof run?.id === "string" && typeof run.routineId === "string" && typeof run.state === "string" && Array.isArray(run.waiting) && Array.isArray(run.denied));
}

function safely(callback) {
	try { callback(); } catch {}
}

function createRoutines({ file, fs, writeAtomic, now, onChange, onNotice }) {
	let error = "";
	// A file that can be neither read nor moved aside may still hold good routines, so nothing overwrites it this launch.
	let writesBlocked = false;
	let data = load();
	const started = now();
	let interrupted = false;
	for (const run of data.runs) {
		if (isOutstanding(run)) {
			endRun(run, "interrupted", started);
			interrupted = true;
		}
	}
	if (interrupted) { persist(); }

	function load() {
		let saved;
		try {
			saved = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (failure) {
			if (failure.code === "ENOENT") { return { routines: [], runs: [] }; }
		}
		if (validFile(saved)) { return saved; }
		try {
			fs.renameSync(file, path.join(path.dirname(file), "routines.bad.json"));
			error = "The saved routines could not be read, so the list starts empty. The old file was kept as routines.bad.json.";
		} catch {
			writesBlocked = true;
			error = "The saved routines could not be read, and nothing will be saved until the app restarts.";
		}
		return { routines: [], runs: [] };
	}

	function persist() {
		if (writesBlocked) { return false; }
		try {
			writeAtomic(file, data);
			error = "";
			return true;
		} catch (failure) {
			error = `Routine changes could not be saved: ${failure.message}`;
			return false;
		}
	}

	function trimRuns() {
		const ended = new Map();
		data.runs = [...data.runs].reverse().filter((run) => {
			if (isOutstanding(run)) { return true; }
			ended.set(run.routineId, (ended.get(run.routineId) ?? 0) + 1);
			return ended.get(run.routineId) <= MAX_ENDED_RUNS;
		}).reverse();
	}

	function commit() {
		trimRuns();
		persist();
		safely(onChange);
	}

	// Dispatches and Pause or Resume take effect only after their write succeeds.
	function commitOrRestore(before) {
		const previousError = error;
		trimRuns();
		if (persist()) { return true; }
		data = JSON.parse(before);
		if (error !== previousError) { safely(onChange); }
		return false;
	}

	function newRun(routine, state, trigger, scheduledFor, at) {
		const id = crypto.randomUUID();
		const open = OUTSTANDING.has(state);
		return { id, routineId: routine.id, trigger, scheduledFor, dispatchedAt: open ? at : null, sessionId: open ? `new-${id}` : "", turnId: "", agentSessionId: "", state, stopReason: "", waiting: [], denied: [], preview: "", error: "", endedAt: open ? null : at };
	}

	function endRun(run, state, at, fields) {
		Object.assign(run, { state, endedAt: at, waiting: [] }, fields);
	}

	function notice(run, body) {
		const title = data.routines.find((routine) => routine.id === run.routineId)?.name ?? "Scheduled run";
		safely(() => onNotice({ title, body, runId: run.id }));
	}

	function failRun(run, message, fields) {
		const text = redactKeys(String(message || "The run could not start."));
		endRun(run, "failed", now(), { error: text, ...fields });
		commit();
		if (run.trigger === "schedule") { notice(run, `This scheduled run failed: ${text.slice(0, 200).replace(/\.$/, "")}.`); }
	}

	function outstandingRun(runId) {
		const run = data.runs.find((item) => item.id === runId);
		return run && isOutstanding(run) ? run : undefined;
	}

	function tick() {
		const at = now();
		const before = JSON.stringify(data);
		const fires = [];
		const notices = [];
		let changed = false;
		for (const run of data.runs) {
			if (run.state === "dispatched" && at - run.dispatchedAt > UNKNOWN_AFTER_MS) {
				run.state = "unknown";
				changed = true;
			}
		}
		for (const routine of data.routines) {
			if (!routine.enabled || routine.schedule.kind === "manual") { continue; }
			const floor = Math.max(routine.lastScheduledFor, at - CATCH_UP_MS, routine.resumedAt, routine.createdAt);
			const once = routine.schedule.kind === "once";
			const when = once ? routine.schedule.at : latestOccurrence(routine.schedule, at, floor);
			if (when === null || when > at) { continue; }
			changed = true;
			if (once) { routine.enabled = false; }
			if (once && when <= floor) {
				data.runs.push(newRun(routine, "missed", "schedule", when, at));
				continue;
			}
			routine.lastScheduledFor = when;
			const open = data.runs.find((run) => run.routineId === routine.id && isOutstanding(run));
			if (open) {
				data.runs.push(newRun(routine, "skipped", "schedule", when, at));
				if (!open.skipNotified) {
					open.skipNotified = true;
					notices.push({ run: open, body: "A scheduled run was skipped because the previous run has not finished." });
				}
				continue;
			}
			const run = newRun(routine, "dispatched", "schedule", when, at);
			data.runs.push(run);
			fires.push({ run, routine });
			if (at - when > LATE_NOTICE_MS) { notices.push({ run, body: `Running the run missed at ${new Date(when).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.` }); }
		}
		if (!changed || !commitOrRestore(before)) { return []; }
		safely(onChange);
		for (const item of notices) { notice(item.run, item.body); }
		return fires;
	}

	function runNow(id) {
		const routine = data.routines.find((item) => item.id === id);
		if (!routine) { return { ok: false, error: "That routine no longer exists." }; }
		if (data.runs.some((run) => run.routineId === id && isOutstanding(run))) { return { ok: false, error: "This routine's last run has not finished." }; }
		const at = now();
		const before = JSON.stringify(data);
		const run = newRun(routine, "dispatched", "manual", at, at);
		data.runs.push(run);
		if (!commitOrRestore(before)) { return { ok: false, error }; }
		safely(onChange);
		return { ok: true, fire: { run, routine } };
	}

	function save(input) {
		const problem = routineProblem(input);
		if (problem) { return { ok: false, error: problem }; }
		const at = now();
		const fields = { name: input.name.trim(), prompt: input.prompt, folder: input.folder, model: input.model, effort: input.effort, mode: input.mode, schedule: cleanSchedule(input.schedule), resumedAt: at };
		let routine;
		if (input.id === undefined) {
			routine = { id: crypto.randomUUID(), ...fields, enabled: true, createdAt: at, lastScheduledFor: 0 };
			data.routines.push(routine);
		} else {
			routine = data.routines.find((item) => item.id === input.id);
			if (!routine) { return { ok: false, error: "That routine no longer exists." }; }
			// A Once that has passed turned itself off, and saving it gives it a new time to run.
			if (routine.schedule.kind === "once" && routine.schedule.at <= at) { routine.enabled = true; }
			Object.assign(routine, fields);
		}
		commit();
		return { ok: true, id: routine.id };
	}

	function setEnabled(id, enabled) {
		const routine = data.routines.find((item) => item.id === id);
		if (!routine) { return { ok: false, error: "That routine no longer exists." }; }
		if (typeof enabled !== "boolean") { return { ok: false, error: "Choose pause or resume." }; }
		if (routine.enabled !== enabled) {
			const before = JSON.stringify(data);
			routine.enabled = enabled;
			if (enabled) { routine.resumedAt = now(); }
			if (!commitOrRestore(before)) { return { ok: false, error }; }
			safely(onChange);
		}
		return { ok: true };
	}

	function remove(id) {
		if (!data.routines.some((item) => item.id === id)) { return { ok: false, error: "That routine no longer exists." }; }
		// Deleting the history would leave a live run with no Stop button.
		if (data.runs.some((run) => run.routineId === id && isOutstanding(run))) { return { ok: false, error: "This routine has a run that has not finished. Stop it first." }; }
		data.routines = data.routines.filter((item) => item.id !== id);
		data.runs = data.runs.filter((run) => run.routineId !== id);
		commit();
		return { ok: true };
	}

	function sendStarted(sessionId, turnId, owns = () => true) {
		const run = data.runs.find((item) => item.sessionId === sessionId && !item.turnId && isOutstanding(item));
		if (!run || typeof turnId !== "string" || !turnId || !owns(run.id)) { return false; }
		run.turnId = turnId;
		run.state = "running";
		commit();
		return true;
	}

	function startResult(sessionId, turnId, result) {
		const run = data.runs.find((item) => item.sessionId === sessionId && item.turnId === turnId && isOutstanding(item));
		if (!run) { return; }
		if (result?.ok === false) {
			// A Stop or a closed window during the turn's start ends it with this result, and no done event follows.
			if (result.error === "Stopped." || result.error === "Closed.") {
				endRun(run, "interrupted", now());
				commit();
			} else {
				failRun(run, result.error);
			}
			return;
		}
		if (result?.agentSessionId) {
			run.agentSessionId = String(result.agentSessionId);
			commit();
		}
	}

	function hostEvent(event) {
		if (!event?.uiSessionId || !event.turnId) { return; }
		const run = data.runs.find((item) => item.sessionId === event.uiSessionId && item.turnId === event.turnId && isOutstanding(item));
		if (!run) { return; }
		if (event.type === "chunk") {
			run.preview = redactKeys(`${run.preview}${event.text ?? ""}`).slice(-PREVIEW_CHARS);
		} else if (event.type === "tool" && event.tool?.id) {
			if (run.preview && !run.preview.endsWith(" ")) { run.preview += " "; }
			const { id, waiting, detail } = event.tool;
			let changed = false;
			if (waiting === true && !run.waiting.includes(id)) {
				run.waiting.push(id);
				changed = true;
			}
			if (waiting === false && run.waiting.includes(id)) {
				run.waiting = run.waiting.filter((item) => item !== id);
				changed = true;
			}
			if (typeof detail === "string" && detail.startsWith("Denied") && !run.denied.includes(id)) {
				run.denied.push(id);
				changed = true;
			}
			if (changed) { commit(); }
		} else if (event.type === "done") {
			const state = event.stopReason === "end_turn" ? "finished" : event.stopReason === "cancelled" ? "interrupted" : "ended";
			endRun(run, state, now(), { stopReason: String(event.stopReason ?? "") });
			commit();
		} else if (event.type === "error") {
			failRun(run, event.message);
		}
	}

	return {
		state: () => {
			const at = now();
			return {
				routines: data.routines.map((routine) => ({ ...routine, nextRun: routine.enabled ? nextOccurrence(routine.schedule, at) : null })),
				runs: data.runs.map((run) => ({ ...run })),
				error,
			};
		},
		run: (runId) => data.runs.find((item) => item.id === runId),
		tick,
		runNow,
		save,
		setEnabled,
		remove,
		sendStarted,
		startResult,
		hostEvent,
		// noChat is for a run that never reached a window, so a click on its notice has no chat to look for.
		fail: (runId, message, noChat = false) => {
			const run = outstandingRun(runId);
			if (run) { failRun(run, message, noChat ? { sessionId: "" } : undefined); }
		},
		interrupt: (runId) => {
			const run = outstandingRun(runId);
			if (run) {
				endRun(run, "interrupted", now());
				commit();
			}
		},
	};
}

module.exports = { createRoutines, latestOccurrence, nextOccurrence, isOutstanding };
