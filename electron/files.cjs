const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { isUtf8 } = require("buffer");
const { promisify } = require("util");
const { folderProblem } = require("./agent.cjs");
const { repoFiles } = require("./git.cjs");

const IMAGE_MIME = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"], [".ico", "image/x-icon"], [".avif", "image/avif"]]);
const DEFAULT_APP_EXT = new Set(".pdf .doc .docx .xls .xlsx .ppt .pptx .odt .ods .odp .rtf .mp3 .wav .mp4 .mov .webm".split(" "));
const PREVIEW_BINARY_EXT = new Set([...IMAGE_MIME.keys(), ...DEFAULT_APP_EXT]);
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
const SKIP_EXT = new Set("png jpg jpeg gif webp bmp ico tif tiff psd ai pdf doc docx xls xlsx xlsm ppt pptx zip 7z rar gz tgz tar mp3 mp4 mov avi wav m4a webm woff woff2 ttf otf eot exe dll so dylib bin pdb class jar o obj db sqlite mdb accdb bak mdf ldf".split(" ").filter((extension) => !PREVIEW_BINARY_EXT.has(`.${extension}`)));
const MAX_FILES = 5000;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const WSL_COPY_CHUNK = 64 * 1024;

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
	if (PREVIEW_BINARY_EXT.has(path.extname(located.target).toLowerCase())) {
		return { ok: true, binary: true, text: "", version: `${located.stat.size}:${located.stat.mtimeMs}:${located.stat.ctimeMs}` };
	}
  if (located.stat.size > MAX_FILE_BYTES) return { ok: false, error: "That file is too large to show here." };
  const buf = fs.readFileSync(located.target);
  if (buf.includes(0)) return { ok: true, binary: true, text: "" };
	if (!isUtf8(buf)) { return { ok: false, error: "This file is not valid UTF-8 and cannot be edited here." }; }
	return { ok: true, binary: false, text: buf.toString("utf8"), version: createHash("sha256").update(buf).digest("hex") };
}

function readImage(cwd, relative) {
	const located = locateFile(cwd, relative);
	if (!located.ok) { return located; }
	const mime = IMAGE_MIME.get(path.extname(located.target).toLowerCase());
	if (!mime || !IMAGE_MIME.has(path.extname(relative).toLowerCase())) { return { ok: false, error: "That file is not an image." }; }
	if (located.stat.size > MAX_IMAGE_BYTES) { return { ok: false, error: "That image is too large to show here." }; }
	try {
		const buffer = fs.readFileSync(located.target);
		if (buffer.length > MAX_IMAGE_BYTES) { return { ok: false, error: "That image is too large to show here." }; }
		return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, bytes: buffer.length };
	} catch {
		return { ok: false, error: "That image could not be read." };
	}
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

function isWslPath(target) {
	return process.platform === "win32" && /^\\\\(?:\?\\UNC\\)?(?:wsl\.localhost|wsl\$)\\/i.test(target);
}

function usesWindowsAcl(target) {
	return process.platform === "win32" && !isWslPath(target);
}

function stageWindowsSave(temporary, target, { existing = false } = {}) {
	const stage = existing ? "[IO.File]::SetAccessControl($env:GROK_SAVE_TEMP, $security)"
		: "$stream = [IO.FileStream]::new($env:GROK_SAVE_TEMP, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security); $stream.Dispose()";
	return windowsSaveStep(`$security = [IO.File]::GetAccessControl($env:GROK_SAVE_TARGET, [Security.AccessControl.AccessControlSections]::Access); ${stage}`, temporary, target);
}

function readWslBytes(file, position, length) {
	const bytes = Buffer.allocUnsafe(length);
	for (let offset = 0; offset < length;) {
		const count = fs.readSync(file, bytes, offset, length - offset, position + offset);
		if (!count) { throw new Error("The file changed on disk during the read."); }
		offset += count;
	}
	return bytes;
}

function writeWslBytes(file, bytes, position, progress) {
	for (let offset = 0; offset < bytes.length;) {
		const count = fs.writeSync(file, bytes, offset, bytes.length - offset, position + offset);
		if (!count) { throw new Error("The file stopped accepting writes."); }
		offset += count;
		if (progress) { progress.written = position + offset; }
	}
}

function matchesWslWrite(file, backup, originalSize, next, { written = 0, truncating = false } = {}) {
	const { size, mtimeMs, ctimeMs } = fs.fstatSync(file);
	const unchanged = () => {
		const after = fs.fstatSync(file);
		return after.size === size && after.mtimeMs === mtimeMs && after.ctimeMs === ctimeMs;
	};
	if (truncating && size === next.length && size < originalSize) {
		return readWslBytes(file, 0, size).equals(next) && unchanged();
	}
	if (size < originalSize || size > Math.max(originalSize, next.length) || size < written) { return false; }
	let earliest = size > originalSize ? size : written;
	let latest = Math.min(size, next.length);
	// A failed write can leave an unknown prefix of the new bytes, followed by the old suffix.
	for (let position = 0; position < size; position += WSL_COPY_CHUNK) {
		const current = readWslBytes(file, position, Math.min(WSL_COPY_CHUNK, size - position));
		const previous = readWslBytes(backup, position, Math.max(0, Math.min(current.length, originalSize - position)));
		const replacement = next.subarray(position, position + current.length);
		for (let index = 0; index < replacement.length; index++) {
			if (current[index] !== replacement[index]) { latest = Math.min(latest, position + index); }
			if (current[index] !== previous[index]) { earliest = Math.max(earliest, position + index + 1); }
			if (earliest > latest) { return false; }
		}
		if (!current.subarray(replacement.length).equals(previous.subarray(replacement.length))) { return false; }
	}
	return unchanged();
}

function copyWslFile(temporary, target, original, expectedVersion = "") {
	const backupPath = `${temporary}.original`;
	const noWrite = Buffer.alloc(0);
	let file;
	let backup;
	let keepBackup = false;
	try {
		const bytes = fs.readFileSync(temporary);
		file = fs.openSync(target, "r+");
		const sameFile = (stat) => stat.dev === original.dev && stat.ino === original.ino;
		const opened = fs.fstatSync(file);
		if (!sameFile(opened)) { return { ok: false }; }
		backup = fs.openSync(backupPath, "wx+", 0o600);
		const hash = expectedVersion ? createHash("sha256") : null;
		for (let position = 0; position < opened.size; position += WSL_COPY_CHUNK) {
			const chunk = readWslBytes(file, position, Math.min(WSL_COPY_CHUNK, opened.size - position));
			hash?.update(chunk);
			writeWslBytes(backup, chunk, position);
		}
		fs.fsyncSync(backup);
		const matchesOriginal = () => matchesWslWrite(file, backup, opened.size, noWrite);
		const sameDestination = () => sameFile(fs.statSync(target));
		if ((hash && hash.digest("hex") !== expectedVersion) || !matchesOriginal() || !sameDestination()) {
			return { ok: false };
		}
		const progress = { written: 0, truncating: false };
		try {
			writeWslBytes(file, bytes, 0, progress);
			progress.truncating = true;
			fs.ftruncateSync(file, bytes.length);
			if (!sameDestination()) { throw new Error("The file changed on disk during the write."); }
			const closing = file;
			file = undefined;
			fs.closeSync(closing);
		} catch (error) {
			try {
				if (file === undefined) { file = fs.openSync(target, "r+"); }
				if (!sameFile(fs.fstatSync(file)) || !sameDestination()) { throw new Error("The file was replaced."); }
				if (!matchesOriginal()) {
					if (!matchesWslWrite(file, backup, opened.size, bytes, progress) || !sameDestination()) {
						throw new Error("The file was changed by another process.");
					}
					for (let position = 0; position < opened.size; position += WSL_COPY_CHUNK) {
						const chunk = readWslBytes(backup, position, Math.min(WSL_COPY_CHUNK, opened.size - position));
						writeWslBytes(file, chunk, position);
					}
					fs.ftruncateSync(file, opened.size);
					if (!matchesOriginal()) { throw new Error("Restoration could not be verified."); }
				}
				if (!sameDestination()) { throw new Error("The file was replaced."); }
				const closing = file;
				file = undefined;
				fs.closeSync(closing);
			} catch {
				keepBackup = true;
				return { ok: false, error, backup: backupPath };
			}
			return { ok: false, error };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	} finally {
		if (file !== undefined) { try { fs.closeSync(file); } catch {} }
		if (backup !== undefined) {
			try { fs.closeSync(backup); } catch {}
			if (!keepBackup) { try { fs.unlinkSync(backupPath); } catch {} }
		}
	}
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
		const windowsAcl = usesWindowsAcl(target);
		const wsl = isWslPath(target);
		const temporary = path.join(wsl ? os.tmpdir() : path.dirname(target), `.grok-save-${randomUUID()}.tmp`);
		let descriptor;
		let created = false;
		let keepStage = false;
		try {
			if (windowsAcl) {
				await stageWindowsSave(temporary, target);
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
			if (wsl) {
				const result = copyWslFile(temporary, target, stat, expectedVersion);
				if (result.backup) {
					keepStage = true;
					return { ok: false, error: `That file could not be saved or restored. Check the file on disk. The original is saved at "${result.backup}". Your draft is saved at "${temporary}".` };
				}
				if (result.error) { throw result.error; }
				if (!result.ok) { return { ok: false, error: "This file changed on disk. Your draft was not saved. Reload the file and reconcile your changes." }; }
			} else if (createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== expectedVersion) {
				return { ok: false, error: "This file changed on disk. Your draft was not saved. Reload the file and reconcile your changes." };
			} else if (windowsAcl) {
				await windowsSaveStep("$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($env:GROK_SAVE_TARGET))).Replace('-', '').ToLowerInvariant(); if ($hash -ne $env:GROK_SAVE_VERSION) { throw 'The file changed on disk before replacement.' }; [IO.File]::Replace($env:GROK_SAVE_TEMP, $env:GROK_SAVE_TARGET, [NullString]::Value)", temporary, target, expectedVersion);
				created = false;
			} else {
				if (!(fs.statSync(target).mode & 0o222)) { return { ok: false, error: "This file is read-only. Your draft was not saved." }; }
				fs.accessSync(target, fs.constants.W_OK);
				fs.renameSync(temporary, target);
				created = false;
			}
			return { ok: true, version: createHash("sha256").update(text, "utf8").digest("hex") };
		} catch {
			if (wsl) {
				let intact = false;
				try { intact = createHash("sha256").update(fs.readFileSync(target)).digest("hex") === expectedVersion; } catch {}
				if (!intact) {
					return { ok: false, error: "That file could not be saved. Check the file on disk." };
				}
			}
			return { ok: false, error: "That file could not be saved. The original file was not replaced." };
		} finally {
			if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
			if (created && !keepStage) {
				try { fs.chmodSync(temporary, stat.mode | 0o200); } catch {}
				try { fs.unlinkSync(temporary); } catch {}
			}
		}
  }
	return { ok: false, error: "This file was removed from disk. Your draft was not saved." };
}

module.exports = { listFiles, readText, readImage, writeText, locateFile, isWslPath, usesWindowsAcl, stageWindowsSave, copyWslFile, DEFAULT_APP_EXT };
