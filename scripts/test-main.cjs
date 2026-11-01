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

class TestWindow extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.webContents = new EventEmitter();
		this.webContents.send = () => {};
		this.webContents.getURL = () => "file:///index.html";
		this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; };
		windows.push(this);
	}
	close() { this.closes = (this.closes || 0) + 1; }
	static getAllWindows() { return windows; }
	static fromWebContents(contents) { return windows.find((win) => win.webContents === contents) || null; }
	isDestroyed() { return false; }
	setIcon() {}
	setAppDetails(details) { this.appDetails = details; }
	show() { this.shown = (this.shown || 0) + 1; }
	isMinimized() { return !!this.minimized; }
	restore() { this.minimized = false; }
	focus() { this.focused = (this.focused || 0) + 1; }
	loadFile(file, options) { this.navigation = { file, options }; return Promise.resolve(); }
	loadURL() { return Promise.resolve(); }
}

class TestHost {
	constructor() {
		host = this;
		this.turns = new Map();
		this.cancelled = [];
		this.decisions = [];
		this.folderUpdates = [];
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
	nativeImage: { createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 640, height: 480 }) }) },
	screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
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
const mainContext = {
	__dirname: path.join(root, "electron"),
	process,
	URL,
	require(name) {
		if (name === "electron") { return electron; }
		if (name === "fs") {
			return {
				...fs,
				existsSync: (file) => file === imageFile || fs.existsSync(file),
				statSync: (file, ...rest) => file === path.join(root, "dist", "index.html") ? { mtimeMs: pageTime } : fs.statSync(file, ...rest),
				readdirSync: (folder, ...rest) => [startMenu, pinnedFolder].includes(folder) ? Object.keys(shortcuts).filter((file) => path.dirname(file) === folder).map((file) => path.basename(file)) : fs.readdirSync(folder, ...rest),
			};
		}
		if (name === "child_process") {
			const real = require("child_process");
			return {
				...real,
				spawnSync(command, args, options) {
					if (!/vite\.js$/.test(args?.[0] ?? "")) { return real.spawnSync(command, args, options); }
					viteBuilds.push({ command, args, options });
					return { status: 0 };
				},
			};
		}
		if (name === "./agent.cjs") { return { AgentHost: TestHost }; }
		if (name === "./git.cjs") { return { prCreate: (...args) => { written = args; return { ok: true }; }, prMergeWhenReady: (...args) => { written = args; return { ok: true }; }, restoreWorktree: (...args) => { written = args; return { ok: true }; } }; }
		if (name === "./diff.cjs" || name === "./usage.cjs") { return {}; }
		if (name === "./customize.cjs") { return { signOut: async () => { grokLogouts += 1; return { ok: true }; } }; }
		if (name === "./terminal.cjs") { return { TerminalHost: TestTerminals }; }
		if (name === "./files.cjs") {
			return { writeText: (...args) => { written = args; return { ok: true }; }, locateFile: (cwd, file) => file === "missing" ? { ok: false, error: "Missing file." } : { ok: true, target: path.join(cwd, file) } };
		}
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
	second.sender.emit("destroyed");
	assert.deepEqual(terminals.closed, [firstTerminal, crashedTerminal, secondTerminal], "destroy closes only the remaining owner's terminals");
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
	});
	assert.equal(api.homeDir, require("node:os").homedir(), "the first session's folder comes from this computer, not a fixed path");
	api.writeFile("folder", "file", "text", "version");
	assert.deepEqual(written, ["grok:write", "folder", "file", "text", "version"]);
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
	assert.deepEqual(shortcutWrites.slice(2).map(({ file }) => path.basename(file)), ["Pinned today.lnk"], "a pin made while the app ran is repaired at quit, and repaired shortcuts are not rewritten");
	const windowCount = windows.length;
	const secondCopy = Object.assign(new EventEmitter(), {
		setPath: app.setPath,
		setName: app.setName,
		setAppUserModelId: app.setAppUserModelId,
		getPath: app.getPath,
		whenReady: app.whenReady,
		requestSingleInstanceLock: () => false,
		quitCalls: 0,
	});
	secondCopy.quit = () => { secondCopy.quitCalls += 1; };
	vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), {
		__dirname: path.join(root, "electron"),
		process,
		URL,
		require(name) {
			if (name === "electron") { return { ...electron, app: secondCopy, ipcMain: { handle: () => {}, on: () => {} } }; }
			if (name === "./agent.cjs") { return { AgentHost: TestHost }; }
			if (name === "./diff.cjs" || name === "./git.cjs" || name === "./usage.cjs" || name === "./files.cjs" || name === "./customize.cjs") { return {}; }
			if (name === "./terminal.cjs") { return { TerminalHost: class { closeAll() {} } }; }
			return require(name);
		},
	});
	assert.equal(secondCopy.quitCalls, 1, "a second copy quits");
	assert.equal(windows.length, windowCount, "and opens no window of its own");
	console.log("Main ownership, session bootstrap, folder policy, version bridge, question/plan ownership, close dialog, Browser permission, right-click menu and single-instance checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
