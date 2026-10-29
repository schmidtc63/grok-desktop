const { contextBridge, ipcRenderer, webUtils } = require("electron");

const folderArg = process.argv.find((arg) => arg.startsWith("--grok-default-folder="));

contextBridge.exposeInMainWorld("grokCode", {
	defaultFolder: folderArg ? folderArg.slice("--grok-default-folder=".length) : "",
	pathForFile(file) {
		try {
			return webUtils.getPathForFile(file) || "";
		} catch {
			return "";
		}
	},
	openExternal(url) {
		return ipcRenderer.invoke("grok:open-external", url);
	},
	openIn(payload) {
		return ipcRenderer.invoke("grok:open-in", payload);
	},
	clearBrowsingData(partition) {
		return ipcRenderer.invoke("grok:clear-browsing-data", partition);
	},
	attention() {
		return ipcRenderer.invoke("grok:attention");
	},
	keepAwake(payload) {
		return ipcRenderer.invoke("grok:keep-awake", payload);
	},
	saveImage(base64) {
		return ipcRenderer.invoke("grok:save-image", base64);
	},
	contextBreakdown(agentSessionId) {
		return ipcRenderer.invoke("grok:context-breakdown", agentSessionId);
	},
	recentSpend() {
		return ipcRenderer.invoke("grok:recent-spend");
	},
	appInfo() {
		return ipcRenderer.invoke("grok:app-info");
	},
	devScripts(cwd) {
		return ipcRenderer.invoke("grok:dev-scripts", cwd);
	},
	terminalOpen(payload) {
		return ipcRenderer.invoke("grok:terminal-open", payload);
	},
	terminalWrite(id, text) {
		return ipcRenderer.invoke("grok:terminal-write", id, text);
	},
	terminalClose(id) {
		return ipcRenderer.invoke("grok:terminal-close", id);
	},
	terminalHistory(id) {
		return ipcRenderer.invoke("grok:terminal-history", id);
	},
	branchInfo(cwd) {
		return ipcRenderer.invoke("grok:branch-info", cwd);
	},
	scopedDiff(cwd, scope) {
		return ipcRenderer.invoke("grok:scoped-diff", cwd, scope);
	},
	listCommits(cwd) {
		return ipcRenderer.invoke("grok:list-commits", cwd);
	},
	prStatus(cwd) {
		return ipcRenderer.invoke("grok:pr-status", cwd);
	},
	prCreate(cwd) {
		return ipcRenderer.invoke("grok:pr-create", cwd);
	},
	prMergeWhenReady(cwd) {
		return ipcRenderer.invoke("grok:pr-merge", cwd);
	},
	addWorktree(cwd, payload) {
		return ipcRenderer.invoke("grok:add-worktree", cwd, payload);
	},
	removeWorktree(cwd, folder, payload) {
		return ipcRenderer.invoke("grok:remove-worktree", cwd, folder, payload);
	},
  send(payload) {
    return ipcRenderer.invoke("grok:send", payload);
  },
  cancel(uiSessionId) {
    return ipcRenderer.invoke("grok:cancel", uiSessionId);
  },
  decide(payload) {
    return ipcRenderer.invoke("grok:decide", payload);
  },
	setAllowedFolders(payload) {
		return ipcRenderer.invoke("grok:allowed-folders", payload);
	},
  pickFolder() {
    return ipcRenderer.invoke("grok:pick-folder");
  },
  diff(cwd) {
    return ipcRenderer.invoke("grok:diff", cwd);
  },
  files(cwd) {
    return ipcRenderer.invoke("grok:files", cwd);
  },
  readFile(cwd, file) {
    return ipcRenderer.invoke("grok:read", cwd, file);
  },
	writeFile(cwd, file, text, expectedVersion) {
		return ipcRenderer.invoke("grok:write", cwd, file, text, expectedVersion);
	},
  revertFile(cwd, file) {
    return ipcRenderer.invoke("grok:revert", cwd, file);
  },
  pickFiles() {
    return ipcRenderer.invoke("grok:pick-files");
  },
	answerQuestion(payload) {
		return ipcRenderer.invoke("grok:answer-question", payload);
	},
	answerPlan(payload) {
		return ipcRenderer.invoke("grok:answer-plan", payload);
	},
	newWindow(uiSessionId) {
		return ipcRenderer.invoke("grok:new-window", uiSessionId);
	},
  copyText(text) {
    return ipcRenderer.invoke("grok:copy", text);
  },
  reveal(cwd, file) {
    return ipcRenderer.invoke("grok:reveal", cwd, file);
  },
  run(payload) {
    return ipcRenderer.invoke("grok:run", payload);
  },
  onEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("grok:event", listener);
    return () => ipcRenderer.removeListener("grok:event", listener);
  },
});
