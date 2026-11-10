const { contextBridge, ipcRenderer, webUtils } = require("electron");

const pageArg = "--grok-app-page=";
const appPage = process.argv.find((arg) => arg.startsWith(pageArg))?.slice(pageArg.length);
function appPageAddress(url) {
	return url.split(/[?#]/, 1)[0].replace(/^file:\/\/\/([a-z]):\//i, (_match, drive) => `file:///${drive.toUpperCase()}:/`);
}
if (!process.isMainFrame || !appPage || appPageAddress(window.location.href) !== appPageAddress(appPage)) { return; }

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
	accessibilitySupport() {
		return ipcRenderer.invoke("grok:accessibility-support");
	},
	taskbar(state) {
		return ipcRenderer.invoke("grok:taskbar", state);
	},
	keepAwake(payload) {
		return ipcRenderer.invoke("grok:keep-awake", payload);
	},
	inbound(enabled) {
		return ipcRenderer.invoke("grok:inbound", enabled === true);
	},
	inboundResult(requestId, result) {
		return ipcRenderer.invoke("grok:inbound-result", requestId, result);
	},
	openAtSignIn(enabled) {
		return ipcRenderer.invoke("grok:open-at-sign-in", enabled);
	},
	routinesReady() {
		return ipcRenderer.invoke("grok:routines-ready");
	},
	routines(request) {
		return ipcRenderer.invoke("grok:routines", request);
	},
	routineResult(runId, result) {
		return ipcRenderer.invoke("grok:routine-result", runId, result);
	},
	saveImage(base64) {
		return ipcRenderer.invoke("grok:save-image", base64);
	},
	prunePastedImages(history, backup) {
		return ipcRenderer.sendSync("grok:prune-pasted-images", history, backup);
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
	sandboxCheck(choice) {
		return ipcRenderer.invoke("grok:sandbox-check", choice);
	},
	sandboxHolder() {
		return ipcRenderer.invoke("grok:sandbox-holder");
	},
	sandboxTest(choice, model) {
		return ipcRenderer.invoke("grok:sandbox-test", choice, model);
	},
	sandboxSignIn(choice) {
		return ipcRenderer.invoke("grok:sandbox-sign-in", choice);
	},
	sandboxBuild() {
		return ipcRenderer.invoke("grok:sandbox-build");
	},
	sandboxCancel() {
		return ipcRenderer.invoke("grok:sandbox-cancel");
	},
	onSandboxText(callback) {
		const listener = (_event, text) => callback(text);
		ipcRenderer.on("grok:sandbox-text", listener);
		return () => ipcRenderer.removeListener("grok:sandbox-text", listener);
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
	readColdChat(id) {
		return ipcRenderer.sendSync("grok:read-cold-chat", id);
	},
	writeColdChat(id, text) {
		return ipcRenderer.sendSync("grok:write-cold-chat", id, text);
	},
	removeColdChats(ids) {
		return ipcRenderer.invoke("grok:remove-cold-chats", ids);
	},
	readiness(request) {
		return ipcRenderer.invoke("grok:readiness", request);
	},
	installGrok() {
		return ipcRenderer.invoke("grok:install-grok");
	},
	updateGrokCli() {
		return ipcRenderer.invoke("grok:update-grok-cli");
	},
	installGit() {
		return ipcRenderer.invoke("grok:install-git");
	},
	customize(cwd, skillsOnly) {
		return ipcRenderer.invoke("grok:customize", cwd, skillsOnly);
	},
	skillExcerpt(cwd, skillPath) {
		return ipcRenderer.invoke("grok:skill-excerpt", cwd, skillPath);
	},
	customizeChange(cwd, input) {
		return ipcRenderer.invoke("grok:customize-change", cwd, input);
	},
	account() {
		return ipcRenderer.invoke("grok:account");
	},
	billing() {
		return ipcRenderer.invoke("grok:billing");
	},
	signOut() {
		return ipcRenderer.invoke("grok:sign-out");
	},
	signInStatus() {
		return ipcRenderer.invoke("grok:sign-in-status");
	},
	saveSignIn(input, options) {
		return ipcRenderer.invoke("grok:sign-in-save", input, options);
	},
	removeSignInKey() {
		return ipcRenderer.invoke("grok:sign-in-remove-key");
	},
	cloudKeyStatus() {
		return ipcRenderer.invoke("grok:cloud-key-status");
	},
	grokBotStatus() { return ipcRenderer.invoke("grok:grokbot-status"); },
	grokBotSignIn() { return ipcRenderer.invoke("grok:grokbot-sign-in"); },
	grokBotCancelSignIn() { return ipcRenderer.invoke("grok:grokbot-cancel-sign-in"); },
	grokBotSignOut() { return ipcRenderer.invoke("grok:grokbot-sign-out"); },
	grokBotHistory(agentId, beforeSeq) { return ipcRenderer.invoke("grok:grokbot-history", agentId, beforeSeq); },
	grokBotSend(payload) { return ipcRenderer.invoke("grok:grokbot-send", payload); },
	grokBotStop(agentId) { return ipcRenderer.invoke("grok:grokbot-stop", agentId); },
	grokBotAnswer(payload) { return ipcRenderer.invoke("grok:grokbot-answer", payload); },
	grokBotOpenFile(payload) { return ipcRenderer.invoke("grok:grokbot-open-file", payload); },
	grokBotRetry() { return ipcRenderer.invoke("grok:grokbot-retry"); },
	grokBotWindowOpen() { return ipcRenderer.invoke("grok:grokbot-window-open"); },
	grokBotWindowPlace(box) { return ipcRenderer.invoke("grok:grokbot-window-place", box); },
	grokBotWindowHide() { return ipcRenderer.invoke("grok:grokbot-window-hide"); },
	grokBotWindowRelease() { return ipcRenderer.invoke("grok:grokbot-window-release"); },
	cloudKeySave(key) {
		return ipcRenderer.invoke("grok:cloud-key-save", key);
	},
	cloudKeyRemove() {
		return ipcRenderer.invoke("grok:cloud-key-remove");
	},
	cloudSetup(folder) {
		return ipcRenderer.invoke("grok:cloud-setup", folder);
	},
	cloudSend(payload) {
		return ipcRenderer.invoke("grok:cloud-send", payload);
	},
	cloudResume(payload) {
		return ipcRenderer.invoke("grok:cloud-resume", payload);
	},
	cloudCancel(uiSessionId) {
		return ipcRenderer.invoke("grok:cloud-cancel", uiSessionId);
	},
	devScripts(cwd) {
		return ipcRenderer.invoke("grok:dev-scripts", cwd);
	},
	terminalOpen(payload) {
		return ipcRenderer.invoke("grok:terminal-open", payload);
	},
	browserTabs(payload) {
		return ipcRenderer.invoke("grok:browser-tabs", payload);
	},
	browserStop(uiSessionId) {
		return ipcRenderer.invoke("grok:browser-stop", uiSessionId);
	},
	browserResume(uiSessionId) {
		return ipcRenderer.invoke("grok:browser-resume", uiSessionId);
	},
	terminalWrite(id, text) {
		return ipcRenderer.invoke("grok:terminal-write", id, text);
	},
	terminalInput(id, data) {
		return ipcRenderer.invoke("grok:terminal-input", id, data);
	},
	terminalResize(id, cols, rows) {
		return ipcRenderer.invoke("grok:terminal-resize", id, cols, rows);
	},
	terminalClose(id) {
		return ipcRenderer.invoke("grok:terminal-close", id);
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
	readChanges(request) {
		return ipcRenderer.invoke("grok:read-changes", request);
	},
	stopChanges(id) {
		return ipcRenderer.invoke("grok:stop-changes", id);
	},
	listCommits(cwd) {
		return ipcRenderer.invoke("grok:list-commits", cwd);
	},
	prStatus(cwd, number) {
		return ipcRenderer.invoke("grok:pr-status", cwd, number);
	},
	prCreate(cwd, expected, ...policy) {
		return ipcRenderer.invoke("grok:pr-create", cwd, expected, ...policy);
	},
	gitCommit(cwd, options) {
		return ipcRenderer.invoke("grok:git-commit", cwd, options);
	},
	prMergeWhenReady(cwd, number) {
		return ipcRenderer.invoke("grok:pr-merge", cwd, number);
	},
	addWorktree(cwd, payload) {
		return ipcRenderer.invoke("grok:add-worktree", cwd, payload);
	},
	restoreWorktree(folder, branch, ...policy) {
		return ipcRenderer.invoke("grok:restore-worktree", folder, branch, ...policy);
	},
	removeWorktree(cwd, folder, payload) {
		return ipcRenderer.invoke("grok:remove-worktree", cwd, folder, payload);
	},
  send(payload) {
    return ipcRenderer.invoke("grok:send", payload);
  },
	setMode(uiSessionId, mode) {
		return ipcRenderer.invoke("grok:set-mode", uiSessionId, mode);
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
	readImage(cwd, file) {
		return ipcRenderer.invoke("grok:read-image", cwd, file);
	},
	writeFile(cwd, file, text, expectedVersion) {
		return ipcRenderer.invoke("grok:write", cwd, file, text, expectedVersion);
	},
	revertFile(cwd, file, policy) {
		return ipcRenderer.invoke("grok:revert", cwd, file, ...(policy ? [policy] : []));
	},
	revertHunk(cwd, file, hunk) {
		return ipcRenderer.invoke("grok:revert-hunk", cwd, file, hunk);
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
  exportMarkdown(payload) {
    return ipcRenderer.invoke("grok:export-markdown", payload);
  },
  listCliSessions(knownIds) {
    return ipcRenderer.invoke("grok:list-cli-sessions", knownIds);
  },
	listCliProjectFolders() {
		return ipcRenderer.invoke("grok:list-cli-project-folders");
	},
  sessionLoops(uiSessionId, agentSessionId) {
    return ipcRenderer.invoke("grok:session-loops", uiSessionId, agentSessionId);
  },
  openCliSession(agentSessionId) {
    return ipcRenderer.invoke("grok:open-cli-session", agentSessionId);
  },
  reveal(cwd, file) {
    return ipcRenderer.invoke("grok:reveal", cwd, file);
  },
  onEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("grok:event", listener);
    return () => ipcRenderer.removeListener("grok:event", listener);
  },
	onGrokBotWindow(callback) {
		const listener = (_event, state) => callback(state);
		ipcRenderer.on("grok:grokbot-window", listener);
		return () => ipcRenderer.removeListener("grok:grokbot-window", listener);
	},
	onBrowserProblem(callback) {
		const listener = (_event, problem) => callback(problem);
		ipcRenderer.on("grok:browser-problem", listener);
		return () => ipcRenderer.removeListener("grok:browser-problem", listener);
	},
});
