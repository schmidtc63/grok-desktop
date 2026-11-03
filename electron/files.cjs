const childProcess = require("child_process");
const { spawn } = childProcess;
const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { isUtf8 } = require("buffer");
const { promisify } = require("util");
const { folderProblem } = require("./agent.cjs");
const { repoFiles } = require("./git.cjs");

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
const SKIP_EXT = new Set("png jpg jpeg gif webp bmp ico tif tiff psd ai pdf doc docx xls xlsx xlsm ppt pptx zip 7z rar gz tgz tar mp3 mp4 mov avi wav m4a webm woff woff2 ttf otf eot exe dll so dylib bin pdb class jar o obj db sqlite mdb accdb bak mdf ldf".split(" "));
const MAX_FILES = 5000;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_OUTPUT = 80 * 1024;
const RUN_MS = 20000;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listFiles(cwd, budgetMs = 5000) {
	const problem = folderProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	let root;
	try {
		root = await fs.promises.realpath(cwd);
	} catch {
		return { ok: false, error: `That folder is not on this computer: ${cwd}` };
	}
	const listed = await repoFiles(root);
	if (listed) {
		const files = listed.files.filter((file) => !file.split("/").some((part) => SKIP.has(part)) && !SKIP_EXT.has(path.extname(file).slice(1).toLowerCase())).sort();
		return { ok: true, files: files.slice(0, MAX_FILES), truncated: listed.truncated || files.length > MAX_FILES };
	}
	const files = [];
	const seen = new Set();
	const deadline = Date.now() + budgetMs;
	let truncated = false;
	let tooDeep = false;

	async function walk(dir, depth) {
		if (depth > MAX_DEPTH) { tooDeep = true; return; }
		if (truncated) { return; }
		if (Date.now() >= deadline) { truncated = true; return; }
		let real;
		try {
			real = await fs.promises.realpath(dir);
		} catch {
			return;
		}
		if (seen.has(real) || !inside(root, real) && real !== root) { return; }
		seen.add(real);
		let entries;
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (files.length >= MAX_FILES || Date.now() >= deadline) {
				truncated = true;
				return;
			}
			if (SKIP.has(entry.name)) { continue; }
			if (entry.isDirectory() && entry.name.startsWith(".")) { continue; }
			if (entry.isFile() && SKIP_EXT.has(path.extname(entry.name).slice(1).toLowerCase())) { continue; }
			const absolute = path.join(dir, entry.name);
			let target;
			try {
				target = await fs.promises.realpath(absolute);
			} catch {
				continue;
			}
			if (!inside(root, target)) { continue; }
			if (entry.isDirectory()) { await walk(absolute, depth + 1); }
			else if (entry.isFile()) { files.push(path.relative(root, target).split(path.sep).join("/")); }
		}
	}

	await walk(root, 0);
	files.sort();
	return { ok: true, files, truncated: truncated || tooDeep };
}

function locateFile(cwd, relative) {
  const problem = folderProblem(cwd);
  if (problem) return { ok: false, error: problem };
  if (typeof relative !== "string" || !relative.trim() || /[\0\r\n]/.test(relative)) {
    return { ok: false, error: "Choose a file in this folder." };
  }
  let root;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    return { ok: false, error: `That folder is not on this computer: ${cwd}` };
  }
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) return { ok: false, error: "That file is not in this folder." };
  let target;
  try {
    target = fs.realpathSync(absolute);
  } catch {
    return { ok: false, error: "That file is not in this folder." };
  }
  if (!inside(root, target)) return { ok: false, error: "That file is not in this folder." };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: "That file is not in this folder." };
  }
  if (!stat.isFile()) return { ok: false, error: "That path is not a file." };
  return { ok: true, target, stat };
}

function readText(cwd, relative) {
  const located = locateFile(cwd, relative);
  if (!located.ok) return located;
  if (located.stat.size > MAX_FILE_BYTES) return { ok: false, error: "That file is too large to show here." };
  const buf = fs.readFileSync(located.target);
  if (buf.includes(0)) return { ok: true, binary: true, text: "" };
	if (!isUtf8(buf)) { return { ok: false, error: "This file is not valid UTF-8 and cannot be edited here." }; }
	return { ok: true, binary: false, text: buf.toString("utf8"), version: createHash("sha256").update(buf).digest("hex") };
}

function revealFile(cwd, relative) {
  const located = locateFile(cwd, relative);
  if (!located.ok) return { ok: false, error: located.error };
  const explorer = path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe");
  try {
    const child = spawn(explorer, [`/select,${located.target}`], { stdio: "ignore" });
    child.on("error", () => {});
  } catch {
    return { ok: false, error: "File Explorer is not available in this window." };
  }
  return { ok: true };
}

async function windowsSaveStep(command, temporary, target, expectedVersion = "") {
	const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	await promisify(childProcess.execFile)(shell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${command}`], {
		windowsHide: true,
		timeout: 8000,
		stdio: "pipe",
		env: { ...process.env, GROK_SAVE_TEMP: temporary, GROK_SAVE_TARGET: target, GROK_SAVE_VERSION: expectedVersion },
	});
}

async function writeText(cwd, relative, text, expectedVersion) {
  const problem = folderProblem(cwd);
  if (problem) return { ok: false, error: problem };
  if (typeof relative !== "string" || !relative.trim() || /[\0\r\n]/.test(relative)) {
    return { ok: false, error: "Choose a file in this folder." };
  }
  if (typeof text !== "string" || text.includes("\0")) {
    return { ok: false, error: "That file could not be saved." };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return { ok: false, error: "That file is too large to save here." };
  }
	if (typeof expectedVersion !== "string" || !expectedVersion) {
		return { ok: false, error: "Reload this file before saving it." };
	}
  let root;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    return { ok: false, error: `That folder is not on this computer: ${cwd}` };
  }
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) return { ok: false, error: "That file is not in this folder." };
  const parent = path.dirname(absolute);
  let parentReal;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    return { ok: false, error: "That file is not in this folder." };
  }
  if (parentReal !== root && !inside(root, parentReal)) {
    return { ok: false, error: "That file is not in this folder." };
  }
  const resolved = path.resolve(parentReal, path.basename(absolute));
  if (!inside(root, resolved)) return { ok: false, error: "That file is not in this folder." };
  if (fs.existsSync(resolved)) {
    let target;
    try {
      target = fs.realpathSync(resolved);
    } catch {
      return { ok: false, error: "That file is not in this folder." };
    }
    if (!inside(root, target)) return { ok: false, error: "That file is not in this folder." };
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return { ok: false, error: "That file is not in this folder." };
    }
    if (!stat.isFile()) return { ok: false, error: "That path is not a file." };
		const current = fs.readFileSync(target);
		if (current.includes(0) || !isUtf8(current)) {
			return { ok: false, error: "This file is not editable UTF-8. Your draft was not saved." };
		}
		const version = createHash("sha256").update(current).digest("hex");
		if (version !== expectedVersion) {
			return { ok: false, error: "This file changed on disk. Your draft was not saved. Reload the file and reconcile your changes." };
		}
		const temporary = path.join(path.dirname(target), `.grok-save-${randomUUID()}.tmp`);
		let descriptor;
		let created = false;
		let replaced = false;
		try {
			if (process.platform === "win32") {
				await windowsSaveStep("$security = [IO.File]::GetAccessControl($env:GROK_SAVE_TARGET, [Security.AccessControl.AccessControlSections]::Access); $stream = [IO.FileStream]::new($env:GROK_SAVE_TEMP, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security); $stream.Dispose()", temporary, target);
				created = true;
				descriptor = fs.openSync(temporary, "r+");
			} else {
				descriptor = fs.openSync(temporary, "wx", stat.mode);
				created = true;
			}
			fs.writeFileSync(descriptor, text, "utf8");
			fs.fsyncSync(descriptor);
			fs.closeSync(descriptor);
			descriptor = undefined;
			if (process.platform !== "win32") { fs.chmodSync(temporary, stat.mode); }
			if (createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== expectedVersion) {
				return { ok: false, error: "This file changed on disk. Your draft was not saved. Reload the file and reconcile your changes." };
			}
			if (process.platform === "win32") {
				await windowsSaveStep("$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($env:GROK_SAVE_TARGET))).Replace('-', '').ToLowerInvariant(); if ($hash -ne $env:GROK_SAVE_VERSION) { throw 'The file changed on disk before replacement.' }; [IO.File]::Replace($env:GROK_SAVE_TEMP, $env:GROK_SAVE_TARGET, [NullString]::Value)", temporary, target, expectedVersion);
			} else {
				fs.renameSync(temporary, target);
			}
			replaced = true;
			return { ok: true, version: createHash("sha256").update(text, "utf8").digest("hex") };
		} catch {
			return { ok: false, error: "That file could not be saved. The original file was not replaced." };
		} finally {
			if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
			if (created && !replaced) { try { fs.chmodSync(temporary, stat.mode | 0o200); fs.unlinkSync(temporary); } catch {} }
		}
  }
	return { ok: false, error: "This file was removed from disk. Your draft was not saved." };
}

function decodeOutput(buf) {
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function killTree(child) {
	if (!child || child.pid == null) { return Promise.resolve(false); }
	return new Promise((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => resolve(false));
		killer.on("close", (code) => resolve(code === 0));
	});
}

function runCommand(cwd, command) {
  const problem = folderProblem(cwd);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) return Promise.resolve({ ok: false, error: "Type a command to run." });
  if (text.length > 4000) return Promise.resolve({ ok: false, error: "That command is too long." });
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    let settled = false;
    let truncated = false;
		let stopping = false;
		let timedOut = false;
    let size = 0;
    const chunks = [];
    const push = (buf) => {
      size += buf.length;
      if (size > MAX_OUTPUT) {
        truncated = true;
				stop(false);
        return;
      }
      chunks.push(buf);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", text], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      const missing = error && error.code === "ENOENT";
      finish({ ok: false, error: missing ? "PowerShell is not available in this window." : "The command could not run." });
    });
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => {
			if (stopping) { return; }
      finish({
        ok: true,
        code: code ?? -1,
        output: decodeOutput(Buffer.concat(chunks)),
        truncated,
      });
    });
		const stop = (timeout) => {
			if (stopping || settled) { return; }
			stopping = true;
			timedOut = timeout;
			truncated = true;
			void killTree(child).then((killed) => {
				const reason = timedOut ? "Command exceeded the 20-second limit." : "Command exceeded the output limit.";
				if (!killed) {
					finish({ ok: false, error: `${reason} Its process tree could not be confirmed stopped.` });
					return;
				}
				finish({ ok: true, code: -1, output: `${decodeOutput(Buffer.concat(chunks))}\n${reason} The process tree was stopped.\n`, truncated, timedOut });
			});
		};
		const timer = setTimeout(() => stop(true), RUN_MS);
  });
}

module.exports = { listFiles, readText, writeText, runCommand, locateFile, revealFile };
