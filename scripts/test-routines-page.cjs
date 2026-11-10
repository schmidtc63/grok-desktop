const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function harness(name, exportName, props, win) {
	const state = { cursor: 0, values: [], effects: [], dirty: false };
	const modules = new Map();
	const jsx = (type, attributes, key) => ({ type, props: attributes ?? {}, key });
	const react = {
		Fragment: "fragment",
		createElement: (type, attributes, ...children) => jsx(type, { ...attributes, children: children.length > 1 ? children : children[0] }),
		useState(initial) {
			const index = state.cursor++;
			if (!(index in state.values)) { state.values[index] = { value: typeof initial === "function" ? initial() : initial }; }
			return [state.values[index].value, (next) => {
				const value = typeof next === "function" ? next(state.values[index].value) : next;
				if (!Object.is(value, state.values[index].value)) { state.values[index].value = value; state.dirty = true; }
			}];
		},
		useEffect(run, dependencies) {
			const index = state.cursor++;
			const previous = state.values[index];
			if (!previous || !dependencies || dependencies.some((value, offset) => value !== previous.dependencies[offset])) {
				state.effects.push(() => { previous?.cleanup?.(); state.values[index] = { dependencies, cleanup: run() }; });
			}
		},
	};
	function load(fileName) {
		if (modules.has(fileName)) { return modules.get(fileName); }
		const file = path.join(__dirname, "..", "src", fileName);
		const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
		const module = { exports: {} };
		const imports = (id) => {
			if (id === "react") { return react; }
			if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
			if (id === "./confirm") { return load("confirm.ts"); }
			throw new Error(`Unexpected import ${id}`);
		};
		vm.runInNewContext(source, { require: imports, module, exports: module.exports, window: win }, { filename: file });
		modules.set(fileName, module.exports);
		return module.exports;
	}
	function flatten(node, output = { elements: [], text: [] }) {
		if (node === null || node === undefined || typeof node === "boolean") { return output; }
		if (Array.isArray(node)) { node.forEach((child) => flatten(child, output)); return output; }
		if (typeof node === "string" || typeof node === "number") { output.text.push(String(node)); return output; }
		if (typeof node.type === "function") { return flatten(node.type(node.props), output); }
		output.elements.push(node);
		return flatten(node.props.children, output);
	}
	const component = load(name)[exportName];
	return {
		load,
		render() {
			let tree;
			for (let pass = 0; pass < 30; pass++) {
				state.cursor = 0;
				state.effects = [];
				state.dirty = false;
				tree = flatten(component(props));
				for (const effect of state.effects) { effect(); }
				if (!state.dirty) { return tree; }
			}
			throw new Error("Routines page did not settle");
		},
		unmount() { for (const value of state.values) { value?.cleanup?.(); } },
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function textOf(node) {
	if (node === null || node === undefined || typeof node === "boolean") { return ""; }
	if (typeof node === "string" || typeof node === "number") { return String(node); }
	if (Array.isArray(node)) { return node.map(textOf).join(""); }
	return textOf(node.props.children);
}

function labelled(tree, label) {
	const element = tree.elements.find((node) => node.props["aria-label"] === label);
	assert.ok(element, `Missing control: ${label}`);
	return element;
}

function missing(tree, label) {
	return !tree.elements.some((node) => node.props["aria-label"] === label);
}

function button(tree, label) {
	const element = tree.elements.find((node) => node.type === "button" && node.props.children === label);
	assert.ok(element, `Missing button: ${label}`);
	return element;
}

function change(element, value) {
	const target = { value };
	element.props.onChange({ target, currentTarget: target });
}

function tick(element, checked) {
	element.props.onChange({ target: { checked } });
}

const alerts = (tree) => tree.elements.filter((node) => node.props.role === "alert").map(textOf);
const forms = (tree) => tree.elements.filter((node) => node.type === "form");
const plain = (value) => JSON.parse(JSON.stringify(value));

const routine = (over) => ({ id: "r1", name: "Morning report", prompt: "Write it.", folder: "", model: "grok-4.7", effort: "low", mode: "Auto-review", schedule: { kind: "manual" }, enabled: true, createdAt: 1, resumedAt: 1, lastScheduledFor: 0, nextRun: null, ...over });
const run = (over) => ({ id: "x", routineId: "r1", trigger: "schedule", scheduledFor: 1000, dispatchedAt: 1000, sessionId: "", turnId: "", agentSessionId: "", state: "finished", stopReason: "", waiting: [], denied: [], preview: "", error: "", endedAt: 2000, ...over });

async function open({ routines = [], runs = [], error = "", replies = {} } = {}) {
	const calls = [];
	const stat = { listener: null, stopped: 0 };
	const win = {
		grokCode: {
			routines: (request) => {
				calls.push(plain(request));
				return Promise.resolve(request.action === "list" ? { ok: true, routines, runs, error } : replies[request.action] ?? { ok: true });
			},
			onEvent: (callback) => { stat.listener = callback; return () => { stat.listener = null; stat.stopped++; }; },
			pickFolder: () => Promise.resolve("C:/picked"),
		},
	};
	const props = {
		models: [{ id: "grok-4.7", name: "Grok 4.7" }, { id: "grok-4.5", name: "Grok 4.5" }],
		effortsFor: (model) => model === "grok-4.5" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"],
		defaultModel: "grok-4.7", defaultEffort: "xhigh", onClose() {},
	};
	const page = harness("Routines.tsx", "RoutinesPage", props, win);
	page.render();
	await settle();
	return { page, calls, stat, win, props };
}

// Opens the form for a new routine, fills the name and instructions, and leaves the schedule to the caller.
async function openForm(options) {
	const env = await open(options);
	button(env.page.render(), "New routine").props.onClick();
	const tree = env.page.render();
	change(labelled(tree, "Name"), "Weekly digest");
	change(labelled(env.page.render(), "Instructions"), "Summarize the week.");
	return env;
}

async function saveForm(env) {
	forms(env.page.render())[0].props.onSubmit({ preventDefault() {} });
	await settle();
	return env.page.render();
}

const saved = (env) => env.calls.filter((call) => call.action === "save");

async function main() {
	let failures = 0;
	async function check(label, run) {
		try {
			await run();
			console.log(`PASS routines page: ${label}`);
		} catch (error) {
			failures++;
			console.error(`FAIL routines page: ${label}`);
			console.error(error);
		}
	}

	await check("loads with list, shows the empty state and a store error, and follows routines events", async () => {
		const env = await open({ error: "The routines file was set aside." });
		let tree = env.page.render();
		assert.deepEqual(plain(env.calls), [{ action: "list" }]);
		assert.deepEqual(alerts(tree), ["The routines file was set aside."]);
		assert.ok(tree.text.includes("No routines yet."));
		assert.ok(tree.text.includes("No runs yet."));
		assert.ok(tree.text.some((text) => text.includes("Routines run only while this app is open.")));
		assert.equal(button(tree, "New routine").props.autoFocus, true);
		assert.equal(tree.elements.find((node) => node.props.role === "dialog").props["aria-label"], "Routines");
		env.stat.listener({ type: "chunk", routines: [routine()] });
		assert.ok(env.page.render().text.includes("No routines yet."));
		env.stat.listener({ type: "routines", routines: [routine()], runs: [run({ id: "a", sessionId: "s1" })], error: "" });
		tree = env.page.render();
		assert.deepEqual(alerts(tree), []);
		assert.ok(tree.elements.some((node) => node.type === "b" && textOf(node) === "Morning report"));
		env.page.unmount();
		assert.equal(env.stat.stopped, 1);
	});

	await check("a new routine preselects the composer's model and effort and Auto-review, and a Daily routine takes more than one time", async () => {
		const env = await openForm();
		let tree = env.page.render();
		assert.equal(labelled(tree, "Name").props.autoFocus, true);
		assert.equal(labelled(tree, "Model").props.value, "grok-4.7");
		assert.equal(labelled(tree, "Effort").props.value, "xhigh");
		assert.equal(labelled(tree, "Mode").props.value, "Auto-review");
		assert.equal(labelled(tree, "Schedule").props.value, "Daily");
		assert.ok(tree.elements.some((node) => node.type === "p" && textOf(node).includes(`Times use your time zone, ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`) && textOf(node).includes("A run missed while the app is closed runs once when it next opens, if it is within 7 days.")));
		button(tree, "Add time").props.onClick();
		tree = env.page.render();
		change(labelled(tree, "Time 2"), "09:00");
		tree = await saveForm(env);
		assert.deepEqual(alerts(tree), ["Use each time once."]);
		assert.equal(saved(env).length, 0);
		change(labelled(tree, "Time 2"), "17:30");
		tree = await saveForm(env);
		assert.deepEqual(saved(env), [{ action: "save", routine: { name: "Weekly digest", prompt: "Summarize the week.", folder: "", model: "grok-4.7", effort: "xhigh", mode: "Auto-review", schedule: { kind: "recurring", times: ["09:00", "17:30"], weekdays: [], monthDay: null, months: [] } } }]);
		assert.equal(forms(tree).length, 0, "a saved form closes");
	});

	await check("Weekdays, Weekly and Monthly build their schedules", async () => {
		let env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Weekdays");
		change(labelled(env.page.render(), "Time"), "08:15");
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule, { kind: "recurring", times: ["08:15"], weekdays: [1, 2, 3, 4, 5], monthDay: null, months: [] });

		env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Weekly");
		tick(labelled(env.page.render(), "Monday"), false);
		let tree = await saveForm(env);
		assert.deepEqual(alerts(tree), ["Pick at least one day."]);
		tick(labelled(env.page.render(), "Wednesday"), true);
		tick(labelled(env.page.render(), "Sunday"), true);
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule, { kind: "recurring", times: ["09:00"], weekdays: [0, 3], monthDay: null, months: [] });

		env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Monthly");
		change(labelled(env.page.render(), "Day of the month"), "15");
		tick(labelled(env.page.render(), "May"), true);
		tick(labelled(env.page.render(), "February"), true);
		button(env.page.render(), "Choose folder").props.onClick();
		await settle();
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule, { kind: "recurring", times: ["09:00"], weekdays: [], monthDay: 15, months: [2, 5] });
		assert.equal(saved(env)[0].routine.folder, "C:/picked");
	});

	await check("A monthly routine shows its months and keeps them on edit", async () => {
		const env = await open({ routines: [routine({ schedule: { kind: "recurring", times: ["09:00"], weekdays: [], monthDay: 1, months: [2, 5, 8, 11] } })] });
		const tree = env.page.render();
		assert.ok(tree.text.some((text) => text.includes("Monthly on day 1 in February, May, August, November at 09:00")));
		labelled(tree, "Edit Morning report").props.onClick();
		assert.equal(labelled(env.page.render(), "February").props.checked, true);
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule.months, [2, 5, 8, 11]);
	});

	await check("Manual and Once build their schedules, and a model change keeps the effort valid", async () => {
		let env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Manual");
		assert.ok(missing(env.page.render(), "Time"));
		change(labelled(env.page.render(), "Model"), "grok-4.5");
		assert.equal(labelled(env.page.render(), "Effort").props.value, "medium");
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule, { kind: "manual" });
		assert.equal(saved(env)[0].routine.model, "grok-4.5");
		assert.equal(saved(env)[0].routine.effort, "medium");

		env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Once");
		const future = "2999-01-01T09:30";
		change(labelled(env.page.render(), "Date and time"), future);
		await saveForm(env);
		assert.deepEqual(saved(env)[0].routine.schedule, { kind: "once", at: new Date(future).getTime() });
	});

	await check("a Once time that is not later than now is refused with a message and nothing is saved", async () => {
		const env = await openForm();
		change(labelled(env.page.render(), "Schedule"), "Once");
		let tree = await saveForm(env);
		assert.deepEqual(alerts(tree), ["Pick a date and time."]);
		change(labelled(tree, "Date and time"), "2000-01-01T09:00");
		tree = await saveForm(env);
		assert.deepEqual(alerts(tree), ["Pick a time later than now."]);
		assert.equal(saved(env).length, 0);
		assert.equal(forms(tree).length, 1, "the form stays open");
		change(labelled(tree, "Date and time"), "2999-01-01T09:00");
		assert.deepEqual(alerts(env.page.render()), [], "editing clears the message");
	});

	await check("an error from save shows in the form and keeps it open", async () => {
		const env = await openForm({ replies: { save: { ok: false, error: "Give the routine a name of 1 to 100 characters." } } });
		const tree = await saveForm(env);
		assert.deepEqual(alerts(tree), ["Give the routine a name of 1 to 100 characters."]);
		assert.equal(forms(tree).length, 1);
		assert.equal(saved(env).length, 1);
	});

	await check("the open form has no Done and tells the app it is open, and Cancel leaves it", async () => {
		const env = await openForm();
		let tree = env.page.render();
		assert.equal(forms(tree)[0].props["data-routine-form"], true, "the app's Escape and routine-open look for this");
		assert.equal(tree.elements.some((node) => node.type === "button" && node.props.children === "Done"), false, "only Save or Cancel leaves a half-written routine");
		button(tree, "Cancel").props.onClick();
		tree = env.page.render();
		assert.equal(forms(tree).length, 0);
		assert.equal(saved(env).length, 0);
		assert.equal(button(tree, "New routine").props.autoFocus, true);
		assert.ok(button(tree, "Done"));
	});

	await check("the list shows Paused, hides Resume for a Once that has passed, and keeps Resume for a later paused Once", async () => {
		const past = Date.now() - 86400000;
		const later = Date.now() + 86400000;
		const env = await open({ routines: [
			routine({ id: "gone", name: "Passed", schedule: { kind: "once", at: past }, enabled: false }),
			routine({ id: "spent", name: "Spent", schedule: { kind: "once", at: past }, enabled: true }),
			routine({ id: "held", name: "Held", schedule: { kind: "once", at: later }, enabled: false }),
			routine({ id: "live", name: "Live", schedule: { kind: "recurring", times: ["09:00"], weekdays: [], monthDay: null, months: [] }, nextRun: later }),
			routine({ id: "hand", name: "Hand", schedule: { kind: "manual" } }),
		] });
		const tree = env.page.render();
		const section = (name) => tree.elements.find((node) => node.props["aria-label"] === `Routine ${name}`);
		for (const name of ["Passed", "Spent", "Hand"]) {
			assert.ok(missing(tree, `Resume ${name}`) && missing(tree, `Pause ${name}`), `${name} has no Pause or Resume`);
		}
		assert.ok(textOf(section("Passed")).includes("No more runs."));
		assert.ok(textOf(section("Hand")).includes("Runs only when you press Run now."));
		assert.equal(textOf(labelled(tree, "Resume Held")), "Resume");
		assert.ok(textOf(section("Held")).includes("Paused"));
		assert.ok(tree.elements.some((node) => node.type === "small" && node.props.className === "routine-paused" && textOf(node) === "Paused"));
		assert.equal(textOf(labelled(tree, "Pause Live")), "Pause");
		assert.ok(textOf(section("Live")).includes("Next run: "));
		assert.ok(textOf(section("Live")).includes("Every day at 09:00"));
		labelled(tree, "Resume Held").props.onClick();
		labelled(tree, "Pause Live").props.onClick();
		assert.deepEqual(env.calls.slice(1), [{ action: "setEnabled", id: "held", enabled: true }, { action: "setEnabled", id: "live", enabled: false }]);
	});

	await check("the history shows each state in words, newest first, with denied tools and the preview", async () => {
		const states = [
			run({ id: "1", state: "dispatched" }),
			run({ id: "2", state: "running" }),
			run({ id: "3", state: "running", waiting: ["Run a command"] }),
			run({ id: "4", state: "finished", preview: "All done.", denied: ["a"] }),
			run({ id: "5", state: "ended", stopReason: "max_tokens" }),
			run({ id: "6", state: "failed", error: "Network down." }),
			run({ id: "7", state: "interrupted" }),
			run({ id: "8", state: "unknown", denied: ["a", "b"] }),
			run({ id: "9", state: "skipped" }),
			run({ id: "10", state: "missed" }),
		];
		const env = await open({ routines: [routine()], runs: states });
		const tree = env.page.render();
		const titles = tree.elements.filter((node) => node.type === "b" && textOf(node).includes(" · ")).map(textOf);
		assert.deepEqual(titles, ["Missed", "Skipped", "Unknown", "Interrupted", "Failed", "Ended: max_tokens", "Finished", "Needs you", "Running", "Running"].map((word) => `Morning report · ${word}`));
		const small = tree.elements.filter((node) => node.type === "small").map(textOf);
		assert.ok(small.includes("All done."));
		assert.ok(small.includes("Network down."));
		assert.ok(small.some((text) => text.endsWith("1 denied tool")));
		assert.ok(small.some((text) => text.endsWith("2 denied tools")));
		assert.ok(small.includes("Last run: Missed"));
	});

	await check("Run now is disabled while a run is outstanding, which shows Stop, and a finished routine can run", async () => {
		for (const state of ["dispatched", "running", "unknown"]) {
			const env = await open({ routines: [routine()], runs: [run({ id: "go", state })] });
			const tree = env.page.render();
			assert.equal(labelled(tree, "Run Morning report now").props.disabled, true, state);
			labelled(tree, "Stop Morning report").props.onClick();
			assert.deepEqual(env.calls[1], { action: "stop", runId: "go" });
		}
		const env = await open({ routines: [routine(), routine({ id: "r2", name: "Other" })], runs: [run({ id: "old", state: "finished" }), run({ id: "busy", routineId: "r2", state: "running" })] });
		const tree = env.page.render();
		assert.equal(labelled(tree, "Run Morning report now").props.disabled, false);
		assert.equal(labelled(tree, "Run Other now").props.disabled, true);
		assert.ok(missing(tree, "Stop Morning report"));
		labelled(tree, "Run Morning report now").props.onClick();
		assert.deepEqual(env.calls[1], { action: "runNow", id: "r1" });
	});

	await check("a failed action shows its message, and only runs with a chat are buttons that open it", async () => {
		const env = await open({ routines: [routine()], runs: [run({ id: "chat", sessionId: "s1", preview: "Has chat" }), run({ id: "bare", state: "skipped", preview: "No chat" })], replies: { runNow: { ok: false, error: "This routine's last run has not finished." } } });
		let tree = env.page.render();
		const opens = tree.elements.filter((node) => node.type === "button" && node.props.className === "routine-run");
		assert.equal(opens.length, 1);
		assert.ok(textOf(opens[0]).includes("Has chat"));
		assert.ok(!tree.elements.some((node) => node.type === "button" && textOf(node).includes("No chat")));
		opens[0].props.onClick();
		assert.deepEqual(env.calls[1], { action: "open", runId: "chat" });
		labelled(tree, "Run Morning report now").props.onClick();
		await settle();
		assert.deepEqual(alerts(env.page.render()), ["This routine's last run has not finished."]);
	});

	await check("Delete asks first, says the chats and folder stay, and removes only after a yes", async () => {
		const env = await open({ routines: [routine()] });
		const asks = [];
		env.page.load("confirm.ts").setConfirmHost((pending) => asks.push(pending));
		labelled(env.page.render(), "Delete Morning report").props.onClick();
		assert.equal(asks.length, 1);
		assert.equal(asks[0].title, `Delete "Morning report"?`);
		assert.equal(asks[0].danger, true);
		assert.ok(asks[0].body.includes("The run chats and the routine's folder stay."));
		asks[0].resolve(false);
		await settle();
		assert.equal(env.calls.length, 1);
		labelled(env.page.render(), "Delete Morning report").props.onClick();
		asks[1].resolve(true);
		await settle();
		assert.deepEqual(env.calls[1], { action: "remove", id: "r1" });
	});

	await check("Edit fills the form from the routine, keeps its id and sends it on save", async () => {
		const later = Date.now() + 86400000;
		const env = await open({ routines: [routine({ schedule: { kind: "recurring", times: ["07:00", "19:00"], weekdays: [1, 2, 3, 4, 5], monthDay: null, months: [] }, model: "grok-4.5", effort: "low", mode: "Normal", folder: "C:/work" }), routine({ id: "r2", name: "Later", schedule: { kind: "once", at: later }, enabled: false })] });
		labelled(env.page.render(), "Edit Morning report").props.onClick();
		let tree = env.page.render();
		assert.equal(labelled(tree, "Schedule").props.value, "Weekdays");
		assert.equal(labelled(tree, "Name").props.value, "Morning report");
		assert.equal(labelled(tree, "Mode").props.value, "Normal");
		assert.ok(tree.text.some((text) => text.includes("Unanswered tool approvals are denied after 8 minutes.")));
		await saveForm(env);
		const request = saved(env)[0];
		assert.equal(request.routine.id, "r1");
		assert.equal(request.routine.folder, "C:/work");
		assert.deepEqual(request.routine.schedule.times, ["07:00", "19:00"], "Editing keeps every time");
		const second = await open({ routines: [routine({ id: "r2", name: "Later", schedule: { kind: "once", at: later }, enabled: false })] });
		labelled(second.page.render(), "Edit Later").props.onClick();
		tree = second.page.render();
		assert.equal(labelled(tree, "Schedule").props.value, "Once");
		assert.match(labelled(tree, "Date and time").props.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		await saveForm(second);
		assert.equal(saved(second)[0].routine.schedule.at - later < 60000, true);
		assert.ok(!("enabled" in saved(second)[0].routine), "the save never sends the paused state");
	});

	if (failures) { throw new Error(`${failures} routines page check(s) failed`); }
	console.log("All routines page checks passed");
}

module.exports = main;
if (require.main === module) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
