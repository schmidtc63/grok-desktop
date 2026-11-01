const assert = require("assert/strict");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { TerminalHost } = require("../electron/terminal.cjs");

const events = [];
const host = new TerminalHost((event) => { events.push(event); });

function output(id) {
	return events.filter((event) => event.type === "terminal-data" && event.id === id).map((event) => event.data).join("");
}

function hasLine(id, line) {
	return output(id).split(/\r?\n/).includes(line);
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

async function main() {
	const tmp = os.tmpdir();
	const opened = host.open({ cwd: tmp });
	assert.equal(opened.ok, true, opened.error);
	const id = opened.id;
	assert.deepEqual(host.list(), [{ id, cwd: tmp, running: true }]);
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
	host.write(sleeper.id, "\"shell=$PID\"; $child = Start-Process ping.exe -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru; \"grandchild=$($child.Id)\"; Start-Sleep 60");
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
	console.log("PASS close() stops Start-Sleep 60 and its child process tree, emits terminal-exit once, removes the tab");

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
