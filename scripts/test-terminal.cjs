const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { randomUUID } = require("crypto");
const { TerminalHost } = require("../electron/terminal.cjs");

const events = [];
const host = new TerminalHost((event) => { events.push(event); }, { flushMs: 0 });

function checkTerminalShell() {
	const source = fs.readFileSync(path.join(__dirname, "../electron/terminal.cjs"), "utf8");
	const fallback = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const preferred = path.join(os.tmpdir(), "PowerShell", "pwsh.exe");
	for (const [found, expected] of [
		[{ status: 0, stdout: `pwsh.exe\r\n${preferred}\r\n` }, preferred],
		[{ status: 1, stdout: preferred }, fallback],
		[{ status: 0, stdout: "pwsh.exe\r\nnot-an-executable.txt\r\n" }, fallback],
	]) {
		let probes = 0;
		const sandbox = {
			module: { exports: {} },
			process,
			require: (name) => {
				if (name === "./agent.cjs") { return { folderProblem: () => "" }; }
				if (name === "child_process") {
					return { spawnSync: (command, args, options) => {
						probes++;
						assert.equal(command, "where.exe");
						assert.deepEqual(Array.from(args), ["pwsh.exe"]);
						assert.equal(options.windowsHide, true);
						assert.equal(options.timeout, 5000);
						return found;
					} };
				}
				return require(name);
			},
		};
		vm.runInNewContext(source, sandbox, { filename: "terminal.cjs" });
		assert.equal(sandbox.module.exports.terminalShell(), expected);
		assert.equal(sandbox.module.exports.terminalShell(), expected);
		assert.equal(probes, 1, "the shell lookup is cached, including its fallback");
	}
	console.log("PASS terminal prefers an absolute pwsh path, falls back on failed/invalid lookup, and caches the result");
}

function checkOutputBatching() {
	const timers = new Map();
	const batched = [];
	const sandbox = {
		module: { exports: {} },
		require: (name) => name === "./agent.cjs" ? { folderProblem: () => "" } : require(name),
		setTimeout: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/terminal.cjs"), "utf8"), sandbox, { filename: "terminal.cjs" });
	const batching = new sandbox.module.exports.TerminalHost((event) => batched.push(event), { flushMs: 30 });
	const makeTab = (id) => { const tab = { id, history: "", done: false }; batching.tabs.set(id, tab); return tab; };
	const last = makeTab("last");
	batching.output(last, "one");
	batching.output(last, "two");
	assert.deepEqual(batched, []);
	assert.equal(last.history, "onetwo", "history is immediately available while events wait");
	batching.finish(last, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(batched)), [{ type: "terminal-data", id: "last", data: "onetwo" }, { type: "terminal-exit", id: "last", code: 0 }]);
	assert.equal(timers.size, 0, "exit flushes and clears the pending timer");
	const ongoing = makeTab("ongoing");
	const flush = () => {
		assert.equal(timers.size, 1);
		const timer = [...timers.values()][0];
		assert.equal(timer.ms, 30);
		timer.callback();
	};
	batching.output(ongoing, "first");
	flush();
	assert.equal(ongoing.flushTimer, null);
	batching.output(ongoing, "second");
	flush();
	assert.deepEqual(batched.slice(-2).map((event) => event.data), ["first", "second"], "later output schedules a fresh timer");
	assert.equal(timers.size, 0);
	console.log("PASS terminal output batches, flushes before exit, and schedules later output");
}

function output(id) {
	return events.filter((event) => event.type === "terminal-data" && event.id === id).map((event) => event.data).join("");
}

function hasLine(id, line) {
	return output(id).split(/\r?\n/).includes(line);
}

// A line sent while a command still runs is echoed at once, so on bash its output follows the next prompt, as in a terminal.
function printed(id, text) {
	return output(id).split(/\r?\n/).some((line) => line === text || line.endsWith(` $ ${text}`));
}

function exits(id) {
	return events.filter((event) => event.type === "terminal-exit" && event.id === id);
}

function pause(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, ms = 20000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) { throw new Error(`Timed out waiting for ${label}`); }
		await pause(100);
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function pidOf(id, name) {
	const match = output(id).match(new RegExp(`${name}=(\\d+)\\r?\\n`));
	return match ? Number(match[1]) : 0;
}

// macOS and Linux: bash -i over pipes prints a prompt naming the folder, and the host echoes each line.
async function posixShell(id, tmp) {
	const real = fs.realpathSync(tmp);
	await waitFor(() => output(id).includes(" $ "), "bash prompt");
	assert.equal(/no job control|cannot set terminal process group/.test(output(id)), false, "the job-control warnings are dropped");
	console.log("PASS bash shows its prompt and no job-control warning");
	host.write(id, "for i in 1 2; do\n  echo \"n$i\"\ndone");
	await waitFor(() => output(id).includes("n1\n") && output(id).includes("n2\n"), "multiline for output");
	console.log("PASS multiline command completes without another write");
	assert.equal(host.write(id, "x=41").ok, true);
	assert.equal(host.write(id, "echo $((x + 1))\n").ok, true);
	await waitFor(() => output(id).includes("42\n"), "42");
	// Both lines were sent before bash printed its next prompt, so they echo together, as typed-ahead lines do in a terminal.
	assert.ok(output(id).includes(" $ x=41\necho $((x + 1))\n"), "input lines are echoed after the prompt");
	assert.equal(output(id).split("echo $((x + 1))").length, 2, "an input line is echoed once");
	assert.ok(output(id).indexOf("echo $((x + 1))") < output(id).indexOf("42\n"), "the echo comes before the output");
	assert.ok(output(id).includes(" $ for i in 1 2; do\n  echo \"n$i\"\ndone\nn1\nn2\n"), "a multiline command is echoed whole, with no continuation prompts");
	assert.equal(output(id).split("\n").some((line) => line.split(" $ ").length > 2), false, "no empty prompt from a blank line");
	console.log("PASS variables persist between writes (x=41, echo $((x + 1)) printed 42) and input is echoed");
	host.write(id, "cd ..");
	host.write(id, "pwd");
	await waitFor(() => output(id).includes(`${path.dirname(real)}\n`), "parent of tmpdir");
	await waitFor(() => output(id).includes(`${path.dirname(real)} $ `), "prompt naming the new folder");
	console.log("PASS location persists between writes (cd .. then pwd) and the prompt shows it");
	host.write(id, "echo \"héllo\"");
	await waitFor(() => output(id).includes("héllo\n"), "UTF-8 output");
	console.log("PASS UTF-8 round trip (héllo intact)");
	host.write(id, "echo \"shell=$$\"");
}

async function windowsShell(id, tmp) {
	host.write(id, "Import-Module \"$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1\"; Get-ExecutionPolicy");
	await waitFor(() => hasLine(id, "RemoteSigned"), "RemoteSigned execution policy");
	console.log("PASS terminal execution policy is RemoteSigned");
	host.write(id, "foreach ($i in 1..2) {\n  \"n$i\"\n}");
	await waitFor(() => hasLine(id, "n1") && hasLine(id, "n2"), "multiline foreach output");
	console.log("PASS multiline command completes without another write");
	assert.equal(host.write(id, "$x = 41").ok, true);
	assert.equal(host.write(id, "$x + 1\n").ok, true);
	await waitFor(() => hasLine(id, "42"), "42");
	console.log("PASS variables persist between writes ($x = 41, $x + 1 printed 42)");

	host.write(id, "Set-Location ..");
	host.write(id, "(Get-Location).Path");
	await waitFor(() => hasLine(id, path.dirname(tmp)), "parent of tmpdir");
	console.log("PASS location persists between writes (Set-Location .. then Get-Location)");

	host.write(id, "Write-Output \"héllo\"");
	host.write(id, "\"héllo\".Length");
	await waitFor(() => hasLine(id, "héllo") && hasLine(id, "5"), "UTF-8 output");
	console.log("PASS UTF-8 round trip (héllo intact, length 5 so stdin was decoded as UTF-8)");
	host.write(id, "\"shell=$PID\"");
}

async function main() {
	const windows = process.platform === "win32";
	if (windows) { checkTerminalShell(); }
	checkOutputBatching();
	const tmp = os.tmpdir();
	const opened = host.open({ cwd: tmp });
	assert.equal(opened.ok, true, opened.error);
	const id = opened.id;
	assert.deepEqual(host.list(), [{ id, cwd: tmp, running: true }]);
	await (windows ? windowsShell(id, tmp) : posixShell(id, tmp));
	await waitFor(() => pidOf(id, "shell") > 0, "shell pid");
	const firstShell = pidOf(id, "shell");
	assert.equal(host.history(id), output(id));
	assert.match(host.history(id), /42\r?\n/);
	assert.equal(host.history("no-such-tab"), "");
	console.log("PASS history(id) returns earlier output");

	assert.equal(host.open({ cwd: path.join(tmp, `no-such-folder-${randomUUID()}`) }).ok, false);
	assert.equal(host.open({ cwd: "" }).ok, false);
	assert.equal(host.open({}).ok, false);
	assert.equal(host.open(null).ok, false);
	assert.equal(host.open({ cwd: __filename }).ok, false);
	console.log("PASS invalid cwd rejected (missing, empty, absent, null, file)");

	assert.equal(host.write(id, "x".repeat(20001)).ok, false);
	assert.equal(host.write(id, "a\0b").ok, false);
	assert.equal(host.write(id, 42).ok, false);
	assert.equal(host.write("no-such-tab", "dir").ok, false);
	console.log("PASS over-long, NUL, non-string and unknown-tab writes rejected");

	const sleeper = host.open({ cwd: tmp });
	assert.equal(sleeper.ok, true, sleeper.error);
	host.write(sleeper.id, windows
		? "\"shell=$PID\"; $child = Start-Process ping.exe -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru; \"grandchild=$($child.Id)\"; Start-Sleep 60"
		: "echo \"shell=$$\"; sleep 60 & echo \"grandchild=$!\"; sleep 60");
	await waitFor(() => pidOf(sleeper.id, "grandchild") > 0, "grandchild pid");
	const shellPid = pidOf(sleeper.id, "shell");
	const grandPid = pidOf(sleeper.id, "grandchild");
	await pause(500);
	assert.equal(alive(shellPid) && alive(grandPid), true);
	assert.equal(host.close(sleeper.id).ok, true);
	assert.equal(exits(sleeper.id).length, 1);
	assert.equal(host.list().some((tab) => tab.id === sleeper.id), false);
	await waitFor(() => !alive(shellPid) && !alive(grandPid), "process tree to stop", 10000);
	await pause(1500);
	assert.equal(exits(sleeper.id).length, 1);
	console.log("PASS close() stops a 60-second sleep and its child process tree, emits terminal-exit once, removes the tab");

	const stopper = host.open({ cwd: tmp });
	assert.equal(stopper.ok, true, stopper.error);
	host.write(stopper.id, windows
		? "\"shell=$PID\"; $ping = Start-Process ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru; \"ping=$($ping.Id)\"; $ping.WaitForExit()"
		: "echo \"shell=$$\"; sleep 60 & echo \"ping=$!\"; wait");
	await waitFor(() => pidOf(stopper.id, "ping") > 0, "ping pid");
	const stopperShell = pidOf(stopper.id, "shell");
	const pingPid = pidOf(stopper.id, "ping");
	assert.equal(alive(stopperShell) && alive(pingPid), true);
	const stopped = await host.interrupt(stopper.id);
	assert.equal(stopped.ok, true, stopped.error);
	assert.ok(stopped.stopped >= 1, `stopped ${stopped.stopped} processes`);
	await waitFor(() => !alive(pingPid), "ping to stop", 5000);
	assert.equal(alive(stopperShell), true, "the shell survives the interrupt");
	assert.deepEqual(host.list().find((tab) => tab.id === stopper.id), { id: stopper.id, cwd: tmp, running: true });
	host.write(stopper.id, "echo after");
	await waitFor(() => printed(stopper.id, "after"), "echo after the interrupt");
	if (!windows) {
		host.write(stopper.id, "sleep 60");
		await pause(500);
		assert.equal((await host.interrupt(stopper.id)).stopped, 1, "Stop ends a foreground command");
		await waitFor(() => output(stopper.id).endsWith(" $ "), "the prompt after Stop");
		// Stopping a foreground command makes bash print a tcsetattr notice. This prints the macOS wording on every system.
		const notice = "bash: [12329: 3] tcsetattr: Operation not supported on socket";
		host.write(stopper.id, `echo "${notice}"; echo back`);
		await waitFor(() => hasLine(stopper.id, "back"), "echo after stopping a foreground command");
		assert.equal(output(stopper.id).split(/\r?\n/).includes(notice), false, "the macOS tcsetattr notice is hidden");
	}
	assert.deepEqual(await host.interrupt(stopper.id), { ok: true, stopped: 0 });
	assert.deepEqual(await host.interrupt("no-such-tab"), { ok: false, error: "That terminal is closed." });
	assert.equal(exits(stopper.id).length, 0);
	host.close(stopper.id);
	console.log(`PASS interrupt() stops the running child (${stopped.stopped} stopped) and keeps the shell, which then runs echo after; an idle shell stops 0; an unknown tab is closed`);

	const quitter = host.open({ cwd: tmp });
	assert.equal(quitter.ok, true, quitter.error);
	host.write(quitter.id, "exit 3");
	await waitFor(() => exits(quitter.id).length > 0, "self exit");
	await pause(1000);
	assert.deepEqual(exits(quitter.id).map((event) => event.code), [3]);
	assert.equal(host.list().some((tab) => tab.id === quitter.id), false);
	console.log("PASS a shell that exits by itself emits terminal-exit once (code 3) and is removed");

	const extra = [];
	while (host.list().length < 12) {
		const tab = host.open({ cwd: tmp });
		assert.equal(tab.ok, true, tab.error);
		extra.push(tab.id);
	}
	assert.deepEqual(host.open({ cwd: tmp }), { ok: false, error: "Close a terminal tab first." });
	for (const extraId of extra) {
		host.close(extraId);
	}
	console.log("PASS 13th tab rejected with \"Close a terminal tab first.\"");

	host.closeAll();
	assert.deepEqual(host.list(), []);
	assert.equal(exits(id).length, 1);
	await waitFor(() => !alive(firstShell), "closeAll to stop the shell", 10000);
	console.log("PASS closeAll() stops every shell and empties list()");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	host.closeAll();
});
