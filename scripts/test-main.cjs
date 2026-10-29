const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const root = path.resolve(__dirname, "..");
const handlers = new Map();
const windows = [];
let host;
let written;

class TestWindow {
	constructor() {
		this.webContents = new EventEmitter();
		this.webContents.send = () => {};
		this.webContents.getURL = () => "file:///index.html";
		windows.push(this);
	}
	static getAllWindows() { return windows; }
	isDestroyed() { return false; }
	setIcon() {}
	setAppDetails() {}
	show() {}
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
	decide(input) { this.decisions.push(input); return { ok: true }; }
	answerQuestion(input) { this.decisions.push({ question: input }); return { ok: true }; }
	answerPlan(input) { this.decisions.push({ plan: input }); return { ok: true }; }
	setAllowedFolders(input) { this.folderUpdates.push(input); return { ok: true }; }
	kill() {}
}

const app = new EventEmitter();
app.setPath = () => {};
app.setName = () => {};
app.setAppUserModelId = () => {};
app.getPath = () => root;
app.whenReady = () => ({ then: (callback) => callback() });
let dialogChoice = 1;
const partitions = new Map();
const electron = {
	app,
	BrowserWindow: TestWindow,
	ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
	nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
	Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
	powerMonitor: { isOnBatteryPower: () => false },
	powerSaveBlocker: { start: () => 1, stop: () => {} },
	shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve("") },
	dialog: { showMessageBoxSync: () => dialogChoice },
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
vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), {
	__dirname: path.join(root, "electron"),
	process,
	URL,
	require(name) {
		if (name === "electron") { return electron; }
		if (name === "./agent.cjs") { return { AgentHost: TestHost }; }
		if (name === "./diff.cjs" || name === "./git.cjs" || name === "./usage.cjs") { return {}; }
		if (name === "./terminal.cjs") { return { TerminalHost: class { closeAll() {} } }; }
		if (name === "./files.cjs") {
			return { writeText: (...args) => { written = args; return { ok: true }; } };
		}
		return require(name);
	},
});

async function main() {
	handlers.get("grok:new-window")();
	assert.equal(windows[1].navigation.options, undefined);
	assert.equal(handlers.get("grok:new-window")({}, "chosen-session").ok, true);
	assert.equal(windows[2].navigation.options.query.session, "chosen-session");
	assert.equal(handlers.get("grok:new-window")({}, { session: "invalid" }).ok, false);
	assert.equal(windows.length, 3);
	const first = { sender: windows[0].webContents };
	const second = { sender: windows[1].webContents };
	assert.equal((await handlers.get("grok:send")(first, { uiSessionId: "first" })).ok, true);
	assert.equal((await handlers.get("grok:send")(second, { uiSessionId: "first" })).ok, false);
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
			ipcRenderer: { invoke: (...args) => { written = args; } },
		}),
		process: { argv: ["electron", "--grok-default-folder=C:\\Users\\me\\Documents"] },
	});
	assert.equal(api.defaultFolder, "C:\\Users\\me\\Documents", "new sessions start in the Documents folder main passes in");
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

	let allowed = 0;
	dialogChoice = 1;
	windows[2].webContents.emit("will-prevent-unload", { preventDefault: () => { allowed += 1; } });
	assert.equal(allowed, 0, "Keep window open keeps the close blocked");
	dialogChoice = 0;
	windows[2].webContents.emit("will-prevent-unload", { preventDefault: () => { allowed += 1; } });
	assert.equal(allowed, 1, "Close anyway lets the window close");

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
	console.log("Main ownership, session bootstrap, folder policy, version bridge, question/plan ownership, close dialog, and Browser permission checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
