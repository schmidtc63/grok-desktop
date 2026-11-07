const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { randomUUID } = require("crypto");
const { StringDecoder } = require("string_decoder");
const { folderProblem, killTree, OWN_GROUP } = require("./agent.cjs");

const MAX_TABS = 12;
const MAX_WRITE = 20000;
const MAX_HISTORY = 200000;
let pty;
try { pty = require("node-pty"); } catch { /* A missing native module keeps the pipe terminal available. */ }
const PIPE_WARNING = "Interactive terminal unavailable. Using the basic pipe terminal.";
// `-Command -` keeps state, but it reads stdin with the console code page
// (OEM 437) fixed at startup, so non-ASCII input is mangled. Interactive mode
// after this command reads stdin, writes output and pipes to native commands
// as UTF-8. Interactive mode also prints the prompt and echoes each input line.
const INIT = "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)";
// macOS and Linux run bash -i with line editing off: over pipes, readline echoes each input line on Linux but not in
// macOS's bash 3.2, so write() echoes the line itself, as a terminal does. bash writes its prompt to stderr, and
// `exec ... 2>&1` sends it down stdout with the command output, in the order bash wrote them.
// PS1 shows the folder (set here: the outer, non-interactive bash drops an inherited PS1), PS2 is empty because the echo
// already shows a command's later lines, and the setting silences macOS bash 3.2's "now zsh" notice. +H turns off ! history
// expansion, which this pane has no use for and which makes bash 3.2 refuse a command such as echo "$!" or echo "done!".
// PROMPT_COMMAND turns job control off once, before the first prompt: even with no terminal, bash 3.2 keeps it on and gives
// each job its own process group, which interrupt() and endTree() would miss. +m on the command line does not hold in 3.2.
const BASH_ARGS = ["-c", "export PS1='\\w \\$ ' PS2='' PROMPT_COMMAND='set +m; unset PROMPT_COMMAND'; exec bash --noprofile --norc --noediting +H -i 2>&1"];
const BASH_SETTINGS = { BASH_SILENCE_DEPRECATION_WARNING: "1" };
// With no terminal, bash -i warns that it has no job control, and again (tcsetattr) after a job ends by a signal; both are expected here.
// The tcsetattr reason differs by system: "Inappropriate ioctl for device" on Linux, "Operation not supported on socket" on macOS.
// ponytail: filters each chunk, and bash writes the tcsetattr notice in three pieces, so now and then a split notice shows; hold back a last line that starts "bash: " if that matters.
const NO_TERMINAL = /^bash: (?:cannot set terminal process group.*|no job control in this shell|\[\d+: \d+(?: \(\d+\))?\] tcsetattr: .*)\r?\n/gm;

let shellPath = null;
function terminalShell() {
	if (process.platform !== "win32") { return "bash"; }
	if (shellPath) { return shellPath; }
	const found = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
	const first = found.status === 0 ? String(found.stdout || "").split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line) && path.isAbsolute(line)) : "";
	shellPath = first || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return shellPath;
}

function endTree(child) {
	if (!child || child.pid === undefined) { return; }
	if (process.platform !== "win32") { killTree(child); return; }
	spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
}

class TerminalHost {
	constructor(emit, { flushMs = 30 } = {}) {
		this.emit = emit;
		this.flushMs = flushMs;
		this.tabs = new Map();
	}

	open(options) {
		const cwd = options ? options.cwd : undefined;
		const problem = folderProblem(cwd);
		if (problem) { return { ok: false, error: problem }; }
		if (this.tabs.size >= MAX_TABS) { return { ok: false, error: "Close a terminal tab first." }; }
		const shell = terminalShell();
		const windows = process.platform === "win32";
		let child;
		try {
			child = pty ? pty.spawn(shell, windows ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-NoExit", "-Command", INIT] : ["--noprofile", "--norc", "-i"], {
				name: "xterm-256color", cols: 80, rows: 24, cwd, env: { ...process.env, ...BASH_SETTINGS, TERM: "xterm-256color" },
			}) : windows
				? spawn(shell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-NoExit", "-Command", INIT], { cwd, windowsHide: true, stdio: "pipe" })
				: spawn(shell, BASH_ARGS, { ...OWN_GROUP, cwd, env: { ...process.env, ...BASH_SETTINGS }, stdio: "pipe" });
		} catch {
			return { ok: false, error: `${windows ? "PowerShell" : "bash"} could not start.` };
		}
		const tab = { id: randomUUID(), cwd, child, backend: pty ? "pty" : "pipe", history: "", done: false, input: "" };
		this.tabs.set(tab.id, tab);
		if (pty) {
			tab.listeners = [child.onData((data) => this.output(tab, data)), child.onExit(({ exitCode }) => this.finish(tab, exitCode))];
			child.on?.("error", () => this.finish(tab, null));
			return { ok: true, id: tab.id, backend: "pty" };
		}
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		child.stdout.on("data", (buf) => this.output(tab, windows ? out.write(buf) : out.write(buf).replace(NO_TERMINAL, "")));
		child.stderr.on("data", (buf) => this.output(tab, err.write(buf)));
		child.stdin.on("error", () => {});
		child.on("error", () => this.finish(tab, null));
		child.on("close", (code) => {
			this.output(tab, out.end() + err.end());
			this.finish(tab, code);
		});
		return { ok: true, id: tab.id, backend: "pipe", warning: PIPE_WARNING };
	}

	output(tab, data) {
		if (!data || tab.done) { return; }
		tab.history += data;
		if (tab.history.length > MAX_HISTORY * 2) { tab.history = tab.history.slice(-MAX_HISTORY); }
		if (!this.flushMs) { this.emit({ type: "terminal-data", id: tab.id, data }); return; }
		tab.pending = (tab.pending || "") + data;
		if (!tab.flushTimer) { tab.flushTimer = setTimeout(() => this.flushOutput(tab), this.flushMs); }
	}

	flushOutput(tab) {
		clearTimeout(tab.flushTimer);
		tab.flushTimer = null;
		if (tab.pending) { this.emit({ type: "terminal-data", id: tab.id, data: tab.pending }); }
		tab.pending = "";
	}

	finish(tab, code) {
		if (tab.done) { return; }
		this.flushOutput(tab);
		tab.done = true;
		this.tabs.delete(tab.id);
		if (tab.backend === "pty") {
			try { tab.child.kill(); } catch { /* An exited PTY still needs its native cleanup attempted. */ }
			for (const listener of tab.listeners ?? []) { listener.dispose(); }
		}
		this.emit({ type: "terminal-exit", id: tab.id, code });
	}

	write(id, text) {
		const tab = this.tabs.get(id);
		if (!tab) { return { ok: false, error: "That terminal is closed." }; }
		if (typeof text !== "string" || text.includes("\0")) { return { ok: false, error: "That text cannot be sent to the terminal." }; }
		if (text.length > MAX_WRITE) { return { ok: false, error: "That command is too long." }; }
		if (tab.backend === "pty") {
			try { tab.child.write(`${text.replace(/\r\n|\n/g, "\r").replace(/\r+$/, "")}\r`); return { ok: true }; } catch { return { ok: false, error: "That terminal is closed." }; }
		}
		if (process.platform !== "win32") {
			// bash runs a multiline command once its last line is complete, so it needs no blank line after it.
			const line = `${text.replace(/\n+$/, "")}\n`;
			this.output(tab, line);
			tab.child.stdin.write(line);
			return { ok: true };
		}
		tab.child.stdin.write(text.includes("\n") ? `${text.replace(/\n+$/, "")}\n\n` : `${text}\n`);
		return { ok: true };
	}

	input(id, data) {
		const tab = this.tabs.get(id);
		if (!tab) { return { ok: false, error: "That terminal is closed." }; }
		if (typeof data !== "string" || data.length > MAX_WRITE) { return { ok: false, error: "That terminal input is too long or invalid." }; }
		if (tab.backend === "pty") {
			try { tab.child.write(data); return { ok: true }; } catch { return { ok: false, error: "That terminal is closed." }; }
		}
		for (const character of data.replace(/\r\n/g, "\r")) {
			if (character === "\r" || character === "\n") {
				const result = this.write(id, tab.input);
				tab.input = "";
				if (!result.ok) { return result; }
			} else if (character === "\b" || character === "\x7f") {
				tab.input = Array.from(tab.input).slice(0, -1).join("");
			} else if (character >= " " || character === "\t") {
				if (tab.input.length + character.length > MAX_WRITE) { return { ok: false, error: "That command is too long." }; }
				tab.input += character;
			}
		}
		return { ok: true };
	}

	resize(id, cols, rows) {
		const tab = this.tabs.get(id);
		if (!tab) { return { ok: false, error: "That terminal is closed." }; }
		if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) { return { ok: false, error: "That terminal size is invalid." }; }
		try { if (tab.backend === "pty") { tab.child.resize(cols, rows); } return { ok: true }; } catch { return { ok: false, error: "That terminal could not be resized." }; }
	}

	interrupt(id) {
		const tab = this.tabs.get(id);
		if (tab?.backend === "pty") { const result = this.input(id, "\x03"); return Promise.resolve(result.ok ? { ok: true, stopped: 1 } : result); }
		if (!tab || tab.child.pid === undefined || tab.child.exitCode !== null) { return Promise.resolve({ ok: false, error: "That terminal is closed." }); }
		const pid = tab.child.pid;
		const failed = { ok: false, error: "The running command could not be stopped." };
		if (process.platform !== "win32") {
			// Without job control, everything bash runs stays in bash's own process group (OWN_GROUP made bash its leader),
			// so the group's other members are the running command and its children. A loop of builtins runs in bash itself.
			return new Promise((resolve) => {
				const query = spawn("pgrep", ["-g", String(pid)], { stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
				let found = "";
				query.stdout.on("data", (buf) => { found += buf; });
				query.on("error", () => resolve(failed));
				query.on("close", (code) => {
					if (code !== 0 && code !== 1) { resolve(failed); return; }
					const pids = (found.match(/\d+/g) || []).map(Number).filter((item) => item !== pid);
					for (const item of pids) {
						try { process.kill(item, "SIGKILL"); } catch {}
					}
					resolve({ ok: true, stopped: pids.length });
				});
			});
		}
		// Stop the shell's direct children with their trees. Skip conhost.exe (the shell's console host: killing it ends the shell)
		// and any process older than the shell (its real parent ended and Windows reused that PID). One CIM query, because a second
		// costs about half a second. A PowerShell loop such as Start-Sleep runs in the shell itself and has no child to stop.
		const script = `$found = Get-CimInstance Win32_Process -Filter "ProcessId=${pid} OR ParentProcessId=${pid}"; $shell = $found | Where-Object ProcessId -eq ${pid}; $found | Where-Object { $shell -and $_.ParentProcessId -eq ${pid} -and $_.CreationDate -ge $shell.CreationDate -and $_.Name -ne 'conhost.exe' } | ForEach-Object ProcessId`;
		return new Promise((resolve) => {
			const query = spawn(terminalShell(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
			let found = "";
			query.stdout.on("data", (buf) => { found += buf; });
			query.on("error", () => resolve(failed));
			query.on("close", (code) => {
				if (code !== 0) { resolve(failed); return; }
				const pids = found.match(/\d+/g) || [];
				if (!pids.length) { resolve({ ok: true, stopped: 0 }); return; }
				const kill = spawn("taskkill", [...pids.flatMap((child) => ["/PID", child]), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
				kill.on("error", () => resolve(failed));
				// ponytail: taskkill exits 128 both for "access denied" and for a process that already ended, so an elevated child still counts as stopped; probe each PID afterwards if that matters.
				kill.on("close", () => resolve({ ok: true, stopped: pids.length }));
			});
		});
	}

	close(id) {
		const tab = this.tabs.get(id);
		if (tab) {
			if (tab.backend !== "pty") { endTree(tab.child); }
			this.finish(tab, null);
		}
		return { ok: true };
	}

	closeAll() {
		const tabs = Array.from(this.tabs.values());
		const pipes = tabs.filter((tab) => tab.backend !== "pty");
		const pids = pipes.filter((tab) => tab.child.pid !== undefined).flatMap((tab) => ["/PID", String(tab.child.pid)]);
		// Synchronous: this runs at app quit, and an async taskkill would die with the app.
		if (process.platform !== "win32") {
			killTree(pipes.map((tab) => tab.child), true);
		} else if (pids.length) {
			spawnSync("taskkill", [...pids, "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
		}
		for (const tab of tabs) {
			this.finish(tab, null);
		}
	}

	list() {
		return Array.from(this.tabs.values(), (tab) => ({ id: tab.id, cwd: tab.cwd, running: !tab.done, backend: tab.backend }));
	}

	history(id) {
		const tab = this.tabs.get(id);
		return tab ? tab.history.slice(-MAX_HISTORY) : "";
	}
}

module.exports = { TerminalHost, terminalShell };
