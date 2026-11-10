const assert = require(`node:assert/strict`);
const childProcess = require(`node:child_process`);
const path = require(`node:path`);
const { EventEmitter } = require(`node:events`);
const { PassThrough } = require(`node:stream`);
const { createGrokBotWindow } = require(`../electron/grokbot-window.cjs`);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ADOPTED = `adopted 77 348585984 2097408 0,1,-1,-1,-1,-1,10,20,30,40`;

function fakeWindow(handle) {
	const handleBuffer = Buffer.alloc(8);
	handleBuffer.writeBigUInt64LE(BigInt(handle));
	const states = [];
	return { states, destroyed: false, isDestroyed() { return this.destroyed; }, getNativeWindowHandle: () => handleBuffer, webContents: { send: (channel, state) => { assert.equal(channel, `grok:grokbot-window`); states.push(state); } } };
}

function fixture(options = {}) {
	const children = [], launched = [];
	const control = createGrokBotWindow({
		platform: `win32`,
		env: { LOCALAPPDATA: `C:/Local`, SystemRoot: `C:/Windows` },
		exists: (file) => options.installed !== false && file.includes(`Grok Bot.exe`),
		launch: (file) => launched.push(file),
		retryMs: 5, retryLimit: 3, watchMs: 5, releaseMs: 30,
		spawn: (file, args, spawnOptions) => {
			const child = new EventEmitter();
			child.file = file;
			child.args = args;
			child.options = spawnOptions;
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.lines = [];
			child.stdin.on(`data`, (text) => child.lines.push(...String(text).trim().split(`\n`)));
			child.say = (line) => child.stdout.write(`${line}\n`);
			child.kill = () => { child.killed = true; child.emit(`exit`); };
			children.push(child);
			return child;
		},
		...options.client,
	});
	return { control, children, launched };
}
const settle = () => pause(1);

async function opensAndPlaces() {
	const { control, children } = fixture();
	const win = fakeWindow(4242);
	assert.deepEqual(control.open(win), { ok: true });
	await settle();
	const [child] = children;
	assert.match(child.file, /powershell\.exe$/);
	assert.ok(child.args.at(-1).endsWith(`grokbot-window.ps1`));
	assert.equal(child.options.windowsHide, true);
	assert.deepEqual(child.lines, [`adopt 4242`]);
	assert.deepEqual(win.states, [`starting`]);
	assert.equal(control.holds(win), true, `a window being adopted counts as held, so a close waits for it`);
	control.place(win, { x: 300, y: 45, width: 800, height: 600, viewHeight: 700, visible: true });
	await settle();
	assert.deepEqual(child.lines, [`adopt 4242`], `nothing is placed before the window is adopted`);
	child.say(ADOPTED);
	await settle();
	assert.deepEqual(win.states, [`starting`, `open`]);
	control.place(win, { x: 300, y: 45, width: 800, height: 600, viewHeight: 700, visible: true });
	control.place(win, { x: 300, y: 45, width: 800, height: 600, viewHeight: 700, visible: false });
	for (const bad of [{ x: `1; drop`, y: 45, width: 800, height: 600, viewHeight: 700 }, { x: 1.5, y: 45, width: 800, height: 600, viewHeight: 700 }, { x: 1, y: 45, width: 0, height: 600, viewHeight: 700 }, null]) { control.place(win, bad); }
	control.place(fakeWindow(9), { x: 1, y: 1, width: 1, height: 1, viewHeight: 1, visible: true });
	await settle();
	assert.deepEqual(child.lines.slice(1), [`place 300 45 800 600 700`, `show`, `place 300 45 800 600 700`, `hide`], `only whole numbers from the holding window reach the helper`);
	control.hide(win);
	await settle();
	assert.equal(child.lines.at(-1), `away`, `a closed view is told apart from a covered one`);
	control.open(win);
	await settle();
	assert.equal(child.lines.at(-1), `adopt 4242 77 348585984 2097408 0,1,-1,-1,-1,-1,10,20,30,40`, `reopening keeps the first saved state`);
	console.log(`PASS Grok Bot window: adopts, then places only valid areas for the holding window`);
}

async function openedElsewhereWhileAway() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	const [child] = children;
	child.say(ADOPTED);
	await settle();
	control.hide(win);
	await settle();
	child.say(`released`);
	child.emit(`exit`);
	await settle();
	assert.equal(control.holding(), false, `Grok Bot opened from elsewhere is back on the desktop, so a close has nothing to wait for`);
	assert.notEqual(win.states.at(-1), `problem`, `the helper ending here isn't a failure`);
	control.open(win);
	await settle();
	assert.equal(children.length, 2);
	assert.deepEqual(children[1].lines, [`adopt 1`], `choosing the row takes it again as it now is`);
	console.log(`PASS Grok Bot window: opening it elsewhere while its view is closed lets it go, and choosing the row takes it back`);
}

async function startsTheApp() {
	const { control, children, launched } = fixture();
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	const [child] = children;
	child.say(`none`);
	await pause(10);
	assert.equal(launched.length, 1);
	assert.ok(launched[0].endsWith(path.join(`Programs`, `Grok Bot`, `Grok Bot.exe`)));
	assert.equal(child.lines.length, 2, `it looks again after starting the app`);
	child.say(`none`);
	await pause(10);
	assert.equal(launched.length, 1, `the app is started once`);
	child.say(`none`);
	await pause(10);
	child.say(`none`);
	await pause(10);
	assert.equal(win.states.at(-1), `notfound`, `it stops looking at the limit`);
	const count = child.lines.length;
	await pause(15);
	assert.equal(child.lines.length, count);
	control.open(win);
	await settle();
	child.say(`none`);
	await pause(10);
	assert.equal(launched.length, 2, `Try again starts the app again`);
	control.hide(win);
	child.say(`none`);
	await pause(15);
	assert.equal(launched.length, 2, `a closed view starts nothing`);
	console.log(`PASS Grok Bot window: starts the app once, looks for a limited time, and stops when the view closes`);
}

async function missingApp() {
	const { control, children, launched } = fixture({ installed: false });
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	children[0].say(`none`);
	await settle();
	assert.deepEqual(win.states, [`starting`, `missing`]);
	assert.equal(launched.length, 0);
	console.log(`PASS Grok Bot window: says when the app isn't installed`);
}

async function closedAndReopened() {
	const { control, children, launched } = fixture({ client: { watchMs: 20 } });
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	const [child] = children;
	child.say(ADOPTED);
	await settle();
	child.say(`gone`);
	await pause(30);
	assert.equal(win.states.at(-1), `closed`);
	assert.equal(child.lines.at(-1), `adopt 1`, `it looks for a new window, because an update restarts the app`);
	child.say(`none`);
	await settle();
	assert.equal(control.holding(), false, `a closed window isn't held`);
	await pause(30);
	assert.equal(launched.length, 0, `it never reopens an app the person closed`);
	child.say(ADOPTED);
	await settle();
	assert.equal(win.states.at(-1), `open`);
	console.log(`PASS Grok Bot window: a closed app is noticed and picked up when it returns, and isn't restarted`);
}

async function secondWindow() {
	const { control, children } = fixture();
	const first = fakeWindow(1), second = fakeWindow(2);
	control.open(first);
	await settle();
	const [child] = children;
	child.say(ADOPTED);
	await settle();
	control.open(second);
	await settle();
	assert.equal(first.states.at(-1), `elsewhere`);
	assert.equal(children.length, 1);
	assert.match(child.lines.at(-1), /^adopt 2 /);
	assert.equal(control.holds(first), false);
	assert.equal(control.holds(second), true);
	control.hide(first);
	await settle();
	assert.notEqual(child.lines.at(-1), `away`, `the old window closing its view leaves the new holder alone`);
	console.log(`PASS Grok Bot window: the last window to open it holds it, and tells the other one`);
}

async function releaseBeforeClose() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	await control.release();
	control.open(win);
	await settle();
	const [child] = children;
	child.say(ADOPTED);
	await settle();
	let done = false;
	const released = control.release().then(() => { done = true; });
	await settle();
	assert.equal(child.lines.at(-1), `release`);
	assert.equal(done, false, `the close waits for the window to be back on the desktop`);
	child.say(`released`);
	child.emit(`exit`);
	await released;
	assert.equal(control.holding(), false);
	assert.equal(control.holds(win), false);
	console.log(`PASS Grok Bot window: release finishes before the window may close`);
}

async function closeBeforeQuit() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	await control.close();
	control.open(win);
	await settle();
	const [child] = children;
	child.say(ADOPTED);
	await settle();
	let done = false;
	const closed = control.close().then(() => { done = true; });
	await settle();
	assert.equal(child.lines.at(-1), `close`);
	assert.equal(done, false, `the app waits until Grok Bot has left its window`);
	child.say(`released`);
	child.emit(`exit`);
	await closed;
	assert.equal(control.holding(), false);
	control.open(win);
	await settle();
	children[1].say(ADOPTED);
	await settle();
	children[1].emit(`exit`);
	await settle();
	const again = control.close();
	await settle();
	assert.deepEqual(children[2].lines, [`adopt 1 77 348585984 2097408 0,1,-1,-1,-1,-1,10,20,30,40`, `close`], `with no helper, a new one takes the window and closes it`);
	children[2].emit(`exit`);
	await again;
	control.open(win);
	await settle();
	children[3].say(ADOPTED);
	await settle();
	await control.close();
	assert.equal(children[3].killed, true, `a stuck helper can't hold up quitting`);
	console.log(`PASS Grok Bot window: close finishes before the app does, with a new helper if needed and without a stuck one`);
}

async function releaseWithStuckHelper() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	children[0].say(ADOPTED);
	await settle();
	await control.release();
	assert.equal(children[0].killed, true, `a stuck helper can't hold up closing the app`);
	assert.equal(control.holding(), false);
	console.log(`PASS Grok Bot window: a stuck helper can't hold up closing`);
}

async function helperStops() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	children[0].say(ADOPTED);
	await settle();
	children[0].emit(`exit`);
	await settle();
	assert.equal(win.states.at(-1), `problem`);
	assert.equal(control.holds(win), true, `the window is still inside, so a close must still put it back`);
	control.open(win);
	await settle();
	assert.equal(children.length, 2);
	assert.equal(children[1].lines[0], `adopt 1 77 348585984 2097408 0,1,-1,-1,-1,-1,10,20,30,40`, `a new helper picks up the same window and its saved state`);
	children[1].emit(`exit`);
	await settle();
	const released = control.release();
	await settle();
	assert.equal(children.length, 3);
	assert.deepEqual(children[2].lines, [`adopt 1 77 348585984 2097408 0,1,-1,-1,-1,-1,10,20,30,40`, `release`], `closing with no helper starts one to put the window back`);
	children[2].emit(`exit`);
	await released;
	console.log(`PASS Grok Bot window: a stopped helper is reported, and a new one takes over the saved state`);
}

async function otherSystems() {
	const { control, children } = fixture({ client: { platform: `darwin` } });
	assert.deepEqual(control.open(fakeWindow(1)), { ok: false });
	assert.equal(children.length, 0);
	console.log(`PASS Grok Bot window: other systems start nothing`);
}

async function helperStopsAndBotCloses() {
	const { control, children } = fixture();
	const win = fakeWindow(1);
	control.open(win);
	await settle();
	children[0].say(ADOPTED);
	children[0].emit(`exit`);
	control.open(win);
	await settle();
	const child = children[1];
	assert.match(child.lines[0], /^adopt 1 77 /);
	child.say(`none`);
	assert.deepEqual(child.lines.slice(1), [`adopt 1`], `a missing saved window triggers a fresh search`);
	child.say(ADOPTED.replace(`adopted 77`, `adopted 88`));
	assert.equal(win.states.at(-1), `open`);
	assert.equal(control.holds(win), true);
	console.log(`PASS Grok Bot window: a restarted helper recovers from a stale window handle`);
}

function helperCompiles() {
	if (process.platform !== `win32`) { return; }
	const result = childProcess.spawnSync(`powershell.exe`, [`-NoProfile`, `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-File`, path.join(__dirname, `..`, `electron`, `grokbot-window.ps1`), `-Check`], { encoding: `utf8`, windowsHide: true });
	assert.equal(result.stdout.trim(), `ok`, result.stderr);
	console.log(`PASS Grok Bot window: the Windows helper compiles`);
}

(async () => {
	await opensAndPlaces();
	await openedElsewhereWhileAway();
	await startsTheApp();
	await missingApp();
	await closedAndReopened();
	await secondWindow();
	await releaseBeforeClose();
	await closeBeforeQuit();
	await releaseWithStuckHelper();
	await helperStops();
	await helperStopsAndBotCloses();
	await otherSystems();
	helperCompiles();
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
