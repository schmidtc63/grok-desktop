// grok export's OUTPUT path must not exist yet, so the transcript comes from stdout and the save replaces a file the person already chose.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { grokPath, killTree, OWN_GROUP } = require("./agent.cjs");

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

function runExport(command, args, cwd, timeout = TIMEOUT, maxBytes = MAX_BYTES) {
	return new Promise((resolve) => {
		let settled = false;
		let size = 0;
		let truncated = false;
		let err = "";
		let timer;
		const chunks = [];
		let child;
		const finish = (extra) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ code: -1, out: Buffer.concat(chunks).toString("utf8"), err, truncated, timedOut: false, missing: false, ...extra });
		};
		try {
			child = spawn(command, args, { ...OWN_GROUP, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
		child.stderr.on("data", (buf) => { err = `${err}${buf.toString("utf8")}`.slice(-4000); });
		child.on("close", (code) => finish({ code: code === null ? -1 : code, truncated }));
	});
}

async function exportMarkdown({ sessionId, file, run = runExport, command = grokPath(), cwd = os.homedir() } = {}) {
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
		return { ok: false, error: "This session has no Grok conversation yet." };
	}
	if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
		return { ok: false, error: "Choose a file to save." };
	}
	const result = await run(command, ["export", sessionId], cwd);
	if (result.missing) { return { ok: false, error: MISSING }; }
	if (result.timedOut) { return { ok: false, error: "Export timed out." }; }
	if (result.truncated) { return { ok: false, error: "That transcript is too large to export." }; }
	if (result.code !== 0) {
		const reason = lastLine(result.err) || lastLine(result.out) || "Grok could not export this session.";
		return { ok: false, error: reason.replace(/^error:\s*/i, "").slice(0, 300) };
	}
	try {
		await fs.promises.writeFile(file, result.out);
	} catch (error) {
		return { ok: false, error: (error && error.message ? error.message : "That file could not be saved.").slice(0, 300) };
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
