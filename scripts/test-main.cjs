const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
for (const [platform, env, missingPackage] of [
	["linux", {}, false],
	["linux", { DISPLAY: ":99", ELECTRON_SKIP_BINARY_DOWNLOAD: "1" }, true],
	["win32", {}, false],
]) {
	const messages = [];
	vm.compileFunction(fs.readFileSync(path.join(__dirname, "test-diagram-security.cjs"), "utf8"), [], {
		parsingContext: vm.createContext({
			require(name) {
				if (name === "electron") {
					if (missingPackage) { throw new Error("Electron failed to install"); }
					return "/missing/electron";
				}
				if (name === "node:fs") { return { existsSync: () => false }; }
				return require(name);
			},
			__dirname,
			__filename: path.join(__dirname, "test-diagram-security.cjs"),
			process: { platform, env, versions: {} },
			console: { log: (message) => messages.push(message) },
		}),
	})();
	assert.equal(messages.length, 1, "unavailable Electron environments skip before writing or building");
	assert.match(messages[0], /^SKIP diagram security:.*(?:display|binary)/);
}
const imageFile = path.join(root, "test-image.png");
const pageFile = path.join(root, "dist", "index.html");
const sandboxGitFile = path.join(root, "sandbox-git.json");
let sandboxGitSaved;
let sandboxGitPending;
let sandboxGitSnapshot;
let onPrCreate;
let onCommitFiles;
let onRemoveWorktree;
const handlers = new Map();
const windows = [];
const browserCalls = [];
const changeReads = new Map();
const browserAgentApi = {
	server: async () => ({ type: "http", name: "browser_pane", url: "http://127.0.0.1:12345/mcp", headers: [] }),
	setTabs: (...args) => { browserCalls.push(["tabs", ...args]); return { ok: true }; },
	stop: (id) => { browserCalls.push(["stop", id]); return { ok: true }; },
	resume: (id) => { browserCalls.push(["resume", id]); return { ok: true }; },
	guestSession() {},
	close() {},
};
let host;
let terminals;
let written;
const savedDataReads = [];
let exportDestination = "";
let grokLogouts = 0;
const signInCalls = [];
let signInProbe = async () => ({ ok: true, signIn: "none" });
let signInCheck = { ok: true };
let signInSave = { ok: true };
let signInRemove = { ok: true };
let signInState = { mode: "grok", hasKey: false, keyReadable: false, keyring: true };
let logoutResult = { ok: true };
let installedSignIn;
const signInApi = {
	check() { signInCalls.push("check"); return signInCheck; },
	save() { signInCalls.push("save"); return signInSave; },
	removeKey() { signInCalls.push("remove"); return signInRemove; },
	status() { return signInState; },
};
const signInAgent = {
	setSignIn(provider) { installedSignIn = provider; },
	probeGrok() { signInCalls.push("probe"); return signInProbe(); },
};
const signInFactory = { createSignIn: () => signInApi, validKey: require("../electron/sign-in.cjs").validKey };
const botCalls = [];
const botMethods = ["status", "signIn", "cancelSignIn", "signOut", "start", "close", "retry", "history", "send", "stop", "answer", "openFile"];
const botFactory = { createGrokBot: () => Object.fromEntries(botMethods.map((name) => [name, (...args) => { botCalls.push([name, ...args]); return { ok: true }; }])) };
const botWindow = {
	held: false, releases: 0, closed: 0, hides: [], finish: null,
	open() { return { ok: true }; },
	place() {},
	hide(win) { this.hides.push(win); },
	holding() { return this.held; },
	holds() { return this.held; },
	wait() {
		return new Promise((resolve) => {
			this.finish = () => {
				this.held = false;
				resolve();
			};
		});
	},
	release() {
		this.releases++;
		return this.wait();
	},
	close() {
		this.closed++;
		return this.wait();
	},
};
const botWindowFactory = { createGrokBotWindow: () => botWindow };
let cloudHost;
let cloudKey = "";
let cloudKeyName = "";
let cloudModelRequests = 0;
let cloudRepos = { ok: true, items: [{ url: "https://github.com/sample-org/sample-repo" }] };
let cloudRemote = "ssh://git@github.com/Sample-Org/Sample-Repo.git";
const cloudApi = {
	CloudHost: class {
		constructor(emit) { cloudHost = this; this.emit = emit; this.turns = new Map(); this.stopped = []; }
		turnOf(id) { return this.turns.get(id); }
		send({ uiSessionId, turnId }) {
			this.turns.set(uiSessionId, turnId);
			this.emit({ uiSessionId, turnId, type: "chunk", text: "Cloud reply" });
			return { ok: true };
		}
		resume(input) { return this.send(input); }
		cancel(id) {
			const turnId = this.turns.get(id);
			this.turns.delete(id);
			this.emit({ uiSessionId: id, turnId, type: "done", stopReason: "cancelled" });
			return { ok: true };
		}
		stop(id) { this.stopped.push(id); this.turns.delete(id); }
	},
	createCursorKey: () => ({
		key: () => cloudKey,
		status: () => ({ hasKey: !!cloudKey, keyReadable: !!cloudKey, keyring: true, name: cloudKeyName }),
		save: (key, name) => { cloudKey = key; cloudKeyName = name; return { ok: true }; },
		remove: () => { cloudKey = ""; cloudKeyName = ""; return { ok: true }; },
	}),
	createCursorApi: ({ getKey }) => ({
		me: async () => getKey() === "test-not-a-key" ? { ok: true, apiKeyName: "Sample key" } : { ok: false, error: "Cursor rejected the key." },
		repositories: async () => cloudRepos,
		models: async () => { cloudModelRequests += 1; return { ok: true, items: [{ id: "default" }] }; },
	}),
};

async function cloudGit(args) {
	const output = {
		"rev-parse --abbrev-ref @{u}": "fork/topic/part\n",
		"remote get-url -- fork": `${cloudRemote}\n`,
		"rev-list --left-right --count @{u}...HEAD": "3\t2\n",
		"--no-optional-locks status --porcelain --ignore-submodules=dirty": "?? new-file\n",
	};
	return Object.hasOwn(output, args.join(" ")) ? { code: 0, out: output[args.join(" ")] } : { code: 1, out: "" };
}
let readinessChecks = 0;
const readinessCalls = [];
let grokUpdates = 0;
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
const expectedFile = path.join(root, "update-expected.json");
// The store's file and folders stay in memory, so no test writes into the checkout.
const routinesFile = path.join(root, "routines.json");
const routineFolderRoot = path.join(root, "routines");
let routineSaved;
let routineWrites = 0;
const routineFolders = [];
let focusedWindow = null;
const installedFolder = path.join(root, "installed-copy");
const installedCommands = [];
const updateRemovals = [];
let updateExpected;
const helperApi = {
	readMarker: () => updateMarker,
	markerLive: async () => updateMarkerLive,
	findNode: async () => "C:\\Node\\node.exe",
	writeAtomic: (file, value) => {
		if (file === routinesFile) {
			routineSaved = JSON.stringify(value);
			routineWrites += 1;
			return;
		}
		if (file === expectedFile) {
			updateExpected = value;
			return;
		}
		assert.equal(file, resultFile);
		updateResult = value;
	},
};
const updateApi = {
	checkForUpdate: async (...args) => { updateChecks.push(args); return updateCheckResult; },
	updatePrepare: async (...args) => { updatePrepares.push(args); return updatePrepared; },
	updateSteps: () => "manual steps",
	updateInstructions: () => "To update, follow the manual steps.",
	installedRoot: () => installedFolder,
	installedUpdateCommand: (update, options) => {
		installedCommands.push([update, options]);
		return { program: "update-program", args: ["--update"] };
	},
	removeUpdateFiles: (options) => { updateRemovals.push(options); },
};

class TestWindow extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.id = windows.length + 1;
		this.webContents = new EventEmitter();
		this.webContents.isDestroyed = () => !!(this.destroyed || this.webContents.gone);
		this.webContents.isCrashed = () => false;
		this.webContents.executeJavaScript = async () => {};
		this.webContents.send = () => {
			if (this.webContents.isDestroyed()) { throw new TypeError("Object has been destroyed"); }
		};
		this.webContents.getURL = () => "file:///index.html";
		this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; };
		windows.push(this);
	}
	close() { this.closes = (this.closes || 0) + 1; }
	destroy() {
		this.destroyed = true;
		this.webContents.emit("destroyed");
		this.emit("closed");
	}
	getParentWindow() { return this.options?.parent ?? null; }
	static getAllWindows() { return windows.filter((win) => !win.isDestroyed()); }
	static fromWebContents(contents) { return windows.find((win) => win.webContents === contents) || null; }
	static getFocusedWindow() { return focusedWindow; }
	isDestroyed() { return !!this.destroyed; }
	setIcon() {}
	setAppDetails(details) { this.appDetails = details; }
	show() { this.shown = (this.shown || 0) + 1; this.maximizedWhenShown = this.isMaximized(); }
	isVisible() { return !!this.shown; }
	getNormalBounds() { return this.bounds || { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height }; }
	setBounds(bounds) { this.bounds = bounds; }
	isMaximized() { return !!this.maximized; }
	maximize() { this.maximized = true; }
	setProgressBar(value, options) { this.progress = { value, options }; }
	setOverlayIcon(image, text) { this.overlay = { image, text }; }
	isMinimized() { return !!this.minimized; }
	minimize() { this.minimized = true; }
	restore() { this.minimized = false; this.emit("restore"); }
	focus() { this.focused = (this.focused || 0) + 1; }
	loadFile(file, options) { this.navigation = { file, options }; return Promise.resolve(); }
	loadURL(url) { this.navigation = { url }; return Promise.resolve(); }
}

class TestHost {
	constructor(emit) {
		host = this;
		this.emit = emit;
		this.turns = new Map();
		this.retainedSteers = new Set();
		this.cancelled = [];
		this.decisions = [];
		this.folderUpdates = [];
		this.steered = [];
		this.procs = new Map();
	}
	prompt(input) {
		if (this.turns.has(input.uiSessionId)) { return Promise.resolve({ ok: false }); }
		this.turns.set(input.uiSessionId, { uiSessionId: input.uiSessionId, turnId: input.turnId, cwd: input.cwd });
		return Promise.resolve({ ok: true });
	}
	cancel(id) {
		if (this.turns.has(id) || this.retainedSteers.has(id)) { this.cancelled.push(id); }
		this.retainedSteers.delete(id);
	}
	stopSession(id) { this.stopped = id; }
	stopFolder(folder) { this.stoppedFolder = folder; }
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
	signInChanged() { signInCalls.push("changed"); }
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
	write() { return { ok: true }; }
	input() { return { ok: true }; }
	resize() { return { ok: true }; }
	interrupt() { return { ok: true }; }
	close(id) { this.closed.push(id); this.emit({ type: "terminal-exit", id }); }
	closeAll() { this.closeAllCalls += 1; }
}

const app = new EventEmitter();
const windowsDockBadges = [];
app.dock = { setBadge: (badge) => windowsDockBadges.push(badge) };
app.commandLine = { switches: [], appendSwitch(...args) { this.switches.push(args); } };
app.setPath = () => {};
app.getVersion = () => "0.1.0";
let accessibilitySupport = false;
app.isAccessibilitySupportEnabled = () => accessibilitySupport;
app.isPackaged = false;
app.setName = () => {};
app.setAppUserModelId = () => {};
app.getPath = () => root;
app.whenReady = () => ({ then: (callback) => callback() });
app.requestSingleInstanceLock = () => true;
app.quit = () => { app.quitCalls = (app.quitCalls || 0) + 1; };
let dialogChoice = 1;
let dialogChecked = false;
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
		openPath: (target) => { written = target; return Promise.resolve(""); },
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
			return Promise.resolve({ response: dialogChoice, checkboxChecked: dialogChecked });
		},
	},
	session: {
		fromPartition(name) {
			if (partitions.has(name)) { return partitions.get(name); }
			const handlersFor = {
				setPermissionRequestHandler(handler) { this.request = handler; },
				setPermissionCheckHandler(handler) { this.check = handler; },
				webRequest: {
					errors: [], completed: [],
					onErrorOccurred(filter, listener) { this.errors.push({ filter, listener }); },
					onCompleted(filter, listener) { this.completed.push({ filter, listener }); },
				},
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
const mainTimeouts = new Set();
// These checks cover the Windows behavior (shortcut repair, Ctrl+R) on every host; checkMacMenu loads a macOS copy.
const mainContext = {
	__dirname: path.join(root, "electron"),
	process: Object.create(process, { platform: { value: "win32" }, versions: { value: { ...process.versions, electron: "45.0.0" } } }),
	URL,
	Buffer,
	AbortController,
	setTimeout(callback, delay) { const timer = { callback, delay }; mainTimeouts.add(timer); return timer; },
	clearTimeout(timer) { mainTimeouts.delete(timer); },
	setInterval: () => 1,
	clearInterval() {},
	require(name) {
		if (name === "electron") { return electron; }
		if (name === "fs") {
			return {
				...fs,
				readFileSync(file, ...rest) {
					if (file === sandboxGitFile) {
						if (sandboxGitSaved === undefined) { throw new Error("No sandbox Git snapshots."); }
						return sandboxGitSaved;
					}
					if (file === routinesFile) {
						if (routineSaved === undefined) { throw Object.assign(new Error("No routines."), { code: "ENOENT" }); }
						return routineSaved;
					}
					if (file === resultFile) { if (!updateResult) { throw new Error("No update result."); } return JSON.stringify(updateResult); }
					if (file === expectedFile) { if (!updateExpected) { throw new Error("No expected update."); } return JSON.stringify(updateExpected); }
					if (file !== windowStateFile) { return fs.readFileSync(file, ...rest); }
					if (windowState === undefined) { throw new Error("No saved window state."); }
					return windowState;
				},
				writeFileSync(file, text, ...rest) {
					if (file === `${sandboxGitFile}.tmp`) { sandboxGitPending = text; }
					else if (file === windowStateFile) { windowState = text; } else { fs.writeFileSync(file, text, ...rest); }
				},
				renameSync(from, to) {
					if (from === `${sandboxGitFile}.tmp` && to === sandboxGitFile) { sandboxGitSaved = sandboxGitPending; }
					else { fs.renameSync(from, to); }
				},
				copyFileSync: (...args) => helperCopies.push(args),
				mkdirSync(folder, ...rest) {
					if (folder.startsWith(routineFolderRoot)) {
						routineFolders.push(folder);
						return;
					}
					fs.mkdirSync(folder, ...rest);
				},
				unlinkSync(file) {
					if (file === resultFile) {
						updateResult = undefined;
					} else if (file === expectedFile) {
						updateExpected = undefined;
					} else {
						throw new Error(`Unexpected unlink ${file}`);
					}
				},
				rmSync(file, options) {
					if (file === expectedFile) {
						updateExpected = undefined;
						return;
					}
					fs.rmSync(file, options);
				},
				existsSync: (file) => file === imageFile || file === pageFile || fs.existsSync(file),
				statSync: (file, ...rest) => file === pageFile ? { mtimeMs: pageTime } : fs.statSync(file, ...rest),
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
		if (name === "./agent.cjs") { return { AgentHost: TestHost, grokHome: () => path.join(root, "no-such-grok"), ...signInAgent }; }
		if (name === "./sign-in.cjs") { return signInFactory; }
		if (name === "./cloud.cjs") { return cloudApi; }
		if (name === "./grokbot.cjs") { return botFactory; }
		if (name === "./grokbot-window.cjs") { return botWindowFactory; }
		if (name === "./redact.cjs") { return require("../electron/redact.cjs"); }
		if (name === "./browser-agent.cjs") { return { createBrowserAgent: () => browserAgentApi }; }
		if (name === "./loops.cjs") { return require("../electron/loops.cjs"); }
		if (name === "./sandbox.cjs") { return { ...require("../electron/sandbox.cjs"), sessionRoots: async () => [] }; }
		if (name === "./updates.cjs") { return updateApi; }
		if (name === "../scripts/update-helper.cjs") { return helperApi; }
		if (name === "./git.cjs") {
			return {
				git: cloudGit,
				useBundledGit() {},
				readChanges: (request, signal) => new Promise((finish) => changeReads.set(request.id, { signal, finish })),
				prStatus: (...args) => { written = args; return { ok: true }; },
				prCreate: (...args) => { written = args; onPrCreate?.(args[1]); return { ok: true }; },
				commitFiles: (...args) => { written = args; onCommitFiles?.(args[1]); return { ok: true }; },
				addWorktree: (...args) => { written = args; return { ok: true }; },
				gitSecuritySnapshot: (...args) => sandboxGitSnapshot(...args),
				prMergeWhenReady: (...args) => { written = args; return { ok: true }; },
				restoreWorktree: (folder, branch, confirm) => {
					if (!confirm) { written = [folder, branch]; return { ok: true }; }
					return confirm(path.resolve(folder, "../../.."), (hooks) => { written = [folder, branch, hooks]; return { ok: true }; });
				},
				removeWorktree: (...args) => { written = args; return onRemoveWorktree?.(...args) ?? { ok: true }; },
			};
		}
		if (name === "./usage.cjs") { return { rootOf: (_id, roots) => roots[0], taskOutput: (...args) => { written = args; return { ok: true, text: "task output" }; }, subagentTranscript: (...args) => { written = args; return { ok: true, messages: [] }; } }; }
		if (name === "./diff.cjs") {
			return {
				localFilterOff: async () => [],
				revertFile: async (folder, file, confirmFilter) => {
					written = [folder, file];
					return { ok: file !== "filtered" || !confirmFilter || await confirmFilter() };
				},
				revertHunk: (...args) => { written = args; return { ok: true }; },
			};
		}
		if (name === "./session-data.cjs") { return { readSessionData: async (request) => {
			savedDataReads.push(request);
			if (request.action === "output") { written = [request.file, undefined]; return { ok: true, text: "task output" }; }
			if (request.action === "transcript") { written = [request.sessionId, request.roots[0]]; return { ok: true, messages: [] }; }
			if (request.action === "loops") { return { ok: true, loops: [] }; }
			if (request.action === "spend") { return { ok: true, usd: 1 }; }
			if (request.action === "export") { return { ok: true, path: request.file }; }
			return { ok: true, parts: {} };
		} }; }
		if (name === "./customize.cjs") { return { signOut: async () => { grokLogouts += 1; signInCalls.push("logout"); return logoutResult; }, readiness: async (...args) => { readinessChecks += 1; readinessCalls.push(args); return { grok: { ok: true, signedIn: true } }; }, updateGrok: async () => { grokUpdates += 1; return { ok: true }; } }; }
		if (name === "./terminal.cjs") { return { TerminalHost: TestTerminals }; }
		if (name === "./files.cjs") {
			return { DEFAULT_APP_EXT: require("../electron/files.cjs").DEFAULT_APP_EXT, readImage: (...args) => { written = args; return { ok: true, dataUrl: "data:image/png;base64,AA==" }; }, writeText: (...args) => { written = args; return { ok: true }; }, locateFile: (cwd, file) => file === "missing" ? { ok: false, error: "Missing file." } : { ok: true, target: path.join(cwd, file === "disguised.pdf" ? "tool.exe" : file) } };
		}
		if (name === "./export.cjs") { return { chooseExport: async (request) => exportDestination ? request.write({ sessionId: request.sessionId, file: exportDestination }) : { ok: true, cancelled: true } }; }
		if (name === "./inbound.cjs") { return require("../electron/inbound.cjs"); }
		if (name === "./cold-chats.cjs") { return require("../electron/cold-chats.cjs"); }
		if (name === "./pasted-images.cjs") { return require("../electron/pasted-images.cjs"); }
		if (name === "./startup.cjs") { return require("../electron/startup.cjs"); }
		if (name === "./routines.cjs") { return require("../electron/routines.cjs"); }
		return require(name);
	},
};
vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), mainContext);
process.argv = launchArgs;

async function checkSignInIpc(event, otherWindow, running) {
	assert.equal(installedSignIn, signInApi, "the main process installs its sign-in provider");
	const save = handlers.get("grok:sign-in-save");
	const remove = handlers.get("grok:sign-in-remove-key");
	const logout = handlers.get("grok:sign-out");
	const status = handlers.get("grok:sign-in-status");
	const send = handlers.get("grok:send");
	const input = { mode: "key" };
	const confirmed = { signOutConfirmed: true };
	const assertCalls = (...expected) => assert.deepEqual(signInCalls.splice(0), expected);
	signInCalls.length = 0;
	host.turns.set("first", running);
	assert.match((await save(event, input)).error, /still answering.*save/);
	assert.match((await remove(event)).error, /still answering.*remove the key/);
	assertCalls();
	host.turns.set("first", { ...running, finished: true });

	signInCheck = { ok: false, error: "Invalid choice." };
	assert.equal((await save(event, input, confirmed)).error, "Invalid choice.");
	assertCalls("check");
	signInCheck = { ok: true };
	signInProbe = async () => ({ ok: false, error: "Probe detail should stay in main." });
	assert.equal((await save(event, input, confirmed)).error, "Grok couldn't be checked, so nothing was saved. Try again.");
	assertCalls("check", "probe");
	signInProbe = async () => ({ ok: true, signIn: "saved" });
	assert.deepEqual({ ...await save(event, input) }, { ok: false, needsSignOut: true });
	assertCalls("check", "probe");

	const fakeKey = `xai-${"A".repeat(80)}`;
	logoutResult = { ok: false, error: `Unable to sign out: ${fakeKey}` };
	const refused = await save(event, input, confirmed);
	assert.ok(!JSON.stringify(refused).includes(fakeKey), "failed logout never returns the key");
	assert.deepEqual({ ...refused }, { ok: false, error: "Unable to sign out: [redacted]" });
	assertCalls("check", "probe", "logout");
	logoutResult = { ok: true };
	signInSave = { ok: false, error: "Profile write failed." };
	assert.equal((await save(event, input, confirmed)).error, "Profile write failed.");
	assertCalls("check", "probe", "logout", "save", "changed");
	signInSave = { ok: true };

	signInState = { mode: "key", hasKey: true, keyReadable: true, keyring: true };
	assert.deepEqual(status(), signInState);
	assert.match((await logout()).error, /API-key mode is on/);
	assertCalls();
	let finishSnapshot;
	sandboxGitSnapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
	const sandboxSend = { uiSessionId: "sign-in-snapshot", cwd: path.join(root, "sign-in-repo"), sandbox: { option: "profile" } };
	const capturing = send(otherWindow, sandboxSend);
	let finishProbe;
	signInProbe = () => new Promise((resolve) => { finishProbe = resolve; });
	const saving = save(event, input);
	assertCalls("check", "probe");
	const direct = await send(otherWindow, { uiSessionId: "sign-in-direct" });
	finishSnapshot({ ok: true, config: "", hooks: "" });
	const sandbox = await capturing;
	assert.match(direct.error, /sign-in is changing/, "a native send is refused during a sign-in change");
	assert.match(sandbox.error, /sign-in is changing/, "a native send checks again after the sandbox snapshot");
	assert.equal(host.turns.has("sign-in-direct"), false);
	assert.equal(host.turns.has(sandboxSend.uiSessionId), false);
	assert.match((await remove(event)).error, /already changing/);
	assert.match((await save(event, { mode: "grok" })).error, /already changing/);
	assert.match((await logout()).error, /already changing/);
	assertCalls();
	finishProbe({ ok: true, signIn: "key" });
	assert.equal((await saving).ok, true);
	assertCalls("save", "changed");
	assert.equal((await send(otherWindow, sandboxSend)).ok, true, "sending works once the sign-in change finishes");
	host.turns.delete(sandboxSend.uiSessionId);
	sandboxGitSnapshot = undefined;
	signInRemove = { ok: false, error: "Removal failed." };
	assert.equal((await remove(event)).ok, false);
	assertCalls("remove");
	signInRemove = { ok: true };
	assert.equal((await remove(event)).ok, true);
	assertCalls("remove", "changed");
	signInState = { mode: "grok", hasKey: false, keyReadable: false, keyring: true };
	console.log("PASS sign-in IPC: busy turns, fresh probes, confirmed logout, partial failure invalidation and cross-window send exclusion");
}

async function checkCloudIpc(first, second) {
	const [status, save, remove, setup, send, resume, cancel] = ["key-status", "key-save", "key-remove", "setup", "send", "resume", "cancel"].map((name) => handlers.get(`grok:cloud-${name}`));
	assert.ok([status, save, remove, setup, send, resume, cancel].every((handler) => typeof handler === "function"));
	const originalSends = [first.sender.send, second.sender.send];
	const sent = [[], []];
	first.sender.send = (_channel, event) => sent[0].push(event);
	second.sender.send = (_channel, event) => sent[1].push(event);
	try {
		assert.equal((await save(first, "not-accepted")).ok, false);
		assert.equal(status().hasKey, false);
		assert.equal((await save(first, "test-not-a-key")).ok, true);
		assert.deepEqual(status(), { hasKey: true, keyReadable: true, keyring: true, name: "Sample key" });
		assert.equal(sent[0].at(-1).type, "cloud-key-changed");
		assert.equal(sent[1].at(-1).type, "cloud-key-changed");
		const found = await setup(first, root);
		assert.equal(found.repoUrl, "https://github.com/Sample-Org/Sample-Repo");
		assert.equal(found.ref, "topic/part");
		assert.equal(found.upstream, "fork/topic/part");
		assert.deepEqual([found.behind, found.ahead, found.dirty, found.reachable], [3, 2, true, true]);
		for (const remote of ["https://user@github.com/Sample-Org/Sample-Repo.git", "ssh://git@github.com:22/Sample-Org/Sample-Repo.git"]) {
			cloudRemote = remote;
			const setupResult = await setup(first, root);
			assert.equal(setupResult.repoUrl, found.repoUrl, remote);
			assert.equal(setupResult.reachable, true, remote);
		}
		cloudRemote = "git@github-work:Sample-Org/Sample-Repo.git";
		assert.equal((await setup(first, root)).ok, false, "SSH aliases do not establish the GitHub host");
		cloudRemote = "ssh://git@github.com/Sample-Org/Sample-Repo.git";
		cloudRepos = { ok: true, items: [] };
		assert.equal((await setup(first, root)).reachable, false);
		cloudRepos = { ok: false, error: "Check failed." };
		const unavailable = await setup(first, root);
		assert.equal(unavailable.reachable, null);
		assert.equal(unavailable.error, "Check failed.");
		assert.equal(cloudModelRequests, 1, "models are cached while repository access is checked again");

		const input = { uiSessionId: "cloud-session", turnId: "cloud-turn" };
		assert.equal(send(first, input).ok, true);
		assert.equal(sent[0].at(-1).text, "Cloud reply");
		assert.equal(sent[1].at(-1).type, "cloud-key-changed", "cloud events only go to the owning window");
		assert.equal(resume(second, input).ok, false);
		assert.equal(cancel(second, input.uiSessionId).ok, false);
		assert.equal((await remove(first)).ok, false, "a live turn keeps its account credentials");
		assert.equal(resume(first, input).ok, true, "the same webContents can resume");
		assert.equal(cancel(first, input.uiSessionId).ok, true);
		assert.equal(sent[0].at(-1).stopReason, "cancelled");
		assert.equal(cancel(first, input.uiSessionId).ok, false);
		assert.equal(send(second, input).ok, true);
		second.sender.emit("destroyed");
		assert.deepEqual(cloudHost.stopped, [input.uiSessionId]);
		assert.equal(resume(first, input).ok, true, "an owner can resume after the other window closes");
		assert.equal(cancel(first, input.uiSessionId).ok, true);
		assert.equal((await remove(first)).ok, true);
		assert.equal(status().hasKey, false);
	} finally { [first.sender.send, second.sender.send] = originalSends; }
	console.log("PASS cloud IPC: key verification, upstream setup, model cache, owner-only events, resume, cancel and close");
}

function checkColdChats() {
	const { createColdChats } = require("../electron/cold-chats.cjs");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cold-chats-"));
	const inner = path.join(dir, "chats");
	const outside = path.join(dir, "outside.json");
	try {
		const store = createColdChats(inner);
		const id = "new-0f4a8a5e-1111-4222-8333-944455556666";
		const file = path.join(inner, `${id}.json`);
		assert.equal(store.read(id), null, "no file reads as no chat");
		const chat = [{ id: "user-1", role: "user", text: "Words é € 😀" }];
		assert.equal(store.write(id, JSON.stringify(chat)), true);
		assert.deepEqual(JSON.parse(store.read(id)), chat, "a chat reads back whole, with any characters");
		assert.deepEqual(fs.readdirSync(inner), [`${id}.json`], "an atomic write leaves no temporary file");
		assert.equal(store.write(id, "{ not json"), false, "text that is not JSON is refused");
		assert.equal(store.write(id, JSON.stringify({ messages: chat })), false, "a value that is not a list is refused");
		assert.equal(store.write(id, undefined), false);
		assert.deepEqual(JSON.parse(store.read(id)), chat, "a refused write leaves the good file alone");
		for (const bad of ["../outside", "..\\outside", "a/b", "a\\b", "C:", "", ".hidden", "a.b", "a".repeat(129), 7, null, undefined, ["a"]]) {
			assert.equal(store.write(bad, "[]"), false, `id ${String(bad)} is refused`);
			assert.equal(store.read(bad), null, `id ${String(bad)} reads as no chat`);
		}
		fs.writeFileSync(outside, "[]");
		store.remove(["../outside", "..\\outside"]);
		assert.equal(fs.existsSync(outside), true, "remove stays in its folder");
		assert.equal(fs.readdirSync(inner).length, 1, "a refused id writes nothing");
		fs.writeFileSync(`${file}.tmp`, "[partial");
		store.remove("not a list");
		store.remove([id, "new-never-written"]);
		assert.deepEqual(fs.readdirSync(inner), [], "remove takes the chat and any temporary copy, and a missing file is fine");
		const failing = createColdChats(inner, { ...fs, readFileSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });
		assert.equal(failing.read(id), false, "a file that can't be read is not the same as no file");
		const full = createColdChats(inner, { ...fs, fsyncSync: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } });
		assert.equal(full.write(id, "[]"), false, "a failed write says so");
		assert.equal(store.read(id), null, "a failed write leaves no chat file");
		store.remove([id]);
		assert.deepEqual(fs.readdirSync(inner), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// A fresh main process on its own fake app, clock and notifications, with every earlier window closed.
function launchCopy({ argv = [], platform = "win32", env = process.env, isPackaged = false, lock = true, spawnSync, dataDir = root } = {}) {
	for (const win of windows) { win.destroyed = true; }
	focusedWindow = null;
	cursorArea = matchingArea = { x: 0, y: 0, width: 1920, height: 1080 };
	const copy = { handlers: new Map(), intervals: [], cleared: [], notifications: [], at: Date.UTC(2026, 5, 1, 19, 0), quits: 0, loginSets: [], loginReads: [], runValues: new Map(), systemLogin: null };
	class ClockDate extends Date {
		constructor(...args) { super(...(args.length ? args : [copy.at])); }
		static now() { return copy.at; }
	}
	const commandOf = (item) => JSON.stringify([item.path, item.args]);
	copy.app = Object.assign(new EventEmitter(), {
		commandLine: app.commandLine,
		dock: { setBadge() {}, setIcon() {} },
		isPackaged,
		setPath() {},
		setName() {},
		setAppUserModelId() {},
		getPath: () => dataDir,
		getVersion: () => "0.1.0",
		isAccessibilitySupportEnabled: () => false,
		whenReady: () => ({ then: (callback) => callback() }),
		requestSingleInstanceLock: () => lock,
		quit() { copy.quits += 1; },
		// As browser_win.cc does: the Run value is written under settings.name, or else the user model id, and read back only under the id.
		setLoginItemSettings(settings) {
			copy.loginSets.push(settings);
			const valueName = settings.name || "Grok.Code";
			if (settings.openAtLogin) { copy.runValues.set(valueName, commandOf(settings)); } else { copy.runValues.delete(valueName); }
		},
		getLoginItemSettings(options) {
			copy.loginReads.push(options);
			return copy.systemLogin ?? { openAtLogin: copy.runValues.get("Grok.Code") === commandOf(options), executableWillLaunchAtLogin: copy.runValues.has("Grok.Code") };
		},
	});
	class FakeNotification extends EventEmitter {
		constructor(options) {
			super();
			this.options = options;
			copy.notifications.push(this);
		}
		show() { this.shown = true; }
	}
	copy.context = {
		__dirname: path.join(root, "electron"),
		process: Object.create(process, { platform: { value: platform }, argv: { value: [...process.argv, ...argv] }, env: { value: env } }),
		URL,
		Buffer,
		AbortController,
		Date: ClockDate,
		setTimeout: mainContext.setTimeout,
		clearTimeout: mainContext.clearTimeout,
		setInterval: (run, ms) => { copy.intervals.push({ run, ms }); return copy.intervals.length; },
		clearInterval: (id) => copy.cleared.push(id),
		require(name) {
			if (name === "electron") { return { ...electron, app: copy.app, Notification: FakeNotification, powerMonitor: new EventEmitter(), ipcMain: { handle: (channel, handler) => copy.handlers.set(channel, handler), on: (channel, handler) => copy.handlers.set(channel, handler) } }; }
			if (name === "child_process") {
				const base = mainContext.require(name);
				if (spawnSync) { return { ...base, spawnSync }; }
				return { ...base, spawnSync: (command, args, options) => (/vite\.js$/.test(args?.[0] ?? "") ? base.spawnSync(command, args, options) : { stdout: "" }) };
			}
			return mainContext.require(name);
		},
	};
	vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), copy.context);
	copy.host = host;
	// Like the real host, a cancel ends the turn with a cancelled done.
	copy.host.cancel = (id) => {
		copy.host.cancelled.push(id);
		const turn = copy.host.turns.get(id);
		if (turn) {
			copy.host.turns.delete(id);
			copy.host.emit({ type: "done", uiSessionId: id, turnId: turn.turnId, stopReason: "cancelled" });
		}
	};
	copy.tick = () => copy.intervals[0].run();
	copy.ready = (win) => copy.handlers.get("grok:routines-ready")({ sender: win.webContents });
	copy.ask = (win, request) => copy.handlers.get("grok:routines")({ sender: win.webContents }, request);
	copy.send = (win, payload) => copy.handlers.get("grok:send")({ sender: win.webContents }, payload);
	copy.openWindow = () => {
		copy.handlers.get("grok:new-window")();
		return record(windows.at(-1));
	};
	return copy;
}

function checkPastedImages() {
	const { spawnSync, execFileSync } = require("node:child_process");
	const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "grok-pasted-image-é-test-"));
	assert.equal(path.dirname(folder), path.resolve(os.tmpdir()), "the fixture uses this operating system's temporary directory");
	let setupCalls = 0;
	const launch = () => launchCopy({ platform: process.platform, dataDir: folder, spawnSync: (...args) => { setupCalls++; return spawnSync(...args); } });
	const save = (copy) => {
		const image = copy.handlers.get("grok:save-image")({}, "AQID");
		assert.equal(image.ok, true, image.error);
		return image.path;
	};
	const prune = (copy, history, backup = null) => {
		const event = { sender: windows.at(-1).webContents };
		copy.handlers.get("grok:prune-pasted-images")(event, history, backup);
		return event.returnValue;
	};
	const checkPrivateAccess = (file, { directory = false, protectedDacl = false } = {}) => {
		const script = `
			$ErrorActionPreference = 'Stop'
			$acl = [System.IO.${directory ? "Directory" : "File"}]::GetAccessControl($env:GROK_PASTE_TEST_PATH)
			$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
				@{ sid = $_.IdentityReference.Value; rights = $_.FileSystemRights.ToString(); access = $_.AccessControlType.ToString(); inheritance = $_.InheritanceFlags.ToString(); propagation = $_.PropagationFlags.ToString() }
			})
			@{ sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
		`;
		const acl = JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
			env: { ...process.env, GROK_PASTE_TEST_PATH: file }, encoding: "utf8", timeout: 5000, windowsHide: true,
		}));
		assert.deepEqual(acl.rules, [{ sid: acl.sid, rights: "FullControl", access: "Allow", inheritance: directory ? "ContainerInherit, ObjectInherit" : "None", propagation: "None" }], "only the current user's SID has full access");
		if (protectedDacl) { assert.equal(acl.protected, true, "the private DACL rejects parent permissions"); }
	};
	try {
		const copy = launch();
		const unrelated = path.join(folder, "another-launch.png");
		fs.writeFileSync(unrelated, "keep");
		const images = Array.from({ length: 6 }, () => save(copy));
		const [draft, queued, inline, cold, orphan, backupOnly] = images;
		const pasteFolder = path.dirname(draft);
		assert.equal(path.dirname(pasteFolder), folder);
		assert.deepEqual(fs.readFileSync(draft), Buffer.from([1, 2, 3]));
		if (process.platform === "win32") {
			checkPrivateAccess(pasteFolder, { directory: true, protectedDacl: true });
			checkPrivateAccess(draft);
		} else {
			assert.equal(fs.statSync(draft).mode & 0o777, 0o600);
		}
		copy.app.emit("will-quit");
		for (const image of images) { assert.equal(fs.existsSync(image), true, "quit preserves images for saved history"); }
		const oldFolder = path.join(folder, `grok-code-paste-${require("node:crypto").randomUUID()}`);
		fs.mkdirSync(oldFolder);
		fs.writeFileSync(path.join(oldFolder, `${require("node:crypto").randomUUID()}.png`), "orphan");
		const chats = path.join(folder, "chats");
		fs.mkdirSync(chats);
		fs.writeFileSync(path.join(chats, "cold.json"), JSON.stringify([{ attachments: [cold] }]));
		fs.writeFileSync(path.join(chats, "inline.json"), JSON.stringify([{ attachments: [orphan] }]));
		const legacyKept = path.join(folder, `grok-code-paste-${require("node:crypto").randomUUID()}.png`);
		const legacyOrphan = path.join(folder, `grok-code-paste-${require("node:crypto").randomUUID()}.png`);
		fs.writeFileSync(legacyKept, "keep");
		fs.writeFileSync(legacyOrphan, "remove");
		if (process.platform === "win32") {
			const setLegacyOwner = `
				$ErrorActionPreference = 'Stop'
				$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
				foreach ($file in @($env:GROK_PASTE_LEGACY_KEPT, $env:GROK_PASTE_LEGACY_ORPHAN)) {
					$acl = [System.IO.File]::GetAccessControl($file)
					if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
						$acl.SetOwner($user)
						[System.IO.File]::SetAccessControl($file, $acl)
					}
				}
			`;
			execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", setLegacyOwner], {
				env: { ...process.env, GROK_PASTE_LEGACY_KEPT: legacyKept, GROK_PASTE_LEGACY_ORPHAN: legacyOrphan }, timeout: 5000, windowsHide: true,
			});
		}
		const restarted = launch();
		const live = save(restarted);
		const history = { sessions: [{ id: "inline", folder }, { id: "cold", folder }], attachments: { draft: [draft, legacyKept] }, queued: { draft: [{ attachments: [queued] }] }, extraChats: { inline: [{ attachments: [inline] }] } };
		const backup = JSON.stringify({ sessions: [], extraChats: { backup: [{ attachments: [backupOnly] }] } });
		assert.equal(prune(restarted, JSON.stringify(history), backup), true);
		for (const image of [draft, queued, inline, cold, live, backupOnly]) { assert.equal(fs.existsSync(image), true, "saved, backup and current-launch references survive cleanup"); }
		assert.equal(fs.existsSync(orphan), false, "stale cold files cannot retain an image absent from the inline chat");
		assert.equal(fs.existsSync(oldFolder), false, "unreferenced launch folders left by a forced exit are removed");
		assert.equal(fs.existsSync(legacyOrphan), false, "flat paste files from older versions are also cleaned");
		assert.equal(fs.existsSync(legacyKept), true, "referenced flat paste files stay available");
		if (process.platform === "win32") {
			checkPrivateAccess(legacyKept, { protectedDacl: true });
			assert.equal(setupCalls, 2, "directory setup runs once and the legacy migration runs once");
		} else { assert.equal(fs.statSync(legacyKept).mode & 0o777, 0o600); }
		history.attachments.draft.push(live);
		const repeated = launch();
		assert.equal(prune(repeated, JSON.stringify(history), backup), true);
		if (process.platform === "win32") { assert.equal(setupCalls, 2, "unchanged retained legacy screenshots do not run PowerShell at the next startup"); }
		const afterCrash = launch();
		assert.equal(prune(afterCrash, "{damaged"), false);
		assert.equal(prune(afterCrash, JSON.stringify({ sessions: [] }), "{damaged backup"), false);
		assert.equal(fs.existsSync(backupOnly), true, "an unreadable backup defers deletion");
		assert.equal(prune(afterCrash, JSON.stringify({ sessions: [42] })), false);
		assert.equal(prune(afterCrash, JSON.stringify({ sessions: [{}] })), false);
		assert.equal(fs.existsSync(live), true, "unreadable history keeps images");
		fs.writeFileSync(path.join(chats, "cold.json"), "{damaged");
		assert.equal(prune(afterCrash, JSON.stringify(history)), false);
		assert.equal(fs.existsSync(cold), true, "unreadable cold chats keep images");
		assert.equal(prune(afterCrash, JSON.stringify({ sessions: [], newSessionDraft: { attachments: [draft] } })), true);
		assert.equal(fs.existsSync(draft), true, "the saved pending form keeps its screenshot");
		assert.equal(fs.existsSync(live), false, "a crash orphan is removed at the next startup");
		assert.equal(fs.existsSync(backupOnly), false, "removing the backup releases its otherwise unreferenced screenshot");
		assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
	console.log("PASS pasted images stay private and referenced drafts/queues/history survive restart while startup removes orphans");
}

function record(win) {
	win.events = [];
	win.webContents.send = (_channel, event) => {
		if (win.webContents.isDestroyed()) { throw new TypeError("Object has been destroyed"); }
		win.events.push(event);
	};
	return win;
}

const fires = (win) => win.events.filter((event) => event.type === "routine-fire");
const opens = (win) => win.events.filter((event) => event.type === "routine-open");

async function checkOpenAtSignIn() {
	const windowsCopy = launchCopy();
	const toggle = windowsCopy.handlers.get("grok:open-at-sign-in");
	const sourceItem = { path: process.execPath, args: [root, "--build-if-stale", "--at-sign-in"] };
	assert.deepEqual({ ...toggle({}) }, { ok: true, available: true, on: false, blockedBySystem: false }, "undefined only reads");
	assert.equal(windowsCopy.loginSets.length, 0);
	assert.deepEqual({ ...toggle({}, true) }, { ok: true, available: true, on: true, blockedBySystem: false }, "a custom value name would read back as off here");
	assert.deepEqual(windowsCopy.loginSets.map((settings) => [...Object.keys(settings)].sort()), [["args", "openAtLogin", "path"]], "Windows never passes name");
	assert.deepEqual([windowsCopy.loginSets[0].openAtLogin, windowsCopy.loginSets[0].path, [...windowsCopy.loginSets[0].args]], [true, sourceItem.path, sourceItem.args]);
	assert.ok(windowsCopy.loginReads.every((options) => JSON.stringify(Object.keys(options).sort()) === JSON.stringify(["args", "path"])), "the read passes the same path and args, and no name");
	assert.deepEqual([...windowsCopy.runValues.keys()], ["Grok.Code"], "so the value is the one the installer removes");
	windowsCopy.systemLogin = { openAtLogin: true, executableWillLaunchAtLogin: false };
	assert.equal(toggle({}).blockedBySystem, true, "turned off in Windows' Startup apps");
	windowsCopy.systemLogin = { openAtLogin: false, executableWillLaunchAtLogin: false };
	assert.equal(toggle({}).blockedBySystem, false, "off is not blocked");
	windowsCopy.systemLogin = null;
	assert.equal(toggle({}, false).on, false);
	assert.equal(windowsCopy.runValues.size, 0);
	const sets = windowsCopy.loginSets.length;
	assert.equal(toggle({}, "yes").on, false, "anything but a boolean only reads");
	assert.equal(windowsCopy.loginSets.length, sets);
	windowsCopy.app.setLoginItemSettings = () => { throw new Error("Access denied"); };
	assert.deepEqual({ ...toggle({}, true) }, { ok: false, available: true, on: false, blockedBySystem: false, error: "The setting could not be changed: Access denied" });

	const installed = launchCopy({ isPackaged: true });
	assert.equal(installed.handlers.get("grok:open-at-sign-in")({}, true).on, true);
	assert.deepEqual([...installed.loginSets[0].args], ["--at-sign-in"], "an installed copy starts itself with only the flag");

	const macInstalled = launchCopy({ platform: "darwin", isPackaged: true });
	macInstalled.systemLogin = { openAtLogin: false };
	assert.deepEqual({ ...macInstalled.handlers.get("grok:open-at-sign-in")({}, true) }, { ok: true, available: true, on: false, blockedBySystem: false }, "macOS returns the read-back value, not the requested one");
	assert.deepEqual({ ...macInstalled.loginSets[0] }, { openAtLogin: true }, "and takes no path or arguments");
	macInstalled.systemLogin = { openAtLogin: true };
	assert.equal(macInstalled.handlers.get("grok:open-at-sign-in")({}, true).on, true, "when it sticks, it says so");
	const macSource = launchCopy({ platform: "darwin" });
	macSource.systemLogin = { openAtLogin: false };
	assert.deepEqual({ ...macSource.handlers.get("grok:open-at-sign-in")({}, true) }, { ok: true, available: false, on: false, blockedBySystem: false }, "a source checkout would open bare Electron, so it is unavailable");
	assert.equal(macSource.loginSets.length, 0, "and nothing is set");

	const config = fs.mkdtempSync(path.join(os.tmpdir(), "grok-autostart-test-"));
	try {
		const linux = launchCopy({ platform: "linux", env: { ...process.env, XDG_CONFIG_HOME: config } });
		const linuxToggle = linux.handlers.get("grok:open-at-sign-in");
		const file = path.join(config, "autostart", "codewomplers-grok-desktop.desktop");
		assert.deepEqual({ ...linuxToggle({}) }, { ok: true, available: true, on: false, blockedBySystem: false });
		assert.equal(fs.existsSync(file), false, "a read writes nothing");
		assert.equal(linuxToggle({}, true).on, true);
		assert.match(fs.readFileSync(file, "utf8"), /^Exec=.*"--build-if-stale" "--at-sign-in"$/m);
		assert.equal(linuxToggle({}).on, true, "on means the file exists");
		assert.equal(linuxToggle({}, false).on, false);
		assert.equal(fs.existsSync(file), false, "off deletes it");
		assert.equal(linuxToggle({}, false).ok, true, "turning off twice is fine");
		assert.equal(linux.loginSets.length + linux.loginReads.length, 0, "Linux never uses Electron's login items");
		const blockedPath = path.join(config, "a-file");
		fs.writeFileSync(blockedPath, "");
		const broken = launchCopy({ platform: "linux", env: { ...process.env, XDG_CONFIG_HOME: blockedPath } }).handlers.get("grok:open-at-sign-in")({}, true);
		assert.equal(broken.ok, false, "a write that fails says so");
		assert.equal(broken.on, false);
		assert.match(broken.error, /could not be changed/);
	} finally {
		fs.rmSync(config, { recursive: true, force: true });
	}
	console.log("PASS Open at sign-in handler: Windows with no name, macOS read-back, Linux file, availability and failure");
}

async function checkSignInWindow() {
	windowState = JSON.stringify({ x: 80, y: 90, width: 1200, height: 700, maximized: true });
	const launched = launchCopy({ argv: ["--at-sign-in", "--keep-me"] });
	const first = record(windows.at(-1));
	first.webContents.emit("did-finish-load");
	assert.equal(first.minimized, true, "--at-sign-in minimizes the first window");
	assert.equal(first.isMaximized(), false, "and does not maximize it, which would show it");
	assert.equal(first.shown, undefined);
	launched.app.emit("second-instance");
	assert.equal(first.minimized, false);
	assert.equal(first.isMaximized(), true, "restoring it brings back the saved maximized state");
	const later = launched.openWindow();
	later.webContents.emit("did-finish-load");
	assert.equal(later.minimized, undefined, "a later window opens normally");
	assert.equal(later.shown, 1);

	const byHand = launchCopy({ argv: ["--at-sign-in"] });
	const opening = windows.at(-1);
	byHand.app.emit("second-instance");
	opening.webContents.emit("did-finish-load");
	assert.equal(opening.minimized, undefined, "opening the app by hand before the page loads keeps the window up");
	assert.equal(opening.isMaximized(), true);

	const plainLaunch = launchCopy();
	const plain = windows.at(-1);
	plain.webContents.emit("did-finish-load");
	assert.equal(plain.minimized, undefined, "without the flag the first window opens normally");
	assert.equal(plain.maximizedWhenShown, true);
	assert.equal(plainLaunch.quits, 0);
	windowState = undefined;

	const source = launchCopy({ argv: ["--at-sign-in", "--keep-me"] });
	assert.equal((await source.handlers.get("grok:update-start")({}, "v0.2.0")).ok, true);
	source.app.emit("will-quit");
	const helperArgs = JSON.parse(children.at(-1).args[1]).args;
	assert.equal(helperArgs.includes("--at-sign-in"), false, "the source update's relaunch does not carry --at-sign-in");
	assert.equal(helperArgs.includes("--keep-me"), true, "and keeps everything else");

	const previousPrepared = updatePrepared;
	updatePrepared = { ok: true, ready: true, kind: "swap", file: path.join(root, "package.json"), staged: "/new", previous: "/old", sandbox: false };
	const packaged = launchCopy({ argv: ["--at-sign-in", "--keep-me"], isPackaged: true });
	await packaged.handlers.get("grok:update-prepare")({}, "v0.2.0");
	assert.equal((await packaged.handlers.get("grok:update-start")({}, "v0.2.0")).ok, true);
	packaged.app.emit("will-quit");
	const installedArgv = [...installedCommands.at(-1)[1].argv];
	assert.equal(installedArgv.includes("--at-sign-in"), false, "the installed update's relaunch does not carry --at-sign-in");
	assert.equal(installedArgv.includes("--keep-me"), true);
	updatePrepared = previousPrepared;
	updateExpected = undefined;
	console.log("PASS --at-sign-in: first window minimized, later windows normal, and neither update relaunch carries the flag");
}

const MINUTE = 60 * 1000;

function routineInput(schedule, extra = {}) {
	return { name: "Morning report", prompt: "Write the report.", folder: "", model: "grok-4.7", effort: "low", mode: "Auto-review", schedule, ...extra };
}

// A daily routine due a minute from the copy's clock, in whatever time zone the tests run under.
function dueNext(copy) {
	const due = new Date(copy.at + MINUTE);
	return { kind: "recurring", times: [`${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`], weekdays: [], monthDay: null, months: [] };
}

function launchWithRoutine(options, schedule = (copy) => ({ kind: "once", at: copy.at + MINUTE }), extra) {
	routineSaved = undefined;
	const copy = launchCopy(options);
	const win = record(windows.at(-1));
	const saved = copy.ask(win, { action: "save", routine: routineInput(schedule(copy), extra) });
	assert.equal(saved.ok, true, saved.error);
	copy.routineId = saved.id;
	copy.window = win;
	copy.run = () => copy.ask(win, { action: "list" }).runs.at(-1);
	return copy;
}

async function checkRoutineDispatch() {
	const noWindow = launchWithRoutine();
	assert.equal(noWindow.intervals[0].ms, 60000, "the store is checked every minute");
	noWindow.at += 2 * MINUTE;
	const writesBefore = routineWrites;
	noWindow.tick();
	assert.equal(routineWrites, writesBefore, "with no ready window, nothing is written");
	assert.equal(noWindow.ask(noWindow.window, { action: "list" }).runs.length, 0);
	assert.equal(noWindow.ask(noWindow.window, { action: "list" }).routines[0].enabled, true, "and the routine stays due");
	noWindow.ready(noWindow.window);
	assert.equal(fires(noWindow.window).length, 1, "the page registering runs what is due");
	noWindow.app.emit("will-quit");
	assert.deepEqual(noWindow.cleared, [1], "quitting clears the timer");

	const copy = launchWithRoutine();
	const first = copy.window;
	const second = copy.openWindow();
	const third = copy.openWindow();
	copy.ready(first);
	copy.ready(second);
	focusedWindow = second;
	copy.at += 2 * MINUTE;
	copy.tick();
	assert.deepEqual([fires(first).length, fires(second).length, fires(third).length], [0, 1, 0], "one fire goes to one window, the focused one");
	const [fire] = fires(second);
	const run = copy.run();
	assert.deepEqual(Object.keys(fire).sort(), ["effort", "folder", "mode", "model", "project", "routineId", "runId", "sessionId", "text", "title", "type"]);
	assert.equal(fire.runId, run.id);
	assert.equal(fire.routineId, copy.routineId);
	assert.equal(fire.sessionId, `new-${run.id}`);
	assert.equal(run.sessionId, fire.sessionId);
	assert.equal(run.state, "dispatched");
	assert.equal(JSON.parse(routineSaved).runs[0].state, "dispatched", "the store wrote the run before it went out");
	assert.equal(fire.title, `Morning report · ${new Date(run.scheduledFor).toLocaleDateString([], { month: "short", day: "numeric" })}`);
	assert.equal(fire.project, "Morning report", "with no folder, the project is the routine's name");
	assert.equal(fire.folder, path.join(routineFolderRoot, copy.routineId));
	assert.equal(routineFolders.at(-1), fire.folder, "and its folder is created at dispatch");
	assert.deepEqual([fire.model, fire.effort, fire.mode], ["grok-4.7", "low", "Auto-review"]);
	assert.equal(fire.text, "[Scheduled run. Nobody is watching. Do not ask questions. If something is blocked, say what and carry on.]\n\nWrite the report.");
	assert.ok(first.events.some((event) => event.type === "routines"), "every window hears the state");
	assert.equal(first.events.at(-1).runs.at(-1).id, run.id);
	assert.equal(first.events.at(-1).routines[0].nextRun, null, "a spent once has no next run");
	copy.tick();
	copy.at += 5 * MINUTE;
	copy.tick();
	assert.equal(fires(second).length, 1, "a second tick does not resend it");

	const unfocused = launchWithRoutine();
	const otherWindow = unfocused.openWindow();
	unfocused.ready(unfocused.window);
	focusedWindow = otherWindow;
	unfocused.at += 2 * MINUTE;
	unfocused.tick();
	assert.deepEqual([fires(unfocused.window).length, fires(otherWindow).length], [1, 0], "a focused window that is not ready gets nothing, and the first ready one takes it");

	for (const leave of [(win) => win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: pathToFileURL(pageFile).href }), (win) => win.webContents.emit("render-process-gone")]) {
		const gone = launchWithRoutine();
		gone.ready(gone.window);
		leave(gone.window);
		gone.at += 2 * MINUTE;
		gone.tick();
		assert.equal(fires(gone.window).length, 0, "a window that navigated or whose renderer died gets no fire");
		assert.equal(gone.run(), undefined);
		gone.ready(gone.window);
		assert.equal(fires(gone.window).length, 1, "until it registers again");
	}
	const samePage = launchWithRoutine();
	samePage.ready(samePage.window);
	samePage.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
	samePage.window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
	samePage.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://example.test/" });
	samePage.at += 2 * MINUTE;
	samePage.tick();
	assert.equal(fires(samePage.window).length, 1, "blocked, same-document and subframe navigation keep the window ready");

	const atSignIn = launchWithRoutine({ argv: ["--at-sign-in"] });
	atSignIn.at += 2 * MINUTE;
	atSignIn.ready(atSignIn.window);
	assert.equal(fires(atSignIn.window).length, 0, "a launch at sign-in does not tick when the window becomes ready");
	atSignIn.tick();
	assert.equal(fires(atSignIn.window).length, 1, "the interval does");

	const chosen = launchWithRoutine({}, undefined, { folder: root });
	const foldersBefore = routineFolders.length;
	chosen.ready(chosen.window);
	chosen.at += 2 * MINUTE;
	chosen.tick();
	assert.equal(fires(chosen.window)[0].folder, root, "a chosen folder is used as it is");
	assert.equal(fires(chosen.window)[0].project, path.basename(root), "and names the project");
	assert.equal(routineFolders.length, foldersBefore, "nothing is created for it");

	const missing = launchWithRoutine({}, undefined, { folder: path.join(root, "no-such-folder") });
	missing.ready(missing.window);
	missing.at += 2 * MINUTE;
	missing.tick();
	assert.equal(fires(missing.window).length, 0, "a chosen folder that is missing gets no dispatch");
	assert.equal(missing.run().state, "failed");
	assert.match(missing.run().error, /no-such-folder/);
	assert.equal(missing.run().sessionId, "", "and has no chat");
	assert.equal(missing.notifications.length, 1, "with a notice");
	assert.match(missing.notifications[0].options.body, /^This scheduled run failed: That folder is not on this computer/);
	missing.notifications[0].emit("click");
	assert.deepEqual({ ...opens(missing.window)[0] }, { type: "routine-open" }, "a click on a notice with no chat has no sessionId");
	console.log("PASS routine dispatch: no window, focused window, one fire, re-registering, sign-in launch and folders");
}

async function checkRoutineRuns() {
	routineSaved = JSON.stringify({ routines: [], runs: [{ id: "live", routineId: "gone", state: "running", waiting: [], denied: [], sessionId: "new-live", turnId: "turn" }] });
	const savedBefore = routineSaved;
	const writesBefore = routineWrites;
	launchCopy({ lock: false });
	assert.equal(routineSaved, savedBefore, "a launch that loses the single-instance lock leaves routines.json unchanged");
	assert.equal(routineWrites, writesBefore, "so live runs are not marked interrupted");
	launchCopy();
	assert.equal(JSON.parse(routineSaved).runs[0].state, "interrupted", "the launch that holds the lock does mark them");

	const stopped = launchWithRoutine({}, dueNext);
	stopped.ready(stopped.window);
	stopped.at += MINUTE;
	stopped.tick();
	const [stoppedFire] = fires(stopped.window);
	assert.equal(stopped.ask(stopped.window, { action: "stop", runId: stoppedFire.runId }).ok, true);
	assert.equal(stopped.run().state, "interrupted");
	const delayed = await stopped.send(stopped.window, { uiSessionId: stoppedFire.sessionId, turnId: "late-turn", routineRunId: stoppedFire.runId });
	assert.equal(delayed.error, "Stopped.");
	assert.equal(stopped.host.turns.has(stoppedFire.sessionId), false, "an interrupted dispatch never reaches the host");
	assert.equal((await stopped.send(stopped.window, { uiSessionId: stoppedFire.sessionId, turnId: "typed-turn" })).ok, true, "a new typed message can use the interrupted run's chat");

	const snapshotRun = stopped.ask(stopped.window, { action: "runNow", id: stopped.routineId });
	const snapshotFire = fires(stopped.window).at(-1);
	const originalSnapshot = sandboxGitSnapshot;
	let finishSnapshot;
	sandboxGitSnapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
	const pending = stopped.send(stopped.window, { uiSessionId: snapshotFire.sessionId, turnId: "sandbox-turn", routineRunId: snapshotRun.runId, cwd: snapshotFire.folder, sandbox: { option: "profile" } });
	assert.equal(stopped.run().state, "running", "the routine claimed its run before waiting on the snapshot");
	assert.equal(stopped.ask(stopped.window, { action: "stop", runId: snapshotRun.runId }).ok, true);
	assert.equal(stopped.run().state, "interrupted");
	finishSnapshot({ ok: false });
	sandboxGitSnapshot = originalSnapshot;
	assert.equal((await pending).error, "Stopped.");
	assert.equal(stopped.host.turns.has(snapshotFire.sessionId), false, "Stop during the snapshot also prevents the prompt");

	const late = launchWithRoutine({}, dueNext);
	late.ready(late.window);
	late.at += MINUTE;
	late.tick();
	const [{ sessionId, runId }] = fires(late.window);
	late.at += 29 * 1000;
	late.tick();
	assert.equal(late.run().state, "dispatched");
	late.at += 2 * 1000;
	late.tick();
	assert.equal(late.run().state, "unknown", "no grok:send within 30 seconds gives unknown");
	assert.match(late.ask(late.window, { action: "runNow", id: late.routineId }).error, /has not finished/, "and overlap stays blocked");
	assert.equal(fires(late.window).length, 1);
	late.at += 24 * 60 * MINUTE;
	late.tick();
	assert.equal(late.run().state, "skipped", "a later occurrence is skipped");
	assert.equal(fires(late.window).length, 1);
	assert.equal(late.notifications.length, 1, "and the first skip shows a notification");
	assert.equal(late.notifications[0].options.body, "A scheduled run was skipped because the previous run has not finished.");
	assert.equal(late.notifications[0].options.title, "Morning report");
	assert.equal(late.notifications[0].shown, true);
	assert.equal(vm.runInContext("routineNotices.size", late.context), 1, "it is held until it closes or is clicked");
	late.notifications[0].emit("close");
	assert.equal(vm.runInContext("routineNotices.size", late.context), 0);
	late.at += 24 * 60 * MINUTE;
	late.tick();
	assert.equal(late.notifications.length, 1, "a second skip shows none");
	const started = await late.send(late.window, { uiSessionId: sessionId, turnId: "turn-1", routineRunId: runId });
	assert.equal(started.ok, true);
	assert.equal(late.ask(late.window, { action: "list" }).runs[0].state, "running", "a late send still moves it to running");
	assert.equal(late.ask(late.window, { action: "list" }).runs[0].turnId, "turn-1");

	const second = launchWithRoutine();
	second.ready(second.window);
	second.at += 2 * MINUTE;
	second.tick();
	const { sessionId: id, runId: secondRunId } = fires(second.window)[0];
	let agentResult = { ok: true, agentSessionId: "agent-1" };
	const realPrompt = second.host.prompt.bind(second.host);
	const routineFlags = [];
	second.host.prompt = (input, context) => {
		routineFlags.push(context?.routine);
		return realPrompt(input).then(() => agentResult);
	};
	assert.equal((await second.send(second.openWindow(), { uiSessionId: id, turnId: "other-window", routineRunId: secondRunId })).ok, false);
	assert.equal(second.run().state, "dispatched", "another window cannot claim the dispatched run");
	await second.send(second.window, { uiSessionId: id, turnId: "turn-1", routineRunId: secondRunId });
	assert.equal(second.run().agentSessionId, "agent-1", "the start result fills in Grok's session");
	assert.equal(JSON.parse(routineSaved).runs[0].agentSessionId, "agent-1");
	const writes = routineWrites;
	const stateEvents = () => second.window.events.filter((event) => event.type === "routines").length;
	const statesBefore = stateEvents();
	second.host.emit({ type: "chunk", uiSessionId: id, turnId: "turn-1", text: "Working" });
	assert.equal(second.run().preview, "Working", "a chunk reaches the preview");
	assert.equal(routineWrites, writes, "and writes nothing");
	assert.equal(stateEvents(), statesBefore, "and sends no state");
	assert.equal(second.window.events.at(-1).type, "chunk", "the event still reaches the page");
	second.host.emit({ type: "tool", uiSessionId: id, turnId: "turn-1", tool: { id: "gate", waiting: true } });
	assert.deepEqual([...second.run().waiting], ["gate"]);
	second.host.emit({ type: "done", uiSessionId: id, turnId: "turn-1", stopReason: "end_turn" });
	assert.equal(second.run().state, "finished");
	second.host.turns.delete(id);
	agentResult = { ok: false, error: "The second turn could not start." };
	await second.send(second.window, { uiSessionId: id, turnId: "turn-2", routine: true });
	assert.deepEqual(routineFlags, [true, false], "only the owning window's initial dispatch uses the routine timeout");
	assert.equal(second.run().turnId, "turn-1", "a second turn in the same session does not change the run");
	assert.equal(second.run().state, "finished");
	second.host.emit({ type: "error", uiSessionId: id, turnId: "turn-2", message: "Second turn failed." });
	assert.equal(second.run().state, "finished");
	assert.equal(second.notifications.length, 0);

	const closing = launchWithRoutine();
	const other = closing.openWindow();
	closing.ready(closing.window);
	closing.ready(other);
	focusedWindow = closing.window;
	closing.at += 2 * MINUTE;
	closing.tick();
	const { sessionId: closingId, runId: closingRunId } = fires(closing.window)[0];
	await closing.send(closing.window, { uiSessionId: closingId, turnId: "turn-1", routineRunId: closingRunId });
	closing.window.destroyed = true;
	closing.window.webContents.emit("destroyed");
	assert.deepEqual(closing.host.cancelled, [closingId]);
	assert.equal(closing.ask(other, { action: "list" }).runs[0].state, "interrupted", "closing the owning window gives interrupted");
	assert.equal(closing.notifications.length, 0, "with no notice");

	const finishedFirst = launchWithRoutine();
	finishedFirst.ready(finishedFirst.window);
	finishedFirst.at += 2 * MINUTE;
	finishedFirst.tick();
	const { sessionId: finishedId, runId: finishedRunId } = fires(finishedFirst.window)[0];
	let finishStart;
	finishedFirst.host.prompt = (input) => {
		finishedFirst.host.turns.set(input.uiSessionId, { uiSessionId: input.uiSessionId, turnId: input.turnId });
		return new Promise((resolve) => { finishStart = resolve; });
	};
	const startResult = finishedFirst.send(finishedFirst.window, { uiSessionId: finishedId, turnId: "turn-1", routineRunId: finishedRunId });
	finishedFirst.host.emit({ type: "done", uiSessionId: finishedId, turnId: "turn-1", stopReason: "end_turn" });
	finishStart({ ok: false, error: "A late start failure." });
	await startResult;
	assert.equal(finishedFirst.run().state, "finished", "a late start result does not overwrite finished");
	assert.equal(finishedFirst.run().error, "");

	const failedStart = launchWithRoutine();
	failedStart.ready(failedStart.window);
	failedStart.at += 2 * MINUTE;
	failedStart.tick();
	failedStart.host.prompt = () => Promise.resolve({ ok: false, error: "That folder is not on this computer: C:/gone" });
	const failedFire = fires(failedStart.window)[0];
	await failedStart.send(failedStart.window, { uiSessionId: failedFire.sessionId, turnId: "turn-1", routineRunId: failedFire.runId });
	assert.equal(failedStart.run().state, "failed", "a failed start result fails the run");
	assert.equal(failedStart.notifications.length, 1, "and a failed scheduled run shows a notification");
	assert.equal(failedStart.notifications[0].options.body, "This scheduled run failed: That folder is not on this computer: C:/gone.");

	const archiving = launchWithRoutine();
	archiving.ready(archiving.window);
	archiving.at += 2 * MINUTE;
	archiving.tick();
	const archiveFire = fires(archiving.window)[0];
	const archiveRemovals = vm.runInContext("autoArchiveRemovals", archiving.context);
	const archiveFolder = vm.runInContext("sandboxGitFolder", archiving.context)(archiveFire.folder);
	archiveRemovals.set(archiveFolder, { deleting: true, skipped: false });
	archiving.host.prompt = () => { throw new Error("An archive-refused routine must not reach the host."); };
	const archivePayload = { uiSessionId: archiveFire.sessionId, turnId: "archive-turn", routineRunId: archiveFire.runId, cwd: archiveFire.folder };
	assert.equal((await archiving.send(archiving.openWindow(), archivePayload)).error, "Stopped.", "routine ownership is checked before archive admission");
	assert.equal(archiving.run().state, "dispatched");
	const archiveRefusal = await archiving.send(archiving.window, archivePayload);
	assert.match(archiveRefusal.error, /being auto-archived/);
	assert.equal(archiving.host.turns.has(archiveFire.sessionId), false);
	assert.equal(archiving.run().state, "failed", "an archive refusal reaches the admitted routine's startResult");
	assert.equal(archiving.run().error, archiveRefusal.error);

	const hostFailed = launchWithRoutine();
	hostFailed.ready(hostFailed.window);
	hostFailed.at += 2 * MINUTE;
	hostFailed.tick();
	const { sessionId: hostFailedId, runId: hostFailedRunId } = fires(hostFailed.window)[0];
	await hostFailed.send(hostFailed.window, { uiSessionId: hostFailedId, turnId: "turn-1", routineRunId: hostFailedRunId });
	hostFailed.host.emit({ type: "error", uiSessionId: hostFailedId, turnId: "turn-1", message: `Bad key xai-${"A".repeat(40)}` });
	assert.equal(hostFailed.run().state, "failed");
	assert.equal(hostFailed.run().error, "Bad key [redacted]");
	assert.equal(hostFailed.notifications[0].options.body, "This scheduled run failed: Bad key [redacted].");
	assert.equal(hostFailed.notifications[0].options.title, "Morning report");

	const manual = launchWithRoutine({}, () => ({ kind: "manual" }));
	manual.ready(manual.window);
	assert.equal(manual.ask(manual.window, { action: "runNow", id: "gone" }).ok, false);
	const started2 = manual.ask(manual.window, { action: "runNow", id: manual.routineId });
	assert.equal(started2.ok, true);
	assert.equal(fires(manual.window)[0].runId, started2.runId, "Run now dispatches as a tick does");
	assert.equal(manual.run().trigger, "manual");
	assert.equal(manual.run().scheduledFor, manual.at, "and its scheduledFor is now");
	assert.match(manual.ask(manual.window, { action: "runNow", id: manual.routineId }).error, /has not finished/, "Run now is refused while a run is outstanding");
	assert.equal(fires(manual.window).length, 1);
	const manualId = fires(manual.window)[0].sessionId;
	await manual.send(manual.window, { uiSessionId: manualId, turnId: "turn-1", routineRunId: started2.runId });
	manual.host.emit({ type: "error", uiSessionId: manualId, turnId: "turn-1", message: "Failed." });
	assert.equal(manual.run().state, "failed");
	assert.equal(manual.notifications.length, 0, "a manual run shows no notification");
	const noReadyWindow = launchWithRoutine({}, () => ({ kind: "manual" }));
	assert.match(noReadyWindow.ask(noReadyWindow.window, { action: "runNow", id: noReadyWindow.routineId }).error, /No window is ready/);
	assert.equal(noReadyWindow.run(), undefined);
	console.log("PASS routine runs: lock, unknown, overlap, second turn, closed owner, late start result and notices");
}

async function checkRoutineActions() {
	const copy = launchWithRoutine({}, () => ({ kind: "manual" }));
	const other = copy.openWindow();
	copy.ready(copy.window);
	copy.ready(other);
	focusedWindow = copy.window;
	const list = () => copy.ask(other, { action: "list" });
	assert.equal(list().ok, true);
	assert.equal(list().routines[0].id, copy.routineId);
	assert.equal(list().error, "");
	assert.match(copy.ask(other, { action: "save", routine: routineInput({ kind: "manual" }, { mode: "Plan" }) }).error, /mode/, "save returns its validation error");
	assert.match(copy.ask(other, { action: "save", routine: { ...routineInput({ kind: "manual" }), id: "gone" } }).error, /no longer exists/);
	assert.equal(copy.ask(other, { action: "save" }).ok, false, "a request with no routine is refused");
	assert.equal(copy.ask(other, { action: "launch" }).ok, false);
	assert.equal(copy.ask(other).ok, false);
	const changes = other.events.filter((event) => event.type === "routines").length;
	assert.equal(copy.ask(other, { action: "setEnabled", id: copy.routineId, enabled: false }).ok, true);
	assert.equal(other.events.filter((event) => event.type === "routines").length, changes + 1, "each change is broadcast");
	assert.equal(copy.window.events.at(-1).type, "routines");
	assert.equal(copy.window.events.at(-1).routines[0].enabled, false);
	assert.equal(copy.ask(other, { action: "setEnabled", id: copy.routineId, enabled: true }).ok, true);

	const past = copy.ask(other, { action: "save", routine: routineInput({ kind: "once", at: copy.at - MINUTE }, { name: "Past" }) });
	assert.equal(past.ok, true);
	assert.equal(list().runs.find((run) => run.routineId === past.id).state, "missed", "a once time already past is missed now, not at the next interval");

	const started = copy.ask(other, { action: "runNow", id: copy.routineId });
	const run = () => list().runs.find((item) => item.id === started.runId);
	const sessionId = run().sessionId;
	assert.equal(copy.handlers.get("grok:routine-result")({ sender: other.webContents }, started.runId, { ok: false, error: "Not mine." }), undefined);
	assert.equal(run().state, "dispatched", "only the window the run went to can report a failed start");
	copy.handlers.get("grok:routine-result")({ sender: copy.window.webContents }, started.runId, { ok: true });
	assert.equal(run().state, "dispatched", "routineResult is only for a failed start");
	copy.handlers.get("grok:routine-result")({ sender: copy.window.webContents }, started.runId, { ok: false, error: "This window could not start the run." });
	assert.equal(run().state, "failed");
	assert.equal(run().error, "This window could not start the run.");
	assert.equal(run().sessionId, sessionId);
	assert.match(copy.ask(other, { action: "stop", runId: started.runId }).error, /already ended/, "an ended run has nothing to stop");
	assert.equal(copy.host.cancelled.length, 0, "and a later turn in that chat is left alone");

	const noTurn = copy.ask(other, { action: "runNow", id: copy.routineId });
	assert.equal(copy.ask(other, { action: "stop", runId: noTurn.runId }).ok, true);
	const stopped = list().runs.find((item) => item.id === noTurn.runId);
	assert.deepEqual(copy.host.cancelled, [stopped.sessionId], "stop calls cancel from any window");
	assert.equal(stopped.state, "interrupted", "with no turn for the session it marks the run interrupted");

	const withTurn = copy.ask(other, { action: "runNow", id: copy.routineId });
	const turnSession = list().runs.find((item) => item.id === withTurn.runId).sessionId;
	await copy.send(copy.window, { uiSessionId: turnSession, turnId: "turn-1", routineRunId: withTurn.runId });
	copy.host.emit({ type: "tool", uiSessionId: turnSession, turnId: "turn-1", tool: { id: "gate", waiting: true } });
	assert.equal(copy.ask(other, { action: "stop", runId: withTurn.runId }).ok, true);
	assert.equal(list().runs.find((item) => item.id === withTurn.runId).state, "interrupted", "a live turn ends through its cancelled event");
	assert.equal(list().runs.find((item) => item.id === withTurn.runId).stopReason, "cancelled");
	assert.equal(copy.ask(other, { action: "stop", runId: "gone" }).ok, false);

	const open = copy.ask(other, { action: "runNow", id: copy.routineId });
	const openSession = list().runs.find((item) => item.id === open.runId).sessionId;
	const agentPrompt = copy.host.prompt.bind(copy.host);
	copy.host.prompt = (input) => agentPrompt(input).then(() => ({ ok: true, agentSessionId: "agent-open" }));
	await copy.send(copy.window, { uiSessionId: openSession, turnId: "turn-open", routineRunId: open.runId });
	copy.window.minimized = true;
	assert.equal(copy.ask(other, { action: "open", runId: open.runId }).ok, true);
	assert.deepEqual({ ...opens(copy.window).at(-1) }, { type: "routine-open", sessionId: openSession, agentSessionId: "agent-open" }, "open from another window goes to the owner");
	assert.equal(opens(other).length, 0);
	assert.equal(copy.window.minimized, false, "and restores its window");
	assert.equal(copy.window.shown, 1);
	assert.equal(copy.window.focused, 1);
	assert.equal(copy.ask(other, { action: "remove", id: "gone" }).ok, false);
	const asking = copy.openWindow();
	copy.ready(asking);
	const ownerOpens = opens(copy.window).length;
	copy.window.webContents.emit("render-process-gone");
	assert.equal(copy.ask(asking, { action: "open", runId: open.runId }).ok, true);
	assert.equal(opens(copy.window).length, ownerOpens, "an owner whose page crashed cannot hear it");
	assert.equal(opens(asking).length, 1);
	copy.ready(copy.window);
	assert.equal(copy.ask(asking, { action: "open", runId: open.runId }).ok, true);
	assert.equal(opens(copy.window).length, ownerOpens + 1, "and takes it again once its page has registered");
	assert.equal(opens(asking).length, 1);
	copy.window.destroyed = true;
	copy.window.webContents.emit("destroyed");
	assert.equal(copy.ask(asking, { action: "open", runId: open.runId }).ok, true);
	assert.deepEqual({ ...opens(asking).at(-1) }, { type: "routine-open", sessionId: openSession, agentSessionId: "agent-open" }, "and to the asking window when the owner is gone");
	assert.equal(opens(other).length, 0, "not to the first ready window");
	assert.equal(asking.focused, 2);
	assert.equal(copy.ask(asking, { action: "open" }).ok, true);
	assert.deepEqual({ ...opens(asking).at(-1) }, { type: "routine-open" }, "no run means no sessionId");

	const removed = copy.ask(other, { action: "remove", id: copy.routineId });
	assert.equal(removed.ok, true);
	assert.equal(list().runs.some((item) => item.routineId === copy.routineId), false, "remove deletes the routine's runs");
	assert.equal(list().routines.some((item) => item.id === copy.routineId), false);

	const notice = launchWithRoutine();
	const noticeOther = notice.openWindow();
	notice.ready(notice.window);
	notice.ready(noticeOther);
	notice.at += 2 * MINUTE;
	notice.tick();
	const { sessionId: noticeSession, runId: noticeRunId } = fires(notice.window)[0];
	await notice.send(notice.window, { uiSessionId: noticeSession, turnId: "turn-1", routineRunId: noticeRunId });
	notice.host.emit({ type: "error", uiSessionId: noticeSession, turnId: "turn-1", message: "Failed." });
	notice.notifications[0].emit("click");
	assert.equal(opens(notice.window).at(-1).sessionId, noticeSession, "a click on a notice calls the same open path as the page");
	assert.equal(notice.window.focused, 1);
	assert.equal(vm.runInContext("routineNotices.size", notice.context), 0, "and lets the notice go");
	notice.window.destroyed = true;
	notice.window.webContents.emit("destroyed");
	const noticeSecond = launchWithRoutine();
	noticeSecond.ready(noticeSecond.window);
	noticeSecond.at += 2 * MINUTE;
	noticeSecond.tick();
	const { sessionId: secondSession, runId: secondNoticeRunId } = fires(noticeSecond.window)[0];
	await noticeSecond.send(noticeSecond.window, { uiSessionId: secondSession, turnId: "turn-1", routineRunId: secondNoticeRunId });
	noticeSecond.host.emit({ type: "error", uiSessionId: secondSession, turnId: "turn-1", message: "Failed." });
	const noticeLater = noticeSecond.openWindow();
	noticeSecond.ready(noticeLater);
	noticeSecond.window.destroyed = true;
	noticeSecond.window.webContents.emit("destroyed");
	noticeSecond.notifications[0].emit("click");
	assert.equal(opens(noticeLater).at(-1).sessionId, secondSession, "with the owner gone and nobody asking, the first ready window shows it");
	console.log("PASS routine actions: list, save, setEnabled, runNow, stop, remove, open and notice clicks");
}

async function checkRoutines() {
	await checkRoutineDispatch();
	await checkRoutineRuns();
	await checkRoutineActions();
}

async function checkUnloadTimeouts() {
	const copy = launchCopy();
	const timers = new Set();
	copy.context.setTimeout = (callback, delay) => {
		const timer = { callback, delay };
		timers.add(timer);
		return timer;
	};
	copy.context.clearTimeout = (timer) => timers.delete(timer);
	const reloads = vm.runInContext("reloadAppWindow", copy.context);
	const settle = async () => { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } };
	const close = (win) => win.emit("close", { preventDefault() {} });
	const expire = () => {
		assert.equal(timers.size, 1, "one deadline covers the whole unload attempt");
		const timer = [...timers][0];
		assert.equal(timer.delay, 5000);
		timer.callback();
	};
	const stalledClose = windows.at(-1);
	let finishClose;
	stalledClose.webContents.executeJavaScript = () => new Promise((resolve) => { finishClose = resolve; });
	copy.app.emit("before-quit", { preventDefault() {} });
	close(stalledClose);
	assert.equal(stalledClose.isDestroyed(), false, "quit first gives history a chance to save");
	expire();
	assert.equal(stalledClose.isDestroyed(), true, "a stalled renderer cannot keep its window open after the deadline");
	assert.equal(stalledClose.closes, undefined, "the fallback bypasses beforeunload, which may also be hung");
	assert.equal(TestWindow.getAllWindows().length, 0);
	copy.app.emit("window-all-closed");
	assert.equal(copy.quits, 1, "the final forced close completes quit");
	finishClose();
	await settle();
	assert.equal(stalledClose.closes, undefined, "late history readiness cannot retry a destroyed window");

	const stalledReload = copy.context.createWindow("initial-session");
	stalledReload.bounds = { x: 120, y: 140, width: 1100, height: 800 };
	stalledReload.maximized = true;
	stalledReload.webContents.getURL = () => "file:///index.html?session=current-session";
	let finishReload;
	stalledReload.webContents.executeJavaScript = () => new Promise((resolve) => { finishReload = resolve; });
	reloads.get(stalledReload)();
	assert.equal(stalledReload.isDestroyed(), false);
	expire();
	const replacement = windows.at(-1);
	assert.notEqual(replacement, stalledReload);
	assert.equal(stalledReload.isDestroyed(), true);
	assert.equal(replacement.isDestroyed(), false);
	assert.deepEqual(replacement.getNormalBounds(), stalledReload.bounds);
	assert.equal(replacement.isMaximized(), true);
	assert.equal(new URL(replacement.navigation.url).searchParams.get("session"), "current-session");
	const replacementCount = windows.length;
	finishReload();
	await settle();
	assert.equal(windows.length, replacementCount, "late readiness cannot create a second replacement");
	assert.equal(stalledReload.reloads, undefined);
	assert.equal(replacement.reloads, undefined);

	const hangsInUnload = copy.context.createWindow();
	close(hangsInUnload);
	await settle();
	assert.equal(hangsInUnload.closes, 1, "ready history first uses ordinary close");
	expire();
	assert.equal(hangsInUnload.isDestroyed(), true, "the deadline also covers a hung beforeunload handler");

	const upgraded = copy.context.createWindow();
	upgraded.webContents.executeJavaScript = () => new Promise(() => {});
	reloads.get(upgraded)();
	close(upgraded);
	const countBeforeClose = windows.length;
	expire();
	assert.equal(upgraded.isDestroyed(), true);
	assert.equal(windows.length, countBeforeClose, "closing during a stalled reload closes instead of opening a replacement");

	const completed = copy.context.createWindow();
	reloads.get(completed)();
	await settle();
	const finishedTimer = [...timers][0];
	completed.webContents.emit("did-finish-load");
	assert.equal(timers.size, 0, "a finished reload cancels its deadline");
	finishedTimer.callback();
	assert.equal(completed.isDestroyed(), false, "a canceled deadline cannot destroy the loaded page");
	console.log("PASS unload timeout: hung preparation, hung beforeunload, quit, replacement reload, geometry, session and late readiness");
}

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
	host.procs.set("live-chat", {});
	const liveLoops = await handlers.get("grok:session-loops")({}, "live-chat", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
	assert.equal(liveLoops.ok, true);
	assert.equal(liveLoops.live, true, "a running Grok keeps the notified loops");
	host.procs.delete("live-chat");
	const stoppedLoops = await handlers.get("grok:session-loops")({}, "stopped-chat", "not-a-session");
	assert.equal(stoppedLoops.ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(stoppedLoops.loops)), [], "a stopped session with no saved loops reads as none");
	assert.equal(savedDataReads.at(-1)?.action, "loops", "cold loops read WSL files outside the main process");
	assert.equal((await handlers.get("grok:context-breakdown")({}, "saved-id")).ok, true);
	assert.equal(savedDataReads.at(-1).action, "context");
	assert.equal((await handlers.get("grok:recent-spend")()).usd, 1);
	assert.equal(savedDataReads.at(-1).action, "spend", "turn-end spend reads leave the main process");
	exportDestination = path.join(root, "saved-export.md");
	assert.equal((await handlers.get("grok:export-markdown")({ sender: {} }, { agentSessionId: "saved-id" })).path, exportDestination);
	assert.equal(savedDataReads.at(-1).action, "export", "export lookup and WSL destination writes leave the main process");
	exportDestination = "";
	console.log("PASS saved WSL data: loops, context, spend and export dispatch off the main process");
	assert.equal(powerSaveBlocker.active, false);
	assert.equal(handlers.get("grok:reveal")({}, root, "a b,c.txt").ok, true);
	assert.equal(written, path.join(root, "a b,c.txt"), "Explorer receives the complete path, including spaces and commas");
	written = null;
	assert.equal(handlers.get("grok:reveal")({}, root, "missing").error, "Missing file.");
	assert.equal(written, null, "a failed lookup never opens Explorer");
	for (const file of ["tool.exe", "tool.bat", "tool.cmd", "tool.ps1", "tool.vbs", "tool.js", "tool.lnk", "disguised.pdf"]) {
		assert.equal((await handlers.get("grok:open-in")({}, { target: "explorer", cwd: root, file })).error, "That kind of file doesn't open from here.");
		assert.equal(written, null, "disallowed file types never reach the OS, including a PDF link targeting an executable");
	}
	assert.equal((await handlers.get("grok:open-in")({}, { target: "explorer", cwd: root, file: "report.PDF" })).ok, true);
	assert.equal(written, path.join(root, "report.PDF"));
	assert.equal((await handlers.get("grok:open-in")({}, { target: "explorer", cwd: root })).ok, true);
	assert.equal(written, root, "opening the session folder still works");
	written = null;
	assert.equal((await handlers.get("grok:open-in")({}, { target: "explorer", cwd: path.join(root, "electron", "main.cjs") })).error, "That folder is not on this computer.");
	assert.equal(written, null, "a file passed as cwd cannot bypass the default-app extension guard");
	console.log("PASS open-in IPC: allowed documents and folders open, executable types and disguised links are refused");
	handlers.get("grok:pr-create")({}, "folder", "feature");
	assert.equal(written[0], "folder");
	assert.equal(written[1].expected, "feature");
	handlers.get("grok:pr-create")({}, "folder", { invalid: true });
	assert.equal(written[1].expected, undefined);
	handlers.get("grok:pr-status")({}, "folder", 42);
	assert.deepEqual(written, ["folder", 42]);
	for (const number of [undefined, 0, -1, 1.5, "42"]) {
		handlers.get("grok:pr-status")({}, "folder", number);
		assert.deepEqual(written, ["folder", undefined], "invalid PR selectors use the current branch");
	}
	handlers.get("grok:pr-merge")({}, "folder", 42);
	assert.deepEqual(written, ["folder", 42]);
	handlers.get("grok:restore-worktree")({}, "worktree", "grok/topic");
	assert.deepEqual(written, ["worktree", "grok/topic"]);
	handlers.get("grok:new-window")();
	assert.equal(windows[1].navigation.url, pathToFileURL(pageFile).href);
	assert.equal(handlers.get("grok:new-window")({}, "chosen-session").ok, true);
	assert.equal(new URL(windows[2].navigation.url).searchParams.get("session"), "chosen-session");
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
	assert.deepEqual(windowsDockBadges, [], "Windows taskbar updates never use the Dock");
	assert.equal(handlers.get("grok:open-image")(first, imageFile).ok, true);
	assert.equal(windows.at(-1).options.parent, windows[0], "an image viewer belongs to the window that opened it");
	assert.equal(windows.at(-1).navigation.file, imageFile);
	const inputPrevented = (sender, input) => {
		let prevented = false;
		sender.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input);
		return prevented;
	};
	const ctrlR = { type: "keyDown", control: true, key: "r" };
	const cmdR = { type: "keyDown", meta: true, key: "r" };
	assert.equal(inputPrevented(first.sender, ctrlR), false, "the app forwards Ctrl+R to its renderer and terminal");
	const firstTerminal = handlers.get("grok:terminal-open")(first, { cwd: root }).id;
	const secondTerminal = handlers.get("grok:terminal-open")(second, { cwd: root }).id;
	for (const [channel, args] of [["write", ["echo x"]], ["input", ["x"]], ["resize", [80, 24]], ["interrupt", []]]) {
		assert.equal(handlers.get(`grok:terminal-${channel}`)(second, firstTerminal, ...args).ok, false, "another window cannot control a terminal");
		assert.equal(handlers.get(`grok:terminal-${channel}`)(first, firstTerminal, ...args).ok, true);
	}
	assert.equal(handlers.get("grok:terminal-close")(second, firstTerminal).ok, false);
	assert.deepEqual(terminals.closed, []);
	const terminalDelivery = [[], []];
	const terminalSenders = [first.sender.send, second.sender.send];
	first.sender.send = (...args) => terminalDelivery[0].push(args);
	second.sender.send = (...args) => terminalDelivery[1].push(args);
	terminals.emit({ type: "terminal-data", id: firstTerminal, data: "private terminal output" });
	assert.equal(terminalDelivery[0].length, 1);
	assert.equal(terminalDelivery[1].length, 0, "terminal output stays in its owning window");
	terminalDelivery[0].length = 0;
	for (const active of [true, false]) {
		accessibilitySupport = active;
		assert.equal(handlers.get("grok:accessibility-support")(), active);
		app.emit("accessibility-support-changed", {}, active);
		for (const delivery of terminalDelivery) {
			const [channel, event] = delivery.shift();
			assert.equal(channel, "grok:event");
			assert.deepEqual({ ...event }, { type: "accessibility-support-changed", active });
		}
	}
	[first.sender.send, second.sender.send] = terminalSenders;
	assert.equal(handlers.get("grok:terminal-open")(first, { cwd: "" }).ok, false);
	const endedTerminal = handlers.get("grok:terminal-open")(first, { cwd: root }).id;
	terminals.emit({ type: "terminal-exit", id: endedTerminal });
	first.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: pathToFileURL(pageFile).href });
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
	assert.equal((await handlers.get("grok:send")(first, { uiSessionId: "first", turnId: "turn" })).ok, true);
	assert.equal((await handlers.get("grok:send")(second, { uiSessionId: "first" })).ok, false);
	const browserReport = { uiSessionId: "first", enabled: true, visible: false, activeId: "", tabs: [] };
	assert.equal(handlers.get("grok:browser-tabs")(first, browserReport).ok, true);
	assert.deepEqual(browserCalls.at(-1), ["tabs", first.sender, browserReport]);
	for (const action of ["stop", "resume"]) {
		assert.equal(handlers.get(`grok:browser-${action}`)(second, "first").ok, false, "another window cannot change browser control");
		assert.equal(handlers.get(`grok:browser-${action}`)(first, "first").ok, true);
		assert.deepEqual(browserCalls.at(-1), [action, "first"]);
	}
	assert.equal((await handlers.get("grok:sign-out")()).ok, false, "signing out waits for a running reply");
	assert.equal(grokLogouts, 0);
	const running = host.turns.get("first");
	host.turns.set("first", { ...running, finished: true });
	assert.equal((await handlers.get("grok:sign-out")()).ok, true);
	assert.equal(grokLogouts, 1);
	assert.equal(host.signOuts, 1, "a signed-out Grok is stopped so the next message signs in again");
	await checkSignInIpc(first, second, running);
	await checkCloudIpc(first, second);
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
	host.turns.delete("first");
	host.retainedSteers.add("first");
	const beforeRetainedCancel = host.cancelled.length;
	handlers.get("grok:cancel")(second, "first");
	assert.equal(host.cancelled.length, beforeRetainedCancel, "another window cannot cancel a completed prompt's retained steers");
	handlers.get("grok:cancel")(first, "first");
	assert.deepEqual(host.cancelled.slice(beforeRetainedCancel), ["first"], "the prior owner can stop a retained steer before the finished reply reaches its window");
	host.cancelled.length = beforeRetainedCancel;
	const promptBeforeNotice = host.prompt;
	host.prompt = function(input) {
		const result = promptBeforeNotice.call(this, input);
		this.emit({ type: "chunk", uiSessionId: input.uiSessionId, turnId: input.turnId, text: "Grok restarted to apply the new permission mode." });
		return result;
	};
	assert.equal((await handlers.get("grok:send")(second, { uiSessionId: "first", turnId: "newer-turn" })).ok, true);
	host.prompt = promptBeforeNotice;
	assert.equal(delivered[1].at(-1)?.[1].text, "Grok restarted to apply the new permission mode.", "a synchronous dispatch notice reaches the sending window");
	delivered[1].length = 0;
	const newer = host.turns.get("first");
	host.turns.delete("first");
	assert.equal((await handlers.get("grok:send")(first, { uiSessionId: "first", turnId: "newer-turn" })).ok, false, "a retained turn id cannot be rebound to another window");
	host.turns.set("first", newer);
	handlers.get("grok:cancel")(first, "first");
	assert.equal(host.cancelled.length, beforeRetainedCancel, "the older window cannot cancel the newer window's active prompt");
	host.turns.set("first", { uiSessionId: "first", turnId: "steer-turn", fallback: true });
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "steer-turn", sourceTurnId: "turn", parallel: true, text: "New direction" });
	assert.deepEqual(delivered.map((list) => list.length), [1, 0], "a turn Grok starts for a late steer goes only to the window that steered");
	assert.equal(handlers.get("grok:steer")(first, "first", "Into the adopted turn").ok, true, "that window owns the adopted turn");
	assert.equal(handlers.get("grok:steer")(second, "first", "Not this window").ok, false);
	host.emit({ type: "chunk", uiSessionId: "first", turnId: "steer-turn", text: "Steer's reply" });
	host.emit({ type: "done", uiSessionId: "first", turnId: "turn", stopReason: "end_turn" });
	host.emit({ type: "chunk", uiSessionId: "first", turnId: "newer-turn", text: "New prompt's reply" });
	assert.deepEqual(delivered[0].map(([, event]) => event.turnId), ["steer-turn", "steer-turn", "turn"], "the old prompt and its fallback keep their original window");
	assert.deepEqual(delivered[1].map(([, event]) => event.turnId), ["newer-turn"], "the newer prompt keeps its own window while the fallback executes");
	host.turns.set("first", newer);
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "newer-turn", resume: true });
	assert.equal(handlers.get("grok:steer")(first, "first", "Wrong window after resume").ok, false);
	assert.equal(handlers.get("grok:steer")(second, "first", "Resumed normal prompt").ok, true, "execution ownership returns to the newer prompt's window");
	host.turns.set("first", { uiSessionId: "first", turnId: "unknown-source", fallback: true });
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "unknown-source", sourceTurnId: "no-match", parallel: true, text: "Unmatched late steer" });
	assert.equal(delivered[1].at(-1)[1].turnId, "unknown-source", "an unmatched fallback remains visible in the process owner's window");
	const cancelledBefore = host.cancelled.length;
	host.turns.set("nobody", { uiSessionId: "nobody", turnId: "orphan", fallback: true });
	host.emit({ type: "turn-start", uiSessionId: "nobody", turnId: "orphan", parallel: true, text: "No window" });
	assert.deepEqual(host.cancelled.slice(cancelledBefore), ["nobody"], "a turn Grok starts with no window to show it stops");
	host.turns.delete("nobody");
	host.cancelled.length = cancelledBefore;
	host.turns.set("first", running);
	host.emit({ type: "turn-start", uiSessionId: "first", turnId: "turn", resume: true });
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
	for (const source of ["about:srcdoc", "about:srcdoc#section"]) {
		for (const url of ["https://example.test/", "file:///private.txt"]) {
			let prevented = false;
			windows[0].webContents.emit("will-frame-navigate", { isMainFrame: false, frame: { url: source }, url, preventDefault() { prevented = true; } });
			assert.equal(prevented, true, "HTML previews cannot navigate to network or file destinations");
		}
	}
	for (const details of [
		{ isMainFrame: false, frame: { url: "about:blank" }, url: "about:srcdoc" },
		{ isMainFrame: false, frame: { url: "about:srcdoc" }, url: "about:srcdoc" },
		{ isMainFrame: false, frame: { url: "https://example.test/" }, url: "https://example.test/next" },
		{ isMainFrame: false, frame: { url: "about:srcdocarbitrary" }, url: "https://example.test/" },
		{ isMainFrame: false, url: "https://example.test/" },
	]) {
		let prevented = false;
		windows[0].webContents.emit("will-frame-navigate", { ...details, preventDefault() { prevented = true; } });
		assert.equal(prevented, false, "initial preview loads, refreshes and unrelated frames stay unchanged");
	}
	for (const name of ["will-frame-navigate", "will-redirect"]) {
		for (const url of ["https://example.test/", "file:///private.html", "data:text/html,other"]) {
			let prevented = false;
			windows[0].webContents.emit(name, { isMainFrame: true, url, preventDefault() { prevented = true; } });
			assert.equal(prevented, true, `main window blocks ${name} to ${url}`);
		}
	}
	windows[0].webContents.emit("will-frame-navigate", {
		isMainFrame: true,
		url: pathToFileURL(pageFile).href,
		preventDefault() { assert.fail("the app page can reload"); },
	});
	windows[0].webContents.emit("will-frame-navigate", {
		isMainFrame: true,
		url: pathToFileURL(pageFile).href.replace(/^file:\/\/\/([A-Z]):/, (_match, drive) => `file:///${drive.toLowerCase()}:`),
		preventDefault() { assert.fail("drive-letter case cannot block the app page"); },
	});
	console.log("PASS HTML preview navigation: network and local navigation blocked, initial loads and refreshes allowed");
	const restOfWindows = windows.splice(1);
	botWindow.held = true;
	let closeHeld = false;
	const closesBefore = windows[0].closes || 0;
	windows[0].emit("close", { preventDefault() { closeHeld = true; } });
	assert.equal(closeHeld, true, "a window holding Grok Bot's window doesn't close yet");
	assert.deepEqual([botWindow.closed, botWindow.releases], [1, 0], "closing the app's last window closes Grok Bot");
	assert.equal(windows[0].closes || 0, closesBefore);
	botWindow.finish();
	await new Promise(setImmediate);
	assert.equal(windows[0].closes, closesBefore + 1, "the window closes once Grok Bot has left it");
	const imageWindow = new TestWindow({ parent: windows[0] });
	botWindow.held = true;
	windows[0].emit("close", { preventDefault() {} });
	assert.deepEqual([botWindow.closed, botWindow.releases], [2, 0], "an image opened from it doesn't count as another window");
	botWindow.finish();
	await new Promise(setImmediate);
	windows.splice(windows.indexOf(imageWindow), 1);
	const otherWindow = new TestWindow({});
	botWindow.held = true;
	windows[0].emit("close", { preventDefault() {} });
	assert.deepEqual([botWindow.closed, botWindow.releases], [2, 1], "with another window open, Grok Bot goes back to the desktop");
	botWindow.finish();
	await new Promise(setImmediate);
	botWindow.held = true;
	let quitHeld = false;
	app.emit("before-quit", { preventDefault() { quitHeld = true; } });
	assert.equal(quitHeld, true, "a quit waits the same way");
	assert.deepEqual([botWindow.closed, botWindow.releases], [3, 1], "and closes Grok Bot, whatever else is open");
	windows.splice(windows.indexOf(otherWindow), 1);
	windows.push(...restOfWindows);
	const quitsBefore = app.quitCalls || 0;
	botWindow.finish();
	await new Promise(setImmediate);
	assert.equal(app.quitCalls, quitsBefore + 1, "then the quit carries on");
	console.log("PASS Grok Bot window: closing the last window and quitting close Grok Bot first, and any other window puts it back on the desktop");
	botWindow.hides.length = 0;
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
	assert.equal(host.cancelled.length, 0);
	assert.deepEqual(botWindow.hides, [], "only a page that really leaves hides Grok Bot's window");
	host.turns.delete("first");
	host.retainedSteers.add("first");
	windows[0].webContents.emit("destroyed");
	assert.deepEqual(host.cancelled, ["first"], "a window closes its retained steer even after the original turn completed");
	host.cancelled.length = 0;
	host.turns.set("first", running);
	windows[0].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: pathToFileURL(pageFile).href });
	assert.deepEqual(host.cancelled, ["first"]);
	assert.deepEqual(botWindow.hides, [windows[0]], "a reloading page hides Grok Bot's window");
	windows[0].webContents.emit("render-process-gone");
	assert.deepEqual(botWindow.hides, [windows[0], windows[0]], "so does a crashed page");
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
	const preloadEvents = new EventEmitter();
	const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
	const appPage = pathToFileURL(pageFile).href;
	const argv = windows[0].options.webPreferences.additionalArguments;
	assert.deepEqual(Array.from(argv), [`--grok-app-page=${appPage}`]);
	const runPreload = (href, isMainFrame = true, pageArgs = argv) => vm.compileFunction(preload, [], { parsingContext: vm.createContext({
		require: () => ({
			contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
			ipcRenderer: {
				invoke: (...args) => { written = args; },
				sendSync: (name, ...args) => { const event = {}; handlers.get(name)(event, ...args); return event.returnValue; },
				on: (...args) => preloadEvents.on(...args),
				removeListener: (...args) => preloadEvents.removeListener(...args),
			},
		}),
		process: { platform: "darwin", argv: pageArgs, isMainFrame },
		window: { location: { href } },
	}) })();
	for (const href of ["https://example.test/dist/index.html", "file:///unrelated/dist/index.html", "data:text/html,error"]) {
		runPreload(href);
		assert.equal(api, undefined, "an off-app page receives no bridge");
	}
	runPreload(appPage, false);
	assert.equal(api, undefined, "a subframe receives no bridge");
	runPreload("file:///C:/GrokCode/dist/index.html", true, ["--grok-app-page=file:///c:/GrokCode/dist/index.html"]);
	assert.ok(api, "an uppercase Chromium drive letter matches a lowercase launch path");
	api = undefined;
	runPreload(`${appPage}?session=restored#chat`);
	assert.equal(api.homeDir, require("node:os").homedir(), "the first session's folder comes from this computer, not a fixed path");
	assert.equal(api.platform, "darwin", "the renderer learns the platform from the preload");
	assert.equal(api.readColdChat("../outside"), null, "the preload reaches the chat store, which refuses an id that leaves its folder");
	assert.equal(api.writeColdChat("../outside", "[]"), false, "the preload reaches the chat store, which refuses an id that leaves its folder");
	api.removeColdChats(["../outside"]);
	assert.deepEqual(written, ["grok:remove-cold-chats", ["../outside"]]);
	checkColdChats();
	api.accessibilitySupport();
	assert.deepEqual(written, ["grok:accessibility-support"]);
	api.browserTabs(browserReport);
	assert.deepEqual(written, ["grok:browser-tabs", browserReport]);
	api.browserStop("first");
	assert.deepEqual(written, ["grok:browser-stop", "first"]);
	api.browserResume("first");
	assert.deepEqual(written, ["grok:browser-resume", "first"]);
	const browserProblems = [];
	const removeBrowserProblems = api.onBrowserProblem((problem) => browserProblems.push(problem));
	const browserProblem = { webContentsId: 17, url: "https://example.test/", message: "HTTP 404", at: 123 };
	preloadEvents.emit("grok:browser-problem", { sender: "private IPC event" }, browserProblem);
	assert.deepEqual(browserProblems, [browserProblem], "the browser subscription forwards only its problem payload");
	removeBrowserProblems();
	preloadEvents.emit("grok:browser-problem", {}, browserProblem);
	assert.equal(browserProblems.length, 1, "the Browser pane subscription can be removed");
	api.readImage("folder", "image.png");
	assert.deepEqual(written, ["grok:read-image", "folder", "image.png"]);
	assert.equal(handlers.get("grok:read-image")({}, "folder", "image.png").dataUrl, "data:image/png;base64,AA==");
	assert.deepEqual(written, ["folder", "image.png"]);
	api.readiness();
	assert.deepEqual(written, ["grok:readiness", undefined]);
	const setupRequest = { folder: root, full: true };
	api.readiness(setupRequest);
	assert.deepEqual(written, ["grok:readiness", setupRequest], "the preload forwards the full setup request");
	api.updateGrokCli();
	assert.deepEqual(written, ["grok:update-grok-cli"]);
	api.openAtSignIn();
	assert.deepEqual(written, ["grok:open-at-sign-in", undefined], "with no argument the setting is only read");
	api.openAtSignIn(true);
	assert.deepEqual(written, ["grok:open-at-sign-in", true]);
	api.routinesReady();
	assert.deepEqual(written, ["grok:routines-ready"]);
	api.routines({ action: "list" });
	assert.deepEqual(written, ["grok:routines", { action: "list" }]);
	api.routineResult("run-1", { ok: false, error: "No." });
	assert.deepEqual(written, ["grok:routine-result", "run-1", { ok: false, error: "No." }]);
	api.signInStatus();
	assert.deepEqual(written, ["grok:sign-in-status"]);
	const profileInput = { mode: "key" };
	const profileOptions = { signOutConfirmed: true };
	api.saveSignIn(profileInput, profileOptions);
	assert.deepEqual(written, ["grok:sign-in-save", profileInput, profileOptions]);
	api.removeSignInKey();
	assert.deepEqual(written, ["grok:sign-in-remove-key"]);
	const cloudInput = { uiSessionId: "cloud-session", turnId: "turn" };
	for (const [method, channel, args] of [
		["status", "status", []], ["signIn", "sign-in", []], ["cancelSignIn", "cancel-sign-in", []], ["signOut", "sign-out", []],
		["history", "history", ["bot-1", "9007199254740993"]], ["send", "send", [{ agentId: "bot-1", messageId: "id", text: "hello" }]],
		["stop", "stop", ["bot-1"]], ["answer", "answer", [{ agentId: "bot-1", entryId: "row-1", value: "yes" }]],
		["openFile", "open-file", [{ agentId: "bot-1", entryId: "row-2" }]], ["retry", "retry", []],
	]) {
		api[`grokBot${method[0].toUpperCase()}${method.slice(1)}`](...args);
		assert.ok(written[0] === `grok:grokbot-${channel}` && written.length === args.length + 1 && args.every((arg, index) => written[index + 1] === arg), `${method} preload forwarding`);
		assert.equal(handlers.get(`grok:grokbot-${channel}`)({}, ...args).ok, true);
		assert.deepEqual(botCalls.at(-1), [method, ...args], `${method} main forwarding`);
	}
	for (const [method, channel, args] of [
		["cloudKeyStatus", "key-status", []], ["cloudKeySave", "key-save", ["test-not-a-key"]], ["cloudKeyRemove", "key-remove", []],
		["cloudSetup", "setup", [root]], ["cloudSend", "send", [cloudInput]], ["cloudResume", "resume", [cloudInput]], ["cloudCancel", "cancel", [cloudInput.uiSessionId]],
	]) {
		api[method](...args);
		assert.ok(written.length === args.length + 1 && written[0] === `grok:cloud-${channel}` && args.every((arg, index) => written[index + 1] === arg), `${method} forwards its arguments`);
	}
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
	assert.equal(updateChecks.at(-1)[2].packaged, false, "a copy run from source uses the source update check");
	updateResult = { ok: true, message: "Updated to version 0.2.0." };
	assert.equal(handlers.get("grok:update-result")().message, "Updated to version 0.2.0.");
	assert.equal(handlers.get("grok:update-result")(), null, "the update result is read only once");
	api.taskbar("running");
	assert.deepEqual(written, ["grok:taskbar", "running"]);
	const launchReadiness = await handlers.get("grok:readiness")();
	assert.equal(launchReadiness.grok.signedIn, true);
	assert.deepEqual(readinessCalls.at(-1), ["", false], "a launch setup check stays light");
	assert.deepEqual({ ...launchReadiness.app }, { version: "0.1.0", electron: "45.0.0", os: `win32 ${require("node:os").release()} ${process.arch}` }, "setup includes app, Electron and OS versions");
	assert.equal((await handlers.get("grok:readiness")({}, setupRequest)).grok.signedIn, true);
	assert.deepEqual(readinessCalls.at(-1), [root, true], "full setup checks forward the session folder");
	await handlers.get("grok:readiness")({}, { folder: 123, full: "true" });
	assert.deepEqual(readinessCalls.at(-1), ["", false], "malformed setup requests use a light check and no folder");
	assert.equal(readinessChecks, 3, "every setup check asks the backend again");
	assert.equal((await handlers.get("grok:update-grok-cli")()).ok, true);
	assert.equal(grokUpdates, 1, "Grok CLI updates use customize.updateGrok");
	console.log("PASS doctor IPC: request forwarding, light defaults, app metadata and mocked Grok CLI update");
	api.writeFile("folder", "file", "text", "version");
	assert.deepEqual(written, ["grok:write", "folder", "file", "text", "version"]);
	const revertHunk = { id: "hunk", loc: "@@ -1 +1 @@", lines: [{ kind: "del", text: "before" }, { kind: "add", text: "after" }] };
	api.revertHunk("folder", "file", revertHunk);
	assert.deepEqual(written, ["grok:revert-hunk", "folder", "file", revertHunk]);
	assert.equal(handlers.get("grok:revert-hunk")({}, "folder", "file", revertHunk).ok, true);
	assert.deepEqual(written, ["folder", "file", revertHunk]);
	console.log("PASS hunk revert IPC: captured file and hunk forwarded through preload and host handler");
	const revertFile = handlers.get("grok:revert");
	const sandboxRevert = { sandbox: true };
	const revertDialogs = dialogs.length;
	api.revertFile("folder", "filtered", sandboxRevert);
	assert.deepEqual(written, ["grok:revert", "folder", "filtered", sandboxRevert]);
	assert.equal((await revertFile(first, "folder", "unfiltered", sandboxRevert)).ok, true);
	api.revertFile("folder", "filtered");
	assert.deepEqual(written, ["grok:revert", "folder", "filtered"]);
	assert.equal((await revertFile(first, "folder", "filtered")).ok, true);
	assert.equal(dialogs.length, revertDialogs, "unfiltered sandbox reverts and all non-sandbox reverts skip the filter prompt");
	const priorDialogChoice = dialogChoice;
	dialogChoice = 1;
	assert.equal((await revertFile(first, "folder", "filtered", sandboxRevert)).ok, false);
	assert.match(dialogs.at(-1).message, /Allow Git filters to revert filtered/);
	assert.match(dialogs.at(-1).detail, /outside the sandbox/);
	assert.equal(dialogs.at(-1).defaultId, 1);
	dialogChoice = 0;
	assert.equal((await revertFile(first, "folder", "filtered", sandboxRevert)).ok, true);
	dialogChoice = priorDialogChoice;
	dialogs.length = revertDialogs;
	console.log("PASS file revert IPC: sandbox policy forwarded and the filter prompt defaults to cancel");
	api.taskOutput("task.log");
	assert.deepEqual(written, ["grok:task-output", "task.log"]);
	assert.equal((await handlers.get("grok:task-output")({}, "task.log")).text, "task output");
	assert.deepEqual(written, ["task.log", undefined], "a file in no known Grok home gets the default root, which refuses it");
	api.subagentTranscript("child-id");
	assert.deepEqual(written, ["grok:subagent-transcript", "child-id"]);
	assert.equal((await handlers.get("grok:subagent-transcript")({}, "child-id")).ok, true);
	assert.deepEqual(written, ["child-id", path.join(root, "no-such-grok", "sessions")]);
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
	const commitOptions = { paths: ["a.txt"], message: "Fix it", push: false, expected: "feature" };
	api.gitCommit("folder", commitOptions);
	assert.deepEqual(written, ["grok:git-commit", "folder", commitOptions]);
	assert.equal(handlers.get("grok:git-commit")({}, "folder", commitOptions).ok, true);
	assert.deepEqual(written, ["folder", commitOptions], "the direct commit bridge forwards options without executing Git");
	console.log("PASS direct commit IPC: options forwarding through preload and host handler");
	const sandboxDialogs = dialogs.length;
	const sendSandbox = handlers.get("grok:send");
	sandboxGitSnapshot = async (folder) => {
		assert.equal(folder, root);
		assert.equal(host.turns.has("sandbox-git"), false, "the baseline is read before Grok starts");
		return { ok: true, config: "initial-config", hooks: "initial-hooks" };
	};
	assert.equal((await sendSandbox(first, { uiSessionId: "sandbox-git", cwd: root, sandbox: { option: "profile" } })).ok, true);
	assert.match(sandboxGitSaved, /initial-config/);
	vm.runInContext("sandboxGitBaselines = undefined", mainContext);
	let config = "initial-config";
	let hooks = "initial-hooks";
	let rawFormatting = "";
	const upstreamBranches = new Set();
	sandboxGitSnapshot = async (_folder, compareUpstream) => {
		const branches = new Set(upstreamBranches);
		const capturedConfig = config;
		return {
			ok: true, config: [config, ...branches].join("/") + rawFormatting, hooks,
			...(compareUpstream ? { upstream: (branch) => ({ config: capturedConfig, established: branches.has(branch) }) } : {}),
		};
	};
	const sandboxCommit = { ...commitOptions, sandbox: true, hooks: false };
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, true);
	assert.equal(written[1].hooks, false, "sandbox commit uses hooks off by default");
	assert.equal(dialogs.length, sandboxDialogs, "a matching baseline adds no second commit dialog");

	dialogChoice = 0;
	api.prCreate(root, "feature", { sandbox: true });
	assert.deepEqual(written, ["grok:pr-create", root, "feature", { sandbox: true }]);
	dialogChecked = true;
	onPrCreate = ({ expected, onUpstream }) => { upstreamBranches.add(expected); onUpstream(expected); };
	assert.equal((await handlers.get(written[0])(first, ...written.slice(1))).ok, true);
	onPrCreate = undefined;
	assert.equal(dialogs.at(-1).checkboxChecked, false, "Create PR starts with the explicit hook choice off");
	assert.match(dialogs.at(-1).detail, /With hooks off, the push can skip uploading Git LFS files/);
	assert.equal(written[1].hooks, true);
	assert.match(sandboxGitSaved, /initial-config\/feature/);
	vm.runInContext("sandboxGitBaselines = undefined", mainContext);
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, true);
	assert.equal(dialogs.length, sandboxDialogs + 1, "the config changed by Create PR does not warn on the next action");

	onPrCreate = ({ expected, onUpstream }) => { rawFormatting = "-normalized"; onUpstream(expected); };
	assert.equal((await handlers.get("grok:pr-create")(first, root, "feature", { sandbox: true })).ok, true);
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, true);
	assert.equal(dialogs.length, sandboxDialogs + 2, "rewriting the formatting of an established upstream adds no warning");

	const beforeCommitPush = dialogs.length;
	onCommitFiles = ({ onUpstream }) => { upstreamBranches.add("commit-feature"); onUpstream?.("commit-feature"); };
	assert.equal((await handlers.get("grok:git-commit")(first, root, { ...sandboxCommit, push: true })).ok, true);
	onCommitFiles = undefined;
	vm.runInContext("sandboxGitBaselines = undefined", mainContext);
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, true);
	assert.equal(dialogs.length, beforeCommitPush, "Commit and push's own upstream change adds no warning");
	assert.match(sandboxGitSaved, /commit-feature/);
	onCommitFiles = ({ onUpstream }) => {
		upstreamBranches.add("other-commit");
		config = "changed-during-commit";
		hooks = "changed-during-commit";
		onUpstream?.("other-commit");
	};
	assert.equal((await handlers.get("grok:git-commit")(first, root, { ...sandboxCommit, push: true })).ok, true);
	onCommitFiles = undefined;
	vm.runInContext("sandboxGitBaselines = undefined", mainContext);
	dialogChoice = 1;
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, false);
	assert.match(dialogs.at(-1).detail, /Git configuration and Git hooks changed/);
	assert.doesNotMatch(sandboxGitSaved, /changed-during-commit/);
	dialogChoice = 0;
	assert.equal((await handlers.get("grok:git-commit")(first, root, sandboxCommit)).ok, true);

	onPrCreate = ({ expected, onUpstream }) => {
		upstreamBranches.add(expected);
		config = "changed-config";
		hooks = "changed-hooks";
		onUpstream(expected);
	};
	assert.equal((await handlers.get("grok:pr-create")(first, root, "another-feature", { sandbox: true })).ok, true);
	onPrCreate = undefined;
	vm.runInContext("sandboxGitBaselines = undefined", mainContext);
	dialogChoice = 1;
	const lastCommit = written;
	assert.equal((await handlers.get("grok:git-commit")(first, root, { ...sandboxCommit, push: true, hooks: true })).ok, false);
	assert.equal(written, lastCommit, "cancelling the warning prevents the Git action");
	assert.match(dialogs.at(-1).detail, /Git configuration and Git hooks changed since the last saved Git snapshot/);
	assert.match(dialogs.at(-1).detail, /Git hooks will run for this action/);
	assert.doesNotMatch(sandboxGitSaved, /changed-config/, "cancelling leaves the prior snapshot intact");

	dialogChoice = 0;
	dialogChecked = false;
	assert.equal((await handlers.get("grok:add-worktree")(first, root, { name: "test", prefix: "grok", sandbox: true })).ok, true);
	assert.match(dialogs.at(-1).detail, /Git configuration and Git hooks changed/, "a cancelled warning repeats on the next action");
	assert.match(dialogs.at(-1).detail, /worktree can keep Git LFS pointers/);
	assert.equal(written[1].hooks, false);
	assert.match(sandboxGitSaved, /changed-config/);

	const restoredFolder = path.join(root, ".grok", "worktrees", "test");
	api.restoreWorktree(restoredFolder, "grok/test", { sandbox: true });
	assert.deepEqual(written, ["grok:restore-worktree", restoredFolder, "grok/test", { sandbox: true }]);
	const restoreArgs = written.slice(1);
	const restore = handlers.get(written[0]);
	hooks = "changed-during-restore-preflight";
	dialogChoice = 1;
	assert.equal((await restore(first, ...restoreArgs)).ok, false);
	assert.deepEqual(written, ["grok:restore-worktree", ...restoreArgs], "cancelling never calls the Git write");
	assert.match(dialogs.at(-1).detail, /Git hooks changed/);
	assert.match(dialogs.at(-1).detail, /worktree can keep Git LFS pointers/);
	assert.equal(dialogs.at(-1).checkboxChecked, false);
	dialogChoice = 0;
	assert.equal((await restore(first, ...restoreArgs)).ok, true);
	assert.deepEqual(written, [restoredFolder, "grok/test", false]);
	dialogChecked = true;
	assert.equal((await restore(first, ...restoreArgs)).ok, true);
	assert.deepEqual(written, [restoredFolder, "grok/test", true]);
	dialogChecked = false;

	const anotherRepo = path.join(root, "another-repo");
	let finishSnapshot;
	sandboxGitSnapshot = () => new Promise((resolve) => { finishSnapshot = resolve; });
	const waiting = sendSandbox(first, { uiSessionId: "snapshot-pending", cwd: anotherRepo, sandbox: { option: "profile" } });
	handlers.get("grok:cancel")(first, "snapshot-pending");
	finishSnapshot({ ok: false });
	assert.equal((await waiting).error, "Stopped.");
	assert.equal(host.turns.has("snapshot-pending"), false);
	sandboxGitSnapshot = async () => ({ ok: true, config: "recovered-config", hooks: "recovered-hooks" });
	assert.equal((await handlers.get("grok:git-commit")(first, anotherRepo, sandboxCommit)).ok, true);
	assert.match(dialogs.at(-1).detail, /could not be compared with a saved snapshot/);
	const afterRecovery = dialogs.length;
	assert.equal((await handlers.get("grok:git-commit")(first, anotherRepo, sandboxCommit)).ok, true);
	assert.equal(dialogs.length, afterRecovery, "the accepted pre-action snapshot replaces the unavailable baseline");
	dialogs.splice(sandboxDialogs);
	dialogChoice = 1;
	console.log("PASS sandbox Git IPC: changes during actions, upstream exception, unavailable recovery, cancel, restore hooks and LFS copy");
	const removeOptions = { branch: "review/topic", force: true };
	api.removeWorktree("repo", "worktree", removeOptions);
	assert.deepEqual(written, ["grok:remove-worktree", "repo", "worktree", removeOptions]);
	assert.equal((await handlers.get(written[0])(first, ...written.slice(1))).ok, true);
	assert.equal(host.stoppedFolder, "worktree");
	assert.deepEqual([...written.slice(0, 2), { ...written[2] }], ["repo", "worktree", removeOptions]);
	const worktreeFolder = path.join(root, "auto-archive-worktree");
	const worktreeTurn = { uiSessionId: "auto-archive-turn", cwd: path.join(worktreeFolder, "nested") };
	const removeAutoWorktree = () => handlers.get("grok:remove-worktree")(first, root, worktreeFolder, { autoArchive: true, branch: "grok/archive" });
	let finishRemovalCheck;
	onRemoveWorktree = (_cwd, _folder, options) => new Promise((resolve) => {
		finishRemovalCheck = () => resolve(options.beforeRemove?.() === false ? { ok: false, skipped: true } : { ok: true });
	});
	const checkingRemoval = removeAutoWorktree();
	await new Promise(setImmediate);
	assert.equal(typeof finishRemovalCheck, "function");
	assert.equal((await handlers.get("grok:send")(first, worktreeTurn)).ok, true, "a prompt can start during the removal check");
	host.turns.delete(worktreeTurn.uiSessionId);
	finishRemovalCheck();
	assert.equal((await checkingRemoval).skipped, true, "a turn that started during the sweep still protects the folder if it has finished");
	let finishDeletion;
	onRemoveWorktree = (_cwd, _folder, options) => {
		assert.equal(options.beforeRemove(), true);
		return new Promise((resolve) => { finishDeletion = () => resolve({ ok: true }); });
	};
	const deletingWorktree = removeAutoWorktree();
	await new Promise(setImmediate);
	const duringDeletion = await handlers.get("grok:send")(first, worktreeTurn);
	assert.match(duringDeletion.error, /being auto-archived/);
	assert.equal(host.turns.has(worktreeTurn.uiSessionId), false, "no turn runs inside Git's irreversible removal");
	finishDeletion();
	assert.equal((await deletingWorktree).ok, true);
	onRemoveWorktree = undefined;
	console.log("PASS auto-archive IPC: new turns cancel preflight, and deletion and turn startup cannot overlap");
	api.prStatus("folder", 42);
	assert.deepEqual(written, ["grok:pr-status", "folder", 42]);
	api.prStatus("folder");
	assert.deepEqual(written, ["grok:pr-status", "folder", undefined]);
	console.log("PASS PR status IPC: valid selector forwarding, invalid selector defaults and preload arguments");
	const changeRequest = { id: "old", cwd: root, scope: "uncommitted", file: "sample.txt", full: true };
	api.readChanges(changeRequest);
	assert.deepEqual(written, ["grok:read-changes", changeRequest]);
	api.stopChanges(changeRequest.id);
	assert.deepEqual(written, ["grok:stop-changes", "old"]);
	const readChanges = handlers.get("grok:read-changes");
	const stopChanges = handlers.get("grok:stop-changes");
	const changeSender = { sender: new EventEmitter() };
	const previousRead = readChanges(changeSender, changeRequest);
	stopChanges({ sender: new EventEmitter() }, "old");
	assert.equal(changeReads.get("old").signal.aborted, false, "other windows cannot stop a read");
	const replacementRead = readChanges(changeSender, { ...changeRequest, id: "new" });
	assert.equal(changeReads.get("old").signal.aborted, true);
	changeReads.get("old").finish({ ok: false });
	await previousRead;
	stopChanges(changeSender, "old");
	assert.equal(changeReads.get("new").signal.aborted, false, "an old cancellation cannot stop its replacement");
	stopChanges(changeSender, "new");
	assert.equal(changeReads.get("new").signal.aborted, true, "a late old completion leaves the replacement stoppable");
	changeReads.get("new").finish({ ok: false });
	await replacementRead;
	console.log("PASS Changes IPC: stop is sender-owned and replacements ignore late completions");
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
	const guarded = windows[2];
	const close = () => {
		let prevented = false;
		guarded.emit("close", { preventDefault() { prevented = true; } });
		return prevented;
	};
	let allowed = 0;
	const unload = () => guarded.webContents.emit("will-prevent-unload", { preventDefault: () => { allowed += 1; } });
	const settle = async () => { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } };
	let releaseClose;
	guarded.webContents.executeJavaScript = (script) => {
		assert.equal(script, "window.grokPrepareUnload?.()");
		return new Promise((resolve) => { releaseClose = resolve; });
	};
	dialogChoice = 1;
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).ok, true);
	assert.equal((await handlers.get("grok:update-start")({}, "v0.2.0")).error, "An update is already running.");
	app.emit("before-quit");
	assert.equal(close(), true, "the first close waits for the renderer to get the history lock");
	assert.equal(close(), true, "repeated close also waits for the same lock request");
	await settle();
	assert.equal(guarded.closes, undefined, "Electron hasn't resumed close while the lock is held");
	releaseClose();
	await settle();
	assert.equal(guarded.closes, 1, "the close resumes when the history lock is available");
	assert.equal(close(), false, "the resumed close reaches beforeunload");
	unload();
	await settle();
	assert.equal(dialogs.at(-1).message, "Some text is not saved or sent yet.");
	assert.equal(dialogs.at(-1).detail, "Keep the window open to finish saving or to send the queued message. If it closes now, that text is lost.");
	assert.equal(allowed, 0, "Keep window open keeps the close blocked");
	assert.equal(guarded.closes, 1);
	assert.equal(terminals.closed.length, closedBeforeUnload, "a canceled close keeps the window's terminals");
	assert.equal(terminals.closeAllCalls, 0, "a canceled quit leaves terminals running");
	assert.equal(vm.runInContext("pendingUpdate", mainContext), null, "Keep window open cancels the pending update too");
	guarded.webContents.executeJavaScript = async () => {};
	dialogChoice = 0;
	assert.equal(close(), true);
	await settle();
	assert.equal(close(), false);
	unload();
	unload();
	assert.equal(dialogs.length, 2, "a second close while the question is open asks nothing new");
	assert.equal(allowed, 0, "the unload waits for the answer");
	await settle();
	assert.equal(guarded.closes, 3, "Close anyway closes the window again");
	assert.equal(close(), false);
	unload();
	assert.equal(allowed, 1, "and lets that close through");
	guarded.webContents.emit("did-finish-load");
	unload();
	await settle();
	assert.equal(guarded.reloads, 1, "a reload also waits for the lock before retrying");
	unload();
	await settle();
	assert.equal(guarded.reloads, 2, "Close anyway during a reload reloads instead of closing");
	assert.equal(guarded.closes, 3);
	guarded.webContents.emit("did-navigate");
	assert.equal(terminals.closed.at(-1), guardedTerminal);
	assert.equal(terminals.closeAllCalls, 0, "owner cleanup never closes every window's terminals");
	const viewMenu = appMenu.find((item) => item.label === "View").submenu;
	const reload = viewMenu.find((item) => item.label === "Reload");
	assert.equal(reload.role, undefined);
	assert.equal(reload.accelerator, undefined);
	reload.click(reload, windows[0]);
	await settle();
	assert.equal(windows[0].reloads, 1, "clicking View > Reload still reloads the selected window");
	const defaultUi = viewMenu.find((item) => item.label === "Use Default UI");
	const uiEvents = [];
	const uiWindow = { isDestroyed: () => false, webContents: { send: (...args) => uiEvents.push(args) } };
	defaultUi.click({}, uiWindow);
	defaultUi.click({}, undefined);
	assert.equal(uiEvents.length, 1, "the recovery menu sends once to the current window");
	assert.equal(uiEvents[0][0], "grok:event");
	assert.equal(uiEvents[0][1].type, "ui-default");
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
		[{ ok: true, available: false, reason: "no-releases" }, "No published GitHub release with a matching tag in this copy's origin was found."],
		[{ ok: true, available: false, reason: "not-checkout" }, "This copy isn't a git checkout of the app."],
		[{ ok: false }, "The update check couldn't finish checking GitHub releases and this copy's origin."],
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
	const otherPage = windows[1].webContents;
	otherPage.setWindowOpenHandler = () => {};
	app.emit("web-contents-created", {}, otherPage);
	const browserDeliveries = [[], []];
	const previousBrowserSends = [page.send, otherPage.send];
	page.send = (...args) => browserDeliveries[0].push(args);
	otherPage.send = (...args) => browserDeliveries[1].push(args);
	const attachBrowserGuest = (owner, id, partition, validate = true) => {
		if (validate) { owner.emit("will-attach-webview", { preventDefault() {} }, {}, { src: "https://example.test/", partition }); }
		const attached = new EventEmitter();
		attached.id = id;
		attached.session = electron.session.fromPartition(partition);
		attached.hostWebContents = owner;
		attached.isDestroyed = () => !!attached.gone;
		attached.setWindowOpenHandler = () => {};
		attached.reloads = 0;
		attached.reload = () => { attached.reloads++; };
		owner.emit("did-attach-webview", {}, attached);
		return attached;
	};
	assert.equal(guest.webRequest.errors.length, 0, "validation without an actual Browser pane attachment installs no diagnostics");
	const tabOne = attachBrowserGuest(page, 201, "temp:grok-1");
	const tabTwo = attachBrowserGuest(page, 202, "temp:grok-1");
	attachBrowserGuest(otherPage, 203, "temp:grok-1");
	assert.equal(inputPrevented(tabOne, ctrlR), true);
	assert.equal(inputPrevented(tabOne, { ...ctrlR, isAutoRepeat: true }), true);
	for (const input of [cmdR, { ...ctrlR, alt: true }, { ...ctrlR, shift: true }, { ...ctrlR, type: "keyUp" }]) {
		assert.equal(inputPrevented(tabOne, input), false, JSON.stringify(input));
	}
	assert.equal(tabOne.reloads, 1, "Ctrl+R reloads just the focused Browser page");
	assert.equal(tabTwo.reloads, 0);
	assert.equal(windows[0].reloads, 1, "the Browser shortcut never reloads the owning window");
	assert.equal(guest.webRequest.errors.length, 1, "a shared partition installs its error listener once across tabs and app windows");
	assert.equal(guest.webRequest.completed.length, 1);
	const failRequest = guest.webRequest.errors[0].listener;
	const completedRequest = guest.webRequest.completed[0].listener;
	const failedDetails = { webContentsId: 201, url: "https://user:password@example.test/api?token=secret#private", error: "net::ERR_CONNECTION_REFUSED", statusLine: "private status text", referrer: "https://private.test/?secret=referrer" };
	for (const field of ["requestHeaders", "responseHeaders", "uploadData", "cookies", "body"]) {
		Object.defineProperty(failedDetails, field, { get() { throw new Error(`Diagnostics must not read ${field}`); } });
	}
	failRequest(failedDetails);
	assert.equal(browserDeliveries[0].length, 1);
	assert.equal(browserDeliveries[1].length, 0, "request failures go only to their guest's host window");
	assert.equal(browserDeliveries[0][0][0], "grok:browser-problem");
	const problemPayload = browserDeliveries[0][0][1];
	assert.deepEqual(Object.keys(problemPayload).sort(), ["at", "message", "url", "webContentsId"]);
	assert.equal(problemPayload.url, "https://example.test/api");
	assert.equal(problemPayload.message, "net::ERR_CONNECTION_REFUSED");
	assert.equal(problemPayload.webContentsId, 201);
	assert.ok(Number.isFinite(problemPayload.at));
	completedRequest({ webContentsId: 202, url: "https://example.test/missing?token=secret#section", statusCode: 404, responseHeaders: { "set-cookie": ["private-cookie"] } });
	assert.equal(browserDeliveries[0][1][1].webContentsId, 202, "same-window tabs keep their distinct guest IDs");
	assert.equal(browserDeliveries[0][1][1].message, "HTTP 404");
	failRequest({ webContentsId: 203, url: "wss://user:password@example.test/socket?token=secret#fragment", error: "net::ERR_FAILED" });
	assert.equal(browserDeliveries[1][0][1].url, "wss://example.test/socket");
	const beforeIgnored = browserDeliveries[0].length;
	for (const statusCode of [200, 302, 399]) { completedRequest({ webContentsId: 201, url: "https://example.test/", statusCode }); }
	for (const error of ["net::ERR_ABORTED", "ERR_ABORTED"]) { failRequest({ webContentsId: 201, url: "https://example.test/", error }); }
	for (const webContentsId of [undefined, 999, page.id]) { failRequest({ webContentsId, url: "https://unrelated.test/?private=1", error: "net::ERR_FAILED" }); }
	for (const url of ["data:text/plain,private-body", "not a URL"]) { failRequest({ webContentsId: 201, url, error: "net::ERR_FAILED" }); }
	assert.equal(browserDeliveries[0].length, beforeIgnored, "successes, cancellations, unknown pages, data bodies and invalid URLs are ignored");
	failRequest({ webContentsId: 201, url: "https://example.test/", error: "private error https://private.test/?secret=1" });
	assert.equal(browserDeliveries[0].at(-1)[1].message, "Network request failed.", "arbitrary error descriptions cannot leak URLs or private text");
	failRequest({ webContentsId: 201, url: "https://example.test/", error: `net::ERR_${"X".repeat(1000)}` });
	assert.equal(browserDeliveries[0].at(-1)[1].message.length, 500);
	const permanentTab = attachBrowserGuest(page, 204, "persist:grok-code");
	const temporaryTab = attachBrowserGuest(page, 205, "temp:grok-2");
	assert.equal(permanentTab.session.webRequest.errors.length, 1);
	assert.equal(temporaryTab.session.webRequest.errors.length, 1, "each allowed partition installs its own listener");
	const refusedTab = attachBrowserGuest(page, 206, "persist:other");
	assert.equal(refusedTab.session.webRequest.errors.length, 0, "a forbidden partition is never observed");
	attachBrowserGuest(contents, 207, "temp:grok-1");
	failRequest({ webContentsId: 207, url: "https://not-an-app-window.test/", error: "net::ERR_FAILED" });
	const beforeClosed = browserDeliveries[0].length;
	tabOne.emit("destroyed");
	failRequest(failedDetails);
	page.gone = true;
	completedRequest({ webContentsId: 202, url: "https://example.test/", statusCode: 500 });
	page.gone = false;
	assert.equal(browserDeliveries[0].length, beforeClosed, "destroyed tabs are unregistered and destroyed hosts receive no problems");
	completedRequest({ webContentsId: 202, url: "https://example.test/", statusCode: 500 });
	assert.equal(browserDeliveries[0].length, beforeClosed + 1, "another tab in the same partition still receives failures after cleanup");
	[page.send, otherPage.send] = previousBrowserSends;
	console.log("PASS Browser diagnostics: once per partition, own-tab/window routing, privacy projection, cancellations and cleanup");
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

	// An installed copy stages its update in the prepare, and will-quit runs it.
	app.isPackaged = true;
	const prepareUpdate = () => handlers.get("grok:update-prepare")({}, "v0.2.0");
	const startUpdate = (tag = "v0.2.0") => handlers.get("grok:update-start")({}, tag);
	const stagedReady = { ok: true, ready: true, notes: "Notes", asksPassword: true, kind: "swap", file: path.join(root, "package.json"), staged: "/new", previous: "/old", sandbox: true };
	updatePrepared = stagedReady;
	assert.deepEqual({ ...await prepareUpdate() }, { ok: true, ready: true, notes: "Notes", asksPassword: true }, "the renderer gets no paths");
	assert.equal(updatePrepares.at(-1)[3].packaged, true);
	assert.deepEqual({ ...updatePrepares.at(-1)[3].installed }, { appRoot: installedFolder, arch: process.arch, home: os.homedir(), localAppData: process.env.LOCALAPPDATA, userData: root });
	const realPrepare = updateApi.updatePrepare;
	let finishPrepare;
	updateApi.updatePrepare = () => new Promise((resolve) => { finishPrepare = resolve; });
	const runningPrepare = prepareUpdate();
	assert.equal((await prepareUpdate()).busy, true, "a second window can't start a second download");
	assert.equal((await startUpdate()).error, "The update isn't ready.", "a prepare in progress clears the last staged update");
	finishPrepare(stagedReady);
	await runningPrepare;
	updateApi.updatePrepare = realPrepare;
	assert.equal((await prepareUpdate()).busy, undefined, "the next prepare runs once that one ends");
	const preparesBeforeStart = updatePrepares.length;
	const quitsBeforeStart = app.quitCalls;
	assert.equal((await startUpdate("v9.9.9")).error, "The update isn't ready.", "a tag that isn't staged can't start");
	updatePrepared = { ...stagedReady, file: path.join(root, "no-such-update.exe") };
	await prepareUpdate();
	assert.equal((await startUpdate()).error, "The update isn't ready.", "the app doesn't close for a file that's gone");
	assert.equal(app.quitCalls, quitsBeforeStart);
	updatePrepared = stagedReady;
	await prepareUpdate();
	const preparesAtStart = updatePrepares.length;
	assert.equal((await startUpdate()).ok, true);
	assert.equal(updatePrepares.length, preparesAtStart, "the start doesn't download again");
	assert.ok(preparesAtStart > preparesBeforeStart);
	assert.equal(app.quitCalls, quitsBeforeStart + 1);
	assert.equal(updateExpected, undefined, "nothing is recorded until the quit can't be cancelled");
	app.emit("will-quit");
	assert.deepEqual({ ...updateExpected }, { version: "0.2.0" });
	const installedChild = children.at(-1);
	assert.equal(installedChild.command, "update-program");
	assert.deepEqual([...installedChild.args], ["--update"]);
	assert.deepEqual({ ...installedChild.options }, { detached: true, stdio: "ignore", cwd: os.tmpdir() }, "no windowsHide, which could hide Setup's window");
	assert.equal(installedChild.child.unreferenced, true);
	const [sentUpdate, sentOptions] = installedCommands.at(-1);
	assert.deepEqual([sentUpdate.kind, sentUpdate.appRoot, sentUpdate.file, sentUpdate.staged, sentUpdate.previous, sentUpdate.sandbox], ["swap", installedFolder, stagedReady.file, "/new", "/old", true]);
	assert.deepEqual({ ...sentOptions, argv: [...sentOptions.argv] }, { platform: "win32", pid: process.pid, userData: root, argv: process.argv.slice(1) });
	assert.equal(helperCopies.length, 1, "an installed copy doesn't use the source copy's helper");
	installedChild.child.emit("error", new Error("Blocked by policy"));
	assert.equal(updateExpected, undefined);
	assert.match(updateResult.message, /couldn't start: Blocked by policy\..*manual steps/);
	assert.match(handlers.get("grok:update-result")().message, /Blocked by policy/);
	updateExpected = { version: "0.1.0" };
	assert.equal(handlers.get("grok:update-result")().message, "Updated to version 0.1.0.");
	assert.equal(handlers.get("grok:update-result")(), null, "the result is read only once");
	updateExpected = { version: "0.2.0" };
	const unfinished = handlers.get("grok:update-result")();
	assert.equal(unfinished.ok, false);
	assert.equal(unfinished.message, "The update to version 0.2.0 didn't finish. Try again from Help > Check for Updates, or update by hand: manual steps");
	assert.equal(handlers.get("grok:update-result")(), null);
	assert.equal(updateRemovals.length, 0, "a window load never removes a staged update");
	app.isPackaged = false;
	updatePrepared = { ok: true, ready: true, node: "C:\\Node\\node.exe", from: "1234567" };

	const windowCount = windows.length;
	const macHandlers = new Map();
	const macDockBadges = [];
	const secondCopy = Object.assign(new EventEmitter(), {
		setPath: app.setPath,
		setName: app.setName,
		setAppUserModelId: app.setAppUserModelId,
		getPath: app.getPath,
		getVersion: app.getVersion,
		whenReady: app.whenReady,
		requestSingleInstanceLock: () => false,
		quitCalls: 0,
		isPackaged: true,
		dock: { setBadge: (badge) => macDockBadges.push(badge) },
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
		Buffer,
		require(name) {
			if (name === "child_process") { return macChildProcess; }
			if (name === "electron") { return { ...electron, app: secondCopy, ipcMain: { handle: (name, handler) => macHandlers.set(name, handler), on: () => {} } }; }
			if (name === "./agent.cjs") { return { AgentHost: TestHost, grokHome: () => path.join(root, "no-such-grok"), ...signInAgent }; }
			if (name === "./sign-in.cjs") { return signInFactory; }
			if (name === "./cloud.cjs") { return cloudApi; }
			if (name === "./grokbot.cjs") { return botFactory; }
			if (name === "./grokbot-window.cjs") { return botWindowFactory; }
			if (name === "./redact.cjs") { return require("../electron/redact.cjs"); }
			if (name === "./browser-agent.cjs") { return { createBrowserAgent: () => browserAgentApi }; }
			if (name === "./loops.cjs") { return require("../electron/loops.cjs"); }
		if (name === "./sandbox.cjs") { return require("../electron/sandbox.cjs"); }
			if (name === "./updates.cjs") { return updateApi; }
			if (name === "../scripts/update-helper.cjs") { return helperApi; }
			if (name === "./usage.cjs") { return { rootOf: (_id, roots) => roots[0], taskOutput: () => ({ ok: true }), subagentTranscript: () => ({ ok: true }) }; }
			if (name === "./session-data.cjs") { return mainContext.require(name); }
			if (name === "./diff.cjs" || name === "./git.cjs" || name === "./files.cjs" || name === "./customize.cjs" || name === "./export.cjs") { return { chooseExport: async () => ({ ok: true, cancelled: true }) }; }
			if (name === "./terminal.cjs") { return { TerminalHost: class { closeAll() {} } }; }
			if (name === "./inbound.cjs") { return require("../electron/inbound.cjs"); }
			if (name === "./cold-chats.cjs") { return require("../electron/cold-chats.cjs"); }
			if (name === "./pasted-images.cjs") { return require("../electron/pasted-images.cjs"); }
			if (name === "./startup.cjs") { return require("../electron/startup.cjs"); }
			if (name === "./routines.cjs") { return require("../electron/routines.cjs"); }
			return require(name);
		},
	});
	assert.equal(secondCopy.quitCalls, 1, "a second copy quits");
	assert.equal(updateRemovals.length, 0, "a second copy never removes the running copy's staged update");
	assert.equal(shellRuns.length, 1, "an installed Mac app asks the login shell for PATH once");
	assert.deepEqual([...shellRuns[0].args], ["-ilc", "echo __GROK_PATH__; /usr/bin/printenv PATH"]);
	assert.equal(shellRuns[0].options.timeout, 5000);
	assert.equal(macEnv.PATH, "/opt/homebrew/bin:/usr/bin:/bin", "and uses it in place of launchd's PATH");
	assert.equal(appMenu[0].role, "appMenu", "macOS gets the application menu first");
	assert.equal(appMenu[1].submenu[0].accelerator, "CmdOrCtrl+Shift+N", "New Window is Cmd+Shift+N on macOS");
	assert.equal(windows.length, windowCount, "and opens no window of its own");
	const macTaskbar = macHandlers.get("grok:taskbar");
	const macFirst = new TestWindow({});
	const macSecond = new TestWindow({});
	macSecond.webContents.setWindowOpenHandler = () => {};
	secondCopy.emit("web-contents-created", {}, macSecond.webContents);
	const macGuest = attachBrowserGuest(macSecond.webContents, 301, "temp:grok-mac");
	assert.equal(inputPrevented(macGuest, cmdR), true);
	assert.equal(macGuest.reloads, 1, "Cmd+R in a Browser page reloads the guest on macOS");
	assert.equal(inputPrevented(macSecond.webContents, cmdR), false);
	assert.equal(macSecond.reloads, undefined);
	const macFirstEvent = { sender: macFirst.webContents };
	const macSecondEvent = { sender: macSecond.webContents };
	assert.equal(macTaskbar(macFirstEvent, "needs-you").ok, true);
	assert.equal(macDockBadges.at(-1), "•", "one Mac window needing input sets the Dock badge");
	macTaskbar(macSecondEvent, "idle");
	assert.equal(macDockBadges.at(-1), "•", "an idle Mac window keeps another window's Dock badge");
	macTaskbar(macFirstEvent, "idle");
	assert.equal(macDockBadges.at(-1), "", "resolving the last Mac window clears the Dock badge");
	macTaskbar(macFirstEvent, "needs-you");
	assert.equal(macFirst.listenerCount("closed"), 1, "each window gets one badge cleanup listener");
	macFirst.destroyed = true;
	Object.defineProperty(macFirst, "id", { get() { throw new TypeError("Object has been destroyed"); } });
	macFirst.emit("closed");
	assert.equal(macDockBadges.at(-1), "", "closing the window needing input clears the Dock badge without reading its destroyed id");
	console.log("PASS macOS Dock badge: needs-you, multi-window aggregation, resolution, and close cleanup; Windows skips Dock");
	const openFirstWindow = (saved) => {
		for (const win of windows) { win.destroyed = true; }
		windowState = typeof saved === "string" || saved === undefined ? saved : JSON.stringify(saved);
		mainContext.createWindow();
		return windows.at(-1);
	};
	const dimensions = (win) => [win.options.x, win.options.y, win.options.width, win.options.height];
	const normal = openFirstWindow();
	assert.deepEqual(dimensions(normal), [240, 80, 1440, 920]);
	assert.deepEqual([normal.options.minWidth, normal.options.minHeight], [680, 560]);
	normal.bounds = { x: 80, y: 90, width: 1200, height: 700 };
	normal.maximized = true;
	const closeNormal = () => normal.emit("close", { preventDefault() {} });
	closeNormal();
	await new Promise((resolve) => setImmediate(resolve));
	closeNormal();
	assert.deepEqual(JSON.parse(windowState), { ...normal.bounds, maximized: true }, "close saves normal bounds and maximized state");
	const restored = openFirstWindow(windowState);
	assert.deepEqual(dimensions(restored), [80, 90, 1200, 700]);
	restored.webContents.emit("did-finish-load");
	assert.equal(restored.maximizedWhenShown, true, "the first restored window maximizes before showing");
	for (const width of [680, 900, 1400]) {
		assert.deepEqual(dimensions(openFirstWindow({ x: 80, y: 90, width, height: 560 })), [80, 90, width, 560], "saved narrow and wide bounds retain their width on startup");
	}
	for (const saved of ["{broken", { x: 80, y: 90, width: 679, height: 700 }]) {
		assert.deepEqual(dimensions(openFirstWindow(saved)), [240, 80, 1440, 920], "invalid state uses centered defaults");
	}
	for (const width of [680, 900, 1400]) {
		cursorArea = matchingArea = { x: 0, y: 0, width, height: 560 };
		assert.deepEqual(dimensions(openFirstWindow()), [0, 0, width, 560], "default startup bounds fit narrow and wide work areas");
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
	const guardRun = async (marker, live, { isPackaged = false, nodeAvailable = true } = {}) => {
		const notifications = [];
		const timers = [];
		let locks = 0;
		let nodeChecks = 0;
		const guarded = Object.assign(new EventEmitter(), { ...app, isPackaged, requestSingleInstanceLock: () => { locks += 1; return true; }, quitCalls: 0 });
		guarded.quit = () => { guarded.quitCalls += 1; };
		const before = { windows: windows.length, dialogs: dialogs.length, builds: viteBuilds.length, children: children.length };
		vm.runInNewContext(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8"), {
			__dirname: path.join(root, "electron"), process: { ...process, platform: "win32", argv: isPackaged ? process.argv : [...process.argv, "--build-if-stale"] }, URL, Buffer,
			setTimeout(callback, delay) { timers.push({ callback, delay }); },
			setInterval: mainContext.setInterval,
			require(name) {
				if (name === "electron") { return { ...electron, app: guarded, ipcMain: { handle() {}, on() {} }, Notification: class { constructor(options) { this.options = options; } show() { notifications.push(this.options); } } }; }
				if (name === "../scripts/update-helper.cjs") {
					return { ...helperApi, readMarker: () => marker, markerLive: async () => live, findNode: async () => { nodeChecks++; return nodeAvailable ? helperApi.findNode() : ""; } };
				}
				return mainContext.require(name);
			},
		});
		for (let i = 0; i < 12; i += 1) { await Promise.resolve(); }
		assert.equal(locks, isPackaged ? 1 : 0, "only a source copy takes the update guard path before the lock");
		assert.equal(windows.length - before.windows, isPackaged ? 1 : 0, "an installed copy opens a normal window");
		assert.equal(dialogs.length, before.dialogs, "an update guard never opens a blocking dialog");
		assert.equal(viteBuilds.length, before.builds, "an update guard never starts a build");
		return { guarded, notifications, timers, before, nodeChecks };
	};
	const liveGuard = await guardRun({ pid: 123, pidStart: 456 }, true);
	assert.equal(liveGuard.notifications[0].title, "Codewomplers Grok Desktop is updating");
	assert.match(liveGuard.notifications[0].body, /usually reopens.*If it stays closed, check update\.log/);
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
	const noNodeGuard = await guardRun({ pid: 123, pidStart: 456 }, false, { nodeAvailable: false });
	assert.equal(noNodeGuard.nodeChecks, 1);
	assert.match(noNodeGuard.notifications[0].body, /Node\.js isn't on PATH/);
	assert.equal(noNodeGuard.guarded.quitCalls, 1);
	const installedGuard = await guardRun({ pid: 123, pidStart: 456 }, false, { isPackaged: true, nodeAvailable: false });
	assert.equal(installedGuard.nodeChecks, 0, "the installed app ignores a stale source marker without needing Node");
	assert.equal(installedGuard.notifications.length, 0);
	assert.equal(installedGuard.guarded.quitCalls, 0);
	assert.deepEqual({ ...updateRemovals.at(-1) }, { platform: "win32", appRoot: installedFolder, userData: root }, "an installed copy clears old update files at startup");
	console.log("PASS startup distinguishes source recovery from an installed app with a stale source marker and no Node");
	await checkOpenAtSignIn();
	await checkSignInWindow();
	await checkRoutines();
	await checkUnloadTimeouts();
	{
		const previousPrepared = updatePrepared;
		const previousCommand = updateApi.installedUpdateCommand;
		const file = path.join(root, "package.json");
		const checksum = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		updatePrepared = { ok: true, ready: true, asksPassword: true, kind: "deb", file, checksum };
		updateApi.installedUpdateCommand = require("../electron/updates.cjs").installedUpdateCommand;
		try {
			const copy = launchCopy({ platform: "linux", isPackaged: true });
			const prepared = await copy.handlers.get("grok:update-prepare")({}, "v0.2.0");
			assert.deepEqual({ ...prepared }, { ok: true, ready: true, asksPassword: true });
			assert.equal((await copy.handlers.get("grok:update-start")({}, "v0.2.0")).ok, true);
			copy.app.emit("will-quit");
			const install = children.at(-1);
			assert.equal(install.command, "/bin/sh");
			assert.deepEqual([...install.args.slice(7, 10)], [file, "", checksum]);
		} finally {
			updatePrepared = previousPrepared;
			updateApi.installedUpdateCommand = previousCommand;
			updateExpected = undefined;
		}
		console.log("PASS Linux package update: IPC carries the prepared checksum to the installer command");
	}
	checkPastedImages();
	console.log("Main ownership, session bootstrap, folder policy, version bridge, update IPC/dialog/quit/recovery/shortcut, question/plan ownership, close dialog, Browser permission, right-click menu and single-instance checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
