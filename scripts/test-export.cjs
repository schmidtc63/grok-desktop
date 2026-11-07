const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseExport, exportMarkdown, markdownName, runExport } = require("../electron/export.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-export-"));
const file = path.join(dir, "chat.md");

function okRun(out) {
	const seen = [];
	return {
		seen,
		run(command, args) {
			seen.push([command, args]);
			return { code: 0, out, err: "", truncated: false, timedOut: false, missing: false };
		},
	};
}

async function main() {
	assert.equal(markdownName("My: chat"), "My chat.md");
	assert.equal(markdownName("notes.md"), "notes.md");
	assert.equal(markdownName("   "), "Session.md");

	assert.equal((await exportMarkdown({ sessionId: "", file })).error, "This session has no Grok conversation yet.");
	assert.equal((await exportMarkdown({ sessionId: "../secret", file })).ok, false);
	assert.equal((await exportMarkdown({ sessionId: "agent-1", file: "chat.md" })).error, "Choose a file to save.");

	fs.writeFileSync(file, "old");
	const saved = okRun("# Hello\n");
	const wrote = await exportMarkdown({ sessionId: "agent-1", file, run: saved.run, command: "grok" });
	assert.equal(wrote.ok, true);
	assert.equal(wrote.path, file);
	assert.equal(fs.readFileSync(file, "utf8"), "# Hello\n");
	assert.deepEqual(saved.seen, [["grok", ["export", "agent-1"]]]);

	fs.writeFileSync(file, "keep");
	const failed = await exportMarkdown({
		sessionId: "agent-1",
		file,
		command: "grok",
		run: async () => ({ code: 1, out: "", err: "error: session not found\n", truncated: false, timedOut: false, missing: false }),
	});
	assert.equal(failed.error, "session not found");
	assert.equal(fs.readFileSync(file, "utf8"), "keep", "a failed export leaves the chosen file alone");

	const missing = await exportMarkdown({
		sessionId: "agent-1",
		file,
		run: async () => ({ code: -1, out: "", err: "", truncated: false, timedOut: false, missing: true }),
	});
	assert.match(missing.error, /GROK_PATH/);
	assert.equal((await exportMarkdown({
		sessionId: "agent-1",
		file,
		run: async () => ({ code: -1, out: "", err: "", truncated: false, timedOut: true, missing: false }),
	})).error, "Export timed out.");
	assert.equal((await exportMarkdown({
		sessionId: "agent-1",
		file,
		run: async () => ({ code: -1, out: "partial", err: "", truncated: true, timedOut: false, missing: false }),
	})).error, "That transcript is too large to export.");
	assert.equal(fs.readFileSync(file, "utf8"), "keep");

	let writes = 0;
	const cancelled = await chooseExport({
		sessionId: "agent-1",
		title: "Second chat",
		choose: async (name) => { assert.equal(name, "Second chat.md"); return ""; },
		write: async () => { writes += 1; return { ok: true }; },
	});
	assert.equal(cancelled.cancelled, true);
	assert.equal(writes, 0, "cancelling the save dialog does nothing");

	const chosen = await chooseExport({
		sessionId: "agent-1",
		title: "Second chat",
		choose: async () => file,
		write: async (input) => ({ ok: true, path: input.file, sessionId: input.sessionId }),
	});
	assert.deepEqual(chosen, { ok: true, path: file, sessionId: "agent-1" });
	assert.equal((await chooseExport({ sessionId: "agent-1", title: "x", choose: async () => { throw new Error("no window"); } })).error, "The save dialog could not open.");

	const printed = await runExport(process.execPath, ["-e", "process.stdout.write('# from node')"], dir, 5000);
	assert.equal(printed.code, 0);
	assert.equal(printed.out, "# from node");
	const stalled = await runExport(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], dir, 300);
	assert.equal(stalled.timedOut, true);

	fs.rmSync(dir, { recursive: true, force: true });
	console.log("PASS markdown export: name, overwrite, failure leaves the file, cancel, and a mocked grok run.");
}

main().catch((error) => {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	console.error(error);
	process.exitCode = 1;
});
