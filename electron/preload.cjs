const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("grokCode", {
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
	taskbar(state) {
		return ipcRenderer.invoke("grok:taskbar", state);
	},
	keepAwake(payload) {
		return ipcRenderer.invoke("grok:keep-awake", payload);
	},
	saveImage(base64) {
		return ipcRenderer.invoke("grok:save-image", base64);
	},
	openImage(file) {
		return ipcRenderer.invoke("grok:open-image", file);
	},
	contextBreakdown(agentSessionId) {
		return ipcRenderer.invoke("grok:context-breakdown", agentSessionId);
	},
	taskOutput(file) {
		return ipcRenderer.invoke("grok:task-output", file);
	},
	subagentTranscript(id) {
		return ipcRenderer.invoke("grok:subagent-transcript", id);
	},
	recentSpend() {
		return ipcRenderer.invoke("grok:recent-spend");
	},
	appInfo() {
		return ipcRenderer.invoke("grok:app-info");
	},
	updateCheck(force) {
		return ipcRenderer.invoke("grok:update-check", force);
	},
	updatePrepare(tag) {
		return ipcRenderer.invoke("grok:update-prepare", tag);
	},
	updateStart(tag) {
		return ipcRenderer.invoke("grok:update-start", tag);
	},
	updateResult() {
		return ipcRenderer.invoke("grok:update-result");
	},
	homeDir: ipcRenderer.sendSync("grok:home-dir"),
	platform: process.platform,
	readiness() {
		return ipcRenderer.invoke("grok:readiness");
	},
	customize(cwd) {
		return ipcRenderer.invoke("grok:customize", cwd);
	},
	customizeChange(cwd, input) {
		return ipcRenderer.invoke("grok:customize-change", cwd, input);
	},
	account() {
		return ipcRenderer.invoke("grok:account");
	},
	signOut() {
		return ipcRenderer.invoke("grok:sign-out");
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
	terminalInterrupt(id) {
		return ipcRenderer.invoke("grok:terminal-interrupt", id);
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
	prCreate(cwd, expected) {
		return ipcRenderer.invoke("grok:pr-create", cwd, expected);
	},
	prMergeWhenReady(cwd, number) {
		return ipcRenderer.invoke("grok:pr-merge", cwd, number);
	},
	addWorktree(cwd, payload) {
		return ipcRenderer.invoke("grok:add-worktree", cwd, payload);
	},
	restoreWorktree(folder, branch) {
		return ipcRenderer.invoke("grok:restore-worktree", folder, branch);
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
	stopSession(uiSessionId) {
		return ipcRenderer.invoke("grok:stop-session", uiSessionId);
	},
	suggestPrompt(uiSessionId) {
		return ipcRenderer.invoke("grok:suggest-prompt", uiSessionId);
	},
	killTask(uiSessionId, taskId) {
		return ipcRenderer.invoke("grok:kill-task", uiSessionId, taskId);
	},
	rewind(payload) {
		return ipcRenderer.invoke("grok:rewind", payload);
	},
	fork(payload) {
		return ipcRenderer.invoke("grok:fork", payload);
	},
	steer(uiSessionId, text) {
		return ipcRenderer.invoke("grok:steer", uiSessionId, text);
	},
	forgetSession(uiSessionId) {
		return ipcRenderer.invoke("grok:forget-session", uiSessionId);
	},
  decide(payload) {
    return ipcRenderer.invoke("grok:decide", payload);
  },
	alwaysRules() {
		return ipcRenderer.invoke("grok:always-rules");
	},
	removeAlwaysRule(folder, command) {
		return ipcRenderer.invoke("grok:always-rule-remove", folder, command);
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
