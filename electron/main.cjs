const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, session, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
app.setPath("userData", path.join(app.getPath("appData"), "grok-code"));
app.setName("Grok");
if (process.platform === "win32") app.setAppUserModelId("Grok.Code");
const appIcon = nativeImage.createFromPath(process.execPath);
const { AgentHost } = require("./agent.cjs");
const { readDiff, revertFile } = require("./diff.cjs");
const git = require("./git.cjs");
const { TerminalHost } = require("./terminal.cjs");
const { listFiles, readText, writeText, runCommand, revealFile, locateFile } = require("./files.cjs");
const usage = require("./usage.cjs");

const owners = new Map();
const host = new AgentHost((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("grok:event", event);
  }
});

const terminals = new TerminalHost((event) => {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) { win.webContents.send("grok:event", event); }
	}
});

const appDir = path.resolve(__dirname, "..");
const pageFile = path.join(appDir, "dist", "index.html");

function createWindow(uiSessionId) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: "#161513",
    title: "Grok Desktop",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // The first session starts in the user's Documents folder.
      additionalArguments: [`--grok-default-folder=${app.getPath("documents")}`],
    },
  });

	const contents = win.webContents;
	const stopOwnedTurn = () => {
		for (const [uiSessionId, owner] of owners) {
			if (owner.contents === contents && owner.turn === host.turns.get(uiSessionId)) { host.cancel(uiSessionId); }
		}
	};
	win.webContents.on("will-prevent-unload", (event) => {
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning",
			buttons: ["Close anyway", "Keep window open"],
			defaultId: 1,
			cancelId: 1,
			title: "Grok Desktop",
			message: "Some editor text is not saved yet.",
			detail: "Keep the window open and try again in a moment. If it closes now, that text is lost.",
		});
		if (choice === 0) { event.preventDefault(); }
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
      appIconPath: process.execPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${appDir}"`,
      relaunchDisplayName: "Grok",
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

ipcMain.handle("grok:reveal", (_event, cwd, file) => revealFile(cwd, file));

ipcMain.handle("grok:terminal-open", (_event, payload) => terminals.open({ cwd: payload && payload.cwd }));
ipcMain.handle("grok:terminal-write", (_event, id, text) => terminals.write(id, text));
ipcMain.handle("grok:terminal-close", (_event, id) => terminals.close(id));
ipcMain.handle("grok:terminal-history", (_event, id) => terminals.history(id));

ipcMain.handle("grok:branch-info", (_event, cwd) => git.branchInfo(cwd));
ipcMain.handle("grok:scoped-diff", (_event, cwd, scope) => git.readScopedDiff(cwd, scope));
ipcMain.handle("grok:list-commits", (_event, cwd) => git.listCommits(cwd));
ipcMain.handle("grok:pr-status", (_event, cwd) => git.prStatus(cwd));
ipcMain.handle("grok:pr-create", (_event, cwd) => git.prCreate(cwd, {}));
ipcMain.handle("grok:pr-merge", (_event, cwd) => git.prMergeWhenReady(cwd));
ipcMain.handle("grok:add-worktree", (_event, cwd, payload) => git.addWorktree(cwd, { name: payload && payload.name, prefix: payload && payload.prefix }));
ipcMain.handle("grok:remove-worktree", (_event, cwd, folder, payload) => git.removeWorktree(cwd, folder, { force: !!(payload && payload.force) }));

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
ipcMain.handle("grok:keep-awake", (_event, payload) => {
	const want = !!(payload && payload.working) && (payload.onBattery !== false || !powerMonitor.isOnBatteryPower());
	if (want && awakeId < 0) { awakeId = powerSaveBlocker.start("prevent-app-suspension"); }
	if (!want && awakeId >= 0) {
		powerSaveBlocker.stop(awakeId);
		awakeId = -1;
	}
	return { ok: true };
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

ipcMain.handle("grok:app-info", () => ({ ok: true, version: app.getVersion(), electron: process.versions.electron }));
ipcMain.handle("grok:context-breakdown", (_event, agentSessionId) => usage.contextBreakdown(String(agentSessionId || "")));
ipcMain.handle("grok:recent-spend", () => usage.recentSpend());

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
	const detail = `Version ${app.getVersion()}\nElectron ${process.versions.electron}`;
	const choice = dialog.showMessageBoxSync(win, { type: "info", title: "About Grok Desktop", message: "Grok Desktop", detail, buttons: ["Copy version", "Close"], defaultId: 1, cancelId: 1 });
	if (choice === 0) { clipboard.writeText(app.getVersion()); }
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
	{ label: "File", submenu: [{ label: "New Window", accelerator: "Ctrl+Shift+N", click: () => createWindow() }, { type: "separator" }, { role: "quit" }] },
	{ role: "editMenu" },
	{ label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
	{ label: "Help", submenu: [
		{ label: "About Grok Desktop", click: (_item, win) => aboutDialog(win) },
		{ label: "Check for Updates…", click: (_item, win) => dialog.showMessageBox(win, { type: "info", title: "Check for Updates", message: "Grok Desktop updates come from its git checkout.", detail: `Version ${app.getVersion()}. Pull the latest commit and run npm run desktop to update.` }) },
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
	app.whenReady().then(createWindow);
}

app.on("before-quit", () => {
  host.kill();
	terminals.closeAll();
});

app.on("window-all-closed", () => {
  host.kill();
  app.quit();
});
