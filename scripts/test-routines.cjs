process.env.TZ = "America/Los_Angeles";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoutines, latestOccurrence, nextOccurrence, isOutstanding } = require("../electron/routines.cjs");

assert.equal(new Date(2026, 2, 8, 2, 30).getHours(), 3, "these checks need the Los Angeles clock change, so a time zone that did not apply fails here");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "grok-routines-test-"));
let storeCount = 0;

function daily(times, extra = {}) {
	return { kind: "recurring", times, weekdays: [], monthDay: null, months: [], ...extra };
}

function routineInput(schedule, extra = {}) {
	return { name: "Daily read", prompt: "Read the logs.", folder: "", model: "grok-4.7", effort: "low", mode: "Auto-review", schedule, ...extra };
}

// One store on a temp file, with its own writeAtomic and a clock the test moves.
function openStore(at, { file = path.join(folder, `routines-${++storeCount}.json`), fileSystem = fs } = {}) {
	const world = { at, failWrites: false, writes: 0, changes: 0, notices: [], file };
	world.store = createRoutines({
		file,
		fs: fileSystem,
		writeAtomic: (target, value) => {
			if (world.failWrites) { throw new Error("The disk is full."); }
			world.writes += 1;
			fs.writeFileSync(target, JSON.stringify(value));
		},
		now: () => world.at,
		onChange: () => { world.changes += 1; },
		onNotice: (notice) => world.notices.push(notice),
	});
	world.routine = (id) => world.store.state().routines.find((item) => item.id === id);
	world.runs = (state) => world.store.state().runs.filter((run) => !state || run.state === state);
	world.saved = () => JSON.parse(fs.readFileSync(file, "utf8"));
	world.add = (schedule, extra) => {
		const result = world.store.save(routineInput(schedule, extra));
		assert.equal(result.ok, true, result.error);
		return result.id;
	};
	return world;
}

function finish(world, run, turnId = "turn") {
	world.store.sendStarted(run.sessionId, turnId);
	world.store.hostEvent({ type: "done", uiSessionId: run.sessionId, turnId, stopReason: "end_turn" });
}

function checkDays() {
	const skipped = daily(["02:30"]);
	assert.equal(latestOccurrence(skipped, new Date(2026, 2, 8, 12, 0).getTime(), new Date(2026, 2, 7, 12, 0).getTime()), null, "2:30 AM does not exist on 2026-03-08");
	assert.equal(nextOccurrence(skipped, new Date(2026, 2, 8, 0, 0).getTime()), new Date(2026, 2, 9, 2, 30).getTime(), "Next run steps over the missing time");
	const twice = daily(["03:00", "15:00"]);
	const noon = new Date(2026, 5, 10, 12, 0).getTime();
	assert.equal(latestOccurrence(twice, noon, noon - 2 * DAY), new Date(2026, 5, 10, 3, 0).getTime(), "the latest time that has passed");
	assert.equal(nextOccurrence(twice, noon), new Date(2026, 5, 10, 15, 0).getTime());
	assert.equal(latestOccurrence(twice, noon, new Date(2026, 5, 10, 3, 0).getTime()), null, "an occurrence at the floor has already happened");
	const monday = daily(["07:00"], { weekdays: [1] });
	assert.equal(new Date(nextOccurrence(monday, noon)).getDay(), 1);
	const quarterly = daily(["09:00"], { monthDay: 1, months: [2, 5, 8, 11] });
	assert.equal(nextOccurrence(quarterly, noon), new Date(2026, 7, 1, 9, 0).getTime(), "the month and day both count");
	assert.equal(nextOccurrence(daily(["09:00"], { monthDay: 28, months: [2] }), new Date(2026, 1, 28, 10, 0).getTime()), new Date(2027, 1, 28, 9, 0).getTime(), "a yearly routine is inside the walk");
	assert.equal(nextOccurrence({ kind: "manual" }, noon), null);
	assert.equal(nextOccurrence({ kind: "once", at: noon + 1 }, noon), noon + 1);
	assert.equal(nextOccurrence({ kind: "once", at: noon }, noon), null);
	console.log("PASS routine days: missing clock times, floor, weekdays, months and the forward walk");
}

function checkClockChanges() {
	const spring = openStore(new Date(2026, 2, 7, 12, 0).getTime());
	const springId = spring.add(daily(["02:30"]));
	spring.at = new Date(2026, 2, 8, 12, 0).getTime();
	assert.equal(spring.store.tick().length, 0, "2:30 AM on 2026-03-08 is skipped");
	spring.at = new Date(2026, 2, 9, 2, 31).getTime();
	const [next] = spring.store.tick();
	assert.equal(next.run.scheduledFor, new Date(2026, 2, 9, 2, 30).getTime(), "and the next day's runs");
	assert.equal(spring.routine(springId).lastScheduledFor, next.run.scheduledFor);

	const fall = openStore(new Date(2026, 9, 31, 12, 0).getTime());
	fall.add(daily(["01:30"]));
	const first = Date.UTC(2026, 10, 1, 8, 31);
	assert.equal(new Date(first).getHours(), 1, "the first 1:31 AM, still on summer time");
	fall.at = first;
	const fires = fall.store.tick();
	assert.equal(fires.length, 1);
	assert.equal(fires[0].run.scheduledFor, Date.UTC(2026, 10, 1, 8, 30), "a repeated time is its earlier instant");
	finish(fall, fires[0].run);
	fall.at = first + HOUR;
	assert.equal(new Date(fall.at).getHours(), 1, "the second 1:31 AM");
	assert.equal(fall.store.tick().length, 0, "1:30 AM on 2026-11-01 fires once");
	console.log("PASS clock changes: a missing time is skipped and a repeated time fires once");
}

function checkCatchUp() {
	const idle = openStore(new Date(2026, 5, 1, 12, 0).getTime());
	idle.add(daily(["07:00"], { weekdays: [1] }));
	idle.at = new Date(2026, 6, 8, 12, 0).getTime();
	const fires = idle.store.tick();
	assert.equal(fires.length, 1, "a weekly routine idle for 5 weeks fires only its latest occurrence");
	assert.equal(fires[0].run.scheduledFor, new Date(2026, 6, 6, 7, 0).getTime());
	assert.equal(idle.notices.length, 1);
	assert.match(idle.notices[0].body, /^Running the run missed at .+\.$/);
	assert.equal(idle.notices[0].title, "Daily read");
	assert.equal(idle.notices[0].runId, fires[0].run.id);
	assert.equal(idle.store.tick().length, 0, "that occurrence is used up");

	const onTime = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	onTime.add(daily(["07:00"]));
	onTime.at = new Date(2026, 5, 1, 7, 5).getTime();
	assert.equal(onTime.store.tick().length, 1);
	assert.equal(onTime.notices.length, 0, "a run 5 minutes late sends no notice");

	const quarterly = openStore(new Date(2026, 9, 1, 12, 0).getTime());
	quarterly.add(daily(["09:00"], { monthDay: 1, months: [2, 5, 8, 11] }));
	quarterly.at = new Date(2026, 10, 9, 9, 1).getTime();
	assert.equal(quarterly.store.tick().length, 0, "a quarterly occurrence 8 days old does not fire");
	const recent = openStore(new Date(2026, 9, 1, 12, 0).getTime());
	recent.add(daily(["09:00"], { monthDay: 1, months: [2, 5, 8, 11] }));
	recent.at = new Date(2026, 10, 7, 9, 1).getTime();
	assert.equal(recent.store.tick().length, 1, "at 6 days old it does");

	const manual = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	manual.add({ kind: "manual" });
	manual.at += 30 * DAY;
	assert.equal(manual.store.tick().length, 0, "a manual routine is never due");
	console.log("PASS catch-up: only the latest occurrence, only within 7 days, with a notice past 5 minutes");
}

function checkPauseAndEdit() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add(daily(["07:00"]));
	assert.equal(world.routine(id).nextRun, new Date(2026, 5, 1, 7, 0).getTime());
	assert.equal(world.store.setEnabled(id, false).ok, true);
	assert.equal(world.routine(id).nextRun, null, "a paused routine has no next run");
	world.at = new Date(2026, 5, 1, 7, 30).getTime();
	assert.equal(world.store.tick().length, 0, "a paused routine does not fire");
	const writes = world.writes;
	assert.equal(world.store.setEnabled(id, false).ok, true);
	assert.equal(world.writes, writes, "pausing a paused routine changes nothing");
	assert.equal(world.store.setEnabled(id, true).ok, true);
	assert.equal(world.routine(id).resumedAt, world.at);
	assert.equal(world.store.tick().length, 0, "resuming does not fire an occurrence from before the resume");

	world.at = new Date(2026, 5, 2, 7, 1).getTime();
	world.store.setEnabled(id, false);
	world.store.setEnabled(id, true);
	assert.equal(world.store.tick().length, 0, "nor does resuming a minute after one");
	const edited = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const editId = edited.add(daily(["07:00"]));
	edited.at = new Date(2026, 5, 1, 7, 30).getTime();
	assert.equal(edited.store.save({ ...routineInput(daily(["07:00"]), { name: "New name" }), id: editId }).ok, true);
	assert.equal(edited.store.tick().length, 0, "saving an edit does not fire an occurrence from before the edit");
	assert.equal(edited.routine(editId).name, "New name");
	assert.equal(edited.routine(editId).createdAt, new Date(2026, 5, 1, 6, 0).getTime(), "an edit keeps what it does not change");
	edited.at = new Date(2026, 5, 2, 7, 1).getTime();
	assert.equal(edited.store.tick().length, 1, "the next occurrence runs");
	const spent = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const spentId = spent.add({ kind: "once", at: new Date(2026, 5, 1, 7, 0).getTime() });
	spent.at = new Date(2026, 5, 1, 7, 1).getTime();
	finish(spent, spent.store.tick()[0].run);
	assert.equal(spent.routine(spentId).enabled, false, "a Once turns itself off when it runs");
	assert.equal(spent.store.save({ ...routineInput({ kind: "once", at: new Date(2026, 5, 2, 7, 0).getTime() }), id: spentId }).ok, true);
	assert.equal(spent.routine(spentId).enabled, true, "a new time for a Once that has passed turns it back on");
	spent.at = new Date(2026, 5, 2, 7, 1).getTime();
	assert.equal(spent.store.tick().length, 1, "and it runs");
	const heldId = spent.add({ kind: "once", at: new Date(2026, 5, 3, 7, 0).getTime() });
	spent.store.setEnabled(heldId, false);
	spent.store.save({ ...routineInput({ kind: "once", at: new Date(2026, 5, 4, 7, 0).getTime() }), id: heldId });
	assert.equal(spent.routine(heldId).enabled, false, "a paused Once that has not passed stays paused");
	console.log("PASS pause, resume and edit never fire an old occurrence");
}

function checkOnce() {
	const inside = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const insideId = inside.add({ kind: "once", at: inside.at + HOUR });
	assert.equal(inside.routine(insideId).nextRun, inside.at + HOUR);
	assert.equal(inside.store.tick().length, 0, "a time still ahead waits");
	assert.equal(inside.routine(insideId).enabled, true);
	inside.at += 3 * HOUR;
	const fires = inside.store.tick();
	assert.equal(fires.length, 1, "inside 7 days it fires");
	assert.equal(inside.routine(insideId).enabled, false, "and turns itself off");
	assert.equal(inside.routine(insideId).nextRun, null);
	assert.equal(inside.notices.length, 1, "more than 5 minutes late it says so");
	finish(inside, fires[0].run);
	assert.equal(inside.store.tick().length, 0);

	const outside = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const outsideId = outside.add({ kind: "once", at: outside.at + HOUR });
	outside.at += 9 * DAY;
	assert.equal(outside.store.tick().length, 0, "past 7 days it does not fire");
	assert.equal(outside.runs("missed").length, 1, "it is recorded as missed");
	assert.equal(outside.runs("missed")[0].sessionId, "", "with no chat");
	assert.equal(outside.routine(outsideId).enabled, false);
	assert.equal(outside.notices.length, 0);
	outside.store.tick();
	assert.equal(outside.runs("missed").length, 1, "once");

	const past = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const pastId = past.add({ kind: "once", at: past.at - HOUR });
	assert.equal(past.store.tick().length, 0, "a time chosen in the past does not fire");
	assert.equal(past.runs("missed").length, 1);
	assert.equal(past.routine(pastId).enabled, false);

	const resumed = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const resumedId = resumed.add({ kind: "once", at: resumed.at + HOUR });
	resumed.store.setEnabled(resumedId, false);
	resumed.at += 2 * HOUR;
	assert.equal(resumed.store.tick().length, 0);
	assert.equal(resumed.runs().length, 0, "paused, nothing is recorded");
	resumed.store.setEnabled(resumedId, true);
	assert.equal(resumed.store.tick().length, 0, "resuming after its time does not fire");
	assert.equal(resumed.runs("missed").length, 1);
	assert.equal(resumed.routine(resumedId).enabled, false);

	const blocked = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const blockedId = blocked.add({ kind: "once", at: blocked.at + HOUR });
	assert.equal(blocked.store.runNow(blockedId).ok, true);
	blocked.at += 2 * HOUR;
	assert.equal(blocked.store.tick().length, 0, "a once time with a run outstanding is skipped");
	assert.equal(blocked.runs("skipped").length, 1);
	assert.equal(blocked.routine(blockedId).enabled, false, "and spent");
	blocked.store.tick();
	assert.equal(blocked.runs("missed").length, 0, "so it is not also missed");
	console.log("PASS once: fires inside 7 days, missed outside, in the past or resumed late, and turns itself off");
}

function checkOutstanding() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add(daily(["07:00"]));
	world.at = new Date(2026, 5, 1, 7, 0).getTime();
	const [{ run }] = world.store.tick();
	assert.equal(run.sessionId, `new-${run.id}`);
	assert.equal(run.state, "dispatched");
	assert.equal(isOutstanding(run), true);
	assert.equal(world.saved().runs[0].state, "dispatched", "the run is on disk before it goes out");
	world.at = new Date(2026, 5, 1, 7, 0, 29).getTime();
	world.store.tick();
	assert.equal(world.runs("dispatched").length, 1, "30 seconds have not passed");
	world.at = new Date(2026, 5, 1, 7, 0, 31).getTime();
	assert.equal(world.store.tick().length, 0);
	assert.equal(world.runs("unknown").length, 1, "no send within 30 seconds is unknown");
	const noticesBefore = world.notices.length;
	world.at = new Date(2026, 5, 2, 7, 0).getTime();
	assert.equal(world.store.tick().length, 0, "an unknown run still blocks the next occurrence");
	assert.equal(world.runs("skipped").length, 1);
	assert.equal(world.routine(id).lastScheduledFor, world.at, "and the skipped occurrence is used up");
	assert.equal(world.store.tick().length, 0);
	assert.equal(world.runs("skipped").length, 1);
	assert.equal(world.notices.length, noticesBefore + 1, "the first skip sends a notice");
	assert.equal(world.notices.at(-1).runId, run.id, "about the run that is stuck");
	assert.equal(world.notices.at(-1).body, "A scheduled run was skipped because the previous run has not finished.");
	world.at = new Date(2026, 5, 3, 7, 0).getTime();
	world.store.tick();
	world.at = new Date(2026, 5, 4, 7, 0).getTime();
	world.store.tick();
	assert.equal(world.runs("skipped").length, 3, "one skipped run per occurrence");
	assert.equal(world.notices.length, noticesBefore + 1, "and one notice in total");
	assert.match(world.store.runNow(id).error, /has not finished/, "Run now is refused too");
	world.store.sendStarted(run.sessionId, "late-turn");
	assert.equal(world.runs("running").length, 1, "a late send still moves it to running");
	world.store.hostEvent({ type: "done", uiSessionId: run.sessionId, turnId: "late-turn", stopReason: "end_turn" });
	assert.equal(world.runs("finished").length, 1, "and a host event can still end it");
	world.at = new Date(2026, 5, 5, 7, 0).getTime();
	assert.equal(world.store.tick().length, 1, "then the next occurrence runs");
	console.log("PASS outstanding runs: unknown after 30 seconds, one skipped per occurrence, one notice in total");
}

function checkTrim() {
	const world = openStore(new Date(2026, 0, 1, 6, 0).getTime());
	world.add(daily(["07:00"]));
	const other = world.add(daily(["08:00"]), { name: "Other" });
	world.at = new Date(2026, 0, 1, 7, 0).getTime();
	const [{ run: stuck }] = world.store.tick();
	for (let day = 2; day <= 60; day += 1) {
		world.at = new Date(2026, 0, day, 7, 0).getTime();
		world.store.tick();
	}
	const runs = world.store.state().runs.filter((run) => run.routineId === stuck.routineId);
	assert.equal(runs.filter((run) => run.state === "skipped").length, 50, "50 ended runs per routine");
	assert.equal(runs.filter((run) => run.id === stuck.id).length, 1, "the oldest run stays because it is outstanding");
	assert.equal(runs.at(-1).scheduledFor, world.at, "the newest ended runs are the ones kept");
	assert.equal(world.saved().runs.filter((run) => run.routineId === stuck.routineId).length, 51, "on disk too");
	assert.equal(world.store.state().runs.some((run) => run.routineId === other), true, "another routine keeps its own");
	console.log("PASS trim: 50 ended runs per routine, never an outstanding one");
}

function checkLoad() {
	const corrupt = path.join(folder, "corrupt", "routines.json");
	fs.mkdirSync(path.dirname(corrupt));
	fs.writeFileSync(corrupt, "{broken");
	const world = openStore(1000, { file: corrupt });
	assert.deepEqual(world.store.state().routines, [], "a corrupt file starts empty");
	assert.match(world.store.state().error, /routines\.bad\.json/);
	assert.equal(fs.readFileSync(path.join(path.dirname(corrupt), "routines.bad.json"), "utf8"), "{broken", "and is kept");
	assert.equal(fs.existsSync(corrupt), false);
	world.add({ kind: "manual" });
	assert.equal(world.store.state().error, "", "the next good write clears the message");

	for (const [index, text] of ["[]", "null", "{\"routines\":[]}", "{\"routines\":[{\"id\":\"a\"}],\"runs\":[]}", "{\"routines\":[],\"runs\":[null]}"].entries()) {
		const wrong = path.join(folder, `wrong-${index}`, "routines.json");
		fs.mkdirSync(path.dirname(wrong));
		fs.writeFileSync(wrong, text);
		const store = openStore(1000, { file: wrong }).store;
		assert.match(store.state().error, /routines\.bad\.json/, `the wrong shape is set aside: ${text}`);
		assert.equal(fs.readFileSync(path.join(path.dirname(wrong), "routines.bad.json"), "utf8"), text);
	}

	const missing = openStore(1000);
	assert.equal(missing.store.state().error, "", "a first launch with no file is not an error");
	assert.equal(missing.writes, 0, "and writes nothing");

	const liveFile = path.join(folder, "routines-live.json");
	const live = openStore(new Date(2026, 5, 1, 6, 0).getTime(), { file: liveFile });
	const liveId = live.add(daily(["07:00"]));
	const otherId = live.add({ kind: "manual" });
	live.at = new Date(2026, 5, 1, 7, 0).getTime();
	const [{ run }] = live.store.tick();
	live.store.sendStarted(run.sessionId, "turn");
	const dispatched = live.store.runNow(otherId).fire.run;
	const reopened = openStore(live.at + MINUTE, { file: liveFile });
	const states = reopened.store.state().runs.map((item) => [item.id, item.state]);
	assert.deepEqual(states, [[run.id, "interrupted"], [dispatched.id, "interrupted"]], "no run survives quitting");
	assert.equal(reopened.saved().runs[0].state, "interrupted", "and that is saved");
	assert.equal(reopened.saved().runs[0].endedAt, live.at + MINUTE);
	assert.equal(reopened.changes, 0, "loading tells nobody, since no window exists yet");
	assert.equal(reopened.routine(liveId).name, "Daily read");
	const again = openStore(live.at + 2 * MINUTE, { file: liveFile });
	assert.equal(again.writes, 0, "a load with nothing outstanding writes nothing");

	const lockedFile = path.join(folder, "routines-locked.json");
	fs.writeFileSync(lockedFile, JSON.stringify({ routines: [], runs: [] }));
	const lockedFs = { readFileSync: () => { throw Object.assign(new Error("Busy."), { code: "EBUSY" }); }, renameSync: () => { throw Object.assign(new Error("Busy."), { code: "EBUSY" }); } };
	const locked = openStore(1000, { file: lockedFile, fileSystem: lockedFs });
	assert.match(locked.store.state().error, /could not be read/);
	assert.equal(locked.store.save(routineInput({ kind: "manual" })).ok, true);
	assert.equal(locked.writes, 0, "a file that cannot be read or moved aside is never overwritten");
	assert.match(locked.store.state().error, /could not be read/);
	console.log("PASS load: a bad file is kept, outstanding runs become interrupted, and an unreadable file is not overwritten");
}

function checkWriteFailure() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add(daily(["07:00"]));
	const stale = world.store.runNow(world.add({ kind: "manual" }, { name: "Stale" })).fire.run;
	const beforeTick = JSON.stringify(world.store.state().runs);
	world.at = new Date(2026, 5, 1, 7, 10).getTime();
	world.failWrites = true;
	const changesBefore = world.changes;
	assert.deepEqual(world.store.tick(), [], "a failed write returns no fires");
	assert.equal(JSON.stringify(world.store.state().runs), beforeTick, "no run was added, and none turned unknown");
	assert.equal(world.routine(id).lastScheduledFor, 0, "nothing was advanced");
	assert.match(world.store.state().error, /could not be saved: The disk is full/);
	assert.equal(world.notices.length, 0, "and nothing was announced");
	assert.equal(world.changes, changesBefore + 1, "the page hears about the error");
	world.store.tick();
	assert.equal(world.changes, changesBefore + 1, "once");
	world.failWrites = false;
	const fires = world.store.tick();
	assert.equal(fires.length, 1, "the next good tick fires that occurrence");
	assert.equal(fires[0].routine.id, id);
	assert.equal(fires[0].run.scheduledFor, new Date(2026, 5, 1, 7, 0).getTime());
	assert.equal(world.store.state().error, "", "and clears the error");
	assert.equal(world.notices.length, 1, "with its late notice");
	assert.equal(world.runs("unknown")[0].id, stale.id, "the other change from the failed tick is applied now");
	assert.equal(world.store.tick().length, 0, "exactly once");

	world.failWrites = true;
	const refused = world.store.runNow(world.add({ kind: "manual" }, { name: "Refused" }));
	assert.equal(refused.ok, false, "Run now does not start a run it could not save");
	assert.match(refused.error, /could not be saved/);
	world.store.sendStarted(fires[0].run.sessionId, "turn");
	assert.equal(world.runs("running").length, 1, "a later state change stays in memory when its write fails");
	assert.match(world.store.state().error, /could not be saved/);
	world.failWrites = false;
	world.store.hostEvent({ type: "done", uiSessionId: fires[0].run.sessionId, turnId: "turn", stopReason: "end_turn" });
	assert.equal(world.store.state().error, "", "the next good write clears it");
	assert.equal(world.saved().runs.find((run) => run.id === fires[0].run.id).state, "finished");
	console.log("PASS write failure: a failed tick changes nothing and fires nothing; the next good tick fires once");
}

function checkPauseResumeWriteFailure() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add(daily(["07:00"]));
	for (const enabled of [false, true]) {
		const before = world.routine(id);
		world.at += MINUTE;
		world.failWrites = true;
		const result = world.store.setEnabled(id, enabled);
		assert.equal(result.ok, false, "a failed Pause or Resume reports failure");
		assert.match(result.error, /could not be saved: The disk is full/);
		assert.deepEqual(world.routine(id), before, "the routine's state is unchanged after the failed write");
		assert.equal(world.saved().routines[0].enabled, before.enabled);
		world.failWrites = false;
		assert.equal(world.store.setEnabled(id, enabled).ok, true, "the change can be retried");
		assert.equal(world.routine(id).enabled, enabled);
		assert.equal(world.saved().routines[0].enabled, enabled);
	}
	console.log("PASS Pause and Resume: both report a failed save, keep their prior state, and can be retried");
}

function checkTerminalStates() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add({ kind: "manual" });
	const finishedRun = world.store.runNow(id).fire.run;
	world.store.sendStarted(finishedRun.sessionId, "turn");
	const ended = { uiSessionId: finishedRun.sessionId, turnId: "turn" };
	world.store.startResult(finishedRun.sessionId, "turn", { ok: true, agentSessionId: "agent-1" });
	assert.equal(world.runs()[0].agentSessionId, "agent-1");
	world.store.hostEvent({ ...ended, type: "done", stopReason: "end_turn" });
	const final = JSON.stringify(world.runs()[0]);
	assert.equal(world.runs()[0].state, "finished");
	const writes = world.writes;
	world.store.hostEvent({ ...ended, type: "error", message: "Late failure" });
	world.store.hostEvent({ ...ended, type: "done", stopReason: "cancelled" });
	world.store.hostEvent({ ...ended, type: "tool", tool: { id: "tool", waiting: true, detail: "Denied" } });
	world.store.hostEvent({ ...ended, type: "chunk", text: "Late text" });
	world.store.startResult(finishedRun.sessionId, "turn", { ok: false, error: "Late start failure" });
	world.store.startResult(finishedRun.sessionId, "turn", { ok: true, agentSessionId: "agent-2" });
	world.store.sendStarted(finishedRun.sessionId, "second-turn");
	world.store.fail(finishedRun.id, "Late failure");
	world.store.interrupt(finishedRun.id);
	assert.equal(JSON.stringify(world.runs()[0]), final, "no later event or start result changes a terminal state");
	assert.equal(world.writes, writes, "or writes");

	for (const [event, state, stopReason] of [
		[{ type: "done", stopReason: "end_turn" }, "finished", "end_turn"],
		[{ type: "done", stopReason: "cancelled" }, "interrupted", "cancelled"],
		[{ type: "done", stopReason: "max_tokens" }, "ended", "max_tokens"],
		[{ type: "error", message: `Key xai-${"A".repeat(80)} failed.` }, "failed", ""],
	]) {
		const run = world.store.runNow(id).fire.run;
		world.store.sendStarted(run.sessionId, "turn");
		world.store.hostEvent({ uiSessionId: run.sessionId, turnId: "other-turn", type: "done", stopReason: "end_turn" });
		assert.equal(world.store.run(run.id).state, "running", "another turn's events do not touch the run");
		world.store.hostEvent({ uiSessionId: run.sessionId, turnId: "turn", ...event });
		assert.equal(world.store.run(run.id).state, state);
		assert.equal(world.store.run(run.id).stopReason, stopReason);
		assert.equal(world.store.run(run.id).endedAt, world.at);
		if (state === "failed") { assert.equal(world.store.run(run.id).error, "Key [redacted] failed.", "the error goes through redactKeys"); }
	}
	assert.equal(world.notices.length, 0, "a manual run sends no notice");

	const stopped = world.store.runNow(id).fire.run;
	world.store.sendStarted(stopped.sessionId, "turn");
	world.store.startResult(stopped.sessionId, "turn", { ok: false, error: "Stopped." });
	assert.equal(world.store.run(stopped.id).state, "interrupted", "a Stop during the turn's start ends in that result, and it is not a failure");
	const closed = world.store.runNow(id).fire.run;
	world.store.sendStarted(closed.sessionId, "turn");
	world.store.startResult(closed.sessionId, "turn", { ok: false, error: "Closed." });
	assert.equal(world.store.run(closed.id).state, "interrupted", "nor is the last window closing during the start");
	const refused = world.store.runNow(id).fire.run;
	world.store.sendStarted(refused.sessionId, "turn");
	world.store.startResult(refused.sessionId, "turn", { ok: false, error: "That folder is not on this computer: C:/gone" });
	assert.equal(world.store.run(refused.id).state, "failed", "any other failed start is failed");
	assert.equal(world.store.run(refused.id).error, "That folder is not on this computer: C:/gone");
	const windowFailed = world.store.runNow(id).fire.run;
	world.store.fail(windowFailed.id, "This window could not start the run.");
	assert.equal(world.store.run(windowFailed.id).state, "failed", "a window's failed start before any send");
	assert.equal(world.store.run(windowFailed.id).sessionId, windowFailed.sessionId);
	const noChat = world.store.runNow(id).fire.run;
	world.store.fail(noChat.id, "That folder is gone.", true);
	assert.equal(world.store.run(noChat.id).sessionId, "", "a run that never reached a window has no chat");
	const stoppedNow = world.store.runNow(id).fire.run;
	world.store.interrupt(stoppedNow.id);
	assert.equal(world.store.run(stoppedNow.id).state, "interrupted");

	const scheduled = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	scheduled.add(daily(["07:00"]));
	scheduled.at = new Date(2026, 5, 1, 7, 0).getTime();
	const [{ run }] = scheduled.store.tick();
	scheduled.store.sendStarted(run.sessionId, "turn");
	scheduled.store.hostEvent({ uiSessionId: run.sessionId, turnId: "turn", type: "error", message: `${"x".repeat(300)}` });
	assert.equal(scheduled.notices.length, 1, "a failed scheduled run sends a notice");
	assert.equal(scheduled.notices[0].body, `This scheduled run failed: ${"x".repeat(200)}.`, "with the first 200 characters of the error");
	scheduled.at = new Date(2026, 5, 2, 7, 0).getTime();
	const [{ run: second }] = scheduled.store.tick();
	scheduled.store.sendStarted(second.sessionId, "turn");
	scheduled.store.hostEvent({ uiSessionId: second.sessionId, turnId: "turn", type: "error", message: "Grok exited." });
	assert.equal(scheduled.notices[1].body, "This scheduled run failed: Grok exited.");
	console.log("PASS run endings: terminal states never change, reasons map to states, and only scheduled failures send a notice");
}

function checkEventsAndPreview() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add({ kind: "manual" });
	const { run } = world.store.runNow(id).fire;
	world.store.sendStarted(run.sessionId, "turn");
	const event = { uiSessionId: run.sessionId, turnId: "turn" };
	const writes = world.writes;
	const changes = world.changes;
	world.store.hostEvent({ ...event, type: "chunk", text: "first " });
	world.store.hostEvent({ ...event, type: "chunk", text: `key xai-${"A".repeat(40)}` });
	world.store.hostEvent({ ...event, type: "thought", text: "not shown" });
	world.store.hostEvent({ ...event, type: "usage", usage: {} });
	assert.equal(world.writes, writes, "preview updates do not write");
	assert.equal(world.changes, changes, "and do not call onChange");
	assert.equal(world.store.state().runs[0].preview, "first key [redacted]", "the preview is in the state sent to the page, through redactKeys");
	assert.equal(world.saved().runs[0].preview, "", "it is not on disk yet");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "between", waiting: false, detail: "Ran" } });
	world.store.hostEvent({ ...event, type: "chunk", text: "second" });
	assert.equal(world.store.state().runs[0].preview, "first key [redacted] second", "a tool call keeps the text either side of it apart");
	world.store.hostEvent({ ...event, type: "chunk", text: "y".repeat(400) });
	assert.equal(world.store.state().runs[0].preview, "y".repeat(300), "only the last 300 characters");

	world.store.hostEvent({ ...event, type: "tool", tool: { id: "plain", waiting: false, detail: "Ran" } });
	assert.equal(world.writes, writes, "a tool with nothing waiting changes nothing");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "gate", waiting: true, detail: "Needs approval" } });
	assert.deepEqual(world.store.state().runs[0].waiting, ["gate"], "waiting: true is Needs you");
	assert.equal(world.writes, writes + 1, "a real change writes");
	assert.equal(world.changes, changes + 1, "and notifies");
	assert.equal(world.saved().runs[0].preview, `${"y".repeat(300)} `, "and carries the preview with it");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "gate", waiting: true, detail: "Needs approval" } });
	assert.equal(world.writes, writes + 1, "the same card again changes nothing");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "gate", waiting: false, detail: "Denied · timed out" } });
	assert.deepEqual(world.store.state().runs[0].waiting, [], "waiting: false clears it");
	assert.deepEqual(world.store.state().runs[0].denied, ["gate"], "a Denied detail is counted");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "gate", detail: "Denied" } });
	assert.deepEqual(world.store.state().runs[0].denied, ["gate"], "once per tool id");
	world.store.hostEvent({ ...event, type: "tool", tool: { id: "still", waiting: true } });
	world.store.hostEvent({ ...event, type: "done", stopReason: "end_turn" });
	assert.deepEqual(world.store.state().runs[0].waiting, [], "a run that ended waits for nobody");
	console.log("PASS events: preview stays in memory, waiting and denied update once");
}

function checkActions() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const id = world.add(daily(["07:00"]));
	const before = world.routine(id).lastScheduledFor;
	const manual = world.store.runNow(id);
	assert.equal(manual.ok, true);
	assert.equal(manual.fire.run.trigger, "manual");
	assert.equal(manual.fire.run.scheduledFor, world.at, "scheduledFor is now");
	assert.equal(world.routine(id).lastScheduledFor, before, "Run now uses up no occurrence");
	assert.equal(world.store.runNow(id).ok, false, "a second Run now is refused while the first is outstanding");
	assert.equal(world.store.runNow("gone").ok, false);
	finish(world, manual.fire.run);
	const lastRun = world.store.runNow(id);
	assert.equal(lastRun.ok, true);

	const paused = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const pausedId = paused.add(daily(["07:00"]));
	paused.store.setEnabled(pausedId, false);
	assert.equal(paused.store.runNow(pausedId).ok, true, "a paused routine can still Run now");

	assert.match(world.store.remove(id).error, /Stop it first/, "a routine with a live run stays, so the run keeps its Stop button");
	assert.equal(world.routine(id).id, id);
	finish(world, lastRun.fire.run);
	assert.equal(world.store.remove(id).ok, true);
	assert.deepEqual(world.store.state(), { routines: [], runs: [], error: "" }, "remove deletes the routine and its runs");
	assert.equal(world.saved().runs.length, 0);
	assert.equal(world.store.remove(id).ok, false);
	assert.equal(world.store.setEnabled(id, true).ok, false);
	assert.equal(world.store.setEnabled(pausedId, "yes").ok, false);

	const throwing = createRoutines({ file: path.join(folder, "throwing.json"), fs, writeAtomic: () => {}, now: () => 1000, onChange: () => { throw new Error("No window."); }, onNotice: () => { throw new Error("No notifications."); } });
	const throwingId = throwing.save(routineInput({ kind: "once", at: 500 + 7 * DAY })).id;
	assert.equal(throwing.save({ ...routineInput({ kind: "manual" }), id: throwingId }).ok, true, "a broken onChange reaches no caller");
	const fire = throwing.runNow(throwingId).fire;
	throwing.sendStarted(fire.run.sessionId, "turn");
	throwing.fail(fire.run.id, "Failed.");
	assert.equal(throwing.run(fire.run.id).state, "failed");
	console.log("PASS actions: Run now, pause, remove, and callbacks that throw never reach the caller");
}

function checkValidation() {
	const world = openStore(new Date(2026, 5, 1, 6, 0).getTime());
	const good = routineInput(daily(["07:00", "03:00"]));
	const saved = world.store.save({ ...good, name: "  Spaces  " });
	assert.equal(saved.ok, true, saved.error);
	const stored = world.routine(saved.id);
	assert.equal(stored.name, "Spaces");
	assert.deepEqual(stored.schedule.times, ["03:00", "07:00"]);
	assert.equal(stored.enabled, true, "a new routine starts on");
	assert.equal(stored.createdAt, world.at);
	assert.notEqual(stored.id, good.id, "the store makes the id");
	for (const [change, message] of [
		[{ name: "" }, /name/], [{ name: "   " }, /name/], [{ name: "n".repeat(101) }, /name/], [{ name: 7 }, /name/],
		[{ prompt: "" }, /instructions/], [{ prompt: "  \n" }, /instructions/], [{ prompt: "p".repeat(32001) }, /32,000/], [{ prompt: null }, /instructions/],
		[{ mode: "Plan" }, /mode/], [{ mode: "plan" }, /mode/], [{ mode: undefined }, /mode/],
		[{ model: "" }, /model/], [{ model: "-bad" }, /model/], [{ model: "m".repeat(81) }, /model/], [{ model: "has space" }, /model/],
		[{ effort: "extreme" }, /effort/], [{ effort: "" }, /effort/],
		[{ folder: "relative/path" }, /folder/], [{ folder: undefined }, /folder/],
		[{ schedule: undefined }, /schedule/], [{ schedule: { kind: "cron", text: "* * * * *" } }, /schedule/],
		[{ schedule: { kind: "once" } }, /schedule/], [{ schedule: { kind: "once", at: "soon" } }, /schedule/],
		[{ schedule: daily([]) }, /schedule/], [{ schedule: daily(["7:00"]) }, /schedule/], [{ schedule: daily(["24:00"]) }, /schedule/], [{ schedule: daily(["07:60"]) }, /schedule/], [{ schedule: daily(["07:00", "07:00"]) }, /schedule/],
		[{ schedule: daily(Array.from({ length: 25 }, (_, hour) => `${String(hour % 24).padStart(2, "0")}:${hour === 24 ? "30" : "00"}`)) }, /schedule/],
		[{ schedule: daily(["07:00"], { weekdays: [7] }) }, /schedule/], [{ schedule: daily(["07:00"], { weekdays: [1, 1] }) }, /schedule/], [{ schedule: daily(["07:00"], { weekdays: undefined }) }, /schedule/],
		[{ schedule: daily(["07:00"], { months: [0] }) }, /schedule/], [{ schedule: daily(["07:00"], { months: [13] }) }, /schedule/],
		[{ schedule: daily(["07:00"], { monthDay: 0 }) }, /schedule/], [{ schedule: daily(["07:00"], { monthDay: 29 }) }, /schedule/], [{ schedule: daily(["07:00"], { monthDay: 1.5 }) }, /schedule/],
		[{ schedule: daily(["07:00"], { monthDay: 1, weekdays: [1] }) }, /schedule/],
	]) {
		const result = world.store.save({ ...good, ...change });
		assert.equal(result.ok, false, JSON.stringify(change));
		assert.match(result.error, message);
	}
	assert.equal(world.store.save(undefined).ok, false, "no routine at all is refused, not thrown");
	assert.match(world.store.save({ ...good, id: "not-saved" }).error, /no longer exists/, "a saved id must already exist");
	for (const schedule of [{ kind: "manual" }, { kind: "once", at: world.at + DAY }, daily(Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`)), daily(["07:00"], { weekdays: [0, 6] }), daily(["09:00"], { monthDay: 28, months: [12] })]) {
		assert.equal(world.store.save({ ...good, schedule }).ok, true, JSON.stringify(schedule));
	}
	for (const mode of ["Auto-review", "Normal", "Always-approve"]) { assert.equal(world.store.save({ ...good, mode }).ok, true); }
	assert.equal(world.store.save({ ...good, name: "n".repeat(100), prompt: "p".repeat(32000), folder: path.resolve("somewhere") }).ok, true, "the limits themselves are allowed");
	const extra = world.store.save({ ...good, schedule: { ...daily(["07:00"]), cron: "ignored" }, enabled: false, createdAt: 1 });
	assert.equal(world.routine(extra.id).schedule.cron, undefined, "unknown fields are not stored");
	assert.equal(world.routine(extra.id).enabled, true);
	assert.equal(world.routine(extra.id).createdAt, world.at);
	console.log("PASS validation: every field's limits, no Plan mode, and a saved id must exist");
}

try {
	checkDays();
	checkClockChanges();
	checkCatchUp();
	checkPauseAndEdit();
	checkOnce();
	checkOutstanding();
	checkTrim();
	checkLoad();
	checkWriteFailure();
	checkPauseResumeWriteFailure();
	checkTerminalStates();
	checkEventsAndPreview();
	checkActions();
	checkValidation();
	console.log("Routine store checks passed.");
} finally {
	fs.rmSync(folder, { recursive: true, force: true });
}
