const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
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

async function checkWslExport() {
	const chosen = "\\\\wsl.localhost\\Ubuntu\\project\\chat.md";
	const originals = { stat: fs.promises.stat, access: fs.promises.access, rename: fs.promises.rename };
	const { openSync, closeSync, statSync, writeSync } = fs;
	const tmpdir = os.tmpdir;
	const mapped = (value) => value === chosen ? file : value;
	fs.writeFileSync(file, "private transcript");
	const before = fs.statSync(file);
	let fault = "";
	let destination;
	try {
		os.tmpdir = () => dir;
		fs.promises.stat = (value) => originals.stat(mapped(value));
		fs.promises.access = (value, mode) => originals.access(mapped(value), mode);
		fs.promises.rename = () => { throw new Error("WSL must preserve the destination inode"); };
		fs.statSync = (value) => statSync(mapped(value));
		fs.openSync = (value, ...args) => {
			const handle = openSync(mapped(value), ...args);
			if (value === chosen) { destination = handle; }
			return handle;
		};
		fs.closeSync = (descriptor) => {
			if (descriptor === destination) { destination = undefined; }
			return closeSync(descriptor);
		};
		fs.writeSync = (descriptor, ...args) => {
			if (descriptor !== destination || !fault) { return writeSync(descriptor, ...args); }
			if (fault !== "rollback") {
				writeSync(descriptor, args[0], args[1], 1, args[3]);
				fault = fault === "both" ? "rollback" : "";
			}
			throw new Error("Injected WSL destination failure");
		};
		const success = await exportMarkdown({ sessionId: "agent-1", file: chosen, run: okRun("new").run });
		assert.equal(success.ok, true);
		const after = fs.statSync(file);
		assert.deepEqual([after.ino, after.uid, after.mode], [before.ino, before.uid, before.mode]);
		assert.equal(fs.readFileSync(file, "utf8"), "new");
		assert.deepEqual(fs.readdirSync(dir), ["chat.md"]);
		fault = "primary";
		assert.match((await exportMarkdown({ sessionId: "agent-1", file: chosen, run: okRun("draft").run })).error, /Injected WSL destination failure/);
		assert.equal(fs.readFileSync(file, "utf8"), "new");
		assert.deepEqual(fs.readdirSync(dir), ["chat.md"]);
		fault = "both";
		const failed = await exportMarkdown({ sessionId: "agent-1", file: chosen, run: okRun("draft").run });
		assert.equal(failed.ok, false);
		assert.equal(fs.readFileSync(file, "utf8"), "dew");
		const recovery = fs.readdirSync(dir).find((name) => name.startsWith(".grok-export-") && name.endsWith(".tmp"));
		const recoveryPath = path.join(dir, recovery);
		assert.ok(failed.error.includes(`"${recoveryPath}"`) && failed.error.includes(`"${recoveryPath}.original"`));
		assert.equal(fs.readFileSync(recoveryPath, "utf8"), "draft");
		assert.equal(fs.readFileSync(`${recoveryPath}.original`, "utf8"), "new");
		fs.unlinkSync(recoveryPath);
		fs.unlinkSync(`${recoveryPath}.original`);
		const final = fs.statSync(file);
		assert.deepEqual([final.ino, final.uid, final.mode], [before.ino, before.uid, before.mode]);
	} finally {
		Object.assign(fs.promises, originals);
		Object.assign(fs, { openSync, closeSync, statSync, writeSync });
		os.tmpdir = tmpdir;
	}
}

async function main() {
	assert.equal(markdownName("My: chat"), "My chat.md");
	assert.equal(markdownName("notes.md"), "notes.md");
	assert.equal(markdownName("   "), "Session.md");

	assert.equal((await exportMarkdown({ sessionId: "", file })).error, "This session has no Grok conversation yet.");
	assert.equal((await exportMarkdown({ sessionId: "../secret", file })).ok, false);
	assert.equal((await exportMarkdown({ sessionId: "agent-1", file: "chat.md" })).error, "Choose a file to save.");

	fs.writeFileSync(file, "old");
	const fakeKey = `xai-${"A".repeat(80)}`;
	const saved = okRun(`# Hello\n${fakeKey}\nxai-grok-cli\n`);
	const wrote = await exportMarkdown({ sessionId: "agent-1", file, run: saved.run, command: "grok" });
	assert.equal(wrote.ok, true);
	assert.equal(wrote.path, file);
	assert.ok(fs.readFileSync(file, "utf8") === "# Hello\n[redacted]\nxai-grok-cli\n", "Markdown masks a key and preserves ordinary text");
	assert.deepEqual(saved.seen, [["grok", ["export", "agent-1"]]]);

	fs.writeFileSync(file, "keep");
	if (process.platform === "win32") {
		const execFile = childProcess.execFile;
		try {
			childProcess.execFile = (_program, args, options, callback) => {
				assert.match(args.at(-1), /SetAccessControl/);
				const staged = options.env.GROK_SAVE_TEMP;
				assert.equal(path.dirname(staged), dir);
				assert.equal(fs.statSync(staged).size, 0);
				callback(new Error("Injected ACL staging failure"));
			};
			const stageFailed = await exportMarkdown({ sessionId: "agent-1", file, run: saved.run });
			assert.match(stageFailed.error, /Injected ACL staging failure/);
			assert.equal(fs.readFileSync(file, "utf8"), "keep");
			assert.deepEqual(fs.readdirSync(dir), ["chat.md"]);
		} finally {
			childProcess.execFile = execFile;
		}
	}

	const { open, rename } = fs.promises;
	try {
		fs.promises.open = async (...args) => {
			const handle = await open(...args);
			const write = handle.writeFile.bind(handle);
			handle.writeFile = async () => {
				await write("PARTIAL");
				throw new Error("Injected partial write");
			};
			return handle;
		};
		const writeFailed = await exportMarkdown({ sessionId: "agent-1", file, run: saved.run });
		assert.match(writeFailed.error, /Injected partial write/);
		assert.equal(fs.readFileSync(file, "utf8"), "keep");
		assert.deepEqual(fs.readdirSync(dir), ["chat.md"]);

		fs.promises.open = open;
		fs.promises.rename = async (source, destination) => {
			assert.equal(path.dirname(source), dir);
			assert.equal(destination, file);
			assert.match(fs.readFileSync(source, "utf8"), /\[redacted\]/);
			throw new Error("Injected replacement failure");
		};
		const replaceFailed = await exportMarkdown({ sessionId: "agent-1", file, run: saved.run });
		assert.match(replaceFailed.error, /Injected replacement failure/);
		assert.equal(fs.readFileSync(file, "utf8"), "keep");
		assert.deepEqual(fs.readdirSync(dir), ["chat.md"]);
	} finally {
		fs.promises.open = open;
		fs.promises.rename = rename;
	}

	const errorPrefix = `${"a".repeat(288)} `;
	const failed = await exportMarkdown({
		sessionId: "agent-1",
		file,
		command: "grok",
		run: async () => ({ code: 1, out: "", err: `error: ${errorPrefix}${fakeKey} end\n`, truncated: false, timedOut: false, missing: false }),
	});
	assert.ok(failed.error === `${errorPrefix}[redacted] `, "Grok errors mask the whole key before shortening the message");
	assert.ok(fs.readFileSync(file, "utf8") === "keep", "a failed export leaves the chosen file alone");
	const clipped = await exportMarkdown({
		sessionId: "agent-1",
		file,
		cwd: dir,
		run: (_command, _args, cwd) => runExport(process.execPath, ["-e", "process.stderr.write('xai-' + 'A'.repeat(80) + ' '.repeat(3950)); process.exitCode = 1;"], cwd, 5000),
	});
	assert.ok(clipped.error === "Grok could not export this session.", "a clipped stderr line cannot expose a key suffix");

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
	if (process.platform === "win32") { await checkWslExport(); }

	fs.rmSync(dir, { recursive: true, force: true });
	console.log("PASS markdown export: name, overwrite, key masking in files and errors, failure leaves the file, cancel, and a mocked grok run.");
}

main().catch((error) => {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	console.error(error);
	process.exitCode = 1;
});
