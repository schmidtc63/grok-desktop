const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { randomUUID } = require("crypto");
const { StringDecoder } = require("string_decoder");
const { folderProblem } = require("./agent.cjs");

const MAX_TABS = 12;
const MAX_WRITE = 20000;
const MAX_HISTORY = 200000;
// `-Command -` keeps state, but it reads stdin with the console code page
// (OEM 437) fixed at startup, so non-ASCII input is mangled. Interactive mode
// after this command reads stdin, writes output and pipes to native commands
// as UTF-8. Interactive mode also prints the prompt and echoes each input line.
const INIT = "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)";

function killTree(child) {
	if (!child || child.pid === undefined) { return; }
	spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
}

class TerminalHost {
	constructor(emit) {
		this.emit = emit;
		this.tabs = new Map();
	}

	open(options) {
		const cwd = options ? options.cwd : undefined;
		const problem = folderProblem(cwd);
		if (problem) { return { ok: false, error: problem }; }
		if (this.tabs.size >= MAX_TABS) { return { ok: false, error: "Close a terminal tab first." }; }
		const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		let child;
		try {
			child = spawn(shell, ["-NoLogo", "-NoProfile", "-NoExit", "-Command", INIT], { cwd, windowsHide: true, stdio: "pipe" });
		} catch {
			return { ok: false, error: "PowerShell could not start." };
		}
		const tab = { id: randomUUID(), cwd, child, history: "", done: false };
		this.tabs.set(tab.id, tab);
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		child.stdout.on("data", (buf) => this.output(tab, out.write(buf)));
		child.stderr.on("data", (buf) => this.output(tab, err.write(buf)));
		child.stdin.on("error", () => {});
		child.on("error", () => this.finish(tab, null));
		child.on("close", (code) => {
			this.output(tab, out.end() + err.end());
			this.finish(tab, code);
		});
		return { ok: true, id: tab.id };
	}

	output(tab, data) {
		if (!data || tab.done) { return; }
		tab.history += data;
		if (tab.history.length > MAX_HISTORY * 2) { tab.history = tab.history.slice(-MAX_HISTORY); }
		this.emit({ type: "terminal-data", id: tab.id, data });
	}

	finish(tab, code) {
		if (tab.done) { return; }
		tab.done = true;
		this.tabs.delete(tab.id);
		this.emit({ type: "terminal-exit", id: tab.id, code });
	}

	write(id, text) {
		const tab = this.tabs.get(id);
		if (!tab) { return { ok: false, error: "That terminal is closed." }; }
		if (typeof text !== "string" || text.includes("\0")) { return { ok: false, error: "That text cannot be sent to the terminal." }; }
		if (text.length > MAX_WRITE) { return { ok: false, error: "That command is too long." }; }
		tab.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
		return { ok: true };
	}

	close(id) {
		const tab = this.tabs.get(id);
		if (tab) {
			killTree(tab.child);
			this.finish(tab, null);
		}
		return { ok: true };
	}

	closeAll() {
		const tabs = Array.from(this.tabs.values());
		const pids = tabs.filter((tab) => tab.child.pid !== undefined).flatMap((tab) => ["/PID", String(tab.child.pid)]);
		// Synchronous: this runs at app quit, and an async taskkill would die with the app.
		if (pids.length) {
			spawnSync("taskkill", [...pids, "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
		}
		for (const tab of tabs) {
			this.finish(tab, null);
		}
	}

	list() {
		return Array.from(this.tabs.values(), (tab) => ({ id: tab.id, cwd: tab.cwd, running: tab.child.exitCode === null }));
	}

	history(id) {
		const tab = this.tabs.get(id);
		return tab ? tab.history.slice(-MAX_HISTORY) : "";
	}
}

module.exports = { TerminalHost };
