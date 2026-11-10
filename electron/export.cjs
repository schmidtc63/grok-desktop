// grok export's OUTPUT path must not exist yet, so the transcript comes from stdout and the save replaces a file the person already chose.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { grokPath, killTree, OWN_GROUP } = require("./agent.cjs");
const { isWslPath, usesWindowsAcl, stageWindowsSave, copyWslFile } = require("./files.cjs");
const { redactKeys } = require("./redact.cjs");

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMEOUT = 120000;
const MAX_BYTES = 32 * 1024 * 1024;
const MISSING = "Grok is not installed, or not on PATH. Set GROK_PATH to its full path.";

function markdownName(title) {
	const cleaned = String(title || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
	const base = cleaned || "Session";
	return /\.md$/i.test(base) ? base : `${base}.md`;
}

function lastLine(text) {
	return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || "";
}

function runExport(command, args, cwd, timeout = TIMEOUT, maxBytes = MAX_BYTES, env = process.env) {
	return new Promise((resolve) => {
		let settled = false;
		let size = 0;
		let truncated = false;
		let err = "";
		let errStartsMidLine = false;
		let timer;
		const chunks = [];
		let child;
		const finish = (extra) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (errStartsMidLine) {
				// The truncated first line might start inside a key, past the prefix redaction needs.
				const nextLine = err.indexOf("\n");
				err = nextLine === -1 ? "" : err.slice(nextLine + 1);
			}
			resolve({ code: -1, out: Buffer.concat(chunks).toString("utf8"), err, truncated, timedOut: false, missing: false, ...extra });
		};
		try {
			child = spawn(command, args, { ...OWN_GROUP, cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: -1, out: "", err: error.message, truncated: false, timedOut: false, missing: error.code === "ENOENT" });
			return;
		}
		timer = setTimeout(() => {
			killTree(child, true);
			finish({ timedOut: true });
		}, timeout);
		child.on("error", (error) => finish({ err: error.message, missing: error.code === "ENOENT" }));
		child.stdout.on("data", (buf) => {
			size += buf.length;
			if (size > maxBytes) {
				truncated = true;
				chunks.length = 0;
				killTree(child, true);
				return;
			}
			chunks.push(buf);
		});
		child.stderr.on("data", (buf) => {
			err += buf.toString("utf8");
			if (err.length > 4000) {
				const first = err.length - 4000;
				errStartsMidLine = err[first - 1] !== "\n";
				err = err.slice(first);
			}
		});
		child.on("close", (code) => finish({ code: code === null ? -1 : code, truncated }));
	});
}

// `home` is a sandbox's Grok home, for a session that this computer's Grok home doesn't hold.
async function exportMarkdown({ sessionId, file, run = runExport, command = grokPath(), cwd = os.homedir(), home = "" } = {}) {
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
		return { ok: false, error: "This session has no Grok conversation yet." };
	}
	if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
		return { ok: false, error: "Choose a file to save." };
	}
	const result = await run(command, ["export", sessionId], cwd, TIMEOUT, MAX_BYTES, home ? { ...process.env, GROK_HOME: home } : process.env);
	if (result.missing) { return { ok: false, error: MISSING }; }
	if (result.timedOut) { return { ok: false, error: "Export timed out." }; }
	if (result.truncated) { return { ok: false, error: "That transcript is too large to export." }; }
	if (result.code !== 0) {
		const reason = lastLine(result.err) || lastLine(result.out) || "Grok could not export this session.";
		return { ok: false, error: redactKeys(reason.replace(/^error:\s*/i, "")).slice(0, 300) };
	}
	let temporary;
	let handle;
	let created = false;
	let keepStage = false;
	try {
		const prior = await fs.promises.stat(file).catch((error) => {
			if (error.code !== "ENOENT") { throw error; }
			return null;
		});
		if (prior) {
			if (!prior.isFile()) { throw new Error("Choose a file to save."); }
			await fs.promises.access(file, fs.constants.W_OK);
		}
		const wsl = prior && isWslPath(file);
		temporary = path.join(wsl ? os.tmpdir() : path.dirname(file), `.grok-export-${randomUUID()}.tmp`);
		handle = await fs.promises.open(temporary, "wx", prior?.mode);
		created = true;
		if (prior && usesWindowsAcl(file)) {
			await handle.close();
			handle = undefined;
			await stageWindowsSave(temporary, file, { existing: true });
			handle = await fs.promises.open(temporary, "r+");
		}
		await handle.writeFile(redactKeys(result.out));
		if (prior && process.platform !== "win32") { await handle.chmod(prior.mode); }
		await handle.close();
		handle = undefined;
		if (wsl) {
			const written = copyWslFile(temporary, file, prior);
			if (written.backup) {
				keepStage = true;
				return { ok: false, error: `The export could not replace or restore the chosen file. Check the file on disk. The original is saved at "${written.backup}". The complete export is saved at "${temporary}".` };
			}
			if (written.error) { throw written.error; }
			if (!written.ok) { return { ok: false, error: "The chosen file changed on disk before export could replace it." }; }
		} else {
			await fs.promises.rename(temporary, file);
			created = false;
		}
	} catch (error) {
		return { ok: false, error: (error && error.message ? error.message : "That file could not be saved.").slice(0, 300) };
	} finally {
		if (handle) { await handle.close().catch(() => {}); }
		if (created && !keepStage) { await fs.promises.unlink(temporary).catch(() => {}); }
	}
	return { ok: true, path: file };
}

async function chooseExport({ sessionId, title, choose, write = exportMarkdown }) {
	let file = "";
	try {
		file = await choose(markdownName(title));
	} catch {
		return { ok: false, error: "The save dialog could not open." };
	}
	if (!file) { return { ok: true, cancelled: true }; }
	return write({ sessionId, file });
}

module.exports = { markdownName, runExport, exportMarkdown, chooseExport };
