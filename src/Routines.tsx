import { useEffect, useState, type ReactNode } from "react";
import { askConfirm } from "./confirm";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KINDS = ["Once", "Manual", "Daily", "Weekdays", "Weekly", "Monthly"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];
const MAX_TIMES = 24;
const MODE_NOTES: Partial<Record<GrokRoutineMode, string>> = {
	Normal: "Asks before edits, commands and reads outside the folder unless already allowed. Unanswered tool approvals are denied after 8 minutes.",
	"Always-approve": "Skips ordinary tool approvals. Browser permissions still apply. Riskiest for routines that read web pages.",
};
const STATE_WORDS: Record<GrokRoutineRun["state"], string> = {
	dispatched: "Running", running: "Running", unknown: "Unknown", finished: "Finished", ended: "Ended", failed: "Failed", interrupted: "Interrupted", skipped: "Skipped", missed: "Missed",
};

type Kind = (typeof KINDS)[number];

export interface RoutineModel { id: string; name: string }

interface FormState {
	id?: string;
	name: string;
	prompt: string;
	folder: string;
	model: string;
	effort: string;
	mode: GrokRoutineMode;
	kind: Kind;
	at: string;
	times: string[];
	weekdays: number[];
	monthDay: number;
	months: number[];
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const wordOf = (run: GrokRoutineRun) => run.state === "running" && run.waiting.length ? "Needs you" : run.state === "ended" && run.stopReason ? `Ended: ${run.stopReason}` : STATE_WORDS[run.state];
const isOutstanding = (run: GrokRoutineRun) => run.state === "dispatched" || run.state === "running" || run.state === "unknown";
const isWeekdays = (days: number[]) => days.length === WEEKDAYS.length && WEEKDAYS.every((day) => days.includes(day));

function localInput(ms: number): string {
	return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function kindOf(schedule: GrokRoutineSchedule): Kind {
	if (schedule.kind === "manual") { return "Manual"; }
	if (schedule.kind === "once") { return "Once"; }
	if (schedule.monthDay !== null) { return "Monthly"; }
	if (!schedule.weekdays.length) { return "Daily"; }
	return isWeekdays(schedule.weekdays) ? "Weekdays" : "Weekly";
}

function scheduleWords(schedule: GrokRoutineSchedule): string {
	if (schedule.kind === "manual") { return "Manual"; }
	if (schedule.kind === "once") { return `Once, ${when(schedule.at)}`; }
	const at = schedule.times.join(", ");
	if (schedule.monthDay !== null) { return `Monthly on day ${schedule.monthDay}${schedule.months.length ? ` in ${schedule.months.map((month) => MONTHS[month - 1]).join(", ")}` : ""} at ${at}`; }
	if (!schedule.weekdays.length) { return `Every day at ${at}`; }
	if (isWeekdays(schedule.weekdays)) { return `Weekdays at ${at}`; }
	return `Every ${schedule.weekdays.map((day) => DAYS[day]).join(", ")} at ${at}`;
}

function buildSchedule(form: FormState): { schedule: GrokRoutineSchedule } | { error: string } {
	if (form.kind === "Manual") { return { schedule: { kind: "manual" } }; }
	if (form.kind === "Once") {
		const at = new Date(form.at).getTime();
		if (!form.at || Number.isNaN(at)) { return { error: "Pick a date and time." }; }
		if (at <= Date.now()) { return { error: "Pick a time later than now." }; }
		return { schedule: { kind: "once", at } };
	}
	const { times } = form;
	if (times.some((time) => !time)) { return { error: "Pick a time." }; }
	if (new Set(times).size !== times.length) { return { error: "Use each time once." }; }
	if (form.kind === "Weekly" && !form.weekdays.length) { return { error: "Pick at least one day." }; }
	const weekdays = form.kind === "Weekdays" ? WEEKDAYS : form.kind === "Weekly" ? [...form.weekdays].sort((first, second) => first - second) : [];
	return { schedule: { kind: "recurring", times, weekdays, monthDay: form.kind === "Monthly" ? form.monthDay : null, months: form.kind === "Monthly" ? [...form.months].sort((first, second) => first - second) : [] } };
}

function fromRoutine(routine: GrokRoutine): FormState {
	const { schedule } = routine;
	return {
		id: routine.id, name: routine.name, prompt: routine.prompt, folder: routine.folder, model: routine.model, effort: routine.effort, mode: routine.mode, kind: kindOf(schedule),
		at: schedule.kind === "once" ? localInput(schedule.at) : "",
		times: schedule.kind === "recurring" ? schedule.times : ["09:00"],
		weekdays: schedule.kind === "recurring" && schedule.weekdays.length && !isWeekdays(schedule.weekdays) ? schedule.weekdays : [1],
		monthDay: schedule.kind === "recurring" && schedule.monthDay !== null ? schedule.monthDay : 1,
		months: schedule.kind === "recurring" ? schedule.months : [],
	};
}

function RoutineForm({ initial, models, effortsFor, onSaved, onCancel }: { initial: FormState; models: RoutineModel[]; effortsFor: (model: string) => string[]; onSaved: () => void; onCancel: () => void }) {
	const [form, setForm] = useState(initial);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const change = (patch: Partial<FormState>) => {
		setForm((current) => ({ ...current, ...patch }));
		setError("");
	};
	const modelOptions = models.some((item) => item.id === form.model) ? models : [...models, { id: form.model, name: form.model }];
	const allowed = effortsFor(form.model);
	const effortOptions = allowed.includes(form.effort) ? allowed : [...allowed, form.effort];
	const setTime = (index: number, value: string) => change({ times: form.times.map((time, at) => at === index ? value : time) });

	async function submit() {
		if (saving) { return; }
		const built = buildSchedule(form);
		if ("error" in built) { setError(built.error); return; }
		setSaving(true);
		try {
			const routine: GrokRoutineInput = { ...(form.id === undefined ? {} : { id: form.id }), name: form.name, prompt: form.prompt, folder: form.folder, model: form.model, effort: form.effort, mode: form.mode, schedule: built.schedule };
			const result = await window.grokCode?.routines?.({ action: "save", routine });
			if (result?.ok) { onSaved(); return; }
			setError(result?.error || "The routine could not be saved.");
		} catch {
			setError("The routine could not be saved.");
		}
		setSaving(false);
	}

	return (
		<form className="routine-form" data-routine-form aria-label={form.id === undefined ? "New routine" : "Edit routine"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
			<div className="cz-form">
				<label htmlFor="routine-name">Name</label>
				<input id="routine-name" aria-label="Name" autoFocus maxLength={100} value={form.name} onChange={(event) => change({ name: event.target.value })} />
				<label htmlFor="routine-prompt">Instructions</label>
				<textarea id="routine-prompt" aria-label="Instructions" rows={6} value={form.prompt} onChange={(event) => change({ prompt: event.target.value })} />
				<label htmlFor="routine-kind">Schedule</label>
				<select id="routine-kind" aria-label="Schedule" value={form.kind} onChange={(event) => change({ kind: event.target.value as Kind })}>
					{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
				</select>
				{form.kind === "Once" && <>
					<label htmlFor="routine-at">Date and time</label>
					<input id="routine-at" aria-label="Date and time" type="datetime-local" value={form.at} onChange={(event) => change({ at: event.target.value })} />
				</>}
				{form.kind !== "Once" && form.kind !== "Manual" && <>
					<label htmlFor="routine-time-0">{form.times.length > 1 ? "Times" : "Time"}</label>
					<div className="routine-times">
						{form.times.map((time, index) => (
							<div className="set-inline" key={index}>
								<input id={`routine-time-${index}`} aria-label={form.times.length > 1 ? `Time ${index + 1}` : "Time"} type="time" value={time} onChange={(event) => setTime(index, event.target.value)} />
								{form.times.length > 1 && <button type="button" className="texty" aria-label={`Remove time ${index + 1}`} onClick={() => change({ times: form.times.filter((_, at) => at !== index) })}>Remove</button>}
							</div>
						))}
						<div><button type="button" className="texty" disabled={form.times.length >= MAX_TIMES} onClick={() => change({ times: [...form.times, ""] })}>Add time</button></div>
					</div>
				</>}
				{form.kind === "Weekly" && <>
					<span id="routine-days-label">Days</span>
					<div className="routine-days" role="group" aria-labelledby="routine-days-label">
						{DAYS.map((day, index) => (
							<label className="toggle" key={day}>
								<input type="checkbox" aria-label={day} checked={form.weekdays.includes(index)} onChange={(event) => change({ weekdays: event.target.checked ? [...form.weekdays, index] : form.weekdays.filter((item) => item !== index) })} />{day}
							</label>
						))}
					</div>
				</>}
				{form.kind === "Monthly" && <>
					<label htmlFor="routine-month-day">Day of the month</label>
					<select id="routine-month-day" aria-label="Day of the month" value={form.monthDay} onChange={(event) => change({ monthDay: Number(event.target.value) })}>
						{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
					</select>
					<span id="routine-months-label">Months</span>
					<div className="routine-days" role="group" aria-labelledby="routine-months-label">
						{MONTHS.map((month, index) => (
							<label className="toggle" key={month}>
								<input type="checkbox" aria-label={month} checked={form.months.includes(index + 1)} onChange={(event) => change({ months: event.target.checked ? [...form.months, index + 1] : form.months.filter((item) => item !== index + 1) })} />{month}
							</label>
						))}
					</div>
					<p className="note">With no month checked, it runs every month.</p>
				</>}
				<p className="note">Times use your time zone, {Intl.DateTimeFormat().resolvedOptions().timeZone}. A run missed while the app is closed runs once when it next opens, if it is within 7 days.</p>
				<span id="routine-folder-label">Folder</span>
				<div className="set-inline" role="group" aria-labelledby="routine-folder-label">
					<span>{form.folder || "None. The routine uses its own folder."}</span>
					<button type="button" className="texty" onClick={() => { void window.grokCode?.pickFolder().then((folder) => { if (folder) { change({ folder }); } }); }}>Choose folder</button>
					{form.folder && <button type="button" className="texty" onClick={() => change({ folder: "" })}>Clear folder</button>}
				</div>
				<label htmlFor="routine-model">Model</label>
				<select id="routine-model" aria-label="Model" value={form.model} onChange={(event) => {
					const list = effortsFor(event.target.value);
					change({ model: event.target.value, effort: list.includes(form.effort) ? form.effort : list[list.length > 1 ? 1 : 0] ?? form.effort });
				}}>
					{modelOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
				</select>
				<label htmlFor="routine-effort">Effort</label>
				<select id="routine-effort" aria-label="Effort" value={form.effort} onChange={(event) => change({ effort: event.target.value })}>
					{effortOptions.map((item) => <option key={item} value={item}>{item}</option>)}
				</select>
				<label htmlFor="routine-mode">Mode</label>
				<select id="routine-mode" aria-label="Mode" value={form.mode} onChange={(event) => change({ mode: event.target.value as GrokRoutineMode })}>
					{(["Auto-review", "Normal", "Always-approve"] as GrokRoutineMode[]).map((mode) => <option key={mode} value={mode}>{mode}</option>)}
				</select>
				{MODE_NOTES[form.mode] && <p className="note">{MODE_NOTES[form.mode]}</p>}
			</div>
			{error && <p className="note bad" role="alert">{error}</p>}
			<div className="actions">
				<button type="submit" className="yes" disabled={saving}>Save routine</button>
				<button type="button" onClick={onCancel}>Cancel</button>
			</div>
		</form>
	);
}

export function RoutinesPage({ models, effortsFor, defaultModel, defaultEffort, onClose, nav }: { models: RoutineModel[]; effortsFor: (model: string) => string[]; defaultModel: string; defaultEffort: string; onClose: () => void; nav?: ReactNode }) {
	const [state, setState] = useState<GrokRoutinesState>({ routines: [], runs: [], error: "" });
	const [loaded, setLoaded] = useState(false);
	const [form, setForm] = useState<FormState | null>(null);
	const [problem, setProblem] = useState("");

	useEffect(() => {
		let live = true;
		const apply = (next: { routines?: GrokRoutine[]; runs?: GrokRoutineRun[]; error?: string }) => {
			if (live) {
				setState({ routines: next.routines ?? [], runs: next.runs ?? [], error: next.error ?? "" });
				setLoaded(true);
			}
		};
		window.grokCode?.routines?.({ action: "list" }).then(apply).catch(() => { if (live) { setProblem("Routines could not be loaded."); } });
		const stop = window.grokCode?.onEvent((event) => { if (event.type === "routines") { apply(event); } });
		return () => { live = false; stop?.(); };
	}, []);

	async function act(request: GrokRoutineRequest, failure: string) {
		setProblem("");
		try {
			const result = await window.grokCode?.routines?.(request);
			if (!result?.ok) { setProblem(result?.error || failure); }
		} catch {
			setProblem(failure);
		}
	}

	const now = Date.now();
	const blank = (): FormState => ({ name: "", prompt: "", folder: "", model: defaultModel, effort: defaultEffort, mode: "Auto-review", kind: "Daily", at: "", times: ["09:00"], weekdays: [1], monthDay: 1, months: [] });
	const nameOf = (id: string) => state.routines.find((routine) => routine.id === id)?.name ?? "Deleted routine";

	return (
		<div className="settings-page routines-page" role="dialog" aria-label="Routines">
			<nav className="settings-nav">
				{!form && nav}
				<h2>Routines</h2>
				<span className="spacer" />
				{!form && <button type="button" className="texty" onClick={onClose}>Done</button>}
			</nav>
			<div className="settings-body routines-body">
				{state.error && <p className="note bad" role="alert">{state.error}</p>}
				{problem && <p className="note bad" role="alert">{problem}</p>}
				{form ? (
					<>
						<h3>{form.id === undefined ? "New routine" : "Edit routine"}</h3>
						<RoutineForm key={form.id ?? "new"} initial={form} models={models} effortsFor={effortsFor} onSaved={() => setForm(null)} onCancel={() => setForm(null)} />
					</>
				) : (
					<>
						<h3>Routines</h3>
						<p className="meta">A routine sends its instructions to Grok on a schedule. Routines run only while this app is open. An unanswered question or plan card ends a routine run after 8 minutes.</p>
						<div className="actions"><button type="button" className="texty" autoFocus onClick={() => { setProblem(""); setForm(blank()); }}>New routine</button></div>
						{loaded && state.routines.length === 0 && <p className="meta">No routines yet.</p>}
						{state.routines.map((routine) => {
							const schedule = routine.schedule;
							const outstanding = state.runs.some((run) => run.routineId === routine.id && isOutstanding(run));
							const last = [...state.runs].reverse().find((run) => run.routineId === routine.id);
							const spent = schedule.kind === "once" && schedule.at <= now;
							const next = schedule.kind === "manual" ? "Runs only when you press Run now." : spent ? "No more runs." : !routine.enabled ? "Paused" : routine.nextRun !== null ? `Next run: ${when(routine.nextRun)}` : "No more runs.";
							return (
								<section className="set-row" key={routine.id} aria-label={`Routine ${routine.name}`}>
									<div>
										<b>{routine.name}</b>
										<small>{scheduleWords(schedule)}</small>
										<small className={!routine.enabled && schedule.kind !== "manual" && !spent ? "routine-paused" : undefined}>{next}</small>
										<small>{last ? `Last run: ${wordOf(last)}` : "Not run yet"}</small>
									</div>
									<div className="set-inline">
										{schedule.kind !== "manual" && !spent && <button type="button" className="texty" aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`} onClick={() => void act({ action: "setEnabled", id: routine.id, enabled: !routine.enabled }, "The routine could not be changed.")}>{routine.enabled ? "Pause" : "Resume"}</button>}
										<button type="button" className="texty" aria-label={`Run ${routine.name} now`} disabled={outstanding} onClick={() => void act({ action: "runNow", id: routine.id }, "The routine could not be run.")}>Run now</button>
										<button type="button" className="texty" aria-label={`Edit ${routine.name}`} onClick={() => { setProblem(""); setForm(fromRoutine(routine)); }}>Edit</button>
										<button type="button" className="texty" aria-label={`Delete ${routine.name}`} onClick={() => {
											void askConfirm({ title: `Delete "${routine.name}"?`, body: `This removes the routine and its run history. The run chats and the routine's folder stay.`, ok: `Delete`, danger: true }).then((yes) => {
												if (yes) { void act({ action: "remove", id: routine.id }, "The routine could not be deleted."); }
											});
										}}>Delete</button>
									</div>
								</section>
							);
						})}
						<h3>History</h3>
						{state.runs.length === 0 ? <p className="meta">No runs yet.</p> : (
							<ul className="routine-runs" aria-label="Run history">
								{[...state.runs].reverse().map((run) => {
									const detail = run.error || run.preview;
									const body = (
										<>
											<b>{nameOf(run.routineId)} · {wordOf(run)}</b>
											<small>{when(run.dispatchedAt ?? run.scheduledFor)}{run.denied.length ? ` · ${run.denied.length} denied ${run.denied.length === 1 ? "tool" : "tools"}` : ""}</small>
											{detail && <small>{detail}</small>}
										</>
									);
									return (
										<li className="set-row" key={run.id}>
											{run.sessionId ? <button type="button" className="routine-run" onClick={() => void act({ action: "open", runId: run.id }, "The chat could not be opened.")}>{body}</button> : <div>{body}</div>}
											{isOutstanding(run) && <button type="button" className="texty" aria-label={`Stop ${nameOf(run.routineId)}`} onClick={() => void act({ action: "stop", runId: run.id }, "The run could not be stopped.")}>Stop</button>}
										</li>
									);
								})}
							</ul>
						)}
					</>
				)}
			</div>
		</div>
	);
}
