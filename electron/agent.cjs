const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pathToFileURL } = require("url");

// Grok's installer puts the CLI here; GROK_BIN points somewhere else.
const GROK = process.env.GROK_BIN || path.join(os.homedir(), ".grok", "bin", "grok.exe");
const MODELS = new Set(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
const IMAGE_TYPES = new Map(Object.entries({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }));
const IMAGE_LIMIT = 5 * 1024 * 1024;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MODES = new Set(["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"]);

// Headless `grok -p` cannot wait for a click. `session/set_mode` accepts a
// mode id and does not change permission. The saved config is always-approve,
// so each tool is held with a client PreToolUse hook. Allow and deny are
// answers to that hook. A hook that times out runs the tool, so this process
// denies the call itself before that deadline.
const HOOK_TIMEOUT_SEC = 600;
const AUTO_DENY_MS = 8 * 60 * 1000;
const HOOKS = {
  PreToolUse: [{ matcher: ".*", hookCallbackIds: ["gate"], timeout: HOOK_TIMEOUT_SEC }],
};

function folderProblem(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "Choose a folder for this session.";
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return `That folder is not on this computer: ${cwd}`;
  }
  if (!stat.isDirectory()) return `That path is not a folder: ${cwd}`;
  return "";
}

function pathKey(folder) {
  return folder.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function allowedFoldersProblem(folders) {
	if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== "string" || !folder.trim() || folder.includes("\0") || !path.isAbsolute(folder))) {
		return "Allowed folders must be absolute folder paths.";
	}
	return "";
}

function resolvedEditPath(target) {
	let parent = path.resolve(target);
	const missing = [];
	while (true) {
		try {
			return path.join(fs.realpathSync(parent), ...missing);
		} catch (error) {
			if (error.code !== "ENOENT") { throw error; }
			let exists = false;
			try {
				fs.lstatSync(parent);
				exists = true;
			} catch (statError) {
				if (statError.code !== "ENOENT") { throw statError; }
			}
			if (exists) { throw error; }
			const next = path.dirname(parent);
			if (next === parent) { throw error; }
			missing.unshift(path.basename(parent));
			parent = next;
		}
	}
}

function editIsAllowed(turn, input) {
	if (input == null || typeof input !== "object" || Array.isArray(input)) { return false; }
	const keys = ["file_path", "target_file", "path"].filter((key) => Object.prototype.hasOwnProperty.call(input, key));
	if (!keys.length) { return false; }
	if (keys.some((key) => typeof input[key] !== "string" || !input[key].trim() || input[key].includes("\0") || input[key].startsWith("~"))) { return false; }
	try {
		const canonical = (value) => {
			const resolved = resolvedEditPath(value);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		const targets = keys.map((key) => canonical(path.resolve(turn.cwd, input[key])));
		if (targets.some((target) => path.relative(targets[0], target) !== "")) { return false; }
		return [turn.cwd, ...(turn.allowedFolders || []), os.tmpdir()].some((folder) => {
			const relative = path.relative(canonical(folder), targets[0]);
			return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
		});
	} catch {
		return false;
	}
}

function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill();
  }
}

// Grok's tool ids and the names its model sees. Anything else, including MCP
// `server__tool` names, is "other" and asks unless the mode allows everything.
const TOOL_KINDS = new Map(Object.entries({
	read_file: "read",
	list_dir: "read",
	grep: "read",
	search_tool: "read",
	scheduler_list: "read",
	get_command_or_subagent_output: "read",
	get_task_output: "read",
	wait_commands_or_subagents: "read",
	wait_tasks: "read",
	todo_write: "internal",
	ask_user_question: "internal",
	exit_plan_mode: "internal",
	kill_command_or_subagent: "internal",
	kill_task: "internal",
	write: "edit",
	search_replace: "edit",
	hashline_edit: "edit",
	run_terminal_command: "command",
	run_terminal_cmd: "command",
	monitor: "command",
	web_fetch: "network",
	web_search: "network",
}));

const PERMISSION_KINDS = new Map(Object.entries({
	read: "read",
	search: "read",
	edit: "edit",
	delete: "edit",
	move: "edit",
	execute: "command",
	fetch: "network",
}));

function classify(toolName) {
	return TOOL_KINDS.get(String(toolName || "").toLowerCase()) || "other";
}

function actionFor(mode, kind) {
	if (kind === "read" || kind === "internal") { return "allow"; }
	if (mode === "Auto" || mode === "Bypass permissions") { return "allow"; }
	if (mode === "Plan") { return "deny"; }
	if (mode === "Accept edits" && kind === "edit") { return "allow"; }
	return "ask";
}

function isPlanFile(turn, input) {
	const target = input && typeof input === "object" ? input.file_path : "";
	if (!turn || !turn.agentSessionId || typeof target !== "string" || !path.isAbsolute(target)) { return false; }
	const resolved = path.resolve(target);
	const sessions = path.join(os.homedir(), ".grok", "sessions");
	const relative = path.relative(sessions, resolved);
	return path.basename(resolved).toLowerCase() === "plan.md"
		&& path.basename(path.dirname(resolved)) === turn.agentSessionId
		&& !relative.startsWith("..") && !path.isAbsolute(relative)
		&& relative.split(path.sep).length === 3;
}

function lineCount(value) {
	if (typeof value !== "string" || !value) { return 0; }
	return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

function clipText(value, size) {
	const text = typeof value === "string" ? value : "";
	return text.length > size ? `${text.slice(0, size)}…` : text;
}

function summaryOf(toolName, input) {
  const kind = classify(toolName);
  const data = input && typeof input === "object" ? input : {};
  if (kind === "command") {
		return clipText(typeof data.command === "string" ? data.command : String(toolName || "Command"), 500);
  }
  const path = data.file_path || data.path || data.target_file || data.file || data.url || data.query || "";
	if (typeof path === "string" && path) { return clipText(path, 300); }
  return String(toolName || "Tool");
}

function inputOf(input) {
	return input && typeof input === "object" && Object.keys(input).length ? { input: JSON.stringify(input, null, 2) } : {};
}

function todosOf(input) {
	const list = input && Array.isArray(input.todos) ? input.todos : null;
	if (!list) { return null; }
	return list.slice(0, 100).map((item) => {
		const data = item && typeof item === "object" ? item : { content: item };
		const text = [data.content, data.text, data.title, data.description, data.activeForm].find((value) => typeof value === "string" && value.trim());
		const raw = String(data.status || data.state || "").toLowerCase().replace(/[\s-]+/g, "_");
		const status = raw === "completed" || raw === "done" || raw === "complete" ? "completed" : (raw === "in_progress" || raw === "active" || raw === "running" ? "in_progress" : "pending");
		return text ? { text: clipText(text.trim(), 300), status } : null;
	}).filter(Boolean);
}

// "Always allow" remembers a command by its first two words (like "npm test"), and never one that chains, pipes or redirects.
// An MCP call through use_tool is remembered by the MCP tool it names, and never when that name is inside a file.
function alwaysKey(kind, toolName, command, input) {
	if (kind === "command") {
		const text = String(command || "").trim();
		if (!text || /[;&|`$<>()\r\n]/.test(text)) { return ""; }
		const words = text.split(/\s+/);
		// A flag as the second word (`powershell -Command`, `node -e`, `cmd /c`) runs whatever follows, so the whole command is remembered.
		return `command:${(/^[-/]/.test(words[1] || "") ? words : words.slice(0, 2)).join(" ").toLowerCase()}`;
	}
	const name = String(toolName || "").toLowerCase();
	if (name === "use_tool") {
		const target = input && typeof input === "object" && !input.file && typeof input.tool_name === "string" ? input.tool_name.trim().toLowerCase() : "";
		return target ? `tool:use_tool:${target}` : "";
	}
	return `tool:${name}`;
}

function attachmentsProblem(list) {
	if (list === undefined) { return ""; }
	if (!Array.isArray(list) || list.length > 20) { return "Attach at most 20 files."; }
	for (const item of list) {
		if (typeof item !== "string" || !item.trim() || item.includes("\0") || !path.isAbsolute(item)) { return "Attachments must be absolute file paths."; }
		let stat;
		try {
			stat = fs.statSync(item);
		} catch {
			return `That attachment is not on this computer: ${item}`;
		}
		if (!stat.isFile()) { return `That attachment is not a file: ${item}`; }
	}
	return "";
}

function promptBlocks(text, attachments) {
	const files = attachments || [];
	const blocks = [{ type: "text", text: files.length ? `${text}\n\nAttached files:\n${files.join("\n")}` : text }];
	for (const file of files) {
		const mimeType = IMAGE_TYPES.get(path.extname(file).toLowerCase());
		if (mimeType && fs.statSync(file).size <= IMAGE_LIMIT) {
			blocks.push({ type: "image", mimeType, data: fs.readFileSync(file).toString("base64") });
		} else {
			blocks.push({ type: "resource_link", uri: pathToFileURL(file).href, name: path.basename(file) });
		}
	}
	return blocks;
}

// Some Grok commands answer with a notification instead of message text.
function commandNote(update) {
	if (update.sessionUpdate === "memory_files") {
		const all = Array.isArray(update.files) ? update.files : [];
		const files = all.filter((file) => !/[\\/]observations[\\/]/.test(String((file && file.path) || "")));
		const raw = all.length - files.length;
		if (!all.length) { return "No memory files."; }
		return `Memory files:\n${files.slice(0, 50).map((file) => `- \`${String((file && file.path) || "")}\` (${String((file && file.source) || "")})`).join("\n")}${raw ? `\n\n${raw} raw observation note${raw === 1 ? "" : "s"} not shown.` : ""}`;
	}
	if (update.sessionUpdate === "auto_compact_completed") {
		return `Compacted the conversation: ${Number(update.tokens_before) || 0} to ${Number(update.tokens_after) || 0} tokens.`;
	}
	return "";
}

// The context in use after a model call, or after compaction.
function contextOf(update) {
	if (update.sessionUpdate === "response_completed" && update.usage) {
		return ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].reduce((sum, key) => sum + (Number(update.usage[key]) || 0), 0);
	}
	if (update.sessionUpdate === "auto_compact_completed") { return Number(update.tokens_after) || 0; }
	return null;
}

function chunkText(update) {
  const content = update && update.content;
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  return "";
}

class AgentHost {
  constructor(emit) {
    this.emit = emit;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.buf = "";
    this.decoder = new StringDecoder("utf8");
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
		this.turns = new Map();
		this.parents = new Map();
		this.stale = new Map();
    this.gates = new Map();
    this.outcomes = new Map();
		this.cardKinds = new Map();
		this.always = new Map();
		this.commands = [];
		this.models = [];
		this.contextWindows = new Map();
  }

  prompt(input) {
    const problem = this.inputProblem(input);
    if (problem) return Promise.resolve({ ok: false, error: problem });
		if (this.turns.has(input.uiSessionId)) {
			return Promise.resolve({ ok: false, error: "Grok is still answering in this session. Press Stop, or wait for that reply." });
		}
    const missing = folderProblem(input.cwd);
    if (missing) return Promise.resolve({ ok: false, error: missing });
    const mode = MODES.has(input.mode) ? input.mode : "Manual";
		const turn = {
      uiSessionId: input.uiSessionId,
			turnId: input.turnId,
      cwd: input.cwd,
			allowedFolders: [...(input.allowedFolders || [])],
      mode,
			agentSessionId: "",
      cancelled: false,
      finished: false,
      promptId: null,
			slash: /^\/[\w:.-]+(\s|$)/.test(String(input.text || "").trim()),
			said: false,
    };
		this.turns.set(input.uiSessionId, turn);
		return this.dispatch(input, turn);
  }

	emitTurn(turn, event) {
		this.emit({ ...event, uiSessionId: turn.uiSessionId, turnId: turn.turnId });
	}

	checkTurn(turn) {
		if (this.turns.get(turn.uiSessionId) !== turn || turn.cancelled || turn.finished) { throw new Error("Stopped."); }
	}

	checkStart() {
		if (![...this.turns.values()].some((turn) => !turn.cancelled && !turn.finished)) { throw new Error("Stopped."); }
	}

	turnFor(sessionId) {
		let id = String(sessionId || "");
		for (let hops = 0; hops < 8 && this.parents.has(id); hops += 1) { id = this.parents.get(id); }
		if (this.pending.has(this.stale.get(id))) { return null; }
		const live = [...this.turns.values()].filter((turn) => !turn.finished);
		const owner = live.find((turn) => turn.agentSessionId === id);
		if (owner) { return owner; }
		return !id && live.length === 1 ? live[0] : null;
	}

	async dispatch(input, turn) {
    try {
			await this.ensureChild(input);
			this.checkTurn(turn);
      const session = await this.ensureSession(input);
			this.checkTurn(turn);
			turn.agentSessionId = session.sessionId;
			await this.applyConfig(session, input, turn);
			this.checkTurn(turn);
			await this.applyMode(session, turn);
			this.checkTurn(turn);
      const sent = this.request("session/prompt", {
        sessionId: session.sessionId,
				// ponytail: Grok's /context prints only in its own terminal UI; /session-info carries the same context numbers over ACP.
				prompt: promptBlocks(turn.slash && input.text.trim() === "/context" ? "/session-info" : input.text, input.attachments),
      });
			turn.promptId = sent.id;
      sent.promise.then(
				(result) => this.finishPrompt(turn, sent.id, result, ""),
				(error) => this.finishPrompt(turn, sent.id, null, error.message || "Grok rejected the request."),
      );
			return { ok: true, agentSessionId: session.sessionId };
    } catch (error) {
			if (this.turns.get(turn.uiSessionId) === turn && turn.promptId == null) { this.turns.delete(turn.uiSessionId); }
			return { ok: false, error: error.message || "Grok could not start.", ...(error.lostSession ? { lostSession: true } : {}) };
    }
  }

  decide(input) {
    if (!input || (input.decision !== "allow" && input.decision !== "deny" && input.decision !== "always")) {
      return { ok: false, error: "Choose Allow or Deny." };
    }
    const gate = this.gates.get(String(input.toolId || ""));
		if (!gate || gate.uiSessionId !== input.uiSessionId || gate.type) { return { ok: false, error: "That approval already closed." }; }
		if (input.decision === "always") {
			const key = alwaysKey(gate.kind, gate.rawName || gate.toolName, gate.command, gate.toolInput);
			if (key) {
				const keys = this.always.get(gate.uiSessionId) || new Set();
				keys.add(key);
				this.always.set(gate.uiSessionId, keys);
			}
		}
    this.answerGate(gate, input.decision === "deny" ? "deny" : "allow", input.decision === "deny" ? "Denied in Grok Desktop." : "");
    return { ok: true };
  }

	answerQuestion(input) {
		const gate = input && this.gates.get(String(input.toolId || ""));
		if (!gate || gate.type !== "question" || gate.uiSessionId !== input.uiSessionId) { return { ok: false, closed: true, error: "That question already closed." }; }
		const answers = input.answers;
		if (answers !== null) {
			const asked = new Set(gate.questions.map((item) => item.question));
			const entries = answers && typeof answers === "object" && !Array.isArray(answers) ? Object.entries(answers) : [];
			if (entries.length !== asked.size || entries.some(([key, value]) => !asked.has(key) || typeof value !== "string" || !value.trim() || value.length > 4000)) {
				return { ok: false, error: "Answer every question first." };
			}
		}
		this.settleGate(gate, answers === null ? { outcome: "cancelled" } : { outcome: "accepted", answers }, answers === null ? "Declined" : "Answered");
		return { ok: true };
	}

	answerPlan(input) {
		const gate = input && this.gates.get(String(input.toolId || ""));
		if (!gate || gate.type !== "plan" || gate.uiSessionId !== input.uiSessionId) { return { ok: false, closed: true, error: "That plan approval already closed." }; }
		const found = this.turns.get(gate.uiSessionId);
		const turn = found && !found.finished ? found : null;
		if (input.outcome === "approved") {
			if (input.mode !== "Accept edits" && input.mode !== "Manual") { return { ok: false, error: "Choose how to handle edits." }; }
			if (turn) { turn.mode = input.mode; }
			this.settleGate(gate, { outcome: "approved" }, `Approved · ${input.mode}`);
			return { ok: true };
		}
		if (input.outcome === "feedback") {
			if (typeof input.feedback !== "string" || !input.feedback.trim() || input.feedback.length > 8000) { return { ok: false, error: "Write what to change first." }; }
			this.settleGate(gate, { outcome: "feedback", feedback: input.feedback.trim() }, "Changes requested");
			return { ok: true };
		}
		if (input.outcome === "abandoned") {
			if (turn) { turn.mode = "Manual"; }
			this.settleGate(gate, { outcome: "abandoned" }, "Abandoned");
			return { ok: true };
		}
		return { ok: false, error: "Choose approve, keep planning, or abandon." };
	}

	setAllowedFolders(input) {
		if (!input || typeof input.uiSessionId !== "string" || !input.uiSessionId) { return { ok: false, error: "Missing session." }; }
		const problem = allowedFoldersProblem(input.allowedFolders);
		if (problem) { return { ok: false, error: problem }; }
		const turn = this.turns.get(input.uiSessionId);
		if (turn && !turn.finished) { turn.allowedFolders = [...input.allowedFolders]; }
		return { ok: true };
	}

  cancel(uiSessionId) {
		const turn = this.turns.get(uiSessionId);
		if (!turn || turn.finished) { return; }
		turn.cancelled = true;
    this.denyOpen(uiSessionId, "Stopped.");
    const session = this.sessions.get(uiSessionId);
    if (session && this.child && this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: session.sessionId },
      }) + "\n");
    }
    const child = this.child;
    setTimeout(() => {
			if (this.child !== child || this.turns.get(uiSessionId) !== turn || turn.finished) { return; }
			const others = [...this.turns.values()].filter((other) => other !== turn && !other.finished);
			if (turn.promptId == null) {
				if (!others.some((other) => other.promptId != null)) { killTree(child); }
				return;
			}
			if (others.length) {
				// Grok still owes an answer to the stopped prompt; ignore that Grok session until it comes.
				this.stale.set(turn.agentSessionId, turn.promptId);
				this.finishPrompt(turn, turn.promptId, null, "");
				return;
			}
			killTree(child);
    }, 5000);
  }

  kill() {
    this.denyOpen("", "Closed.");
    const child = this.child;
    this.child = null;
    this.ready = false;
		this.turns.clear();
		this.parents.clear();
    this.sessions.clear();
    if (child) killTree(child);
  }

  inputProblem(input) {
    if (!input || typeof input.uiSessionId !== "string" || !input.uiSessionId) return "Missing session.";
    if (typeof input.text !== "string" || !input.text.trim()) return "Write a prompt first.";
    if (!MODELS.has(input.model) && !this.models.some((item) => item.id === input.model)) return "Pick a model from the list.";
    if (!EFFORTS.has(input.effort)) return "Pick an effort from the list.";
		if (input.model === "grok-4.5" && input.effort === "xhigh") { return "Grok 4.5 supports Low, Medium, or High effort."; }
		if (input.agentSessionId != null && (typeof input.agentSessionId !== "string" || !input.agentSessionId.trim())) { return "Invalid saved Grok session."; }
		if (input.turnId != null && (typeof input.turnId !== "string" || !input.turnId.trim() || input.turnId.length > 200)) { return "Invalid turn."; }
    if (input.mode != null && !MODES.has(input.mode)) return "Pick a permission mode from the list.";
		if (input.allowedFolders !== undefined && allowedFoldersProblem(input.allowedFolders)) { return allowedFoldersProblem(input.allowedFolders); }
		return attachmentsProblem(input.attachments);
  }

	ensureChild(input) {
    if (this.child && this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
		this.starting = this.start(input).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

	start(input) {
    const child = spawn(GROK, [
      "agent",
      "--no-leader",
      "--model",
      input.model,
      "--reasoning-effort",
      input.effort,
      "stdio",
    ], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;
    this.buf = "";
    this.decoder = new StringDecoder("utf8");
		child.stdout.on("data", (chunk) => { if (this.child === child) { this.onData(chunk); } });
		let stderr = "";
		const stderrDecoder = new StringDecoder("utf8");
		child.stderr.on("data", (chunk) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-4096); });
		child.on("error", () => this.loseChild(child, this.processFailure("Grok could not start.", stderr)));
		child.on("exit", () => this.loseChild(child, this.processFailure("Grok exited.", stderr)));
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "grok-code", version: "0.1.0" },
      _meta: { "x.ai/hooks": HOOKS },
    }).promise
			.then(() => {
				this.checkStart();
				return this.request("authenticate", { methodId: "cached_token" }).promise;
			})
      .then(() => {
        if (this.child !== child) throw new Error("Grok exited.");
				this.checkStart();
        this.ready = true;
      })
      .catch((error) => {
        this.loseChild(child, error.message || "Grok could not start.");
				killTree(child);
        throw error;
      });
  }

  loseChild(child, message) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
		for (const session of this.sessions.values()) {
			session.child = null;
			session.model = "";
			session.effort = "";
			session.grokMode = "";
		}
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
		for (const gate of [...this.gates.values()]) { this.answerGate(gate, "deny", "Grok exited.", false); }
		const turns = [...this.turns.values()];
		this.turns.clear();
		this.parents.clear();
		for (const turn of turns) {
			if (turn.finished || turn.promptId == null) { continue; }
			turn.finished = true;
			if (turn.cancelled) { this.emitTurn(turn, { type: "done", stopReason: "cancelled" }); } else { this.emitTurn(turn, { type: "error", message }); }
		}
  }

  async ensureSession(input) {
    const existing = this.sessions.get(input.uiSessionId);
		const sameFolder = existing && pathKey(existing.cwd) === pathKey(input.cwd);
		if (sameFolder && existing.child === this.child) { return existing; }
		const savedId = sameFolder ? existing.sessionId : input.agentSessionId;
		const child = this.child;
		let created;
		try {
			created = await this.request(savedId ? "session/load" : "session/new", {
				...(savedId ? { sessionId: savedId } : {}),
				cwd: input.cwd,
				mcpServers: [],
				_meta: { "x.ai/hooks": HOOKS },
			}).promise;
		} catch (error) {
			if (error.fromGrok && savedId) {
				this.sessions.delete(input.uiSessionId);
				throw Object.assign(new Error(`Grok could not reload the earlier conversation (${error.message}). Send again to start a new one.`), { lostSession: true });
			}
			throw error;
		}
		if (this.child !== child) { throw new Error("Grok exited."); }
		const sessionId = savedId || (created && created.sessionId);
		if (!sessionId) { throw new Error("Grok did not open a session."); }
    const session = {
			sessionId: String(sessionId),
      cwd: input.cwd,
			child,
      model: "",
      effort: "",
			configOptions: [],
			grokMode: "",
    };
		this.recordConfig(session, created);
    this.sessions.set(input.uiSessionId, session);
    return session;
  }

	recordConfig(session, result) {
		const options = result && result.configOptions;
		if (!Array.isArray(options)) { return; }
		session.configOptions = options;
		for (const option of options) {
			if (option.id === "model" && typeof option.currentValue === "string") { session.model = option.currentValue; }
			if (option.id === "reasoning_effort" && typeof option.currentValue === "string") { session.effort = option.currentValue; }
		}
	}

	async applyMode(session, turn) {
		const mode = turn.mode === "Plan" ? "plan" : "default";
		if (session.grokMode === mode) { return; }
		try {
			await this.request("session/set_mode", { sessionId: session.sessionId, modeId: mode }).promise;
			session.grokMode = mode;
		} catch (error) {
			if (!error.fromGrok) { throw error; }
		}
	}

	onModeUpdate(sessionId, modeId) {
		const session = [...this.sessions.values()].find((item) => item.sessionId === sessionId);
		if (session) { session.grokMode = modeId; }
		const turn = [...this.turns.values()].find((item) => !item.finished && item.agentSessionId === sessionId);
		if (!turn) { return; }
		const mode = modeId === "plan" ? "Plan" : (turn.mode === "Plan" ? "Manual" : "");
		if (!mode || mode === turn.mode) { return; }
		turn.mode = mode;
		this.emitTurn(turn, { type: "mode", mode });
	}

	async applyConfig(session, input, turn) {
    if (session.model === input.model && session.effort === input.effort) return;
    if (session.model !== input.model) {
			await this.tryConfig(session, "model", input.model);
			if (turn) { this.checkTurn(turn); }
    }
    if (session.effort !== input.effort) {
			await this.tryConfig(session, "reasoning_effort", input.effort);
			if (turn) { this.checkTurn(turn); }
    }
  }

	async tryConfig(session, configId, value) {
		const option = (session.configOptions || []).find((item) => item.id === configId);
		if (option && Array.isArray(option.options) && !option.options.some((item) => item.value === value)) {
			throw new Error(`Grok does not support ${configId}: ${value}.`);
		}
		const sent = this.request("session/set_config_option", { sessionId: session.sessionId, configId, value });
    let timer;
		const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(sent.id);
				session.model = "";
				session.effort = "";
				session.configOptions = [];
				reject(new Error(`Grok did not confirm ${configId}: ${value}.`));
      }, 15000);
    });
    try {
			const result = await Promise.race([sent.promise, timeout]);
			this.recordConfig(session, result);
			const applied = result && Array.isArray(result.configOptions) && result.configOptions.find((item) => item.id === configId);
			if (!applied) {
				session.model = "";
				session.effort = "";
				session.configOptions = [];
			}
			if (!applied || applied.currentValue !== value) { throw new Error(`Grok did not apply ${configId}: ${value}.`); }
			return result;
    } finally {
      clearTimeout(timer);
    }
  }

  request(method, params) {
    if (!this.child || !this.child.stdin.writable) return { id: 0, promise: Promise.reject(new Error("Grok is not running.")) };
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, promise };
  }

  onData(chunk) {
    this.buf += this.decoder.write(chunk);
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.method === "session/update") {
      this.onUpdate(msg.params || {});
      return;
    }
    if (msg.method && String(msg.method).endsWith("hooks/run")) {
      this.onHook(msg);
      return;
    }
    if (msg.method === "session/request_permission") {
      this.onPermission(msg);
      return;
    }
		if (msg.id != null && (msg.method === "_x.ai/ask_user_question" || msg.method === "_x.ai/exit_plan_mode")) {
			this.onInteraction(msg);
			return;
		}
		if (msg.method === "_x.ai/models/update") {
			this.onModels(msg.params || {});
			if (msg.id != null) { this.reply(msg.id, null); }
			return;
		}
		if (msg.method === "_x.ai/mcp/servers_updated" || msg.method === "_x.ai/mcp/server_status") {
			const params = msg.params || {};
			if (Array.isArray(params.mcpServers)) {
				this.emit({ type: "mcp", servers: params.mcpServers.slice(0, 100).map((item) => ({ name: String((item && item.name) || ""), source: String((item && item.source) || ""), status: "" })).filter((item) => item.name) });
			} else if (typeof params.name === "string") {
				this.emit({ type: "mcp-status", name: params.name, status: String(params.status || "") });
			}
			if (msg.id != null) { this.reply(msg.id, null); }
			return;
		}
		if (msg.method === "_x.ai/session_notification") {
			const update = (msg.params && msg.params.update) || {};
			if (update.sessionUpdate === "subagent_spawned" && update.child_session_id && update.parent_session_id) {
				this.parents.set(String(update.child_session_id), String(update.parent_session_id));
			}
			const sessionId = String((msg.params && msg.params.sessionId) || "");
			const turn = this.turnFor(sessionId);
			const live = turn && turn.promptId != null ? turn : null;
			const note = commandNote(update);
			if (live && note && live.slash) {
				live.said = true;
				this.emitTurn(live, { type: "chunk", text: note });
			}
			const tokens = contextOf(update);
			if (live && tokens != null && !this.parents.has(sessionId)) {
				live.contextTokens = tokens;
				const session = this.sessions.get(live.uiSessionId);
				this.emitTurn(live, { type: "context", contextTokens: tokens, contextWindow: this.windowOf(session ? session.model : "") });
			}
			if (msg.id != null) { this.reply(msg.id, null); }
			return;
		}
    if (msg.id != null && msg.method) {
      this.reply(msg.id, null, { code: -32601, message: "not handled" });
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
			if (msg.error) { waiter.reject(Object.assign(new Error(this.clip(msg.error.message)), { fromGrok: true })); } else { waiter.resolve(msg.result); }
    }
  }

	onUpdate(params) {
		const update = params.update || {};
		if (update.sessionUpdate === "available_commands_update") {
			const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
			this.commands = list.slice(0, 200).map((item) => ({
				name: String((item && item.name) || ""),
				description: clipText(String((item && item.description) || ""), 200),
				hint: item && item.input && typeof item.input.hint === "string" ? clipText(item.input.hint, 120) : "",
			})).filter((item) => /^[\w:.-]+$/.test(item.name));
			this.emit({ type: "commands", commands: this.commands });
			return;
		}
		if (update.sessionUpdate === "current_mode_update") {
			this.onModeUpdate(String(params.sessionId || ""), String(update.currentModeId || ""));
			return;
		}
		const turn = this.turnFor(params.sessionId);
		if (!turn || turn.promptId == null) { return; }
		if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
			const text = chunkText(update);
			if (text && !this.parents.has(String(params.sessionId || ""))) {
				if (update.sessionUpdate === "agent_message_chunk") { turn.said = true; }
				this.emitTurn(turn, { type: update.sessionUpdate === "agent_message_chunk" ? "chunk" : "thought", text });
			}
			return;
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const tool = this.toolCard(update);
			if (tool) { this.emitTurn(turn, { type: "tool", tool }); }
		}
	}

	onHook(msg) {
		const params = msg.params || {};
		const toolId = String(params.toolUseId || params.hookCallbackId || "tool");
		const toolName = String(params.toolName || "tool");
		const kind = classify(toolName);
		const found = this.turnFor(params.sessionId);
		const turn = found && !found.cancelled ? found : null;
		const mode = turn ? turn.mode : "Manual";
		let action = "deny";
		if (turn) {
			action = actionFor(mode, kind);
			if (action === "allow" && mode === "Accept edits" && kind === "edit" && !editIsAllowed(turn, params.toolInput)) { action = "ask"; }
			if (kind === "edit" && isPlanFile(turn, params.toolInput)) { action = "allow"; }
			if (mode === "Plan" && toolName === "enter_plan_mode") { action = "allow"; }
		}
		if (action !== "ask") {
			const reason = action === "deny" && mode === "Plan" ? "Plan mode does not change files or run commands." : "";
			this.reply(msg.id, { decision: action, reason });
			this.outcomes.set(toolId, action);
			if (action === "deny" && turn) {
				this.outcomes.set(`${toolId}:detail`, "Not run · plan mode");
				this.emitTurn(turn, { type: "tool", tool: { id: toolId, kind, title: toolName, detail: "Not run · plan mode", summary: summaryOf(toolName, params.toolInput), waiting: false } });
			}
			return;
		}
		const command = params.toolInput && typeof params.toolInput.command === "string" ? params.toolInput.command : "";
		const key = alwaysKey(kind, toolName, command, params.toolInput);
		if (key && (this.always.get(turn.uiSessionId) || new Set()).has(key) && (kind !== "edit" || editIsAllowed(turn, params.toolInput))) {
			this.reply(msg.id, { decision: "allow", reason: "" });
			this.outcomes.set(toolId, "allow");
			this.outcomes.set(`${toolId}:detail`, "Allowed");
			return;
		}
		const previous = this.gates.get(toolId);
		if (previous) { this.answerGate(previous, "deny", "Replaced by a newer approval."); }
		this.openGate({
			rawName: toolName,
			toolInput: params.toolInput,
			rpcId: msg.id,
			toolId,
			uiSessionId: turn.uiSessionId,
			turnId: turn.turnId,
			toolName,
			kind,
			summary: summaryOf(toolName, params.toolInput),
			...(command ? { command } : {}),
			...inputOf(params.toolInput),
			detail: "Waiting for you",
			timer: null,
		});
	}

	onInteraction(msg) {
		const params = msg.params || {};
		const question = msg.method === "_x.ai/ask_user_question";
		const found = this.turnFor(params.sessionId);
		const turn = found && !found.cancelled ? found : null;
		const questions = question && Array.isArray(params.questions) ? params.questions.filter((item) => item && typeof item.question === "string" && item.question.trim()).slice(0, 20).map((item) => ({
			question: item.question,
			options: (Array.isArray(item.options) ? item.options : []).slice(0, 20).map((option) => (typeof option === "string"
				? { label: option }
				: { label: String((option && option.label) || ""), ...(option && typeof option.description === "string" && option.description ? { description: clipText(option.description, 1000) } : {}) })).filter((option) => option.label),
			multiSelect: item.multiSelect === true,
			...(typeof item.header === "string" && item.header.trim() ? { header: clipText(item.header.trim(), 40) } : {}),
		})) : [];
		if (!turn || (question && !questions.length)) {
			this.reply(msg.id, question ? { outcome: "cancelled" } : { outcome: "feedback", feedback: "Grok Desktop could not show this plan. Ask the user what to change." });
			return;
		}
		const toolId = typeof params.toolCallId === "string" && params.toolCallId ? params.toolCallId : `${question ? "question" : "plan"}:${msg.id}`;
		const previous = this.gates.get(toolId);
		if (previous) { this.answerGate(previous, "deny", "Replaced by a newer approval."); }
		this.openGate({
			type: question ? "question" : "plan",
			rpcId: msg.id,
			toolId,
			uiSessionId: turn.uiSessionId,
			turnId: turn.turnId,
			toolName: question ? "Question" : "Plan",
			kind: question ? "question" : "plan",
			detail: question ? "Waiting for your answer" : "Waiting for your approval",
			...(question ? { questions } : { plan: clipText(typeof params.planContent === "string" ? params.planContent : "", 60000) }),
			timer: null,
		});
	}

	openGate(gate) {
		if (!gate.type) { gate.timer = setTimeout(() => this.answerGate(gate, "deny", "No answer before the approval window closed."), AUTO_DENY_MS); }
		this.gates.set(gate.toolId, gate);
		this.outcomes.set(gate.toolId, "ask");
		this.emit({
			type: "tool",
			uiSessionId: gate.uiSessionId,
			turnId: gate.turnId,
			tool: {
				id: gate.toolId,
				kind: gate.kind,
				title: gate.toolName,
				detail: gate.detail,
				summary: gate.summary,
				...(gate.command ? { command: gate.command } : {}),
				...(gate.input ? { input: gate.input } : {}),
				waiting: true,
				...(gate.questions ? { questions: gate.questions } : {}),
				...(gate.plan !== undefined ? { plan: gate.plan } : {}),
			},
		});
	}

	onPermission(msg) {
		const params = msg.params || {};
		const tool = params.toolCall || {};
		const toolName = String(tool.title || tool.kind || "tool");
		const found = this.turnFor(params.sessionId);
		const turn = found && !found.cancelled ? found : null;
		const mode = turn ? turn.mode : "Manual";
		const kind = PERMISSION_KINDS.get(String(tool.kind || "")) || classify(toolName);
		const userAllowed = tool.toolCallId != null && this.outcomes.get(`${tool.toolCallId}:detail`) === "Allowed";
		let action = !turn ? "deny" : (userAllowed ? "allow" : actionFor(mode, kind));
		// The same folder rule as the hook: Accept edits asks before an edit outside the session's folders.
		if (action === "allow" && !userAllowed && mode === "Accept edits" && kind === "edit" && !editIsAllowed(turn, tool.rawInput)) { action = "ask"; }
		if (action !== "ask") {
			this.reply(msg.id, this.permissionResult(params, action));
			return;
		}
		const command = tool.rawInput && typeof tool.rawInput.command === "string" ? tool.rawInput.command : "";
		this.openGate({
			rpcId: msg.id,
			toolId: `native-permission:${msg.id}`,
			uiSessionId: turn.uiSessionId,
			turnId: turn.turnId,
			toolName: `Permission: ${toolName}`,
			kind,
			summary: summaryOf(toolName, tool.rawInput),
			...(command ? { command } : {}),
			...inputOf(tool.rawInput),
			detail: "Waiting for you",
			permission: params,
			timer: null,
		});
	}

	answerGate(gate, decision, reason, respond = true) {
		const current = this.gates.get(gate.toolId);
		if (!current || current.rpcId !== gate.rpcId) { return; }
		if (gate.type) {
			const detail = reason === "Grok exited." ? "Closed · Grok exited" : (reason === "Stopped." ? "Closed · Stopped" : "Closed");
			const reply = gate.type === "question" ? { outcome: "cancelled" } : { outcome: "feedback", feedback: "The user closed the plan without answering. Ask what to change." };
			this.settleGate(gate, respond ? reply : null, detail);
			return;
		}
		clearTimeout(gate.timer);
		this.gates.delete(gate.toolId);
		this.outcomes.set(gate.toolId, decision);
		const detail = reason === "Grok exited." ? "Closed · Grok exited" : decision === "allow"
			? "Allowed"
			: (reason === "No answer before the approval window closed." ? "Denied · timed out" : "Denied");
		this.outcomes.set(`${gate.toolId}:detail`, detail);
		if (respond) { this.reply(gate.rpcId, gate.permission ? this.permissionResult(gate.permission, decision) : { decision, reason: reason || "" }); }
		this.emit({
			type: "tool",
			uiSessionId: gate.uiSessionId,
			turnId: gate.turnId,
			tool: {
				id: gate.toolId,
				kind: gate.kind,
				title: gate.toolName,
				detail,
				summary: gate.summary,
				waiting: false,
			},
		});
	}

	settleGate(gate, reply, detail) {
		clearTimeout(gate.timer);
		this.gates.delete(gate.toolId);
		this.outcomes.set(gate.toolId, "answered");
		this.outcomes.set(`${gate.toolId}:detail`, detail);
		if (reply) { this.reply(gate.rpcId, reply); }
		this.emit({
			type: "tool",
			uiSessionId: gate.uiSessionId,
			turnId: gate.turnId,
			tool: { id: gate.toolId, kind: gate.kind, title: gate.toolName, detail, waiting: false },
		});
	}

  denyOpen(uiSessionId, reason) {
    for (const gate of [...this.gates.values()]) {
      if (!uiSessionId || gate.uiSessionId === uiSessionId) this.answerGate(gate, "deny", reason);
    }
  }

  permissionResult(params, decision) {
    const options = Array.isArray(params.options) ? params.options : [];
    const kind = decision === "allow" ? "allow_once" : "reject_once";
    const option = options.find((item) => item && item.kind === kind);
    if (!option || !option.optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  reply(id, result, error) {
    if (!this.child || !this.child.stdin.writable || id == null) return;
    const message = { jsonrpc: "2.0", id };
    if (error) message.error = error;
    else message.result = result;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

	finishPrompt(turn, id, result, error) {
		if (this.turns.get(turn.uiSessionId) !== turn || turn.finished || turn.promptId !== id) { return; }
		turn.finished = true;
		this.turns.delete(turn.uiSessionId);
		this.denyOpen(turn.uiSessionId, "The turn ended.");
		if (turn.cancelled) {
			this.emitTurn(turn, { type: "done", stopReason: "cancelled" });
			return;
		}
		if (error) {
			this.emitTurn(turn, { type: "error", message: this.clip(error) });
			return;
		}
		if (turn.slash && !turn.said) { this.emitTurn(turn, { type: "chunk", text: "Grok ran the command. It sent no output." }); }
		const usage = this.usageOf(result, turn);
		if (usage) { this.emitTurn(turn, { type: "usage", usage }); }
		const stopReason = result && result.stopReason ? String(result.stopReason) : "end_turn";
		this.emitTurn(turn, { type: "done", stopReason });
	}

	toolCard(update) {
		const id = String(update.toolCallId || "");
		if (!id) { return null; }
		const gate = this.gates.get(id);
		const outcome = this.outcomes.get(id);
		const card = { id, waiting: !!gate };
		if (update.kind) {
			card.kind = String(update.kind);
			this.cardKinds.set(id, card.kind);
		}
		if (update.title) { card.title = String(update.title); }
		const meta = update._meta && update._meta["x.ai/tool"];
		if (meta && typeof meta.label === "string" && meta.label.trim()) { card.label = clipText(meta.label.trim(), 80); }
		const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : null;
		if (input && typeof input.description === "string" && input.description.trim()) { card.description = clipText(input.description.trim(), 300); }
		const todos = todosOf(input);
		if (todos) { card.todos = todos; }
		if (input && typeof input.command === "string" && input.command.trim()) { card.command = gate ? input.command : clipText(input.command, 4000); }
		const location = Array.isArray(update.locations) && update.locations[0] && update.locations[0].path;
		const target = location || (input && (input.file_path || input.target_file || input.target_directory || input.path));
		if (typeof target === "string" && target.trim()) { card.path = clipText(target, 1000); }
		const parts = Array.isArray(update.content) ? update.content : [];
		const diffs = parts.filter((part) => part && part.type === "diff");
		if (diffs.length) {
			card.additions = diffs.reduce((sum, part) => sum + lineCount(part.newText), 0);
			card.deletions = diffs.reduce((sum, part) => sum + lineCount(part.oldText), 0);
		}
		const kind = this.cardKinds.get(id) || "";
		if ((update.status === "completed" || update.status === "failed") && kind !== "read" && kind !== "edit") {
			const text = parts.map((part) => (part && part.type === "content" && part.content && typeof part.content.text === "string" ? part.content.text : "")).filter(Boolean).join("\n");
			if (text.trim()) { card.output = clipText(text, 1500); }
		}
		if (gate) { card.detail = gate.detail; }
		else if (outcome === "deny" || outcome === "answered") { card.detail = this.outcomes.get(`${id}:detail`) || "Denied"; }
		else if (update.status === "completed") { card.detail = "Ran"; }
		else if (update.status === "failed") { card.detail = outcome === "allow" ? "Failed" : "Not run · failed"; }
		else { card.detail = "Running"; }
		return card;
	}

	onModels(params) {
		const list = Array.isArray(params.availableModels) ? params.availableModels : [];
		this.models = list.slice(0, 40).map((item) => {
			const meta = (item && item._meta) || {};
			const efforts = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.map((effort) => String((effort && effort.value) || "")).filter((value) => EFFORTS.has(value)) : [];
			return { id: String((item && item.modelId) || ""), name: String((item && item.name) || (item && item.modelId) || ""), description: clipText(String((item && item.description) || ""), 160), efforts, contextWindow: Number(meta.totalContextTokens) || 0 };
		}).filter((item) => /^[\w.:-]+$/.test(item.id));
		for (const item of this.models) {
			if (item.contextWindow) { this.contextWindows.set(item.id, item.contextWindow); }
		}
		this.emit({ type: "models", models: this.models });
	}

	windowOf(model) {
		return this.contextWindows.get(model) || this.contextWindows.get(String(model || "").replace(/-build$/, "")) || 256000;
	}

	usageOf(result, turn) {
		const meta = result && result._meta;
		const usage = meta && meta.usage;
		if (!usage || typeof usage !== "object") { return null; }
		const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
		const calls = Math.max(1, number(usage.modelCalls));
		const model = String(meta.modelId || "");
		return {
			model,
			inputTokens: number(usage.inputTokens),
			outputTokens: number(usage.outputTokens),
			cachedReadTokens: number(usage.cachedReadTokens),
			reasoningTokens: number(usage.reasoningTokens),
			modelCalls: calls,
			// The last model call's size is exact; the per-call average is the fallback when Grok sent none.
			contextTokens: turn && turn.contextTokens != null ? turn.contextTokens : Math.round(number(usage.inputTokens) / calls) + number(usage.outputTokens),
			contextWindow: this.windowOf(model),
			costUsd: number(usage.costUsdTicks) / 1e10,
		};
	}

	processFailure(message, stderr) {
		const diagnostic = stderr.replace(/\x1b\[[0-9;]*m/g, "")
			.replace(/(authorization["']?\s*:\s*(?:(?:bearer|basic)\s+)?|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
			.replace(/\b(?:xai-|sk-)[A-Za-z0-9_-]+\b/g, "[redacted]")
			.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
		return diagnostic ? `${message} ${diagnostic.slice(-300)}` : message;
	}

  clip(message) {
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return "Grok rejected the request.";
    return text.length > 300 ? text.slice(0, 300) : text;
  }
}

module.exports = { AgentHost, folderProblem, resolvedEditPath, killTree };
