const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const root = path.resolve(__dirname, "..");
const imageFile = path.join(root, "test-image.png");
const handlers = new Map();
const windows = [];
let host;
let terminals;
let written;
let grokLogouts = 0;
let readinessChecks = 0;
const windowStateFile = path.join(root, "window-state.json");
let windowState;
let cursorArea = { x: 0, y: 0, width: 1920, height: 1080 };
let matchingArea = cursorArea;
let updateCheckResult = { ok: true, available: false, reason: "no-releases" };
let updatePrepared = { ok: true, ready: true, node: "C:\\Node\\node.exe", from: "1234567" };
let updateMarker = null;
let updateMarkerLive = false;
let updateResult;
const updateChecks = [];
const updatePrepares = [];
const helperCopies = [];
const children = [];
const resultFile = path.join(root, "update-result.json");
const helperApi = {
	readMarker: () => updateMarker,
	markerLive: async () => updateMarkerLive,
	findNode: async () => "C:\\Node\\node.exe",
	writeAtomic: (file, value) => { assert.equal(file, resultFile); updateResult = value; },
};
const updateApi = {
	checkForUpdate: async (...args) => { updateChecks.push(args); return updateCheckResult; },
	updatePrepare: async (...args) => { updatePrepares.push(args); return updatePrepared; },
};

class TestWindow extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.webContents = new EventEmitter();
		this.webContents.isDestroyed = () => !!(this.destroyed || this.webContents.gone);
		this.webContents.send = () => {
			if (this.webContents.isDestroyed()) { throw new TypeError("Object has been destroyed"); }
		};
		this.webContents.getURL = () => "file:///index.html";
		this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; };
		windows.push(this);
	}
	close() { this.closes = (this.closes || 0) + 1; }
	static getAllWindows() { return windows.filter((win) => !win.isDestroyed()); }
	static fromWebContents(contents) { return windows.find((win) => win.webContents === contents) || null; }
	isDestroyed() { return !!this.destroyed; }
	setIcon() {}
	setAppDetails(details) { this.appDetails = details; }
	show() { this.shown = (this.shown || 0) + 1; this.maximizedWhenShown = this.isMaximized(); }
	getNormalBounds() { return this.bounds || { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height }; }
	isMaximized() { return !!this.maximized; }
	maximize() { this.maximized = true; }
	setProgressBar(value, options) { this.progress = { value, options }; }
	setOverlayIcon(image, text) { this.overlay = { image, text }; }
	isMinimized() { return !!this.minimized; }
	restore() { this.minimized = false; }
	focus() { this.focused = (this.focused || 0) + 1; }
	loadFile(file, options) { this.navigation = { file, options }; return Promise.resolve(); }
	loadURL() { return Promise.resolve(); }
}

class TestHost {
	constructor(emit) {
		host = this;
		this.emit = emit;
		this.turns = new Map();
		this.cancelled = [];
		this.decisions = [];
		this.folderUpdates = [];
		this.steered = [];
	}
	prompt(input) {
		if (this.turns.has(input.uiSessionId)) { return Promise.resolve({ ok: false }); }
		this.turns.set(input.uiSessionId, { uiSessionId: input.uiSessionId });
		return Promise.resolve({ ok: true });
	}
	cancel(id) { this.cancelled.push(id); }
	stopSession(id) { this.stopped = id; }
	forgetSession(id) { this.forgotten = id; }
	decide(input) { this.decisions.push(input); return { ok: true }; }
	answerQuestion(input) { this.decisions.push({ question: input }); return { ok: true }; }
	answerPlan(input) { this.decisions.push({ plan: input }); return { ok: true }; }
	setAllowedFolders(input) { this.folderUpdates.push(input); return { ok: true }; }
	rewind(input) { this.rewound = input; return { ok: true, done: input.force }; }
	fork(input) { this.forked = input; return { ok: true, agentSessionId: "forked-session" }; }
	steer(id, text) { this.steered.push([id, text]); return { ok: true }; }
	kill() {}
	signedOut() { this.signOuts = (this.signOuts || 0) + 1; }
}

class TestTerminals {
	constructor(emit) {
		terminals = this;
		this.emit = emit;
		this.nextId = 0;
		this.closed = [];
		this.closeAllCalls = 0;
	}
	open({ cwd }) { return cwd ? { ok: true, id: `terminal-${++this.nextId}` } : { ok: false }; }
	close(id) { this.closed.push(id); this.emit({ type: "terminal-exit", id }); }
	closeAll() { this.closeAllCalls += 1; }
}

const app = new EventEmitter();
app.commandLine = { switches: [], appendSwitch(...args) { this.switches.push(args); } };
app.setPath = () => {};
app.getVersion = () => "0.1.0";
app.isPackaged = false;
app.setName = () => {};
app.setAppUserModelId = () => {};
app.getPath = () => root;
app.whenReady = () => ({ then: (callback) => callback() });
app.requestSingleInstanceLock = () => true;
app.quit = () => { app.quitCalls = (app.quitCalls || 0) + 1; };
let dialogChoice = 1;
const dialogs = [];
let appMenu = [];
const popups = [];
const partitions = new Map();
const electron = {
	app,
	BrowserWindow: TestWindow,
	ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) },
	nativeImage: {
		createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 640, height: 480 }) }),
		createFromBitmap: (pixels, options) => ({ pixels, options }),
	},
	screen: { getCursorScreenPoint: () => ({ x: cursorArea.x, y: cursorArea.y }), getDisplayNearestPoint: () => ({ workArea: cursorArea }), getDisplayMatching: () => ({ workArea: matchingArea }) },
	Menu: { buildFromTemplate: (template) => Object.assign([...template], { popup: (options) => popups.push({ template, options }) }), setApplicationMenu: (menu) => { appMenu = menu; } },
	clipboard: { writeText: (text) => { written = ["clipboard", text]; } },
	powerMonitor: Object.assign(new EventEmitter(), { onBattery: false, isOnBatteryPower() { return this.onBattery; } }),
	powerSaveBlocker: { active: false, start() { this.active = true; return 1; }, stop() { this.active = false; } },
	shell: {
		openExternal: () => Promise.resolve(),
		openPath: () => Promise.resolve(""),
		showItemInFolder: (target) => { written = target; },
		readShortcutLink: (file) => {
			if (!shortcuts[file]) { throw new Error("Not a shortcut."); }
			return shortcuts[file];
		},
		writeShortcutLink: (file, operation, options) => {
			shortcutWrites.push({ file, operation, options });
			Object.assign(shortcuts[file], options);
			return true;
		},
	},
	// A synchronous dialog stops the main process, and with it the approvals' auto-deny.
	dialog: {
		showMessageBoxSync: () => { throw new Error("showMessageBoxSync blocks the main process"); },
		showMessageBox: (_win, options) => {
			dialogs.push(options);
			return Promise.resolve({ response: dialogChoice });
		},
	},
	session: {
		fromPartition(name) {
			const handlersFor = {
				setPermissionRequestHandler(handler) { this.request = handler; },
				setPermissionCheckHandler(handler) { this.check = handler; },
			};
			partitions.set(name, handlersFor);
			return handlersFor;
		},
	},
};
delete process.env.GROK_CODE_DEBUG_PORT;
// What `npm run desktop` adds, on top of whatever launched this test.
const launchPath = process.env.PATH;
process.env.PATH = [path.join(root, "node_modules", ".bin"), "C:\\npm\\node_modules\\@npmcli\\run-script\\lib\\node-gyp-bin", launchPath].join(path.delimiter);
process.env.npm_lifecycle_event = "desktop";
process.env.npm_config_cache = "C:\\npm-cache";
process.env.INIT_CWD = root;
// Started from the taskbar pin, with a page older than the source.
const launchArgs = process.argv;
process.argv = [...launchArgs, "--build-if-stale"];
const viteBuilds = [];
let pageTime = 0;
// Shortcuts Windows made when the app was pinned, with no arguments, beside ones that belong to something else.
const startMenu = path.join(root, "Microsoft", "Windows", "Start Menu", "Programs");
const pinnedFolder = path.join(root, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
const shortcuts = {
	[path.join(startMenu, "Codewomplers Grok Desktop.lnk")]: { target: process.execPath, args: "", appUserModelId: "Grok.Code" },
	[path.join(startMenu, "Other app.lnk")]: { target: process.execPath, args: "", appUserModelId: "Other.App" },
	[path.join(startMenu, "Other checkout.lnk")]: { target: path.join(root, "other-checkout", "electron.exe"), args: "", appUserModelId: "Grok.Code" },
	[path.join(pinnedFolder, "Grok.lnk")]: { target: process.execPath, args: "", appUserModelId: "Grok.Code" },
};
const shortcutWrites = [];
// These checks cover the Windows behavior (shortcut repair, Ctrl+R) on every host; checkMacMenu loads a macOS copy.
const mainContext = {
	__dirname: path.join(root, "electron"),
	process: Object.create(process, { platform: { value: "win32" } }),
	URL,
	Buffer,
	require(name) {
		if (name === "electron") { return electron; }
		if (name === "fs") {
			return {
				...fs,
				readFileSync(file, ...rest) {
					if (file === resultFile) { if (!updateResult) { throw new Error("No update result."); } return JSON.stringify(updateResult); }
					if (file !== windowStateFile) { return fs.readFileSync(file, ...rest); }
					if (windowState === undefined) { throw new Error("No saved window state."); }
					return windowState;
				},
				writeFileSync(file, text, ...rest) {
					if (file === windowStateFile) { windowState = text; } else { fs.writeFileSync(file, text, ...rest); }
				},
				copyFileSync: (...args) => helperCopies.push(args),
				unlinkSync(file) { if (file === resultFile) { updateResult = undefined; } else { throw new Error(`Unexpected unlink ${file}`); } },
				existsSync: (file) => file === imageFile || fs.existsSync(file),
				statSync: (file, ...rest) => file === path.join(root, "dist", "index.html") ? { mtimeMs: pageTime } : fs.statSync(file, ...rest),
				readdirSync: (folder, ...rest) => [startMenu, pinnedFolder].includes(folder) ? Object.keys(shortcuts).filter((file) => path.dirname(file) === folder).map((file) => path.basename(file)) : fs.readdirSync(folder, ...rest),
			};
		}
		if (name === "child_process") {
			const real = require("child_process");
			return {
				...real,
				spawn(command, args, options) {
					const child = Object.assign(new EventEmitter(), { unref() { this.unreferenced = true; } });
					children.push({ command, args, options, child });
					return child;
				},
				spawnSync(command, args, options) {
					if (!/vite\.js$/.test(args?.[0] ?? "")) { return real.spawnSync(command, args, options); }
					viteBuilds.push({ command, args, options });
					return { status: 0 };
				},
			};
		}
		if (name === "./agent.cjs") { return { AgentHost: TestHost }; }
		if (name === "./updates.cjs") { return updateApi; }
		if (name === "../scripts/update-helper.cjs") { return helperApi; }
		if (name === "./git.cjs") { return { prCreate: (...args) => { written = args; return { ok: true }; }, prMergeWhenReady: (...args) => { written = args; return { ok: true }; }, restoreWorktree: (...args) => { written = args; return { ok: true }; } }; }
		if (name === "./usage.cjs") { return { taskOutput: (...args) => { written = args; return { ok: true, text: "task output" }; }, subagentTranscript: (...args) => { written = args; return { ok: true, messages: [] }; } }; }
		if (name === "./diff.cjs") { return {}; }
		if (name === "./customize.cjs") { return { signOut: async () => { grokLogouts += 1; return { ok: true }; }, readiness: async () => { readinessChecks += 1; return { grok: { ok: true, signedIn: true } }; } }; }
		if (name === "./terminal.cjs") { return { TerminalHost: TestTerminals }; }
		if (name === "./files.cjs") {
			return { writeText: (...args) => { written = args; return { ok: true }; }, locateFile: (cwd, file) => file === "missing" ? { ok: false, error: "Missing file." } : { ok: true, target: path.join(cwd, file) } };
		}
		if (name === "./inbound.cjs") { return require("../electron/inbound.cjs"); }
		return require(name);
	},
};
vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), mainContext);
process.argv = launchArgs;

async function main() {
	assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, "1");
	assert.equal(process.env.PATH.split(path.delimiter).some((entry) => /node-gyp-bin$/i.test(entry) || entry === path.join(root, "node_modules", ".bin")), false, "npm's PATH entries are gone");
	assert.ok(launchPath.endsWith(process.env.PATH), "the rest of PATH is kept in order");
	assert.deepEqual([process.env.npm_lifecycle_event, process.env.npm_config_cache, process.env.INIT_CWD], [undefined, undefined, undefined], "npm's variables are gone");
	assert.equal(viteBuilds.length, 1, "started from the taskbar pin with source newer than the page, the page is rebuilt before the window opens");
	assert.deepEqual([viteBuilds[0].command, [...viteBuilds[0].args]], [process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"]]);
	assert.equal(viteBuilds[0].options.env.ELECTRON_RUN_AS_NODE, "1", "Electron runs the build itself, so the pin does not need Node on PATH");
	pageTime = Infinity;
	mainContext.buildIfStale();
	assert.equal(viteBuilds.length, 1, "a page newer than the source is not rebuilt");
	assert.ok(windows[0].appDetails.relaunchCommand.endsWith(" --build-if-stale"), "the taskbar pin asks for the check");
	const iconFile = path.join(root, "assets", "codewomplers-grok-desktop.ico");
	assert.equal(windows[0].appDetails.appIconPath, iconFile);
	assert.deepEqual(shortcutWrites.map(({ file, operation }) => [path.basename(file), operation]), [["Codewomplers Grok Desktop.lnk", "update"], ["Grok.lnk", "update"]], "at launch, this app's pinned shortcuts are repaired; other apps' and other checkouts' are left alone");
	assert.deepEqual({ ...shortcutWrites[0].options }, { target: process.execPath, args: `"${root}" --build-if-stale`, icon: iconFile, iconIndex: 0 });
	assert.equal(app.commandLine.switches.some(([name]) => name === "remote-debugging-port"), false, "the DevTools port stays closed unless GROK_CODE_DEBUG_PORT is set");
	const { powerMonitor, powerSaveBlocker } = electron;
	handlers.get("grok:keep-awake")({}, { working: true, onBattery: false });
	assert.equal(powerSaveBlocker.active, true, "on mains power a working session keeps the computer awake");
	powerMonitor.onBattery = true;
	powerMonitor.emit("on-battery");
	assert.equal(powerSaveBlocker.active, false, "switching to battery drops the hold when Keep awake on battery power is off");
	powerMonitor.onBattery = false;
	powerMonitor.emit("on-ac");
	assert.equal(powerSaveBlocker.active, true, "back on mains power the hold returns");
	handlers.get("grok:keep-awake")({}, { working: false, onBattery: false });
	assert.equal(powerSaveBlocker.active, false);
	assert.equal(handlers.get("grok:reveal")({}, root, "a b,c.txt").ok, true);
	assert.equal(written, path.join(root, "a b,c.txt"), "Explorer receives the complete path, including spaces and commas");
	written = null;
	assert.equal(handlers.get("grok:reveal")({}, root, "missing").error, "Missing file.");
	assert.equal(written, null, "a failed lookup never opens Explorer");
	handlers.get("grok:pr-create")({}, "folder", "feature");
	assert.equal(written[0], "folder");
	assert.equal(written[1].expected, "feature");
	handlers.get("grok:pr-create")({}, "folder", { invalid: true });
	assert.equal(written[1].expected, undefined);
	handlers.get("grok:pr-merge")({}, "folder", 42);
	assert.deepEqual(written, ["folder", 42]);
	handlers.get("grok:restore-worktree")({}, "worktree", "grok/topic");
	assert.deepEqual(written, ["worktree", "grok/topic"]);
	handlers.get("grok:new-window")();
	assert.equal(windows[1].navigation.options, undefined);
	assert.equal(handlers.get("grok:new-window")({}, "chosen-session").ok, true);
	assert.equal(windows[2].navigation.options.query.session, "chosen-session");
	assert.equal(handlers.get("grok:new-window")({}, { session: "invalid" }).ok, false);
	for (const file of [process.execPath, "shot.png", path.join(root, "missing.png"), { file: "x.png" }]) {
		assert.equal(handlers.get("grok:open-image")({}, file).ok, false, "only an existing image file opens in an image window");
	}
	assert.equal(windows.length, 3);
	const first = { sender: windows[0].webContents };
	const second = { sender: windows[1].webContents };
	const taskbar = handlers.get("grok:taskbar");
	assert.equal(taskbar(first, "running").ok, true);
	assert.equal(windows[0].progress.value, 2);
	assert.equal(windows[0].progress.options.mode, "indeterminate");
	assert.equal(windows[0].overlay.image, null);
	assert.equal(taskbar(first, "needs-you").ok, true);
	assert.equal(windows[0].progress.value, -1);
	assert.equal(windows[0].overlay.text, "Grok needs you");
	assert.equal(windows[0].overlay.image.options.width, 16);
	assert.equal(windows[0].overlay.image.options.height, 16);
	assert.equal(windows[0].overlay.image.pixels.length, 16 * 16 * 4);
	assert.equal(taskbar(first, "idle").ok, true);
	assert.equal(windows[0].progress.value, -1);
	assert.equal(windows[0].overlay.image, null);
	const unchangedProgress = windows[0].progress;
	assert.equal(taskbar(first, "other").ok, false);
	assert.equal(windows[0].progress, unchangedProgress);
	assert.equal(taskbar({ sender: new EventEmitter() }, "running").ok, false);
	assert.equal(handlers.get("grok:open-image")(first, imageFile).ok, true);
	assert.equal(windows.at(-1).options.parent, windows[0], "an image viewer belongs to the window that opened it");
	assert.equal(windows.at(-1).navigation.file, imageFile);
	for (const [input, expected] of [
		[{ type: "keyDown", control: true, key: "r" }, true],
		[{ type: "keyDown", control: true, key: "t" }, false],
		[{ type: "keyDown", control: true, alt: true, key: "r" }, false],
		[{ type: "keyDown", control: true, meta: true, key: "r" }, false],
		[{ type: "keyUp", control: true, key: "r" }, false],
	]) {
		let prevented = false;
		first.sender.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input);
		assert.equal(prevented, expected, JSON.stringify(input));
	}
	const firstTerminal = handlers.get("grok:terminal-open")(first, { cwd: root }).id;
	const secondTerminal = handlers.get("grok:terminal-open")(second, { cwd: root }).id;
	assert.equal(handlers.get("grok:terminal-open")(first, { cwd: "" }).ok, false);
	const endedTerminal = handlers.get("grok:terminal-open")(first, { cwd: root }).id;
	terminals.emit({ type: "terminal-exit", id: endedTerminal });
	first.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
	first.sender.emit("did-frame-navigate", {}, "https://example.test", 200, "OK", false);
	first.sender.emit("did-navigate-in-page");
	assert.deepEqual(terminals.closed, [], "attempted, subframe and same-document navigation keep terminals");
	first.sender.emit("did-navigate");
	assert.deepEqual(terminals.closed, [firstTerminal], "a completed reload closes only its owner's terminals, excluding exited and failed opens");
	const crashedTerminal = handlers.get("grok:terminal-open")(first, { cwd: root }).id;
	first.sender.emit("render-process-gone");
	assert.deepEqual(terminals.closed, [firstTerminal, crashedTerminal], "a renderer crash closes its terminals");
	// As on macOS Cmd+Q: the page is destroyed while its window still exists, so the terminal-exit broadcast must skip it.
	second.sender.gone = true;
	second.sender.emit("destroyed");
	assert.deepEqual(terminals.closed, [firstTerminal, crashedTerminal, secondTerminal], "destroy closes only the remaining owner's terminals");
	second.sender.gone = false;
	assert.equal(terminals.closeAllCalls, 0);
	assert.equal((await handlers.get("grok:send")(first, { uiSessionId: "first" })).ok, true);
	assert.equal((await handlers.get("grok:send")(second, { uiSessionId: "first" })).ok, false);
	assert.equal((await handlers.get("grok:sign-out")()).ok, false, "signing out waits for a running reply");
	assert.equal(grokLogouts, 0);
	const running = host.turns.get("first");
	host.turns.set("first", { ...running, finished: true });
	assert.equal((await handlers.get("grok:sign-out")()).ok, true);
	assert.equal(grokLogouts, 1);
	assert.equal(host.signOuts, 1, "a signed-out Grok is stopped so the next message signs in again");
	host.turns.set("first", running);
	assert.equal(handlers.get("grok:steer")(second, "first", "New direction").ok, false, "another window cannot steer the running turn");
	assert.deepEqual(host.steered, []);
	assert.equal(handlers.get("grok:steer")(first, "first", "New direction").ok, true);
	assert.deepEqual(host.steered, [["first", "New direction"]]);
	host.turns.set("first", { ...running });
	assert.equal(handlers.get("grok:steer")(first, "first", "Stale owner").ok, false, "ownership follows the exact running turn");
	assert.equal(host.steered.length, 1);
	const sends = [windows[0].webContents.send, windows[1].webContents.send];
	const delivered = [[], []];
	windows[0].webContents.send = (...args) => delivered[0].push(args);
	windows[1].webContents.send = (...args) => delivered[1].push(args);
	host.turns.set("first", { uiSessionId: "first", fallback: true });
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "steer-turn", text: "New direction" });
	assert.deepEqual(delivered.map((list) => list.length), [1, 0], "a turn Grok starts for a late steer goes only to the window that steered");
	assert.equal(handlers.get("grok:steer")(first, "first", "Into the adopted turn").ok, true, "that window owns the adopted turn");
	assert.equal(handlers.get("grok:steer")(second, "first", "Not this window").ok, false);
	const cancelledBefore = host.cancelled.length;
	host.emit({ type: "turn-start", uiSessionId: "nobody", turnId: "orphan", text: "No window" });
	assert.deepEqual(host.cancelled.slice(cancelledBefore), ["nobody"], "a turn Grok starts with no window to show it stops");
	host.cancelled.length = cancelledBefore;
	host.turns.set("first", running);
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "turn", text: "" });
	host.steered.length = 1;
	[windows[0].webContents.send, windows[1].webContents.send] = sends;
	assert.equal(handlers.get("grok:decide")(second, { uiSessionId: "first", toolId: "native" }).ok, false);
	const folders = { uiSessionId: "first", allowedFolders: ["C:/extra"] };
	assert.equal(handlers.get("grok:allowed-folders")(second, folders).ok, false);
	assert.equal(host.folderUpdates.length, 0);
	assert.equal(handlers.get("grok:allowed-folders")(first, folders).ok, true);
	assert.deepEqual(host.folderUpdates, [folders]);
	handlers.get("grok:cancel")(second, "first");
	windows[1].webContents.emit("destroyed");
	assert.equal(host.cancelled.length, 0);
	assert.equal(handlers.get("grok:decide")(first, { uiSessionId: "first", toolId: "native" }).ok, true);
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
	assert.equal(host.cancelled.length, 0);
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
	assert.deepEqual(host.cancelled, ["first"]);
	windows[0].webContents.emit("render-process-gone");
	windows[0].webContents.emit("destroyed");
	assert.deepEqual(host.cancelled, ["first", "first", "first"]);
	host.turns.clear();
	assert.equal((await handlers.get("grok:send")(first, { uiSessionId: "one" })).ok, true);
	assert.equal((await handlers.get("grok:send")(second, { uiSessionId: "two" })).ok, true, "two sessions run at the same time");
	assert.equal(handlers.get("grok:decide")(first, { uiSessionId: "two", toolId: "native" }).ok, false);
	assert.equal(handlers.get("grok:decide")(second, { uiSessionId: "two", toolId: "native" }).ok, true);
	windows[1].webContents.emit("destroyed");
	assert.deepEqual(host.cancelled.slice(3), ["two"], "closing a window stops only its own sessions");
	host.turns.clear();
	host.cancelled.length = 3;
	await handlers.get("grok:send")(second, { uiSessionId: "second" });
	windows[0].webContents.emit("destroyed");
	assert.equal(host.cancelled.length, 3);
	handlers.get("grok:write")(first, "folder", "file", "text", "version");
	assert.deepEqual(written, ["folder", "file", "text", "version"]);
	let api;
	vm.runInNewContext(fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8"), {
		require: () => ({
			contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
			ipcRenderer: {
				invoke: (...args) => { written = args; },
				sendSync: (name) => { const event = {}; handlers.get(name)(event); return event.returnValue; },
			},
		}),
		process: { platform: "darwin" },
	});
	assert.equal(api.homeDir, require("node:os").homedir(), "the first session's folder comes from this computer, not a fixed path");
	assert.equal(api.platform, "darwin", "the renderer learns the platform from the preload");
	api.readiness();
	assert.deepEqual(written, ["grok:readiness"]);
	api.updateCheck(true);
	assert.deepEqual(written, ["grok:update-check", true]);
	api.updatePrepare("v0.2.0");
	assert.deepEqual(written, ["grok:update-prepare", "v0.2.0"]);
	api.updateStart("v0.2.0");
	assert.deepEqual(written, ["grok:update-start", "v0.2.0"]);
	api.updateResult();
	assert.deepEqual(written, ["grok:update-result"]);
	assert.ok(["check", "prepare", "start", "result"].every((name) => handlers.has(`grok:update-${name}`)), "all update IPC handlers are registered");
	await handlers.get("grok:update-check")({}, true);
	assert.equal(updateChecks.at(-1)[2].force, true);
	await handlers.get("grok:update-check")({}, "true");
	assert.equal(updateChecks.at(-1)[2].force, false);
	assert.equal(await handlers.get("grok:update-prepare")({}, "v0.2.0"), updatePrepared);
	// The options object comes from main.cjs's context, so compare its field rather than the object.
	assert.deepEqual([...updatePrepares.at(-1).slice(0, 3), updatePrepares.at(-1)[3].packaged], [root, "0.1.0", "v0.2.0", false]);
	assert.equal(updateChecks.at(-1)[2].packaged, false, "a copy run from source checks its git origin");
	updateResult = { ok: true, message: "Updated to version 0.2.0." };
	assert.equal(handlers.get("grok:update-result")().message, "Updated to version 0.2.0.");
	assert.equal(handlers.get("grok:update-result")(), null, "the update result is read only once");
	api.taskbar("running");
	assert.deepEqual(written, ["grok:taskbar", "running"]);
	assert.equal((await handlers.get("grok:readiness")()).grok.signedIn, true);
	assert.equal((await handlers.get("grok:readiness")()).grok.signedIn, true);
	assert.equal(readinessChecks, 2, "every setup check asks the backend again");
	api.writeFile("folder", "file", "text", "version");
	assert.deepEqual(written, ["grok:write", "folder", "file", "text", "version"]);
	api.taskOutput("task.log");
	assert.deepEqual(written, ["grok:task-output", "task.log"]);
	assert.equal(handlers.get("grok:task-output")({}, "task.log").text, "task output");
	assert.deepEqual(written, ["task.log"]);
	api.subagentTranscript("child-id");
	assert.deepEqual(written, ["grok:subagent-transcript", "child-id"]);
	assert.equal(handlers.get("grok:subagent-transcript")({}, "child-id").ok, true);
	assert.deepEqual(written, ["child-id"]);
	api.setAllowedFolders(folders);
	assert.deepEqual(written, ["grok:allowed-folders", folders]);
	api.newWindow("chosen-session");
	assert.deepEqual(written, ["grok:new-window", "chosen-session"]);
	api.answerQuestion({ toolId: "q" });
	assert.deepEqual(written, ["grok:answer-question", { toolId: "q" }]);
	api.answerPlan({ toolId: "p" });
	assert.deepEqual(written, ["grok:answer-plan", { toolId: "p" }]);
	api.prMergeWhenReady("folder", 42);
	assert.deepEqual(written, ["grok:pr-merge", "folder", 42]);
	api.prCreate("folder", "feature");
	assert.deepEqual(written, ["grok:pr-create", "folder", "feature"]);
	api.restoreWorktree("worktree", "grok/topic");
	assert.deepEqual(written, ["grok:restore-worktree", "worktree", "grok/topic"]);
	api.stopSession("gone");
	assert.deepEqual(written, ["grok:stop-session", "gone"]);
	handlers.get("grok:stop-session")({}, "gone");
	assert.equal(host.stopped, "gone");
	api.forgetSession("moved");
	assert.deepEqual(written, ["grok:forget-session", "moved"]);
	handlers.get("grok:forget-session")({}, "moved");
	assert.equal(host.forgotten, "moved");
	const branchRequest = { uiSessionId: "first", agentSessionId: "native", index: 1, text: "Earlier prompt" };
	const rewindRequest = { ...branchRequest, rewindMode: "all", force: true, seen: ["edited.txt"] };
	api.rewind(rewindRequest);
	assert.deepEqual(written, ["grok:rewind", rewindRequest]);
	assert.equal(handlers.get("grok:rewind")(first, rewindRequest).done, true);
	assert.equal(host.rewound, rewindRequest);
	api.fork(branchRequest);
	assert.deepEqual(written, ["grok:fork", branchRequest]);
	assert.equal(handlers.get("grok:fork")(first, branchRequest).agentSessionId, "forked-session");
	assert.equal(host.forked, branchRequest);
	api.steer("first", "New direction");
	assert.deepEqual(written, ["grok:steer", "first", "New direction"]);

	host.turns.clear();
	const owner = { sender: windows[2].webContents };
	assert.equal((await handlers.get("grok:send")(owner, { uiSessionId: "third" })).ok, true);
	const before = host.decisions.length;
	assert.equal(handlers.get("grok:answer-question")(second, { uiSessionId: "third", toolId: "q" }).ok, false);
	assert.equal(handlers.get("grok:answer-plan")(second, { uiSessionId: "third", toolId: "p" }).ok, false);
	assert.equal(host.decisions.length, before, "another window cannot answer");
	assert.equal(handlers.get("grok:answer-question")(owner, { uiSessionId: "third", toolId: "q" }).ok, true);
	assert.equal(handlers.get("grok:answer-plan")(owner, { uiSessionId: "third", toolId: "p" }).ok, true);
	assert.equal(host.decisions.length, before + 2);

	const guardedTerminal = handlers.get("grok:terminal-open")(owner, { cwd: root }).id;
	const closedBeforeUnload = terminals.closed.length;
	let allowed = 0;
	const unload = () => windows[2].webContents.emit("will-prevent-unload", { preventDefault: () => { allowed += 1; } });
	const settle = async () => { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } };
	dialogChoice = 1;
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).ok, true);
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).error, "An update is already running.");
	app.emit("before-quit");
	windows[2].emit("close");
	unload();
	await settle();
	assert.equal(dialogs.at(-1).message, "Some text is not saved or sent yet.");
	assert.equal(dialogs.at(-1).detail, "Keep the window open to finish saving or to send the queued message. If it closes now, that text is lost.");
	assert.equal(allowed, 0, "Keep window open keeps the close blocked");
	assert.equal(windows[2].closes, undefined);
	assert.equal(terminals.closed.length, closedBeforeUnload, "a canceled close keeps the window's terminals");
	assert.equal(terminals.closeAllCalls, 0, "a canceled quit leaves terminals running");
	assert.equal(vm.runInContext("pendingUpdate", mainContext), null, "Keep window open cancels the pending update too");
	dialogChoice = 0;
	windows[2].emit("close");
	unload();
	unload();
	assert.equal(dialogs.length, 2, "a second close while the question is open asks nothing new");
	assert.equal(allowed, 0, "the unload waits for the answer");
	await settle();
	assert.equal(windows[2].closes, 1, "Close anyway closes the window again");
	unload();
	assert.equal(allowed, 1, "and lets that close through");
	windows[2].webContents.emit("did-finish-load");
	unload();
	await settle();
	assert.equal(windows[2].reloads, 1, "Close anyway during a reload reloads instead of closing");
	assert.equal(windows[2].closes, 1);
	windows[2].webContents.emit("did-navigate");
	assert.equal(terminals.closed.at(-1), guardedTerminal);
	assert.equal(terminals.closeAllCalls, 0, "owner cleanup never closes every window's terminals");
	const about = appMenu.find((item) => item.label === "Help").submenu.find((item) => item.label === "About Codewomplers Grok Desktop");
	dialogChoice = 1;
	written = null;
	about.click({}, windows[0]);
	await settle();
	assert.equal(dialogs.at(-1).title, "About Codewomplers Grok Desktop");
	assert.equal(written, null, "Close copies nothing");
	dialogChoice = 0;
	about.click({}, windows[0]);
	await settle();
	assert.deepEqual(written, ["clipboard", app.getVersion()], "Copy version copies after the answer");
	const updateMenu = appMenu.find((item) => item.label === "Help").submenu.find((item) => item.label === "Check for Updates…");
	for (const [result, message] of [
		[{ ok: true, available: false, reason: "up-to-date" }, "You have the latest version (0.1.0)."],
		[{ ok: true, available: false, reason: "no-releases" }, "No releases were found on this copy's origin."],
		[{ ok: true, available: false, reason: "not-checkout" }, "This copy isn't a git checkout of the app."],
		[{ ok: false }, "The update check couldn't reach this copy's origin."],
	]) {
		updateCheckResult = result;
		await updateMenu.click({}, windows[0]);
		assert.equal(dialogs.at(-1).message, message);
		assert.equal(updateChecks.at(-1)[2].force, true, "the Help check always bypasses the cache");
		if (result.reason !== "up-to-date") { assert.match(dialogs.at(-1).detail, /git pull, npm install and npm run desktop/); }
	}
	updateCheckResult = { ok: true, available: true, current: "0.1.0", latest: "0.2.0", tag: "v0.2.0" };
	const updateEvents = [];
	windows[0].webContents.send = (...args) => updateEvents.push(args);
	dialogChoice = 1;
	await updateMenu.click({}, windows[0]);
	assert.equal(updateEvents.length, 0, "Later leaves the update dialog closed");
	dialogChoice = 0;
	await updateMenu.click({}, windows[0]);
	assert.equal(dialogs.at(-1).message, "Version 0.2.0 is available");
	assert.deepEqual(Array.from(dialogs.at(-1).buttons), ["Update…", "Later"]);
	assert.equal(updateEvents.at(-1)[0], "grok:event");
	assert.deepEqual({ ...updateEvents.at(-1)[1] }, { type: "update-open", current: "0.1.0", latest: "0.2.0", tag: "v0.2.0" });

	const contents = new EventEmitter();
	contents.setWindowOpenHandler = () => {};
	app.emit("web-contents-created", {}, contents);
	let blocked = 0;
	contents.emit("will-attach-webview", { preventDefault: () => { blocked += 1; } }, {}, { src: "file:///C:/secret.txt", partition: "temp:grok-1" });
	assert.equal(blocked, 1);
	assert.equal(partitions.size, 0);
	contents.emit("will-attach-webview", { preventDefault: () => { blocked += 1; } }, {}, { src: "https://example.com/", partition: "temp:grok-1" });
	assert.equal(blocked, 1);
	const guest = partitions.get("temp:grok-1");
	for (const permission of ["openExternal", "media", "notifications", "geolocation", "display-capture", "clipboard-read"]) {
		let granted;
		guest.request(null, permission, (value) => { granted = value; }, {});
		assert.equal(granted, false, permission);
		assert.equal(guest.check(null, permission), false, permission);
	}
	let fullscreen;
	guest.request(null, "fullscreen", (value) => { fullscreen = value; }, {});
	assert.equal(fullscreen, true);
	assert.equal(guest.check(null, "clipboard-sanitized-write"), true);

	const page = windows[0].webContents;
	const replaced = [];
	const added = [];
	page.replaceMisspelling = (word) => replaced.push(word);
	page.session = { addWordToSpellCheckerDictionary: (word) => added.push(word) };
	page.setWindowOpenHandler = () => {};
	app.emit("web-contents-created", {}, page);
	const menuFor = (params) => {
		const before = popups.length;
		page.emit("context-menu", {}, params);
		return popups.length > before ? popups.at(-1) : null;
	};
	const labels = (menu) => Array.from(menu.template, (item) => item.label || item.role || item.type);
	assert.equal(menuFor({ isEditable: false, selectionText: "", editFlags: {} }), null, "no menu where there is nothing to do");
	const editMenu = menuFor({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } });
	assert.deepEqual(labels(editMenu), ["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
	assert.equal(editMenu.template.find((item) => item.role === "cut").enabled, false, "Cut is greyed out with no selection");
	assert.equal(editMenu.template.find((item) => item.role === "paste").enabled, true);
	assert.equal(editMenu.options.window, windows[0], "the menu opens on its own window");
	const spellMenu = menuFor({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tea"], editFlags: {} });
	assert.deepEqual(labels(spellMenu).slice(0, 4), ["the", "tea", "Add to dictionary", "separator"]);
	spellMenu.template[0].click();
	spellMenu.template[2].click();
	assert.deepEqual([replaced, added], [["the"], ["teh"]], "a suggestion replaces the word; Add to dictionary saves it");
	assert.equal(menuFor({ isEditable: true, misspelledWord: "zzq", dictionarySuggestions: [], editFlags: {} }).template[0].enabled, false);
	const linkMenu = menuFor({ isEditable: false, selectionText: "", linkURL: "https://x.ai/", editFlags: {} });
	assert.deepEqual(labels(linkMenu), ["Open link in browser", "Copy link"]);
	linkMenu.template[1].click();
	assert.deepEqual(written, ["clipboard", "https://x.ai/"]);
	assert.equal(menuFor({ isEditable: false, selectionText: "", linkURL: "file:///C:/secret.txt", editFlags: {} }), null, "only web links get link items");
	assert.deepEqual(labels(menuFor({ isEditable: false, selectionText: "some text", editFlags: {} })), ["copy"]);
	const guestPage = new EventEmitter();
	guestPage.setWindowOpenHandler = () => {};
	guestPage.hostWebContents = windows[1].webContents;
	app.emit("web-contents-created", {}, guestPage);
	guestPage.emit("context-menu", {}, { isEditable: false, selectionText: "page text", editFlags: {} });
	assert.equal(popups.at(-1).options.window, windows[1], "a Browser pane menu opens on the window that holds the pane");

	windows[0].minimized = true;
	app.emit("second-instance");
	assert.equal(windows[0].minimized, false, "a second launch restores the minimized window");
	assert.equal(windows[0].focused, 1, "and brings it forward");
	shortcuts[path.join(startMenu, "Pinned today.lnk")] = { target: process.execPath, args: "", appUserModelId: "Grok.Code" };
	app.emit("will-quit");
	assert.equal(terminals.closeAllCalls, 1, "a completed quit closes every terminal");
	assert.equal(helperCopies.length, 0, "a later normal quit does not revive a cancelled update");
	assert.deepEqual(shortcutWrites.slice(2).map(({ file }) => path.basename(file)), ["Pinned today.lnk"], "a pin made while the app ran is repaired at quit, and repaired shortcuts are not rewritten");
	updateMarkerLive = true;
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).error, "An update is already running.");
	updateMarkerLive = false;
	updatePrepared = { ok: true, ready: false, reason: "This copy has changes that aren't committed." };
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).error, updatePrepared.reason);
	updatePrepared = { ok: true, ready: true, node: "C:\\Node\\node.exe", from: "1234567" };
	const starts = await Promise.all([handlers.get("grok:update-start")({}, "v0.2.0"), handlers.get("grok:update-start")({}, "v0.2.0")]);
	assert.deepEqual(starts.map((value) => value.ok), [true, false], "two concurrent requests prepare only one update");
	assert.equal(helperCopies.length, 0, "update-start waits for will-quit to launch the helper");
	app.emit("will-quit");
	assert.equal(helperCopies.length, 1);
	assert.equal(helperCopies[0][0], path.join(root, "scripts", "update-helper.cjs"));
	assert.match(path.basename(helperCopies[0][1]), /^grok-code-update-[\w-]+\.cjs$/);
	assert.equal(children.at(-1).command, "C:\\Node\\node.exe");
	assert.equal(children.at(-1).args[0], helperCopies[0][1]);
	const updateInput = JSON.parse(children.at(-1).args[1]);
	assert.deepEqual(updateInput, { appDir: root, tag: "v0.2.0", from: "1234567", fromVersion: "0.1.0", waitPid: process.pid, args: process.argv.slice(1), cwd: process.cwd(), userData: root });
	assert.deepEqual({ ...children.at(-1).options }, { detached: true, windowsHide: true, stdio: "ignore" });
	assert.equal(children.at(-1).child.unreferenced, true);
	children.at(-1).child.emit("error", new Error("Access denied"));
	assert.match(updateResult.message, /couldn't start: Access denied/);
	assert.equal(updateResult.ok, false);
	app.emit("will-quit");
	assert.equal(helperCopies.length, 1, "the pending update is consumed once");
	const windowCount = windows.length;
	const secondCopy = Object.assign(new EventEmitter(), {
		setPath: app.setPath,
		setName: app.setName,
		setAppUserModelId: app.setAppUserModelId,
		getPath: app.getPath,
		whenReady: app.whenReady,
		requestSingleInstanceLock: () => false,
		quitCalls: 0,
		isPackaged: true,
	});
	secondCopy.quit = () => { secondCopy.quitCalls += 1; };
	// The second copy runs as an installed Mac app: started from the Dock with launchd's PATH, it takes PATH from the login shell.
	const macEnv = { ...process.env, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
	const shellRuns = [];
	const childProcess = require("child_process");
	const macChildProcess = { ...childProcess, spawnSync: (command, args, options) => {
		if (command !== "/bin/zsh") { return childProcess.spawnSync(command, args, options); }
		shellRuns.push({ args, options });
		return { stdout: "Last login: today\n__GROK_PATH__\n/opt/homebrew/bin:/usr/bin:/bin\n" };
	} };
	// It quits at once, but it still builds the application menu.
	vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), {
		__dirname: path.join(root, "electron"),
		process: { ...process, platform: "darwin", env: macEnv },
		URL,
		require(name) {
			if (name === "child_process") { return macChildProcess; }
			if (name === "electron") { return { ...electron, app: secondCopy, ipcMain: { handle: () => {}, on: () => {} } }; }
			if (name === "./agent.cjs") { return { AgentHost: TestHost }; }
			if (name === "./updates.cjs") { return updateApi; }
			if (name === "../scripts/update-helper.cjs") { return helperApi; }
			if (name === "./usage.cjs") { return { taskOutput: () => ({ ok: true }), subagentTranscript: () => ({ ok: true }) }; }
			if (name === "./diff.cjs" || name === "./git.cjs" || name === "./files.cjs" || name === "./customize.cjs") { return {}; }
			if (name === "./terminal.cjs") { return { TerminalHost: class { closeAll() {} } }; }
			if (name === "./inbound.cjs") { return require("../electron/inbound.cjs"); }
			return require(name);
		},
	});
	assert.equal(secondCopy.quitCalls, 1, "a second copy quits");
	assert.equal(shellRuns.length, 1, "an installed Mac app asks the login shell for PATH once");
	assert.deepEqual([...shellRuns[0].args], ["-ilc", "echo __GROK_PATH__; /usr/bin/printenv PATH"]);
	assert.equal(shellRuns[0].options.timeout, 5000);
	assert.equal(macEnv.PATH, "/opt/homebrew/bin:/usr/bin:/bin", "and uses it in place of launchd's PATH");
	assert.equal(appMenu[0].role, "appMenu", "macOS gets the application menu first");
	assert.equal(appMenu[1].submenu[0].accelerator, "CmdOrCtrl+Shift+N", "New Window is Cmd+Shift+N on macOS");
	assert.equal(windows.length, windowCount, "and opens no window of its own");
	const openFirstWindow = (saved) => {
		for (const win of windows) { win.destroyed = true; }
		windowState = typeof saved === "string" || saved === undefined ? saved : JSON.stringify(saved);
		mainContext.createWindow();
		return windows.at(-1);
	};
	const dimensions = (win) => [win.options.x, win.options.y, win.options.width, win.options.height];
	const normal = openFirstWindow();
	assert.deepEqual(dimensions(normal), [240, 80, 1440, 920]);
	assert.deepEqual([normal.options.minWidth, normal.options.minHeight], [1100, 560]);
	normal.bounds = { x: 80, y: 90, width: 1200, height: 700 };
	normal.maximized = true;
	normal.emit("close");
	assert.deepEqual(JSON.parse(windowState), { ...normal.bounds, maximized: true }, "close saves normal bounds and maximized state");
	const restored = openFirstWindow(windowState);
	assert.deepEqual(dimensions(restored), [80, 90, 1200, 700]);
	restored.webContents.emit("did-finish-load");
	assert.equal(restored.maximizedWhenShown, true, "the first restored window maximizes before showing");
	for (const saved of ["{broken", { x: 80, y: 90, width: 1000, height: 700 }]) {
		assert.deepEqual(dimensions(openFirstWindow(saved)), [240, 80, 1440, 920], "invalid state uses centered defaults");
	}
	cursorArea = matchingArea = { x: 0, y: 0, width: 1280, height: 672 };
	assert.deepEqual(dimensions(openFirstWindow()), [0, 0, 1280, 672], "default size fits a small work area");
	assert.deepEqual(dimensions(openFirstWindow({ x: 0, y: 0, width: 1600, height: 1000 })), [0, 0, 1280, 672], "oversized saved bounds fit the selected display");
	assert.deepEqual(dimensions(openFirstWindow({ x: 3000, y: -40, width: 1200, height: 600, maximized: true })), [40, 36, 1200, 600], "an offscreen titlebar uses the cursor display");
	assert.equal(windows.at(-1).isMaximized(), false);
	matchingArea = { x: 1920, y: 0, width: 3840, height: 2160 };
	const secondary = openFirstWindow({ x: 2000, y: 50, width: 2000, height: 1100, maximized: true });
	assert.deepEqual(dimensions(secondary), [2000, 50, 2000, 1100]);
	mainContext.createWindow();
	const later = windows.at(-1);
	assert.deepEqual(dimensions(later), [0, 0, 1280, 672], "later windows fit and center on the cursor display, not the saved secondary");
	later.webContents.emit("did-finish-load");
	assert.equal(later.maximizedWhenShown, false, "later windows do not inherit maximized state");
	const originalProcess = mainContext.process;
	const appExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
	mainContext.process = Object.create(originalProcess, { execPath: { value: appExe } });
	const movedPin = path.join(pinnedFolder, "Moved by Windows.lnk");
	const unrelatedPin = path.join(pinnedFolder, "Other moved checkout.lnk");
	shortcuts[movedPin] = { target: appExe.replace("node_modules", "NODE_MODULES.UPDATE-OLD"), args: `"${root}" --build-if-stale`, icon: iconFile, appUserModelId: "Grok.Code" };
	shortcuts[unrelatedPin] = { target: path.join(root, "other-checkout", "node_modules.update-old", "electron", "dist", "electron.exe"), args: "", appUserModelId: "Grok.Code" };
	mainContext.repairShortcuts();
	assert.equal(shortcuts[movedPin].target, appExe, "the next launch repairs a pin Windows followed into node_modules.update-old");
	assert.match(shortcuts[unrelatedPin].target, /other-checkout/, "another checkout's moved pin is left alone");
	mainContext.process = originalProcess;
	const guardRun = async (marker, live) => {
		const notifications = [];
		const timers = [];
		let locks = 0;
		const guarded = Object.assign(new EventEmitter(), { ...app, requestSingleInstanceLock: () => { locks += 1; return true; }, quitCalls: 0 });
		guarded.quit = () => { guarded.quitCalls += 1; };
		const before = { windows: windows.length, dialogs: dialogs.length, builds: viteBuilds.length, children: children.length };
		vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), {
			__dirname: path.join(root, "electron"), process: { ...process, platform: "win32", argv: [...process.argv, "--build-if-stale"] }, URL, Buffer,
			setTimeout(callback, delay) { timers.push({ callback, delay }); },
			require(name) {
				if (name === "electron") { return { ...electron, app: guarded, ipcMain: { handle() {}, on() {} }, Notification: class { constructor(options) { this.options = options; } show() { notifications.push(this.options); } } }; }
				if (name === "../scripts/update-helper.cjs") { return { ...helperApi, readMarker: () => marker, markerLive: async () => live }; }
				return mainContext.require(name);
			},
		});
		for (let i = 0; i < 12; i += 1) { await Promise.resolve(); }
		assert.equal(locks, 0, "the update guard runs before the single-instance lock");
		assert.equal(windows.length, before.windows, "an update guard opens no window");
		assert.equal(dialogs.length, before.dialogs, "an update guard never opens a blocking dialog");
		assert.equal(viteBuilds.length, before.builds, "an update guard never starts a build");
		return { guarded, notifications, timers, before };
	};
	const liveGuard = await guardRun({ pid: 123, pidStart: 456 }, true);
	assert.equal(liveGuard.notifications[0].title, "Codewomplers Grok Desktop is updating");
	assert.equal(liveGuard.timers[0].delay, 1500);
	assert.equal(liveGuard.guarded.quitCalls, 0);
	liveGuard.timers[0].callback();
	assert.equal(liveGuard.guarded.quitCalls, 1, "a live marker only notifies then quits");
	assert.equal(children.length, liveGuard.before.children, "a live marker starts no recover");
	const staleGuard = await guardRun({ pid: 123, pidStart: 456 }, false);
	assert.equal(staleGuard.guarded.quitCalls, 1);
	assert.equal(staleGuard.notifications.length, 0);
	assert.equal(children.length, staleGuard.before.children + 1);
	assert.deepEqual(Array.from(children.at(-1).args), [path.join(root, "scripts", "update-helper.cjs"), "--recover", "--wait", String(process.pid), root]);
	assert.equal(children.at(-1).child.unreferenced, true);
	assert.deepEqual({ ...children.at(-1).options }, { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
	console.log("Main ownership, session bootstrap, folder policy, version bridge, update IPC/dialog/quit/recovery/shortcut, question/plan ownership, close dialog, Browser permission, right-click menu and single-instance checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
