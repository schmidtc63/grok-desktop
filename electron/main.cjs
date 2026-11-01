const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
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
app.setPath("userData", path.join(app.getPath("appData"), "grok-code"));
app.setName("Codewomplers Grok Desktop");
if (process.platform === "win32") app.setAppUserModelId("Grok.Code");
const appIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "codewomplers-grok-desktop.png"));
const { AgentHost } = require("./agent.cjs");
const { readDiff, revertFile } = require("./diff.cjs");
const git = require("./git.cjs");
const { TerminalHost } = require("./terminal.cjs");
const { listFiles, readText, writeText, runCommand, locateFile } = require("./files.cjs");
const usage = require("./usage.cjs");
const customize = require("./customize.cjs");

const owners = new Map();
const terminalOwners = new Map();
const host = new AgentHost((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("grok:event", event);
  }
});

const terminals = new TerminalHost((event) => {
	if (event.type === "terminal-exit") { terminalOwners.delete(event.id); }
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) { win.webContents.send("grok:event", event); }
	}
});

const appDir = path.resolve(__dirname, "..");
const pageFile = path.join(appDir, "dist", "index.html");
const appIconFile = path.join(appDir, "assets", "codewomplers-grok-desktop.ico");

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
				if (link.appUserModelId === "Grok.Code" && path.resolve(link.target).toLowerCase() === process.execPath.toLowerCase() && (link.args !== args || link.icon?.toLowerCase() !== appIconFile.toLowerCase())) {
					shell.writeShortcutLink(file, "update", { target: process.execPath, args, icon: appIconFile, iconIndex: 0 });
				}
			} catch {}
		}
	}
}

function createWindow(uiSessionId) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: "#161513",
    title: "Codewomplers Grok Desktop",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

	const contents = win.webContents;
	// Ctrl+R in the app's own page would reload the window and stop its turns. View > Reload stays, and a focused Browser-pane page still refreshes.
	contents.on("before-input-event", (event, input) => {
		if (input.type === "keyDown" && input.control && !input.alt && !input.meta && input.key.toLowerCase() === "r") { event.preventDefault(); }
	});
	const closeOwnedTerminals = () => {
		for (const [id, owner] of terminalOwners) {
			if (owner === contents) { terminals.close(id); }
		}
	};
	contents.on("did-navigate", closeOwnedTerminals);
	contents.on("destroyed", closeOwnedTerminals);
	contents.on("render-process-gone", closeOwnedTerminals);
	const stopOwnedTurn = () => {
		for (const [uiSessionId, owner] of owners) {
			if (owner.contents === contents && owner.turn === host.turns.get(uiSessionId)) { host.cancel(uiSessionId); }
		}
	};
	// The question is async so the main process keeps answering approvals, and their auto-deny keeps running, while it is open.
	// Without preventDefault the unload is cancelled, so "Close anyway" repeats the close or reload with `leave` set.
	let asking = false;
	let leave = false;
	let closing = false;
	win.on("close", () => { closing = true; });
	win.webContents.on("did-finish-load", () => { leave = false; });
	win.webContents.on("will-prevent-unload", (event) => {
		const wasClosing = closing;
		closing = false;
		if (leave) {
			event.preventDefault();
			return;
		}
		if (asking) { return; }
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
			if (response !== 0 || win.isDestroyed()) { return; }
			leave = true;
			if (wasClosing) { win.close(); } else { win.webContents.reload(); }
		}, () => { asking = false; });
	});
	win.webContents.on("destroyed", stopOwnedTurn);
	win.webContents.on("render-process-gone", stopOwnedTurn);
	win.webContents.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument) {
			stopOwnedTurn();
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
    return;
  }
	win.loadFile(pageFile, uiSessionId ? { query: { session: uiSessionId } } : undefined).catch(() => {
    if (!win.isDestroyed()) win.loadURL(failed).catch(() => {});
  });
}

ipcMain.handle("grok:send", (event, payload) => {
	const uiSessionId = payload && payload.uiSessionId;
	const previous = host.turns.get(uiSessionId);
	const result = host.prompt(payload);
	const turn = host.turns.get(uiSessionId);
	if (turn && turn !== previous) {
		owners.set(uiSessionId, { contents: event.sender, turn });
	}
	return result;
});

function ownsTurn(event, uiSessionId) {
	const owner = owners.get(uiSessionId);
	return !!owner && owner.contents === event.sender && owner.turn === host.turns.get(uiSessionId);
}

ipcMain.handle("grok:cancel", (event, uiSessionId) => {
	if (ownsTurn(event, uiSessionId)) {
		host.cancel(uiSessionId);
	}
});

ipcMain.handle("grok:stop-session", (_event, uiSessionId) => {
	if (typeof uiSessionId === "string" && uiSessionId) { host.stopSession(uiSessionId); }
});

ipcMain.handle("grok:forget-session", (_event, uiSessionId) => {
	if (typeof uiSessionId === "string" && uiSessionId) { host.forgetSession(uiSessionId); }
});

ipcMain.handle("grok:decide", (event, payload) => {
	if (!ownsTurn(event, payload && payload.uiSessionId)) {
		return { ok: false, error: "That approval belongs to another window." };
	}
	return host.decide(payload);
});

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

ipcMain.handle("grok:write", (_event, cwd, file, text, expectedVersion) => writeText(cwd, file, text, expectedVersion));

ipcMain.handle("grok:revert", (_event, cwd, file) => revertFile(cwd, file));

ipcMain.handle("grok:run", (_event, payload) => {
  const cwd = payload && payload.cwd;
  const command = payload && payload.command;
  return runCommand(cwd, command);
});

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
ipcMain.handle("grok:terminal-write", (_event, id, text) => terminals.write(id, text));
ipcMain.handle("grok:terminal-close", (_event, id) => terminals.close(id));
ipcMain.handle("grok:terminal-history", (_event, id) => terminals.history(id));

ipcMain.handle("grok:branch-info", (_event, cwd) => git.branchInfo(cwd));
ipcMain.handle("grok:scoped-diff", (_event, cwd, scope) => git.readScopedDiff(cwd, scope));
ipcMain.handle("grok:list-commits", (_event, cwd) => git.listCommits(cwd));
ipcMain.handle("grok:pr-status", (_event, cwd) => git.prStatus(cwd));
ipcMain.handle("grok:pr-create", (_event, cwd, expected) => git.prCreate(cwd, { expected: typeof expected === "string" ? expected : undefined }));
ipcMain.handle("grok:pr-merge", (_event, cwd, number) => git.prMergeWhenReady(cwd, number));
ipcMain.handle("grok:add-worktree", (_event, cwd, payload) => git.addWorktree(cwd, { name: payload && payload.name, prefix: payload && payload.prefix }));
ipcMain.handle("grok:restore-worktree", (_event, folder, branch) => git.restoreWorktree(folder, branch));
ipcMain.handle("grok:remove-worktree", async (_event, cwd, folder, payload) => {
	await host.stopFolder(folder);
	return git.removeWorktree(cwd, folder, { force: !!(payload && payload.force) });
});

ipcMain.handle("grok:open-external", (_event, url) => {
	if (!httpUrl(url)) { return { ok: false, error: "Only http and https links open outside." }; }
	return shell.openExternal(String(url)).then(() => ({ ok: true }), () => ({ ok: false, error: "That link could not open." }));
});

// VS Code's CLI is a .cmd; start Code.exe beside it instead, so no shell parses the path.
function vsCodeExe() {
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
	} else if (typeof cwd !== "string" || !fs.existsSync(cwd)) {
		return { ok: false, error: "That folder is not on this computer." };
	}
	if (target === "explorer") {
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

ipcMain.handle("grok:save-image", (_event, base64) => {
	if (typeof base64 !== "string" || !base64 || base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) { return { ok: false, error: "That image could not be attached." }; }
	const file = path.join(os.tmpdir(), `grok-code-paste-${crypto.randomUUID()}.png`);
	try {
		fs.writeFileSync(file, Buffer.from(base64, "base64"));
		return { ok: true, path: file };
	} catch {
		return { ok: false, error: "That image could not be attached." };
	}
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
ipcMain.handle("grok:context-breakdown", (_event, agentSessionId) => usage.contextBreakdown(String(agentSessionId || "")));
ipcMain.handle("grok:recent-spend", () => usage.recentSpend());
ipcMain.handle("grok:customize", (_event, cwd) => customize.inventory(cwd));
ipcMain.handle("grok:customize-change", (_event, cwd, input) => customize.change(cwd, input));
// Undefined until Grok first starts in this app; null after signing out.
ipcMain.handle("grok:account", () => host.account);
ipcMain.handle("grok:sign-out", async () => {
	if ([...host.turns.values()].some((turn) => !turn.finished)) { return { ok: false, error: "Grok is still answering. Press Stop or wait, then sign out." }; }
	const result = await customize.signOut();
	if (result.ok) { host.signedOut(); }
	return result;
});
// Read once by the preload: the folder a first session opens in.
ipcMain.on("grok:home-dir", (event) => { event.returnValue = os.homedir(); });

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

Menu.setApplicationMenu(Menu.buildFromTemplate([
	{ label: "File", submenu: [{ label: "New Window", accelerator: "Ctrl+Shift+N", click: () => createWindow() }, { type: "separator" }, { role: "quit" }] },
	{ role: "editMenu" },
	{ label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
	{ label: "Help", submenu: [
		{ label: "About Codewomplers Grok Desktop", click: (_item, win) => aboutDialog(win) },
		{ label: "Check for Updates…", click: (_item, win) => dialog.showMessageBox(win, { type: "info", title: "Check for Updates", message: "Codewomplers Grok Desktop updates come from its git checkout.", detail: `Version ${app.getVersion()}. To update, quit Codewomplers Grok Desktop, then in its folder run git pull, npm install and npm run desktop.` }) },
	] },
]));

const GUEST_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);

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
		guestSession.setPermissionRequestHandler((_contents, permission, callback) => callback(GUEST_PERMISSIONS.has(permission)));
		guestSession.setPermissionCheckHandler((_contents, permission) => GUEST_PERMISSIONS.has(permission));
  });
  contents.on("did-attach-webview", (_attach, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    const block = (event, url) => {
      if (!httpUrl(url)) event.preventDefault();
    };
    guest.on("will-navigate", block);
    guest.on("will-redirect", block);
  });
});

// One running copy per profile, so two copies never write the same saved chats. A second launch shows this one.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
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
	app.whenReady().then(repairShortcuts);
}

// After every window has closed, so a quit that a window's unsaved-text question cancels leaves Grok running.
app.on("will-quit", () => {
	terminals.closeAll();
	host.kill();
	repairShortcuts();
});

app.on("window-all-closed", () => {
  host.kill();
  app.quit();
});
