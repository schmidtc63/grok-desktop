const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, webContents } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
process.env.NoDefaultCurrentDirectoryInExePath = "1";
// `npm run desktop` puts this app's node_modules\.bin folders and node-gyp-bin first on PATH and adds npm_* variables.
// Grok and every terminal would inherit them, so a bare tsc or vite in the user's project would run this app's copy.
if (process.env.npm_lifecycle_event) {
	const entries = (process.env.PATH || "").split(path.delimiter);
	const gyp = entries.findLastIndex((entry) => /[\\/]node-gyp-bin$/i.test(entry));
	if (gyp !== -1) { process.env.PATH = entries.slice(gyp + 1).join(path.delimiter); }
	for (const key of Object.keys(process.env)) {
		if (/^npm_/i.test(key) || key === "INIT_CWD") { delete process.env[key]; }
	}
}
// Started from Finder or the Dock, a Mac app gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), without Homebrew's git, gh and code.
// The installed app takes PATH from the user's login shell, as Terminal would. printenv prints it colon-separated in any shell, fish included.
// ponytail: blocks startup for the shell's start time (5 s cap); move it off the startup path if a slow shell makes launch drag.
if (process.platform === "darwin" && app.isPackaged) {
	try {
		const shellOut = spawnSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo __GROK_PATH__; /usr/bin/printenv PATH"], { encoding: "utf8", timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }).stdout || "";
		const shellPath = shellOut.split("__GROK_PATH__\n")[1]?.split("\n")[0];
		if (shellPath) { process.env.PATH = shellPath; }
	} catch {}
}
app.setPath("userData", path.join(app.getPath("appData"), "grok-code"));
app.setName("Codewomplers Grok Desktop");
if (process.platform === "win32") app.setAppUserModelId("Grok.Code");
const appIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "codewomplers-grok-desktop.png"));
const { AgentHost, grokHome, grokPath, probeGrok, setSignIn } = require("./agent.cjs");
const sandbox = require("./sandbox.cjs");
sandbox.setDataDir(path.join(app.getPath("userData"), "sandbox"));
const { createSignIn, validKey } = require("./sign-in.cjs");
const { redactDeep, redactKeys } = require("./redact.cjs");
const { CloudHost, createCursorApi, createCursorKey } = require("./cloud.cjs");
const { createGrokBot } = require("./grokbot.cjs");
const { createGrokBotWindow } = require("./grokbot-window.cjs");
const { createBrowserAgent } = require("./browser-agent.cjs");
const { readDiff, revertFile, revertHunk, localFilterOff } = require("./diff.cjs");
const git = require("./git.cjs");
if (process.platform === "win32") { git.useBundledGit(); }
const { TerminalHost } = require("./terminal.cjs");
const { createInbound, candidatesFor, askInOrder } = require("./inbound.cjs");
const { listFiles, readText, readImage, writeText, locateFile, DEFAULT_APP_EXT } = require("./files.cjs");
const usage = require("./usage.cjs");
const customize = require("./customize.cjs");
const { chooseExport } = require("./export.cjs");
const { readSessionData } = require("./session-data.cjs");
const updates = require("./updates.cjs");
const updateHelper = require("../scripts/update-helper.cjs");
const { createColdChats } = require("./cold-chats.cjs");
const { createPastedImages } = require("./pasted-images.cjs");
const { signInCommand, desktopEntry, autostartFile } = require("./startup.cjs");
const { createRoutines, isOutstanding } = require("./routines.cjs");
const signIn = createSignIn({ file: path.join(app.getPath("userData"), "sign-in.json"), safeStorage, platform: process.platform, fs });
setSignIn(signIn);
async function sessionRoots() {
	const roots = [path.join(grokHome(), "sessions"), ...await sandbox.sessionRoots()];
	return process.platform === "win32" ? [...new Map(roots.map((root) => [root.toLowerCase(), root])).values()] : roots;
}
async function savedSessionData(action, request = {}) {
	return readSessionData({ ...request, action, roots: await sessionRoots() });
}
let pendingUpdate = null;
let startingUpdate = false;
let preparingUpdate = false;
let stagedUpdate = null;
// Set in startApplication, after the single-instance lock: loading the store marks outstanding runs interrupted, and a second launch must not.
let routines;
let routineTimer;
const routineWindows = new Set();
const routineOwners = new Map();
const routineNotices = new Set();

const owners = new Map();
const turnOwners = new Map();
const terminalOwners = new Map();
const changeReads = new Map();
const cloudOwners = new Map();
const cursorKey = createCursorKey({ file: path.join(app.getPath("userData"), "cursor-key.json"), safeStorage, platform: process.platform, fs });
const cursorApi = createCursorApi({ getKey: cursorKey.key });
const cloudHost = new CloudHost((event) => {
	const owner = cloudOwners.get(event.uiSessionId);
	if (!owner || owner.turnId !== event.turnId) { return; }
	if (event.type === "done" || event.type === "error") { cloudOwners.delete(event.uiSessionId); }
	if (!owner.contents.isDestroyed()) { owner.contents.send("grok:event", event); }
}, { api: cursorApi, getKey: cursorKey.key });
const grokBot = createGrokBot({
	file: path.join(app.getPath("userData"), "grok-bot.json"),
	healthFile: path.join(app.getPath("userData"), "grok-bot-health.json"),
	safeStorage, platform: process.platform, fs, emit: broadcast,
	openExternal: (url) => shell.openExternal(url), version: app.getVersion(),
});
const grokBotWindow = createGrokBotWindow({ platform: process.platform, spawn, exists: fs.existsSync, launch: (file) => { void shell.openPath(file); } });
let changingCursorKey = false;
let cursorModels;
let browserAgent;
let pasteStartupContents;
const sandboxGitFile = path.join(app.getPath("userData"), "sandbox-git.json");
const sandboxGitCaptures = new Map();
const sandboxGitActions = new Set();
const startingSandboxTurns = new Map();
let sandboxGitBaselines;

function sandboxGitFolder(cwd) {
	let folder;
	try { folder = fs.realpathSync(cwd); } catch { folder = path.resolve(cwd); }
	return process.platform === "win32" ? folder.toLowerCase() : folder;
}

function sandboxGitHistory() {
	if (!sandboxGitBaselines) {
		try { sandboxGitBaselines = new Map(JSON.parse(fs.readFileSync(sandboxGitFile, "utf8"))); }
		catch { sandboxGitBaselines = new Map(); }
	}
	return sandboxGitBaselines;
}

function saveSandboxGit(key, snapshot) {
	const baselines = sandboxGitHistory();
	baselines.set(key, snapshot ? { config: snapshot.config, hooks: snapshot.hooks } : null);
	try {
		fs.mkdirSync(path.dirname(sandboxGitFile), { recursive: true });
		fs.writeFileSync(`${sandboxGitFile}.tmp`, JSON.stringify([...baselines]));
		fs.renameSync(`${sandboxGitFile}.tmp`, sandboxGitFile);
	} catch { /* The in-memory baseline still protects this launch. */ }
}

function rememberSandboxGit(cwd) {
	const key = sandboxGitFolder(cwd);
	if (sandboxGitHistory().has(key)) { return; }
	if (!sandboxGitCaptures.has(key)) {
		const capture = git.gitSecuritySnapshot(cwd).catch(() => null)
			.then((snapshot) => saveSandboxGit(key, snapshot?.ok ? snapshot : null))
			.finally(() => sandboxGitCaptures.delete(key));
		sandboxGitCaptures.set(key, capture);
	}
	return sandboxGitCaptures.get(key);
}

const host = new AgentHost((event) => {
	routines?.hostEvent(event);
	if (!event.turnId) { broadcast(event); return; }
	let turns = turnOwners.get(event.uiSessionId);
	let contents = turns?.get(event.turnId);
	if (event.type === "turn-start") {
		if (contents === undefined) {
			contents = turns?.has(event.sourceTurnId) ? turns.get(event.sourceTurnId) : owners.get(event.uiSessionId)?.contents;
		}
		if (!contents || contents.isDestroyed()) {
			host.cancel(event.uiSessionId);
			return;
		}
		if (!turns) {
			turns = new Map();
			turnOwners.set(event.uiSessionId, turns);
		}
		turns.set(event.turnId, contents);
		const turn = host.turns.get(event.uiSessionId);
		if (turn?.turnId === event.turnId) { owners.set(event.uiSessionId, { contents, turn }); }
	}
	if (contents && !contents.isDestroyed()) { contents.send("grok:event", event); }
}, { rulesFile: () => path.join(app.getPath("userData"), "always-allow.json"), browserServer: (id) => browserAgent.server(id) });

const blockedBrowserPorts = new Set();
const debugBrowserPort = Number(process.env.GROK_CODE_DEBUG_PORT);
if (Number.isInteger(debugBrowserPort) && debugBrowserPort > 0 && debugBrowserPort <= 65535) { blockedBrowserPorts.add(debugBrowserPort); }
browserAgent = createBrowserAgent({ host, owners, blockedPorts: blockedBrowserPorts, webContents });

const inbound = createInbound({ registryFile: path.join(app.getPath("userData"), "inbound.json"), deliver: deliverInbound });
const inboundWindows = new Set();
const inboundWaits = new Map();

function focusedContents() {
	return BrowserWindow.getFocusedWindow()?.webContents ?? null;
}

async function deliverInbound({ agentSessionId, text }) {
	let requestId;
	try {
		return await askInOrder(candidatesFor({ agentSessionId, sessions: host.sessions, owners, registered: inboundWindows, focused: focusedContents() }), (contents) => new Promise((resolve) => {
			requestId = crypto.randomUUID();
			inboundWaits.set(requestId, { contents, resolve });
			contents.send("grok:event", { type: "inbound", requestId, agentSessionId, text });
		}), 3000);
	} finally {
		inboundWaits.delete(requestId);
	}
}

const terminals = new TerminalHost((event) => {
	const owner = terminalOwners.get(event.id);
	if (event.type === "terminal-exit") { terminalOwners.delete(event.id); }
	if (owner && !owner.isDestroyed()) { owner.send("grok:event", event); }
});

function broadcast(event) {
	for (const win of BrowserWindow.getAllWindows()) {
		// A closing window's page is destroyed before the window, and its terminals close in between (macOS Cmd+Q).
		if (!win.isDestroyed() && !win.webContents.isDestroyed()) { win.webContents.send("grok:event", event); }
	}
}

ipcMain.handle("grok:accessibility-support", () => app.isAccessibilitySupportEnabled?.() === true);
app.on("accessibility-support-changed", (_event, active) => broadcast({ type: "accessibility-support-changed", active }));

const appDir = path.resolve(__dirname, "..");
const pageFile = path.join(appDir, "dist", "index.html");
const appPageUrl = appPageAddress(pathToFileURL(pageFile).href);
const appIconFile = path.join(appDir, "assets", "codewomplers-grok-desktop.ico");

function appPageAddress(url) {
	return url.split(/[?#]/, 1)[0].replace(/^file:\/\/\/([a-z]):\//i, (_match, drive) => `file:///${drive.toUpperCase()}:/`);
}

function isAppPage(url) {
	return appPageAddress(url) === appPageUrl;
}

// The taskbar pin starts Electron directly, skipping the build in `npm run desktop`, so it passes --build-if-stale.
// The page is rebuilt when the source is newer. If that fails, the old page loads as before.
function buildIfStale() {
	try {
		const built = fs.statSync(pageFile, { throwIfNoEntry: false })?.mtimeMs ?? 0;
		const src = path.join(appDir, "src");
		const inputs = [path.join(appDir, "index.html"), path.join(appDir, "vite.config.ts"), ...fs.readdirSync(src, { recursive: true }).map((name) => path.join(src, name))];
		if (inputs.every((file) => fs.statSync(file).mtimeMs <= built)) { return; }
		spawnSync(process.execPath, [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: appDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true, timeout: 60000 });
	} catch {}
}

// Windows starts the pin through a Start menu shortcut with this app's id, and that shortcut has none of relaunchCommand's
// arguments, so the pin opened Electron's welcome screen. At launch and at quit, every such shortcut gets the full command and the app's icon.
function repairShortcuts() {
	if (process.platform !== "win32") { return; }
	const args = `"${appDir}" --build-if-stale`;
	for (const parts of [["Windows", "Start Menu", "Programs"], ["Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"]]) {
		const folder = path.join(app.getPath("appData"), "Microsoft", ...parts);
		let names = [];
		try { names = fs.readdirSync(folder).filter((name) => /\.lnk$/i.test(name)); } catch {}
		for (const name of names) {
			const file = path.join(folder, name);
			try {
				const link = shell.readShortcutLink(file);
				const target = path.resolve(link.target).replace(/[\\/]node_modules\.update-old[\\/]/i, `${path.sep}node_modules${path.sep}`);
				if (link.appUserModelId === "Grok.Code" && target.toLowerCase() === process.execPath.toLowerCase() && (path.resolve(link.target).toLowerCase() !== process.execPath.toLowerCase() || link.args !== args || link.icon?.toLowerCase() !== appIconFile.toLowerCase())) {
					shell.writeShortcutLink(file, "update", { target: process.execPath, args, icon: appIconFile, iconIndex: 0 });
				}
			} catch {}
		}
	}
}

const windowStateFile = path.join(app.getPath("userData"), "window-state.json");
function windowPlacement(first) {
	let saved;
	try {
		const value = JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
		if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width >= 680 && value.height >= 560 && ((value.x === undefined && value.y === undefined) || (Number.isFinite(value.x) && Number.isFinite(value.y)))) { saved = value; }
	} catch {}
	const fit = (area) => ({ width: Math.max(680, Math.min(saved?.width ?? 1440, area.width)), height: Math.max(560, Math.min(saved?.height ?? 920, area.height)) });
	if (first && saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
		const area = screen.getDisplayMatching(saved).workArea;
		const size = fit(area);
		if (saved.x >= area.x && saved.y >= area.y && saved.x + size.width <= area.x + area.width && saved.y + 32 <= area.y + area.height) {
			return { bounds: { ...size, x: Math.min(saved.x, area.x + area.width - size.width), y: Math.min(saved.y, area.y + area.height - size.height) }, maximized: saved.maximized === true };
		}
	}
	const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const size = fit(area);
	return { bounds: { ...size, x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2) }, maximized: false };
}

const reloadAppWindow = new WeakMap();

function createWindow(uiSessionId) {
	const atSignIn = process.argv.includes("--at-sign-in") && BrowserWindow.getAllWindows().length === 0;
	const placement = windowPlacement(BrowserWindow.getAllWindows().length === 0);
  const win = new BrowserWindow({
		...placement.bounds,
    minWidth: 680,
		minHeight: 560,
    show: false,
    backgroundColor: "#161513",
    title: "Codewomplers Grok Desktop",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [`--grok-app-page=${appPageUrl}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

	const contents = win.webContents;
	pasteStartupContents ??= contents;
	const closeOwnedTerminals = () => {
		for (const [id, owner] of terminalOwners) {
			if (owner === contents) { terminals.close(id); }
		}
	};
	contents.on("did-navigate", closeOwnedTerminals);
	contents.on("destroyed", closeOwnedTerminals);
	contents.on("render-process-gone", closeOwnedTerminals);
	const stopOwnedTurn = () => {
		routineWindows.delete(contents);
		for (const turns of turnOwners.values()) {
			for (const [turnId, owner] of turns) {
				if (owner === contents) { turns.set(turnId, null); }
			}
		}
		for (const [id, start] of startingSandboxTurns) { if (start.contents === contents) { startingSandboxTurns.delete(id); } }
		for (const [uiSessionId, owner] of owners) {
			if (owner.contents === contents && (!host.turns.has(uiSessionId) || owner.turn === host.turns.get(uiSessionId))) { host.cancel(uiSessionId); }
		}
	};
	// The question is async so the main process keeps answering approvals, and their auto-deny keeps running, while it is open.
	// Without preventDefault the unload is cancelled, so "Close anyway" repeats the close or reload with `leave` set.
	let asking = false;
	let leave = false;
	let closing = false;
	let preparing = null;
	let prepared = false;
	const finishUnload = () => {
		if (!preparing) { return; }
		clearTimeout(preparing.timeout);
		preparing = null;
	};
	const resumeUnload = (wasClosing) => {
		if (wasClosing) { win.close(); } else { contents.reload(); }
	};
	const prepareUnload = async (wasClosing) => {
		if (asking) { return; }
		if (preparing) { preparing.closing ||= wasClosing; return; }
		const request = { closing: wasClosing, resumed: false };
		preparing = request;
		request.timeout = setTimeout(() => {
			if (preparing !== request) { return; }
			finishUnload();
			if (win.isDestroyed()) { return; }
			if (!request.closing) {
				let sessionId = uiSessionId;
				try { sessionId = new URL(contents.getURL()).searchParams.get("session") || uiSessionId; } catch {}
				const replacement = createWindow(sessionId);
				replacement.setBounds(win.getNormalBounds());
				if (win.isMaximized()) { replacement.maximize(); }
			}
			win.destroy();
		}, 5000);
		try { await contents.executeJavaScript("window.grokPrepareUnload?.()"); } catch {}
		if (preparing !== request || win.isDestroyed()) { return; }
		prepared = true;
		request.resumed = true;
		resumeUnload(request.closing);
	};
	reloadAppWindow.set(win, () => void prepareUnload(false));
	win.on("close", (event) => {
		// Windows would destroy Grok Bot's window along with this one. Closing the app closes Grok Bot properly first; with another window still open, it goes back to the desktop.
		if (grokBotWindow.holds(win)) {
			event.preventDefault();
			const last = BrowserWindow.getAllWindows().every((item) => item === win || item.getParentWindow());
			void (last ? grokBotWindow.close() : grokBotWindow.release()).finally(() => { if (!win.isDestroyed()) { win.close(); } });
			return;
		}
		if (preparing) { preparing.closing = true; }
		if (!leave && !prepared && !contents.isCrashed()) {
			event.preventDefault();
			void prepareUnload(true);
			return;
		}
		closing = true;
		try { fs.writeFileSync(windowStateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
	});
	contents.on("destroyed", finishUnload);
	contents.on("did-finish-load", () => {
		if (preparing?.resumed) { finishUnload(); }
		leave = false;
		prepared = false;
	});
	win.webContents.on("will-prevent-unload", (event) => {
		const wasClosing = closing;
		closing = false;
		if (leave) {
			finishUnload();
			event.preventDefault();
			return;
		}
		if (asking) { return; }
		if (!prepared) {
			void prepareUnload(wasClosing);
			return;
		}
		finishUnload();
		prepared = false;
		asking = true;
		dialog.showMessageBox(win, {
			type: "warning",
			buttons: ["Close anyway", "Keep window open"],
			defaultId: 1,
			cancelId: 1,
			title: "Codewomplers Grok Desktop",
			message: "Some text is not saved or sent yet.",
			detail: "Keep the window open to finish saving or to send the queued message. If it closes now, that text is lost.",
		}).then(({ response }) => {
			asking = false;
			if (response !== 0 || win.isDestroyed()) { pendingUpdate = null; return; }
			leave = true;
			void prepareUnload(wasClosing);
		}, () => { asking = false; pendingUpdate = null; });
	});
	win.webContents.on("destroyed", stopOwnedTurn);
	win.webContents.on("destroyed", () => {
		for (const [id, owner] of cloudOwners) {
			if (owner.contents === contents) {
				cloudOwners.delete(id);
				cloudHost.stop(id);
			}
		}
	});
	win.webContents.on("render-process-gone", stopOwnedTurn);
	win.webContents.on("render-process-gone", () => grokBotWindow.hide(win));
	win.webContents.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument && isAppPage(details.url)) {
			stopOwnedTurn();
			grokBotWindow.hide(win);
		}
	});
	win.webContents.on("will-frame-navigate", (details) => {
		const source = details.frame?.url ?? "";
		const blocked = details.isMainFrame
			? !isAppPage(details.url)
			: (source === "about:srcdoc" || source.startsWith("about:srcdoc#")) && details.url !== "about:srcdoc";
		if (blocked) {
			details.preventDefault();
		}
	});
	win.webContents.on("will-redirect", (details) => {
		if (details.isMainFrame) {
			details.preventDefault();
		}
	});

  if (process.platform === "win32") {
    win.setIcon(appIcon);
    win.setAppDetails({
      appId: "Grok.Code",
      appIconPath: appIconFile,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${appDir}" --build-if-stale`,
      relaunchDisplayName: "Codewomplers Grok Desktop",
    });
  }
  const failed = "data:text/html," + encodeURIComponent(
    "<body style=\"margin:0;background:#161513;color:#f4f0e6;font-family:Segoe UI,sans-serif;padding:28px\">This window could not load its page.</body>",
  );
  let revealed = false;
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
		// Opening the app by hand while the page loads has already shown this window, so it stays up.
		if (atSignIn && !win.isVisible()) {
			if (placement.maximized) { win.once("restore", () => win.maximize()); }
			win.minimize();
			return;
		}
		if (placement.maximized) { win.maximize(); }
    win.show();
  };
  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    if (!url || url === "about:blank") return;
    reveal();
  });
  win.webContents.on("did-fail-load", (_event, code, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (String(failedUrl || "").startsWith("data:")) return;
    win.loadURL(failed).catch(() => {});
  });
  if (!fs.existsSync(pageFile)) {
    win.loadURL(failed).catch(() => {});
    return win;
  }
	const destination = new URL(appPageUrl);
	if (uiSessionId) { destination.searchParams.set("session", uiSessionId); }
	win.loadURL(destination.href).catch(() => {
    if (!win.isDestroyed()) win.loadURL(failed).catch(() => {});
  });
	return win;
}

ipcMain.handle("grok:set-mode", (_event, uiSessionId, mode) => host.setMode(String(uiSessionId || ""), mode));

function promptFromWindow(event, payload, options) {
	if (changingSignIn) { return Promise.resolve({ ok: false, error: "Grok's sign-in is changing. Try again in a moment." }); }
	const uiSessionId = payload && payload.uiSessionId;
	if (options?.routine && routines?.run(payload.routineRunId)?.state !== "running") { return Promise.resolve({ ok: false, error: "Stopped." }); }
	const previous = host.turns.get(uiSessionId);
	const turnId = payload?.turnId;
	if (!previous && typeof turnId === "string" && turnId.trim() && turnId.length <= 200) {
		const turns = turnOwners.get(uiSessionId);
		if (turns?.has(turnId) && turns.get(turnId) !== event.sender) {
			return Promise.resolve({ ok: false, error: "That turn belongs to another window." });
		}
		if (!turns) { turnOwners.set(uiSessionId, new Map()); }
		turnOwners.get(uiSessionId).set(turnId, event.sender);
	}
	const result = host.prompt(payload, options);
	const turn = host.turns.get(uiSessionId);
	if (turn && turn !== previous) {
		if (!turnOwners.has(uiSessionId)) { turnOwners.set(uiSessionId, new Map()); }
		turnOwners.get(uiSessionId).set(turn.turnId, event.sender);
		owners.set(uiSessionId, { contents: event.sender, turn });
	}
	return result;
}

function promptWithSandboxSnapshot(event, payload, options) {
	const id = payload?.uiSessionId;
	if (startingSandboxTurns.has(id)) { return Promise.resolve({ ok: false, error: "Grok is still starting in this session." }); }
	if (!payload?.sandbox || typeof id !== "string" || !id || typeof payload.cwd !== "string" || !payload.cwd || host.turns.has(id)) {
		return promptFromWindow(event, payload, options);
	}
	const capture = rememberSandboxGit(payload.cwd);
	if (!capture) { return promptFromWindow(event, payload, options); }
	const start = { contents: event.sender, folder: sandboxGitFolder(payload.cwd) };
	startingSandboxTurns.set(id, start);
	return capture.then(() => {
		if (startingSandboxTurns.get(id) !== start) { return { ok: false, error: "Stopped." }; }
		startingSandboxTurns.delete(id);
		return start.contents.isDestroyed() ? { ok: false, error: "Closed." } : promptFromWindow(event, payload, options);
	});
}

const autoArchiveRemovals = new Map();

function worktreeContains(folder, cwd) {
	const relative = path.relative(folder, cwd);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

ipcMain.handle("grok:send", (event, payload) => {
	const uiSessionId = payload?.uiSessionId;
	const turnId = payload?.turnId;
	const routineRunId = payload?.routineRunId;
	const routine = routineRunId !== undefined;
	if (routine && !routines?.sendStarted(uiSessionId, turnId, (runId) => runId === routineRunId && routineOwners.get(runId) === event.sender)) {
		return Promise.resolve({ ok: false, error: "Stopped." });
	}
	const cwd = autoArchiveRemovals.size && typeof payload?.cwd === "string" && sandboxGitFolder(payload.cwd);
	const removals = cwd ? [...autoArchiveRemovals].filter(([folder]) => worktreeContains(folder, cwd)).map(([, removal]) => removal) : [];
	// Once Git starts deleting, it cannot be interrupted safely. Until then, starting a turn wins.
	const result = removals.some((removal) => removal.deleting)
		? Promise.resolve({ ok: false, error: "This worktree is being auto-archived. Unarchive the session when it finishes to continue." })
		: promptWithSandboxSnapshot(event, payload, { routine });
	if (removals.length && (host.turns.has(uiSessionId) || startingSandboxTurns.has(uiSessionId))) {
		for (const removal of removals) { removal.skipped = true; }
	}
	if (routine) {
		void result.then((value) => routines.startResult(uiSessionId, turnId, value), (error) => routines.startResult(uiSessionId, turnId, { ok: false, error: error?.message }));
	}
	return result;
});

function ownsTurn(event, uiSessionId) {
	const owner = owners.get(uiSessionId);
	return !!owner && owner.contents === event.sender && owner.turn === host.turns.get(uiSessionId);
}

ipcMain.handle("grok:cancel", (event, uiSessionId) => {
	if (startingSandboxTurns.get(uiSessionId)?.contents === event.sender) { startingSandboxTurns.delete(uiSessionId); }
	const ownsRetained = !host.turns.has(uiSessionId) && owners.get(uiSessionId)?.contents === event.sender;
	if (ownsTurn(event, uiSessionId) || ownsRetained) {
		host.cancel(uiSessionId);
	}
});

function startCloudTurn(event, payload, resume) {
	const { uiSessionId, turnId } = payload || {};
	const contents = event.sender;
	if (typeof uiSessionId !== "string" || !uiSessionId || typeof turnId !== "string" || !turnId || !BrowserWindow.fromWebContents(contents) || contents.isDestroyed()) {
		return { ok: false, error: "Invalid Cloud session." };
	}
	if (changingCursorKey) { return { ok: false, error: "The Cursor key is changing. Try again in a moment." }; }
	if (!cursorKey.status().keyReadable) { return { ok: false, error: "Add a readable Cursor key in Settings." }; }
	const previous = cloudOwners.get(uiSessionId);
	const live = cloudHost.turnOf(uiSessionId);
	if (live && previous?.contents !== contents) { return { ok: false, error: "This session is running in another window." }; }
	if (live && !resume) { return { ok: false, error: "This Cloud session already has a running turn." }; }
	const owner = { contents, turnId };
	cloudOwners.set(uiSessionId, owner);
	const result = resume ? cloudHost.resume(payload) : cloudHost.send(payload);
	if (!result.ok && cloudOwners.get(uiSessionId) === owner) {
		if (live && previous) { cloudOwners.set(uiSessionId, previous); } else { cloudOwners.delete(uiSessionId); }
	}
	return result;
}

ipcMain.handle("grok:cloud-send", (event, payload) => startCloudTurn(event, payload, false));
ipcMain.handle("grok:cloud-resume", (event, payload) => startCloudTurn(event, payload, true));
ipcMain.handle("grok:cloud-cancel", (event, uiSessionId) => {
	const owner = cloudOwners.get(uiSessionId);
	if (!owner || owner.contents !== event.sender || owner.turnId !== cloudHost.turnOf(uiSessionId)) {
		return { ok: false, error: "This Cloud turn belongs to another window or has ended." };
	}
	return cloudHost.cancel(uiSessionId);
});

ipcMain.handle("grok:stop-session", (_event, uiSessionId) => {
	if (typeof uiSessionId === "string" && uiSessionId) {
		startingSandboxTurns.delete(uiSessionId);
		host.stopSession(uiSessionId);
	}
});

ipcMain.handle("grok:suggest-prompt", (_event, uiSessionId) => host.suggestPrompt(String(uiSessionId || "")));

ipcMain.handle("grok:kill-task", (_event, uiSessionId, taskId) => host.killTask(String(uiSessionId || ""), String(taskId || "")));

ipcMain.handle("grok:rewind", (_event, payload) => host.rewind(payload));

ipcMain.handle("grok:fork", (_event, payload) => host.fork(payload));

ipcMain.handle("grok:steer", (event, uiSessionId, text) => {
	const id = String(uiSessionId || "");
	return ownsTurn(event, id) ? host.steer(id, text) : { ok: false, error: "Grok has finished this turn." };
});

ipcMain.handle("grok:forget-session", (_event, uiSessionId) => {
	if (typeof uiSessionId === "string" && uiSessionId) {
		startingSandboxTurns.delete(uiSessionId);
		host.forgetSession(uiSessionId);
	}
});

ipcMain.handle("grok:decide", (event, payload) => {
	if (!ownsTurn(event, payload && payload.uiSessionId)) {
		return { ok: false, error: "That approval belongs to another window." };
	}
	return host.decide(payload);
});

// Commands saved with Always allow, by folder, for Settings to list and remove.
ipcMain.handle("grok:always-rules", () => host.listRules());
ipcMain.handle("grok:always-rule-remove", (_event, folder, command) => (typeof folder === "string" && typeof command === "string" ? host.removeRule(folder, command) : { ok: false, error: "That rule is already gone." }));

ipcMain.handle("grok:answer-question", (event, payload) => {
	if (!ownsTurn(event, payload && payload.uiSessionId)) { return { ok: false, error: "That question belongs to another window." }; }
	return host.answerQuestion(payload);
});

ipcMain.handle("grok:answer-plan", (event, payload) => {
	if (!ownsTurn(event, payload && payload.uiSessionId)) { return { ok: false, error: "That plan belongs to another window." }; }
	return host.answerPlan(payload);
});

ipcMain.handle("grok:allowed-folders", (event, payload) => {
	const uiSessionId = payload && payload.uiSessionId;
	if (host.turns.has(uiSessionId) && !ownsTurn(event, uiSessionId)) {
		return { ok: false, error: "That session is running in another window." };
	}
	return host.setAllowedFolders(payload);
});

ipcMain.handle("grok:diff", (_event, cwd) => readDiff(cwd));

ipcMain.handle("grok:files", (_event, cwd) => listFiles(cwd));

ipcMain.handle("grok:read", (_event, cwd, file) => readText(cwd, file));

ipcMain.handle("grok:read-image", (_event, cwd, file) => readImage(cwd, file));

ipcMain.handle("grok:write", (_event, cwd, file, text, expectedVersion) => writeText(cwd, file, text, expectedVersion));

ipcMain.handle("grok:revert", (event, cwd, file, policy) => {
	if (policy?.sandbox !== true) { return revertFile(cwd, file); }
	return revertFile(cwd, file, async () => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.isDestroyed()) { return false; }
		const answer = await dialog.showMessageBox(win, {
			type: "warning", message: `Allow Git filters to revert ${file}?`,
			detail: "Git may run filter programs outside the sandbox. Continue only if you trust this repository's Git configuration.",
			buttons: ["Run filters and revert", "Cancel"], defaultId: 1, cancelId: 1,
		});
		return answer.response === 0 && !win.isDestroyed();
	});
});
ipcMain.handle("grok:revert-hunk", (_event, cwd, file, hunk) => revertHunk(cwd, file, hunk));

ipcMain.handle("grok:pick-folder", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    title: "Session folder",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("grok:pick-files", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    title: "Add files",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle("grok:new-window", (_event, uiSessionId) => {
	if (uiSessionId !== undefined && (typeof uiSessionId !== "string" || !uiSessionId.trim() || uiSessionId.length > 512)) {
		return { ok: false, error: "Choose a session to open." };
	}
	createWindow(uiSessionId);
  return { ok: true };
});

ipcMain.handle("grok:copy", (_event, text) => {
  if (typeof text !== "string" || !text.trim() || text.length > 5000000 || text.includes("\0")) {
    return { ok: false, error: "That text could not be copied." };
  }
  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle("grok:export-markdown", async (event, payload) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const sessionId = payload && payload.agentSessionId;
  return chooseExport({
    sessionId,
    title: payload && payload.title,
    write: (request) => savedSessionData("export", request),
    choose: async (name) => {
      const options = {
        title: "Export as Markdown",
        defaultPath: path.join(app.getPath("documents"), name),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const picked = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options));
      return picked.canceled || !picked.filePath ? "" : picked.filePath;
    },
  });
});

ipcMain.handle("grok:reveal", (_event, cwd, file) => {
	const located = locateFile(cwd, file);
	if (!located.ok) { return { ok: false, error: located.error }; }
	shell.showItemInFolder(located.target);
	return { ok: true };
});

ipcMain.handle("grok:terminal-open", (event, payload) => {
	const result = terminals.open({ cwd: payload && payload.cwd });
	if (result.ok) { terminalOwners.set(result.id, event.sender); }
	return result;
});
ipcMain.handle("grok:terminal-write", (event, id, text) => (terminalOwners.get(id) === event.sender ? terminals.write(id, text) : { ok: false, error: "That terminal is closed." }));
ipcMain.handle("grok:terminal-input", (event, id, data) => (terminalOwners.get(id) === event.sender ? terminals.input(id, data) : { ok: false, error: "That terminal is closed." }));
ipcMain.handle("grok:terminal-resize", (event, id, cols, rows) => (terminalOwners.get(id) === event.sender ? terminals.resize(id, cols, rows) : { ok: false, error: "That terminal is closed." }));
ipcMain.handle("grok:terminal-close", (event, id) => (terminalOwners.get(id) === event.sender ? terminals.close(id) : { ok: false, error: "That terminal is closed." }));
ipcMain.handle("grok:terminal-interrupt", (event, id) => (terminalOwners.get(id) === event.sender ? terminals.interrupt(id) : { ok: false, error: "That terminal is closed." }));

ipcMain.handle("grok:branch-info", (_event, cwd) => git.branchInfo(cwd));
ipcMain.handle("grok:scoped-diff", (_event, cwd, scope) => git.readScopedDiff(cwd, scope));
ipcMain.handle("grok:read-changes", async ({ sender }, request) => {
	if (typeof request?.id !== "string" || !/^[\w-]{1,128}$/.test(request.id)) { return { ok: false, error: "Choose a changes request to load." }; }
	const previous = changeReads.get(sender);
	if (previous?.id === request.id) { return { ok: false, error: "That changes request is already loading." }; }
	previous?.controller.abort();
	const current = { id: request.id, controller: new AbortController() };
	const stop = () => current.controller.abort();
	changeReads.set(sender, current);
	sender.once("destroyed", stop);
	try {
		return await git.readChanges(request, current.controller.signal);
	} finally {
		sender.removeListener("destroyed", stop);
		if (changeReads.get(sender) === current) { changeReads.delete(sender); }
	}
});
ipcMain.handle("grok:stop-changes", ({ sender }, id) => {
	const active = changeReads.get(sender);
	if (active?.id === id) { active.controller.abort(); }
});
ipcMain.handle("grok:list-commits", (_event, cwd) => git.listCommits(cwd));
ipcMain.handle("grok:pr-status", (_event, cwd, number) => git.prStatus(cwd, Number.isInteger(number) && number > 0 ? number : undefined));
function withSandboxGit(event, cwd, policy, title, run, lfsNote = "", setsUpstream = false) {
	if (policy?.sandbox !== true) { return run(); }
	return (async () => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof cwd !== "string" || !cwd) { return { ok: false, error: "Choose a folder in this window to use Git." }; }
		const key = sandboxGitFolder(cwd);
		if (sandboxGitActions.has(key)) { return { ok: false, error: "A sandbox Git action is already in progress in this folder." }; }
		sandboxGitActions.add(key);
		try {
			await sandboxGitCaptures.get(key);
			const before = sandboxGitHistory().get(key);
			const now = await git.gitSecuritySnapshot(cwd, setsUpstream).catch(() => null);
			const changed = before && now?.ok ? [
				...(before.config !== now.config ? ["Git configuration"] : []),
				...(before.hooks !== now.hooks ? ["Git hooks"] : []),
			] : [];
			const warning = !before || !now?.ok ? "Git configuration and hooks could not be compared with a saved snapshot."
				: changed.length ? `${changed.join(" and ")} changed since the last saved Git snapshot.` : "";
			const chooseHooks = typeof policy.hooks !== "boolean";
			let hooks = policy.hooks === true;
			if (win.isDestroyed()) { return { ok: false, error: "Git action cancelled." }; }
			if (warning || chooseHooks) {
				const answer = await dialog.showMessageBox(win, {
					type: warning ? "warning" : "question", message: title,
					detail: [warning, hooks ? "Git hooks will run for this action." : "Git hooks are off by default for sandbox sessions.", lfsNote].filter(Boolean).join("\n\n"),
					buttons: ["Continue", "Cancel"], defaultId: 1, cancelId: 1,
					...(chooseHooks ? { checkboxLabel: "Run Git hooks this time", checkboxChecked: false } : {}),
				});
				if (answer.response !== 0 || win.isDestroyed()) { return { ok: false, error: "Git action cancelled." }; }
				if (chooseHooks) { hooks = answer.checkboxChecked === true; }
			}
			let upstreamBranch;
			try {
				return await run(hooks, setsUpstream ? (branch) => { upstreamBranch = branch; } : undefined);
			} finally {
				await sandboxGitCaptures.get(key);
				let accepted = now?.ok ? now : before;
				if (upstreamBranch && now?.upstream) {
					const prior = now.upstream(upstreamBranch);
					const after = await git.gitSecuritySnapshot(cwd, true).catch(() => null);
					const upstream = after?.upstream?.(upstreamBranch);
					if (upstream?.established && prior.config === upstream.config) {
						accepted = { config: after.config, hooks: now.hooks };
					}
				}
				saveSandboxGit(key, accepted);
			}
		} finally {
			sandboxGitActions.delete(key);
		}
	})();
}

ipcMain.handle("grok:pr-create", (event, cwd, expected, policy) => withSandboxGit(event, cwd, policy, "Create a pull request?", (hooks, onUpstream) =>
	git.prCreate(cwd, { expected: typeof expected === "string" ? expected : undefined, ...(hooks !== undefined ? { hooks, onUpstream } : {}) }),
	"With hooks off, the push can skip uploading Git LFS files.", true));
ipcMain.handle("grok:git-commit", (event, cwd, options) => withSandboxGit(event, cwd, options, options?.push ? "Commit and push?" : "Commit changes?", (hooks, onUpstream) =>
	git.commitFiles(cwd, hooks === undefined ? options : { ...options, hooks, onUpstream }), "", options?.push === true));
ipcMain.handle("grok:pr-merge", (_event, cwd, number) => git.prMergeWhenReady(cwd, number));
const worktreeLfsNote = "With hooks off, a worktree can keep Git LFS pointers if a checkout hook normally fetches the files.";
ipcMain.handle("grok:add-worktree", (event, cwd, payload) => withSandboxGit(event, cwd, payload, "Create a worktree?", (hooks) =>
	git.addWorktree(cwd, { name: payload?.name, prefix: payload?.prefix, ...(hooks !== undefined ? { hooks } : {}) }),
	worktreeLfsNote));
ipcMain.handle("grok:restore-worktree", (event, folder, branch, policy) => git.restoreWorktree(folder, branch,
	policy?.sandbox === true ? (cwd, add) => withSandboxGit(event, cwd, policy, "Restore a worktree?", add, worktreeLfsNote) : undefined));
ipcMain.handle("grok:remove-worktree", async (_event, cwd, folder, payload) => {
	const key = typeof folder === "string" && folder ? sandboxGitFolder(folder) : "";
	const branch = typeof payload?.branch === "string" ? payload.branch : undefined;
	if (payload?.autoArchive === true && key) {
		const skipped = { ok: false, skipped: true };
		if (autoArchiveRemovals.has(key)) { return skipped; }
		const removal = { deleting: false, skipped: false };
		const occupied = () => removal.skipped ||
			[...startingSandboxTurns.values()].some((start) => worktreeContains(key, start.folder)) ||
			[...host.turns.values()].some((turn) => !turn.finished && typeof turn.cwd === "string" && worktreeContains(key, sandboxGitFolder(turn.cwd)));
		if (occupied()) { return skipped; }
		autoArchiveRemovals.set(key, removal);
		try {
			await host.stopFolder(folder);
			if (occupied()) { return skipped; }
			const result = await git.removeWorktree(cwd, folder, { branch, beforeRemove() {
				if (occupied()) { return false; }
				removal.deleting = true;
				return true;
			} });
			return !removal.deleting && occupied() ? skipped : result;
		} finally {
			autoArchiveRemovals.delete(key);
		}
	}
	if (key) {
		for (const [id, start] of startingSandboxTurns) { if (start.folder === key) { startingSandboxTurns.delete(id); } }
	}
	await host.stopFolder(folder);
	return git.removeWorktree(cwd, folder, { force: !!payload?.force, branch });
});

ipcMain.handle("grok:open-external", (_event, url) => {
	if (!httpUrl(url)) { return { ok: false, error: "Only http and https links open outside." }; }
	return shell.openExternal(String(url)).then(() => ({ ok: true }), () => ({ ok: false, error: "That link could not open." }));
});

// VS Code's CLI is a .cmd; start Code.exe beside it instead, so no shell parses the path.
// On macOS and Linux `code` is a script with a shebang, which spawn runs directly.
function vsCodeExe() {
	if (process.platform !== "win32") {
		const which = spawnSync("which", ["code"], { encoding: "utf8" });
		return which.status === 0 ? String(which.stdout || "").split(/\r?\n/)[0].trim() : "";
	}
	const found = spawnSync("where.exe", ["code"], { encoding: "utf8", windowsHide: true });
	const cmd = String(found.stdout || "").split(/\r?\n/).map((line) => line.trim()).find((line) => /code\.cmd$/i.test(line));
	if (!cmd) { return ""; }
	const exe = path.resolve(path.dirname(cmd), "..", "Code.exe");
	return fs.existsSync(exe) ? exe : "";
}

ipcMain.handle("grok:open-in", (_event, payload) => {
	const target = payload && payload.target;
	const cwd = payload && payload.cwd;
	const file = payload && payload.file;
	const line = payload && Number.isInteger(payload.line) && payload.line > 0 ? payload.line : 0;
	let absolute = cwd;
	if (file) {
		const located = locateFile(cwd, file);
		if (!located.ok) { return { ok: false, error: located.error }; }
		absolute = located.target;
	} else if (typeof cwd !== "string" || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		return { ok: false, error: "That folder is not on this computer." };
	}
	if (target === "explorer") {
		if (file && (!DEFAULT_APP_EXT.has(path.extname(file).toLowerCase()) || !DEFAULT_APP_EXT.has(path.extname(absolute).toLowerCase()))) {
			return { ok: false, error: "That kind of file doesn't open from here." };
		}
		return shell.openPath(absolute).then((error) => (error ? { ok: false, error } : { ok: true }));
	}
	if (target === "vscode") {
		const exe = vsCodeExe();
		if (!exe) { return { ok: false, error: "VS Code is not installed, or `code` is not on PATH." }; }
		const child = spawn(exe, file ? ["-g", `${absolute}${line ? `:${line}` : ""}`] : [absolute], { detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", () => {});
		child.unref();
		return { ok: true };
	}
	return { ok: false, error: "Choose where to open it." };
});

ipcMain.handle("grok:browser-tabs", (event, payload) => browserAgent.setTabs(event.sender, payload));
ipcMain.handle("grok:browser-stop", (event, id) => (owners.get(id)?.contents === event.sender ? browserAgent.stop(id) : { ok: false, error: "That browser belongs to another window." }));
ipcMain.handle("grok:browser-resume", (event, id) => (owners.get(id)?.contents === event.sender ? browserAgent.resume(id) : { ok: false, error: "That browser belongs to another window." }));

ipcMain.handle("grok:clear-browsing-data", async (_event, partition) => {
	if (partition !== "persist:grok-code" && !/^temp:grok-[A-Za-z0-9-]+$/.test(String(partition))) { return { ok: false, error: "Unknown browser storage." }; }
	try {
		const target = session.fromPartition(partition);
		await target.clearStorageData();
		await target.clearCache();
		return { ok: true };
	} catch {
		return { ok: false, error: "Browsing data could not be cleared." };
	}
});

ipcMain.handle("grok:attention", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !win.isDestroyed() && !win.isFocused()) { win.flashFrame(true); }
	return { ok: true };
});

const taskbarStates = new Map();
function applyDockBadge() {
	if (process.platform === "darwin") {
		const anyNeedsYou = [...taskbarStates.values()].some((state) => state === "needs-you");
		app.dock.setBadge(anyNeedsYou ? "•" : "");
	}
}
let badge = null;
function badgeImage() {
	if (badge) { return badge; }
	const size = 16;
	const pixels = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - 7.5;
			const dy = y - 7.5;
			if (dx * dx + dy * dy <= 49) { pixels.set([0x62, 0x8a, 0xe0, 0xff], (y * size + x) * 4); }
		}
	}
	badge = nativeImage.createFromBitmap(pixels, { width: size, height: size });
	return badge;
}
ipcMain.handle("grok:taskbar", (event, state) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win || win.isDestroyed() || !["idle", "running", "needs-you"].includes(state)) { return { ok: false }; }
	const windowId = win.id;
	if (!taskbarStates.has(windowId)) {
		win.once("closed", () => {
			taskbarStates.delete(windowId);
			applyDockBadge();
		});
	}
	taskbarStates.set(windowId, state);
	applyDockBadge();
	win.setProgressBar(state === "running" ? 2 : -1, state === "running" ? { mode: "indeterminate" } : undefined);
	win.setOverlayIcon(state === "needs-you" ? badgeImage() : null, state === "needs-you" ? "Grok needs you" : "");
	return { ok: true };
});

let awakeId = -1;
let awakeRequest = null;
function applyKeepAwake() {
	const payload = awakeRequest;
	const want = !!(payload && payload.working) && (payload.onBattery !== false || !powerMonitor.isOnBatteryPower());
	if (want && awakeId < 0) { awakeId = powerSaveBlocker.start("prevent-app-suspension"); }
	if (!want && awakeId >= 0) {
		powerSaveBlocker.stop(awakeId);
		awakeId = -1;
	}
}
ipcMain.handle("grok:keep-awake", (_event, payload) => {
	awakeRequest = payload;
	applyKeepAwake();
	return { ok: true };
});
// A switch between battery and mains power rechecks the last request, so "Keep awake on battery power" follows the power source.
app.whenReady().then(() => {
	powerMonitor.on("on-battery", applyKeepAwake);
	powerMonitor.on("on-ac", applyKeepAwake);
});

const pastedImages = createPastedImages({ getPath: (name) => app.getPath(name), platform: process.platform, spawnSync });
ipcMain.handle("grok:save-image", (_event, base64) => pastedImages.save(base64));
ipcMain.on("grok:prune-pasted-images", (event, history, backup) => {
	event.returnValue = event.sender === pasteStartupContents && pastedImages.prune(history, (id) => coldChats.read(id), backup);
});

// Clicking an attached image opens it full size in its own window. Only an image file loads, sandboxed and with no preload.
ipcMain.handle("grok:open-image", (event, file) => {
	if (typeof file !== "string" || !path.isAbsolute(file) || !/\.(png|jpe?g|gif|webp)$/i.test(file) || !fs.existsSync(file)) {
		return { ok: false, error: "That image is no longer on this computer." };
	}
	const size = nativeImage.createFromPath(file).getSize();
	const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const width = Math.min(Math.max(size.width, 400), Math.round(area.width * 0.9));
	const height = Math.min(Math.max(size.height, 300), Math.round(area.height * 0.9));
	const win = new BrowserWindow({
		parent: BrowserWindow.fromWebContents(event.sender) || undefined,
		x: Math.round(area.x + (area.width - width) / 2),
		y: Math.round(area.y + (area.height - height) / 2),
		width,
		height,
		useContentSize: true,
		title: path.basename(file),
		backgroundColor: "#0e0e0e",
		autoHideMenuBar: true,
		icon: appIcon.isEmpty() ? undefined : appIcon,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	win.loadFile(file).catch(() => {});
	return { ok: true };
});

ipcMain.handle("grok:app-info", () => ({ ok: true, version: app.getVersion(), electron: process.versions.electron }));
// The answer is what the system says, not a saved setting: Windows' Startup apps can turn it off, and macOS may not keep an unsigned app's login item.
ipcMain.handle("grok:open-at-sign-in", (_event, enabled) => {
	const isWindows = process.platform === "win32";
	const isLinux = !isWindows && process.platform !== "darwin";
	// macOS takes no arguments for a login item, so a source checkout would open bare Electron.
	const available = process.platform !== "darwin" || app.isPackaged;
	const command = signInCommand({ isPackaged: app.isPackaged, execPath: process.execPath, appDir });
	const file = autostartFile(process.env, os.homedir());
	// Never `name`: Electron writes the Run value under it but reads it back under the app's user model id, so a custom name always reads as off.
	const item = isWindows ? { path: command.path, args: command.args } : {};
	let error = "";
	if (typeof enabled === "boolean" && available) {
		try {
			if (!isLinux) {
				app.setLoginItemSettings({ openAtLogin: enabled, ...item });
			} else if (enabled) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, desktopEntry(command));
			} else {
				fs.rmSync(file, { force: true });
			}
		} catch (failure) {
			error = `The setting could not be changed: ${failure.message}`;
		}
	}
	const system = isLinux ? { openAtLogin: fs.existsSync(file) } : app.getLoginItemSettings(item);
	const on = system.openAtLogin === true;
	return { ok: !error, available, on, blockedBySystem: isWindows && on && !system.executableWillLaunchAtLogin, ...(error ? { error } : {}) };
});
ipcMain.handle("grok:update-check", (_event, force) => updates.checkForUpdate(appDir, app.getVersion(), { force: force === true, packaged: app.isPackaged }));
// One at a time across every window: two prepares would overwrite the same download.
ipcMain.handle("grok:update-prepare", async (_event, tag) => {
	if (preparingUpdate) { return { ok: true, ready: false, busy: true }; }
	preparingUpdate = true;
	stagedUpdate = null;
	try {
		if (!app.isPackaged) { return await updates.updatePrepare(appDir, app.getVersion(), tag, { packaged: false }); }
		const appRoot = updates.installedRoot(process.platform, process.execPath);
		const prepared = await updates.updatePrepare(appDir, app.getVersion(), tag, { packaged: true, installed: { appRoot, arch: process.arch, home: os.homedir(), localAppData: process.env.LOCALAPPDATA, userData: app.getPath("userData") } });
		if (!prepared.ready) { return prepared; }
		const { kind, file, staged, previous, sandbox, checksum, ...shown } = prepared;
		stagedUpdate = { tag, appRoot, kind, file, staged, previous, sandbox, checksum };
		return shown;
	} finally {
		preparingUpdate = false;
	}
});
ipcMain.handle("grok:update-start", async (_event, tag) => {
	if (pendingUpdate || startingUpdate) { return { ok: false, error: "An update is already running." }; }
	startingUpdate = true;
	try {
		if (await updateHelper.markerLive(updateHelper.readMarker(app.getPath("userData")))) { return { ok: false, error: "An update is already running." }; }
		if (app.isPackaged) {
			// Antivirus can remove an unsigned download while the dialog waits, and the app must not close for a file that's gone.
			if (stagedUpdate?.tag !== tag || !fs.existsSync(stagedUpdate.file)) { return { ok: false, error: "The update isn't ready." }; }
			pendingUpdate = { ...stagedUpdate, installed: true };
		} else {
			const prepared = await updates.updatePrepare(appDir, app.getVersion(), tag, { packaged: false });
			if (!prepared.ok || !prepared.ready) { return { ok: false, error: prepared.reason || "The update isn't ready." }; }
			pendingUpdate = { tag, from: prepared.from, node: prepared.node };
		}
		app.quit();
		return { ok: true };
	} finally {
		startingUpdate = false;
	}
});
ipcMain.handle("grok:update-result", () => {
	const expected = app.isPackaged ? installedUpdateResult() : null;
	if (expected) { return expected; }
	const file = path.join(app.getPath("userData"), "update-result.json");
	try {
		const result = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.unlinkSync(file);
		return result;
	} catch {
		return null;
	}
});
ipcMain.handle("grok:context-breakdown", (_event, agentSessionId) => savedSessionData("context", { sessionId: String(agentSessionId || "") }));
ipcMain.handle("grok:task-output", (_event, file) => savedSessionData("output", { file: String(file || "") }));
ipcMain.handle("grok:subagent-transcript", (_event, id) => savedSessionData("transcript", { sessionId: String(id || "") }));
ipcMain.handle("grok:recent-spend", () => savedSessionData("spend"));
function sandboxText(event) {
	return (text) => { if (!event.sender.isDestroyed()) { event.sender.send("grok:sandbox-text", redactKeys(text)); } };
}
const sandboxGrok = () => ({ grokExe: grokPath(), grokHome: grokHome(), env: { ...process.env, ...signIn.grokEnv() } });
ipcMain.handle("grok:sandbox-check", (_event, choice) => sandbox.check(choice));
ipcMain.handle("grok:sandbox-holder", () => sandbox.windowsSandboxHolder());
ipcMain.handle("grok:sandbox-test", (_event, choice, model) => sandbox.runTest(choice, { ...sandboxGrok(), model }).then(redactDeep));
ipcMain.handle("grok:sandbox-sign-in", (event, choice) => sandbox.signIn(choice, { ...sandboxGrok(), onText: sandboxText(event) }).then(redactDeep));
ipcMain.handle("grok:sandbox-build", (event) => sandbox.buildImage(sandboxText(event)).then(redactDeep));
ipcMain.handle("grok:sandbox-cancel", () => sandbox.cancelJob());
ipcMain.handle("grok:list-cli-sessions", (_event, knownIds) => usage.listCliSessions(knownIds));
ipcMain.handle("grok:list-cli-project-folders", () => usage.listCliProjectFolders());
ipcMain.handle("grok:session-loops", async (_event, uiSessionId, agentSessionId) => {
	if (host.procs.has(String(uiSessionId || ""))) { return { ok: true, live: true }; }
	return savedSessionData("loops", { sessionId: String(agentSessionId || "") });
});
ipcMain.handle("grok:open-cli-session", (_event, agentSessionId) => usage.openCliSession(String(agentSessionId || "")));
ipcMain.handle("grok:readiness", async (_event, request) => {
	const result = await customize.readiness(request && typeof request.folder === "string" ? request.folder : "", !!request && request.full === true);
	return { ...result, app: { version: app.getVersion(), electron: process.versions.electron, os: `${process.platform} ${os.release()} ${process.arch}` } };
});
ipcMain.handle("grok:install-grok", async () => {
	const result = await customize.installGrok();
	if (process.platform === "win32") { git.useBundledGit(); }
	return result;
});
ipcMain.handle("grok:update-grok-cli", () => customize.updateGrok());
ipcMain.handle("grok:install-git", () => customize.installGit());
ipcMain.handle("grok:customize", (_event, cwd, skillsOnly) => customize.inventory(cwd, skillsOnly));
ipcMain.handle("grok:skill-excerpt", (_event, cwd, skillPath) => customize.skillExcerpt(cwd, skillPath));
ipcMain.handle("grok:customize-change", (_event, cwd, input) => customize.change(cwd, input));
// Undefined until Grok first starts in this app; null after signing out.
ipcMain.handle("grok:account", () => host.account);
ipcMain.handle("grok:inbound", (event, enabled) => {
	if (!inboundWindows.has(event.sender)) {
		inboundWindows.add(event.sender);
		event.sender.once("destroyed", () => inboundWindows.delete(event.sender));
	}
	return inbound.setEnabled(enabled === true).then(() => ({ ok: true }), (error) => ({ ok: false, error: error.message }));
});
ipcMain.handle("grok:inbound-result", (event, requestId, result) => {
	const wait = inboundWaits.get(requestId);
	if (wait && wait.contents === event.sender) {
		inboundWaits.delete(requestId);
		wait.resolve(result);
	}
});

const ROUTINE_NOTE = "[Scheduled run. Nobody is watching. Do not ask questions. If something is blocked, say what and carry on.]";

function firstRoutineWindow() {
	return [...routineWindows].find((contents) => !contents.isDestroyed()) ?? null;
}

function routineWindow() {
	const focused = focusedContents();
	return focused && routineWindows.has(focused) && !focused.isDestroyed() ? focused : firstRoutineWindow();
}

function dispatchRoutine({ run, routine }, contents) {
	let folder = routine.folder;
	try {
		if (!folder) {
			folder = path.join(app.getPath("userData"), "routines", routine.id);
			fs.mkdirSync(folder, { recursive: true });
		} else if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
			routines.fail(run.id, `That folder is not on this computer: ${folder}`, true);
			return;
		}
	} catch (error) {
		routines.fail(run.id, `The routine's folder could not be used: ${error.message}`, true);
		return;
	}
	routineOwners.set(run.id, contents);
	contents.send("grok:event", {
		type: "routine-fire",
		runId: run.id,
		routineId: routine.id,
		sessionId: run.sessionId,
		title: `${routine.name} · ${new Date(run.scheduledFor).toLocaleDateString([], { month: "short", day: "numeric" })}`,
		project: routine.folder ? path.basename(routine.folder) || routine.name : routine.name,
		folder,
		model: routine.model,
		effort: routine.effort,
		mode: routine.mode,
		text: `${ROUTINE_NOTE}\n\n${routine.prompt}`,
	});
}

// ponytail: runs due in the same minute all start together, with no cap. Add a cap if someone has enough routines for it to matter.
function routineTick() {
	const contents = routines && routineWindow();
	if (!contents) { return; }
	for (const fire of routines.tick()) { dispatchRoutine(fire, contents); }
}

function openRoutineRun(runId, asking) {
	const run = routines?.run(runId);
	const owner = routineOwners.get(runId);
	// routineWindows leaves out an owner whose page crashed or is reloading, which isDestroyed alone does not.
	const target = owner && routineWindows.has(owner) && !owner.isDestroyed() ? owner : asking && !asking.isDestroyed() ? asking : firstRoutineWindow();
	if (!target) { return { ok: false, error: "No window is ready to show that run." }; }
	target.send("grok:event", { type: "routine-open", ...(run?.sessionId ? { sessionId: run.sessionId } : {}), ...(run?.agentSessionId ? { agentSessionId: run.agentSessionId } : {}) });
	const win = BrowserWindow.fromWebContents(target);
	if (win && !win.isDestroyed()) {
		if (win.isMinimized()) { win.restore(); }
		win.show();
		win.focus();
	}
	return { ok: true };
}

// Held until it closes or is clicked, so its click handler is not garbage collected.
function showRoutineNotice({ title, body, runId }) {
	const notice = new Notification({ title, body });
	routineNotices.add(notice);
	notice.on("close", () => routineNotices.delete(notice));
	notice.on("click", () => {
		routineNotices.delete(notice);
		openRoutineRun(runId);
	});
	notice.show();
}

// Right after sign-in the network is often not up, so that launch waits for the interval.
ipcMain.handle("grok:routines-ready", (event) => {
	routineWindows.add(event.sender);
	if (!process.argv.includes("--at-sign-in")) { routineTick(); }
});
ipcMain.handle("grok:routines", (event, request) => {
	if (!routines) { return { ok: false, error: "Routines are not available right now." }; }
	const action = request?.action;
	if (action === "list") { return { ok: true, ...routines.state() }; }
	if (action === "save" || action === "setEnabled") {
		const result = action === "save" ? routines.save(request.routine) : routines.setEnabled(request.id, request.enabled);
		// A once time already past becomes a missed run now, not at the next interval.
		if (result.ok) { routineTick(); }
		return result;
	}
	if (action === "remove") { return routines.remove(request.id); }
	if (action === "runNow") {
		const contents = routineWindow();
		if (!contents) { return { ok: false, error: "No window is ready to start this run." }; }
		const result = routines.runNow(request.id);
		if (!result.ok) { return result; }
		dispatchRoutine(result.fire, contents);
		return { ok: true, runId: result.fire.run.id };
	}
	if (action === "stop") {
		const run = routines.run(request.runId);
		if (!run || !isOutstanding(run)) { return { ok: false, error: "That run has already ended." }; }
		host.cancel(run.sessionId);
		if (!host.turns.has(run.sessionId)) { routines.interrupt(run.id); }
		return { ok: true };
	}
	if (action === "open") { return openRoutineRun(request.runId, event.sender); }
	return { ok: false, error: "Unknown routine action." };
});
// Only for a start that failed in the window the run went to. A start that works reports through grok:send.
ipcMain.handle("grok:routine-result", (event, runId, result) => {
	if (routineOwners.get(runId) === event.sender && result?.ok === false) { routines?.fail(runId, result.error); }
});
ipcMain.handle("grok:billing", () => host.billing());
let changingSignIn = false;
async function changeSignIn(verb, action) {
	if ([...host.turns.values()].some((turn) => !turn.finished)) { return { ok: false, error: `Grok is still answering. Press Stop or wait, then ${verb}.` }; }
	if (changingSignIn) { return { ok: false, error: "Grok's sign-in is already changing. Wait, then try again." }; }
	changingSignIn = true;
	try { return await action(); }
	catch { return { ok: false, error: "Couldn't finish changing Grok's sign-in. Check Settings and try again." }; }
	finally { changingSignIn = false; }
}

async function signOutGrok() {
	try {
		const result = await customize.signOut();
		if (result.ok) { return { ok: true }; }
		if (typeof result.error === "string" && result.error) {
			const envKey = process.env.XAI_API_KEY;
			const message = envKey?.trim() ? result.error.replaceAll(envKey, "[redacted]") : result.error;
			return { ok: false, error: redactKeys(message) };
		}
	} catch {}
	return { ok: false, error: "Grok couldn't sign out. Try again." };
}

ipcMain.handle("grok:sign-in-status", () => signIn.status());
ipcMain.handle("grok:sign-in-save", (_event, input, options) => changeSignIn("save", async () => {
	const checked = signIn.check(input);
	if (!checked.ok) { return checked; }
	let changed = false;
	try {
		if (input.mode === "key") {
			let probe;
			try { probe = await probeGrok(); } catch {}
			if (!probe?.ok) { return { ok: false, error: "Grok couldn't be checked, so nothing was saved. Try again." }; }
			if (probe.signIn === "saved") {
				if (options?.signOutConfirmed !== true) { return { ok: false, needsSignOut: true }; }
				const logout = await signOutGrok();
				if (!logout.ok) { return logout; }
				changed = true;
			}
		}
		const result = signIn.save(input);
		changed = changed || result.ok;
		return result;
	} finally {
		if (changed) { host.signInChanged(); }
	}
}));
ipcMain.handle("grok:sign-in-remove-key", () => changeSignIn("remove the key", () => {
	const result = signIn.removeKey();
	if (result.ok) { host.signInChanged(); }
	return result;
}));
ipcMain.handle("grok:sign-out", () => changeSignIn("sign out", async () => {
	const status = signIn.status();
	if (status.mode === "key" && status.hasKey) { return { ok: false, error: "API-key mode is on. Remove the key in Settings, or choose Grok sign-in." }; }
	const result = await signOutGrok();
	if (result.ok) { host.signedOut(); }
	return result;
}));

async function changeCursorKey(action) {
	if (changingCursorKey) { return { ok: false, error: "The Cursor key is already changing. Try again in a moment." }; }
	if (cloudOwners.size) { return { ok: false, error: "A Cloud turn is still running. Stop it or wait before changing the Cursor key." }; }
	changingCursorKey = true;
	try {
		const result = await action();
		if (result.ok) {
			cursorModels = undefined;
			broadcast({ type: "cloud-key-changed" });
		}
		return result;
	} catch { return { ok: false, error: "Couldn't change the Cursor key. Try again." }; }
	finally { changingCursorKey = false; }
}

ipcMain.handle("grok:cloud-key-status", () => cursorKey.status());
ipcMain.handle("grok:grokbot-status", () => grokBot.status());
ipcMain.handle("grok:grokbot-sign-in", () => grokBot.signIn());
ipcMain.handle("grok:grokbot-cancel-sign-in", () => grokBot.cancelSignIn());
ipcMain.handle("grok:grokbot-sign-out", () => grokBot.signOut());
ipcMain.handle("grok:grokbot-history", (_event, agentId, beforeSeq) => grokBot.history(agentId, beforeSeq));
ipcMain.handle("grok:grokbot-send", (_event, payload) => grokBot.send(payload));
ipcMain.handle("grok:grokbot-stop", (_event, agentId) => grokBot.stop(agentId));
ipcMain.handle("grok:grokbot-answer", (_event, payload) => grokBot.answer(payload));
ipcMain.handle("grok:grokbot-open-file", (_event, payload) => grokBot.openFile(payload));
ipcMain.handle("grok:grokbot-retry", () => grokBot.retry());
ipcMain.handle("grok:grokbot-window-open", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win ? grokBotWindow.open(win) : { ok: false };
});
ipcMain.handle("grok:grokbot-window-place", (event, box) => grokBotWindow.place(BrowserWindow.fromWebContents(event.sender), box));
ipcMain.handle("grok:grokbot-window-hide", (event) => grokBotWindow.hide(BrowserWindow.fromWebContents(event.sender)));
ipcMain.handle("grok:grokbot-window-release", () => grokBotWindow.release());
ipcMain.handle("grok:cloud-key-save", (_event, key) => changeCursorKey(async () => {
	if (!validKey(key)) { return { ok: false, error: "Enter a Cursor key of 1 to 512 characters with no spaces." }; }
	if (!cursorKey.status().keyring) { return { ok: false, error: "This computer has no keyring the app can use, so the Cursor key can't be saved." }; }
	const checked = await createCursorApi({ getKey: () => key }).me();
	if (!checked.ok) { return { ok: false, error: redactKeys(checked.error) }; }
	const name = typeof checked.apiKeyName === "string" ? redactKeys(checked.apiKeyName).slice(0, 200) : "";
	return cursorKey.save(key, name);
}));
ipcMain.handle("grok:cloud-key-remove", () => changeCursorKey(cursorKey.remove));

function githubCloudUrl(value, bare = false) {
	if (typeof value !== "string") { return ""; }
	const url = bare && /^github\.com\//i.test(value) ? `https://${value}` : value;
	const match = /^(?:https:\/\/(?:[\w.%+-]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
	return match && match[2] !== "." && match[2] !== ".." ? `https://github.com/${match[1]}/${match[2]}` : "";
}

function cloudModels() {
	if (!cursorModels) {
		const pending = cursorApi.models().then((reply) => {
			if (reply.ok && Array.isArray(reply.items)) { return { models: reply.items }; }
			if (cursorModels === pending) { cursorModels = undefined; }
			return { modelsError: redactKeys(reply.error || "Cursor didn't return its models.") };
		});
		cursorModels = pending;
	}
	return cursorModels;
}

async function cloudDirty(folder, options) {
	const filters = await localFilterOff(folder);
	if (filters === null) { return undefined; }
	const status = await git.git([...filters, "--no-optional-locks", "status", "--porcelain", "--ignore-submodules=dirty"], folder, undefined, options);
	if (status.code === 0 || status.truncated) { return !!status.out || status.truncated === true; }
}

ipcMain.handle("grok:cloud-setup", async (_event, folder) => {
	if (typeof folder !== "string" || !path.isAbsolute(folder)) { return { ok: false, error: "Choose a local repository folder." }; }
	const result = await git.git(["rev-parse", "--abbrev-ref", "@{u}"], folder);
	const upstream = result.out.trim();
	const slash = upstream.indexOf("/");
	if (result.code !== 0 || slash < 1 || slash === upstream.length - 1) {
		return { ok: false, error: "This branch isn't on GitHub. Push it, then check again." };
	}
	const remote = await git.git(["remote", "get-url", "--", upstream.slice(0, slash)], folder);
	const repoUrl = remote.code === 0 ? githubCloudUrl(remote.out.trim()) : "";
	if (!repoUrl) { return { ok: false, error: "Cloud sessions need a github.com remote." }; }
	const options = { env: { GIT_NO_LAZY_FETCH: "1" } };
	const [counts, dirty, repos, models] = await Promise.all([
		git.git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], folder, undefined, options),
		cloudDirty(folder, options),
		cursorApi.repositories(),
		cloudModels(),
	]);
	const pair = counts.code === 0 ? /^(\d+)\s+(\d+)$/.exec(counts.out.trim()) : null;
	const reachable = repos.ok && Array.isArray(repos.items)
		? repos.items.some((item) => githubCloudUrl(item?.url, true).toLowerCase() === repoUrl.toLowerCase())
		: null;
	return {
		ok: true, repoUrl, ref: upstream.slice(slash + 1), upstream,
		...(pair ? { behind: Number(pair[1]), ahead: Number(pair[2]) } : {}),
		dirty,
		reachable,
		...(reachable === null ? { error: redactKeys(repos.error || "Cursor didn't return its repositories.") } : {}),
		...models,
	};
});
// Read once by the preload: the folder a first session opens in.
ipcMain.on("grok:home-dir", (event) => { event.returnValue = os.homedir(); });
// Synchronous because the history save calls them: a chat leaves the saved value only after its file is written.
const coldChats = createColdChats(path.join(app.getPath("userData"), "chats"));
ipcMain.on("grok:read-cold-chat", (event, id) => { event.returnValue = coldChats.read(id); });
ipcMain.on("grok:write-cold-chat", (event, id, text) => { event.returnValue = coldChats.write(id, text); });
ipcMain.handle("grok:remove-cold-chats", (_event, ids) => coldChats.remove(ids));

const DEV_SCRIPTS = ["dev", "start", "serve", "preview", "storybook"];
ipcMain.handle("grok:dev-scripts", (_event, cwd) => {
	try {
		const data = JSON.parse(fs.readFileSync(path.join(String(cwd), "package.json"), "utf8"));
		const scripts = data && data.scripts && typeof data.scripts === "object" ? data.scripts : {};
		return { ok: true, scripts: DEV_SCRIPTS.filter((name) => typeof scripts[name] === "string").map((name) => ({ script: name, command: String(scripts[name]).slice(0, 200) })) };
	} catch {
		return { ok: true, scripts: [] };
	}
});

function aboutDialog(win) {
	const detail = `Version ${app.getVersion()}\nElectron ${process.versions.electron}\n\nCopyright (c) 2026 Codewomplers. MIT License.\nNot affiliated with or endorsed by xAI. Grok is a trademark of its owner.`;
	dialog.showMessageBox(win, { type: "info", title: "About Codewomplers Grok Desktop", message: "Codewomplers Grok Desktop", detail, buttons: ["Copy version", "Close"], defaultId: 1, cancelId: 1 }).then(({ response }) => {
		if (response === 0) { clipboard.writeText(app.getVersion()); }
	});
}

// Whichever copy opens after an installed update reads this once: the new version if it worked, the old one if it didn't.
function installedUpdateResult() {
	const file = path.join(app.getPath("userData"), "update-expected.json");
	let version;
	try {
		version = JSON.parse(fs.readFileSync(file, "utf8")).version;
		fs.unlinkSync(file);
	} catch {
		return null;
	}
	if (version === app.getVersion()) { return { ok: true, message: `Updated to version ${version}.` }; }
	return { ok: false, message: `The update to version ${version} didn't finish. Try again from Help > Check for Updates, or update by hand: ${updates.updateSteps()}` };
}

// An update reopens the app the way it was started, except that it must not reopen minimized.
function relaunchArgs() {
	return process.argv.slice(1).filter((arg) => arg !== "--at-sign-in");
}

function startInstalledUpdate(update) {
	const userData = app.getPath("userData");
	const expected = path.join(userData, "update-expected.json");
	const failed = (error) => {
		try { fs.rmSync(expected, { force: true }); } catch {}
		try { updateHelper.writeAtomic(path.join(userData, "update-result.json"), { ok: false, message: `The update couldn't start: ${error.message}. Nothing was updated. To update by hand: ${updates.updateSteps()}` }); } catch {}
	};
	try {
		updateHelper.writeAtomic(expected, { version: update.tag.slice(1) });
		const { program, args } = updates.installedUpdateCommand(update, { platform: process.platform, pid: process.pid, userData, argv: relaunchArgs() });
		const child = spawn(program, args, { detached: true, stdio: "ignore", cwd: os.tmpdir() });
		child.on("error", failed);
		child.unref();
	} catch (error) {
		failed(error);
	}
}

async function checkForUpdates(win) {
	const result = await updates.checkForUpdate(appDir, app.getVersion(), { force: true, packaged: app.isPackaged });
	if (result.ok && result.available) {
		const { response } = await dialog.showMessageBox(win, { type: "info", title: "Check for Updates", message: `Version ${result.latest} is available`, buttons: ["Update…", "Later"], defaultId: 1, cancelId: 1 });
		if (response === 0 && win && !win.isDestroyed()) { win.webContents.send("grok:event", { type: "update-open", current: result.current, latest: result.latest, tag: result.tag }); }
		return;
	}
	const latest = result.ok && result.reason === "up-to-date";
	const noReleases = app.isPackaged ? "No releases were found on GitHub." : "No published GitHub release with a matching tag in this copy's origin was found.";
	const failed = app.isPackaged ? "The update check couldn't reach GitHub." : "The update check couldn't finish checking GitHub releases and this copy's origin.";
	const reason = result.reason === "no-releases" ? noReleases : result.reason === "not-checkout" ? "This copy isn't a git checkout of the app." : failed;
	const detail = app.isPackaged
		? `Codewomplers Grok Desktop updates come from its GitHub releases.\nVersion ${app.getVersion()}. ${updates.updateInstructions()}`
		: `Codewomplers Grok Desktop checks the published GitHub release, then its tag in this copy's git origin.\nVersion ${app.getVersion()}. To update, quit Codewomplers Grok Desktop, then in its folder run git pull, npm install and npm run desktop.`;
	await dialog.showMessageBox(win, {
		type: "info", title: "Check for Updates",
		message: latest ? `You have the latest version (${app.getVersion()}).` : reason,
		...(latest ? {} : { detail }),
	});
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
	// macOS shows the first menu as the application menu whatever its label.
	...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
	{ label: "File", submenu: [{ label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() }, { type: "separator" }, { role: "quit" }] },
	{ role: "editMenu" },
	{ label: "View", submenu: [
		{ label: "Reload", click: (_item, win) => {
			const reload = reloadAppWindow.get(win);
			if (reload) { reload(); } else { win?.webContents?.reload(); }
		} },
		{ role: "toggleDevTools" }, { type: "separator" },
		{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
		{ type: "separator" },
		{ label: "Use Default UI", click: (_item, win) => { if (win && !win.isDestroyed()) { win.webContents.send("grok:event", { type: "ui-default" }); } } },
	] },
	{ label: "Help", submenu: [
		{ label: "About Codewomplers Grok Desktop", click: (_item, win) => aboutDialog(win) },
		{ label: "Check for Updates…", click: (_item, win) => checkForUpdates(win) },
	] },
]));

const GUEST_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);
const browserDiagnosticSessions = new WeakMap();

function watchBrowserGuest(guest) {
	let guests = browserDiagnosticSessions.get(guest.session);
	if (!guests) {
		guests = new Map();
		browserDiagnosticSessions.set(guest.session, guests);
		const report = (details, message) => {
			const owner = guests.get(details.webContentsId);
			if (!owner || owner.isDestroyed() || !owner.hostWebContents || owner.hostWebContents.isDestroyed()) { return; }
			let url;
			try {
				const parsed = new URL(details.url);
				if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) { return; }
				parsed.username = "";
				parsed.password = "";
				parsed.search = "";
				parsed.hash = "";
				url = parsed.href;
			} catch { return; }
			owner.hostWebContents.send("grok:browser-problem", { webContentsId: owner.id, url, message: message.slice(0, 500), at: Date.now() });
		};
		guest.session.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
			if (details.error === "net::ERR_ABORTED" || details.error === "ERR_ABORTED") { return; }
			const code = typeof details.error === "string" && /^(?:net::)?ERR_[A-Z0-9_]+$/.test(details.error) ? details.error : "Network request failed.";
			report(details, code);
		});
		guest.session.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
			if (Number.isInteger(details.statusCode) && details.statusCode >= 400) { report(details, `HTTP ${details.statusCode}`); }
		});
	}
	guests.set(guest.id, guest);
	guest.once("destroyed", () => { if (guests.get(guest.id) === guest) { guests.delete(guest.id); } });
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Electron shows no right-click menu of its own, so build one for the app window and the Browser pane.
function contextMenuItems(contents, params) {
	const items = [];
	if (params.misspelledWord) {
		for (const word of (params.dictionarySuggestions || []).slice(0, 5)) {
			items.push({ label: word, click: () => contents.replaceMisspelling(word) });
		}
		if (!items.length) { items.push({ label: "No spelling suggestions", enabled: false }); }
		items.push({ label: "Add to dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
	}
	if (httpUrl(params.linkURL)) {
		items.push({ label: "Open link in browser", click: () => shell.openExternal(params.linkURL) }, { label: "Copy link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
	}
	const flags = params.editFlags || {};
	if (params.isEditable) {
		items.push(
			{ role: "undo", enabled: !!flags.canUndo },
			{ role: "redo", enabled: !!flags.canRedo },
			{ type: "separator" },
			{ role: "cut", enabled: !!flags.canCut },
			{ role: "copy", enabled: !!flags.canCopy },
			{ role: "paste", enabled: !!flags.canPaste },
			{ type: "separator" },
			{ role: "selectAll", enabled: !!flags.canSelectAll },
		);
	} else if (params.selectionText && params.selectionText.trim()) {
		items.push({ role: "copy" });
	}
	while (items.length && items[items.length - 1].type === "separator") { items.pop(); }
	return items;
}

app.on("web-contents-created", (_event, contents) => {
	const allowedGuestSessions = new WeakSet();
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("context-menu", (_menuEvent, params) => {
		const items = contextMenuItems(contents, params);
		if (!items.length) { return; }
		const win = BrowserWindow.fromWebContents(contents.hostWebContents || contents);
		Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
	});
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    const partition = String((params && params.partition) || webPreferences.partition || "");
    const partitionOk = partition === "persist:grok-code" || /^temp:grok-[A-Za-z0-9-]+$/.test(partition);
		if (!httpUrl(params && params.src) || !partitionOk) {
			event.preventDefault();
			return;
		}
		// Pages in the Browser pane get no device, notification or external-app access.
		const guestSession = session.fromPartition(partition);
		browserAgent.guestSession(guestSession);
		if (BrowserWindow.fromWebContents(contents)?.webContents === contents) { allowedGuestSessions.add(guestSession); }
		guestSession.setPermissionRequestHandler((_contents, permission, callback) => callback(GUEST_PERMISSIONS.has(permission)));
		guestSession.setPermissionCheckHandler((_contents, permission) => GUEST_PERMISSIONS.has(permission));
  });
  contents.on("did-attach-webview", (_attach, guest) => {
		if (guest.hostWebContents === contents && allowedGuestSessions.has(guest.session)) {
			watchBrowserGuest(guest);
			browserAgent.guestSession(guest.session, guest);
			guest.on("before-input-event", (event, input) => {
				const reloadKey = (input.control && !input.meta) || (process.platform === "darwin" && input.meta && !input.control);
				if (input.type === "keyDown" && reloadKey && !input.alt && !input.shift && input.key.toLowerCase() === "r") {
					event.preventDefault();
					if (!input.isAutoRepeat) { guest.reload(); }
				}
			});
		}
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    const block = (event, url) => {
      if (!httpUrl(url)) event.preventDefault();
    };
    guest.on("will-navigate", block);
    guest.on("will-redirect", block);
  });
});

// One running copy per profile, so two copies never write the same saved chats. A second launch shows this one.
function startApplication() {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	routines = createRoutines({
		file: path.join(app.getPath("userData"), "routines.json"),
		fs,
		writeAtomic: updateHelper.writeAtomic,
		now: () => Date.now(),
		onChange: () => broadcast({ type: "routines", ...routines.state() }),
		onNotice: showRoutineNotice,
	});
	if (app.isPackaged) { updates.removeUpdateFiles({ platform: process.platform, appRoot: updates.installedRoot(process.platform, process.execPath), userData: app.getPath("userData") }); }
	// The DevTools port is for local automation only: it opens when GROK_CODE_DEBUG_PORT names one, never by default, since any process on the computer could drive the app through it.
	if (/^\d+$/.test(process.env.GROK_CODE_DEBUG_PORT || "")) { app.commandLine.appendSwitch("remote-debugging-port", process.env.GROK_CODE_DEBUG_PORT); }
	app.on("second-instance", () => {
		const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
		if (!win) {
			app.whenReady().then(() => createWindow());
			return;
		}
		if (win.isMinimized()) { win.restore(); }
		win.show();
		win.focus();
	});
	if (process.argv.includes("--build-if-stale")) { buildIfStale(); }
	app.whenReady().then(createWindow);
	app.whenReady().then(() => { routineTimer = setInterval(routineTick, 60000); });
	app.whenReady().then(() => grokBot.start());
	app.whenReady().then(repairShortcuts);
	app.whenReady().then(sandbox.stopLeftover);
	// macOS ignores a window's icon and shows the dock icon instead.
	if (process.platform === "darwin" && !appIcon.isEmpty()) { app.whenReady().then(() => app.dock.setIcon(appIcon)); }
}

const startupMarker = app.isPackaged ? null : updateHelper.readMarker(app.getPath("userData"));
if (startupMarker) {
	void (async () => {
		if (await updateHelper.markerLive(startupMarker)) {
			await app.whenReady();
			new Notification({ title: "Codewomplers Grok Desktop is updating", body: "The app usually reopens when the update finishes. If it stays closed, check update.log in the app's data folder." }).show();
			setTimeout(() => app.quit(), 1500);
			return;
		}
		const node = await updateHelper.findNode();
		if (node) {
			const child = spawn(node, [path.join(appDir, "scripts", "update-helper.cjs"), "--recover", "--wait", String(process.pid), app.getPath("userData")], { cwd: appDir, detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
		} else {
			await app.whenReady();
			new Notification({ title: "Codewomplers Grok Desktop couldn't recover its update", body: "Node.js isn't on PATH. Open the app's folder and run node scripts/update-helper.cjs --recover." }).show();
		}
		app.quit();
	})();
} else {
	startApplication();
}

// A window's close event can't hold the quit and then finish it, so Grok Bot closes first.
app.on("before-quit", (event) => {
	if (!grokBotWindow.holding()) { return; }
	event.preventDefault();
	void grokBotWindow.close().finally(() => app.quit());
});

// After every window has closed, so a quit that a window's unsaved-text question cancels leaves Grok running.
app.on("will-quit", () => {
	clearInterval(routineTimer);
	void grokBot.close();
	for (const id of cloudOwners.keys()) { cloudHost.stop(id); }
	cloudOwners.clear();
	terminals.closeAll();
	void browserAgent.close();
	inbound.close();
	host.kill();
	repairShortcuts();
	if (pendingUpdate) {
		const update = pendingUpdate;
		pendingUpdate = null;
		if (update.installed) {
			startInstalledUpdate(update);
			return;
		}
		const failed = (error) => {
			try { updateHelper.writeAtomic(path.join(app.getPath("userData"), "update-result.json"), { ok: false, message: `The update couldn't start: ${error.message}. Nothing was updated.` }); } catch {}
		};
		try {
			const helper = path.join(os.tmpdir(), `grok-code-update-${crypto.randomUUID()}.cjs`);
			fs.copyFileSync(path.join(appDir, "scripts", "update-helper.cjs"), helper);
			const input = { appDir, tag: update.tag, from: update.from, fromVersion: app.getVersion(), waitPid: process.pid, args: relaunchArgs(), cwd: process.cwd(), userData: app.getPath("userData") };
			const child = spawn(update.node, [helper, JSON.stringify(input)], { detached: true, windowsHide: true, stdio: "ignore" });
			child.on("error", failed);
			child.unref();
		} catch (error) {
			failed(error);
		}
	}
});

app.on("window-all-closed", () => {
  host.kill();
  app.quit();
});
