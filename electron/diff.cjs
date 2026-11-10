const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { isUtf8 } = require("buffer");
const { folderProblem, resolvedEditPath, killTree, OWN_GROUP } = require("./agent.cjs");

const MAX_BYTES = 180000;
const MAX_LINES = 700;
const MAX_FILES = 40;
const MAX_UNTRACKED_BYTES = 48 * 1024;
const MAX_REVERT_BYTES = 200 * 1024;
const FILTER_NOT_OFF = "This repository's git config names a filter the app cannot turn off.";

function runGit(args, cwd, timeout = 8000, raw = false) {
  return new Promise((resolve) => {
    let settled = false;
    let truncated = false;
    let timer;
    const chunks = [];
    let size = 0;
    let err = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
			if (raw) { value.bytes = Buffer.concat(chunks); }
      resolve(value);
    };
    // A repo's own config must not start a program just because the Changes pane opened.
		// core.hooksPath stops hook files only; a hook set in config ignores it, so the event an index refresh fires is off too.
		const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", "diff.suppressBlankEmpty=false", "-c", `core.hooksPath=${os.devNull}`, "-c", "hook.post-index-change.enabled=false", ...args], { cwd, env: { ...process.env, GROK_CODE_EMPTY: "", GROK_CODE_FALSE: "false" }, ...OWN_GROUP, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (error) => {
      finish({
        code: -1,
        out: Buffer.concat(chunks).toString("utf8"),
        err: error.message,
        truncated,
        spawnError: error.code === "ENOENT",
      });
    });
    child.stdout.on("data", (buf) => {
      size += buf.length;
      if (size > MAX_BYTES) {
        truncated = true;
        killTree(child);
        return;
      }
      chunks.push(buf);
    });
    child.stderr.on("data", (buf) => {
      err += buf.toString("utf8");
      if (err.length > 2000) err = err.slice(0, 2000);
    });
    child.on("close", (code) => {
      finish({
        code: code ?? -1,
        out: Buffer.concat(chunks).toString("utf8"),
        err,
        truncated,
        spawnError: false,
      });
    });
    timer = setTimeout(() => {
      truncated = true;
      killTree(child);
		}, timeout);
  });
}

async function localFilterOff(cwd, read = (args) => runGit(args, cwd), approvedDrivers) {
	// Every key, matched here: in a UTF-8 locale (macOS, Linux) git's own --get-regexp "." skips a name that is not valid UTF-8,
	// so that driver would stay on unseen.
	const config = await read(["config", "--show-scope", "--name-only", "--list"]);
	// A cut-off listing could miss a driver, so it is refused like a name that cannot be turned off.
	if (config.code !== 0 || config.truncated) { return null; }
	const names = new Set();
	for (const line of config.out.split(/\r?\n/)) {
		// The s flag lets "." match U+2028 and U+2029, which a driver name may hold.
		const found = /^(\S+)\s+filter\.(.*)\.(?:clean|smudge|process)$/s.exec(line);
		if (found && (approvedDrivers || ["local", "worktree"].includes(found[1]))) { names.add(found[2]); }
	}
	// A name that is not valid UTF-8 decodes with U+FFFD, so --config-env would name a different driver.
	if ([...names].some((name) => name.includes("\uFFFD"))) { return null; }
	// `-c` splits at the first "=", so a driver named "a=b" would stay on; --config-env splits at the last.
	// A sandbox file revert disables every scope's drivers except those approved for its target.
	return [...names].filter((name) => !approvedDrivers?.has(name)).flatMap((name) => [
		`--config-env=filter.${name}.clean=GROK_CODE_EMPTY`,
		`--config-env=filter.${name}.smudge=GROK_CODE_EMPTY`,
		`--config-env=filter.${name}.process=GROK_CODE_EMPTY`,
		`--config-env=filter.${name}.required=GROK_CODE_FALSE`,
	]);
}

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

function unquote(text) {
	if (text.length < 2 || !text.startsWith("\"") || !text.endsWith("\"")) { return text; }
	return Buffer.concat(text.slice(1, -1).split(/(\\[0-3][0-7]{2}|\\.)/).map((part, index) => {
		if (index % 2 === 0) { return Buffer.from(part, "utf8"); }
		if (part.length === 4) { return Buffer.from([parseInt(part.slice(1), 8)]); }
		return ESCAPES[part[1]] ? Buffer.from([ESCAPES[part[1]]]) : Buffer.from(part.slice(1), "utf8");
	})).toString("utf8");
}

function gitPath(raw) {
	const text = unquote(raw.split("\t")[0]);
	if (!text || text === "/dev/null") { return ""; }
	return text.replace(/^[ab]\//, "");
}

function pairPath(text, separator) {
	const half = (text.length - separator.length) / 2;
	const name = gitPath(text.slice(half + separator.length));
	return Number.isInteger(half) && text.slice(half, half + separator.length) === separator && gitPath(text.slice(0, half)) === name ? name : "";
}

function parseNames(parts) {
	const names = [];
	let index = 0;
	while (index < parts.length - 1 && parts[index].startsWith(":")) {
		const header = parts[index++];
		const fields = header.split(" ");
		const status = fields.pop();
		const first = parts[index++];
		if (!status || !first) { break; }
		if (/^[RC]/.test(status)) {
			const next = parts[index++];
			if (!next) { break; }
			names.push({ path: next, from: first, status });
		} else {
			names.push({ path: first, status, mode: fields[0].slice(1), nextMode: fields[1], unmerged: header.startsWith("::") || status === "U" });
		}
	}
	return { names, index };
}

function parseGitDiff(text, label, inputTruncated = false, maxLines = MAX_LINES) {
	const boundary = text.indexOf("\0\0");
	const { names: inventory } = parseNames((boundary < 0 ? text : text.slice(0, boundary + 1)).split("\0"));
	const unmerged = new Set(inventory.filter((change) => change.unmerged).map((change) => change.path));
	const parsed = parseUnified(boundary < 0 ? "" : text.slice(boundary + 2), label, inventory.filter((change) => !unmerged.has(change.path)), inputTruncated, maxLines);
	if (!label && !parsed.truncated) {
		for (const change of inventory) {
			if (change.status !== "M" || !["100644", "100755"].includes(change.mode) || !["100644", "100755"].includes(change.nextMode)) { continue; }
			for (const hunk of parsed.files.find((file) => file.path === change.path)?.hunks ?? []) {
				const range = hunkRange(hunk.loc);
				if (range && hunk.lines.filter((line) => line.kind !== "add").length === range.oldCount && hunk.lines.filter((line) => line.kind !== "del").length === range.newCount) { hunk.revertible = true; }
			}
		}
	}
	for (const file of unmerged) {
		if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; break; }
		parsed.files.push({ path: file, additions: 0, deletions: 0, conflicted: true, hunks: [{ id: "", loc: "Unresolved merge conflict", reviewable: false, lines: [{ kind: "context", text: "Unresolved merge conflict. Combined conflict content is not shown here; resolve it in the editor or a Git merge tool." }] }] });
	}
	return parsed;
}

function hunkRange(loc) {
	const found = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(loc);
	return found ? { oldStart: Number(found[1]), oldCount: Number(found[2] ?? 1), newStart: Number(found[3]), newCount: Number(found[4] ?? 1) } : null;
}

function parseUnified(text, label, inventory = [], inputTruncated = false, maxLines = MAX_LINES) {
  const files = [];
	const fingerprints = new Map();
  let file = null;
  let hunk = null;
  let linesUsed = 0;
  let truncated = false;
	const finish = () => {
		const name = file && (file.plus || file.minus || file.moved || file.binary || pairPath(file.header, " "));
		if (!name) { return; }
		let found = files.find((item) => item.path === name);
		if (!found) {
			if (files.length >= MAX_FILES) {
				truncated = true;
				return;
			}
			found = { path: name, additions: 0, deletions: 0, hunks: [] };
			files.push(found);
		}
		found.additions = file.isBinary || found.additions === undefined ? undefined : found.additions + file.additions;
		found.deletions = file.isBinary || found.deletions === undefined ? undefined : found.deletions + file.deletions;
		found.hunks.push(...file.hunks);
		if (file.index) { fingerprints.set(found, file.index); }
	};
  for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
			finish();
			file = null;
			hunk = null;
			if (truncated) { break; }
			if (line.startsWith("diff --git ")) { file = { header: line.slice(11), additions: 0, deletions: 0, hunks: [] }; }
			continue;
		}
    if (!file) continue;
		if (!hunk) {
			if (line.startsWith("index ")) {
				file.index = line;
			} else if (line.startsWith("+++ ")) {
				file.plus = gitPath(line.slice(4));
			} else if (line.startsWith("--- ")) {
				file.minus = gitPath(line.slice(4));
			} else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
				file.moved = unquote(line.slice(line.indexOf(" to ") + 4));
			} else if (line.startsWith("Binary files ")) {
				file.isBinary = true;
				const pair = line.slice(13).replace(/ differ$/, "");
				file.binary = pair.startsWith("/dev/null and ") ? gitPath(pair.slice(14)) : pairPath(pair, " and ");
				file.hunks.push({ id: file.index || "", loc: label || "Binary", lines: [{ kind: "context", text: "Binary file" }] });
			}
		}
    if (line.startsWith("@@")) {
      if (linesUsed >= maxLines) {
        truncated = true;
        break;
      }
      hunk = { id: "", loc: label ? `${label} ${line}` : line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    if (linesUsed >= maxLines) {
      truncated = true;
      break;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1) });
      file.additions += 1;
      linesUsed += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1) });
      file.deletions += 1;
      linesUsed += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1) });
      linesUsed += 1;
    }
  }
	finish();
	for (const change of inventory) {
		let item = files.find((entry) => entry.path === change.path);
		if (!item) {
			if (files.length >= MAX_FILES) { truncated = true; break; }
			item = { path: change.path, additions: 0, deletions: 0, hunks: [] };
			files.push(item);
		}
		if (change.from) { item.from = change.from; }
		if (!item.hunks.length) {
			const detail = change.from ? `Renamed from ${change.from}` : (truncated || inputTruncated ? "Diff content was left out." : "File metadata changed.");
			item.hunks.push({ id: fingerprints.get(item) || "", loc: label || "Change", lines: [{ kind: "context", text: detail }] });
		}
	}
	return { files: files.filter((item) => item.path && item.hunks.length > 0), truncated: truncated || inputTruncated };
}

function parseNumstat(text) {
	const parts = text.split("\0");
	const counts = new Map();
	for (let index = 0; index < parts.length - 1;) {
		const entry = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[index++]);
		if (!entry) { continue; }
		let file = entry[3];
		if (!file) {
			index += 1;
			file = parts[index++];
		}
		if (file && entry[1] !== "-" && entry[2] !== "-") {
			counts.set(file, { additions: Number(entry[1]), deletions: Number(entry[2]) });
		}
	}
	return counts;
}

function parseInventory(text) {
	const parts = text.split("\0");
	const { names, index } = parseNames(parts);
	const counts = parseNumstat(parts.slice(index).join("\0"));
	const files = new Map();
	for (const change of names) {
		const { path, from } = change;
		const previous = files.get(path);
		files.set(path, {
			path, ...(from || previous?.from ? { from: from || previous.from } : {}),
			...counts.get(path), hunks: [], ...(change.unmerged || previous?.conflicted ? { conflicted: true } : {}),
		});
	}
	return [...files.values()];
}

function mergeFiles(into, files) {
	const byPath = new Map(into.map((file) => [file.path, file]));
  for (const file of files) {
    const found = byPath.get(file.path);
    if (!found) {
      into.push(file);
			byPath.set(file.path, file);
      continue;
    }
		// A staged rename with unstaged edits arrives twice; only the staged half knows the old path.
		if (file.from && !found.from) { found.from = file.from; }
		if (found.conflicted || file.conflicted) {
			if (file.conflicted) { Object.assign(found, file); }
			continue;
		}
		found.additions = found.additions === undefined || file.additions === undefined ? undefined : found.additions + file.additions;
		found.deletions = found.deletions === undefined || file.deletions === undefined ? undefined : found.deletions + file.deletions;
    found.hunks.push(...file.hunks);
  }
}

function assignIds(files) {
	for (const file of files) {
		for (const hunk of file.hunks) {
			const hash = createHash("sha256").update(JSON.stringify([file.path, hunk.id, hunk.loc, hunk.lines])).digest("hex");
			hunk.id = `${file.path}:${hash}`;
		}
	}
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function displayPath(toplevel, folder, gitRelative) {
  const absolute = path.resolve(toplevel, gitRelative);
  const relative = path.relative(folder, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/");
}

function untrackedHunk(folder, absolute, maxBytes = MAX_UNTRACKED_BYTES, maxLines = 80) {
  let target = absolute;
  try {
    target = fs.realpathSync(absolute);
  } catch {
		return { additions: 0, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This file could not be read." }] } };
  }
  if (!inside(fs.realpathSync(folder), target)) return null;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
		return { additions: 0, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This file could not be read." }] } };
  }
  if (!stat.isFile()) return null;
  absolute = target;
	const tooLarge = () => ({ additions: 0, truncated: true, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This new file is too large to show here." }] } });
	if (stat.size > maxBytes) { return tooLarge(); }
	let buf;
	try {
		const descriptor = fs.openSync(absolute, "r");
		try {
			const buffer = Buffer.alloc(maxBytes + 1);
			let size = 0;
			while (size < buffer.length) {
				const read = fs.readSync(descriptor, buffer, size, buffer.length - size, size);
				if (!read) { break; }
				size += read;
			}
			if (size > maxBytes) { return tooLarge(); }
			buf = buffer.subarray(0, size);
		} finally { fs.closeSync(descriptor); }
	} catch {
		return { additions: 0, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This file could not be read." }] } };
	}
	const fingerprint = createHash("sha256").update(buf).digest("hex");
  if (buf.includes(0)) {
		return { additions: 0, hunk: { id: fingerprint, loc: "New file", lines: [{ kind: "context", text: "Binary file" }] } };
  }
  const body = buf.toString("utf8").replace(/\n$/, "");
  const all = body.length ? body.split(/\r?\n/) : [];
  const shown = all.slice(0, maxLines);
  const lines = shown.map((text) => ({ kind: "add", text }));
  if (shown.length < all.length) lines.push({ kind: "context", text: "Further lines were left out." });
	return { additions: shown.length, truncated: shown.length < all.length, hunk: { id: fingerprint, loc: "New file", lines } };
}

async function readDiff(cwd) {
  const problem = folderProblem(cwd);
  if (problem) return { ok: false, error: problem };
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.spawnError) return { ok: false, error: "Git is not available in this window." };
  if (probe.code !== 0 || probe.out.trim() !== "true") return { ok: true, repo: false, files: [] };

  const top = await runGit(["rev-parse", "--show-toplevel"], cwd);
	const toplevel = fs.realpathSync(top.code === 0 ? top.out.trim() : cwd);
	const folder = fs.realpathSync(cwd);
  let spec = path.relative(toplevel, folder);
  if (!spec) spec = ".";
  else spec = spec.split(path.sep).join("/");
  if (spec.startsWith("..") || path.isAbsolute(spec)) return { ok: true, repo: true, truncated: false, files: [] };
	const filterOff = await localFilterOff(cwd);
	if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
	// A dirty-submodule check runs git status inside the submodule, which loads that submodule's own filters.
	const diffArgs = [...filterOff, "--literal-pathspecs", "-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=dirty"];
	const [unstaged, staged] = await Promise.all([
		runGit([...diffArgs, "--raw", "-z", "-p", "-U3", "--", spec], toplevel),
		runGit([...diffArgs, "--cached", "--raw", "-z", "-p", "-U3", "--", spec], toplevel),
	]);
	for (const result of [unstaged, staged]) {
		if (result.code !== 0 && !result.truncated) { return { ok: false, error: "The working tree diff could not be read." }; }
	}
	const parsedUnstaged = parseGitDiff(unstaged.out, "", unstaged.truncated);
	const parsedStaged = parseGitDiff(staged.out, "Staged", staged.truncated);
	await Promise.all([[parsedUnstaged, []], [parsedStaged, ["--cached"]]].map(async ([parsed, stagedArgs]) => {
		if (!parsed.truncated) { return; }
		const result = await runGit([...diffArgs, ...stagedArgs, "--numstat", "-z", "--", spec], toplevel);
		const counts = result.code === 0 && !result.truncated ? parseNumstat(result.out) : new Map();
		for (const file of parsed.files) {
			const count = counts.get(file.path);
			file.additions = count?.additions;
			file.deletions = count?.deletions;
		}
	}));
  const files = [];
  mergeFiles(files, parsedUnstaged.files);
  mergeFiles(files, parsedStaged.files);

	let truncated = unstaged.truncated || staged.truncated || parsedUnstaged.truncated || parsedStaged.truncated;
  const listed = await runGit(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z", "--", spec], toplevel);
  if (listed.truncated) truncated = true;
	const names = listed.out.split("\0").filter(Boolean);
  for (const name of names) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const absolute = path.resolve(toplevel, name);
    if (!inside(folder, absolute)) continue;
    if (files.some((file) => file.path === name)) continue;
    const built = untrackedHunk(folder, absolute);
    if (!built) continue;
    files.push({ path: name, additions: built.additions, deletions: 0, hunks: [built.hunk] });
  }

  const visible = [];
  for (const file of files) {
    const shown = displayPath(toplevel, folder, file.path);
    if (!shown) continue;
    // A rename keeps its old path, so a commit of the file can name both; an old path outside this folder is dropped.
    const from = file.from ? displayPath(toplevel, folder, file.from) : "";
    const entry = { ...file, path: shown };
    if (from) { entry.from = from; } else { delete entry.from; }
    visible.push(entry);
  }
	await checkRevertible(cwd, folder, visible);
  assignIds(visible);
  return { ok: true, repo: true, truncated, files: visible };
}

async function checkRevertible(cwd, folder, files, read = (args) => runGit(args, cwd)) {
	const candidates = files.filter((file) => file.hunks.some((hunk) => hunk.revertible));
	if (candidates.length) {
		const attributes = await read(["--literal-pathspecs", "check-attr", "-z", "filter", "--", ...candidates.map((file) => file.path)]);
		const values = attributes.out.split("\0");
		const filtered = new Set();
		for (let index = 0; index + 2 < values.length; index += 3) { if (!["unspecified", "unset"].includes(values[index + 2])) { filtered.add(values[index]); } }
		for (const file of candidates) {
			let supported = attributes.code === 0 && !attributes.truncated && !filtered.has(file.path);
			try {
				const target = fs.realpathSync(path.resolve(folder, file.path));
				const stat = fs.statSync(target);
				supported = supported && inside(folder, target) && stat.isFile() && stat.size <= MAX_REVERT_BYTES;
			} catch { supported = false; }
			if (!supported) { for (const hunk of file.hunks) { delete hunk.revertible; } }
		}
	}
}

function fileInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function revertFilterState(cwd, file) {
	const args = ["-z", "--all", "--", file];
	const read = (extra = []) => runGit(["--literal-pathspecs", "check-attr", ...extra, ...args], cwd);
	const working = await read();
	// Restoring .gitattributes can make Git read the replacement from the index during checkout.
	const head = path.basename(file) === ".gitattributes" ? await read(["--source=HEAD"]) : null;
	if (working.code !== 0 || working.truncated || head?.truncated || (head && ![0, 129].includes(head.code))) { return null; }
	const filters = [working, head].map((result) => {
		const values = (result?.out ?? "").split("\0");
		for (let index = 0; index + 2 < values.length; index += 3) {
			if (values[index + 1] === "filter") { return values[index + 2]; }
		}
		return null;
	});
	const unknown = head?.code === 129;
	if (!unknown && filters.every((filter) => filter === null)) { return { needsApproval: false }; }
	const config = await runGit(["config", "--null", "--get-regexp", "^filter\\."], cwd, 8000, true);
	if (config.truncated || ![0, 1].includes(config.code)) { return null; }
	// Git prints both -filter and filter=unset as "unset".
	const programs = config.out.split("\0").filter((entry) => /\.(?:clean|smudge|process)\n[\s\S]/.test(entry));
	if (unknown && programs.length > 0) { return null; }
	const needsApproval = filters.some((filter) => filter !== null && filter !== "unset")
		|| (filters.includes("unset") && programs.some((entry) => entry.startsWith("filter.unset.")));
	return { needsApproval, drivers: filters.filter((filter) => filter !== null), signature: JSON.stringify(filters), config: config.bytes };
}

async function revertFile(cwd, relative, confirmFilter) {
  const problem = folderProblem(cwd);
  if (problem) return { ok: false, error: problem };
  if (typeof relative !== "string" || !relative.trim() || /[\0\r\n]/.test(relative)) {
    return { ok: false, error: "Choose a file in this folder." };
  }
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.spawnError) return { ok: false, error: "Git is not available in this window." };
  if (probe.code !== 0 || probe.out.trim() !== "true") return { ok: false, error: "This folder is not a git checkout." };
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0 || !top.out.trim()) return { ok: false, error: "This folder is not a git checkout." };
	const toplevel = fs.realpathSync(top.out.trim());
	const folder = fs.realpathSync(cwd);
  const absolute = path.resolve(folder, relative);
  if (!fileInside(folder, absolute)) return { ok: false, error: "That file is not in this folder." };
  if (fs.existsSync(absolute)) {
    let root;
    let target;
    try {
      root = fs.realpathSync(folder);
      target = fs.realpathSync(absolute);
    } catch {
      return { ok: false, error: "That file is not in this folder." };
    }
    if (!fileInside(root, target)) return { ok: false, error: "That file is not in this folder." };
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return { ok: false, error: "That file is not in this folder." };
    }
    if (!stat.isFile()) return { ok: false, error: "That path is not a file." };
  }
  const gitRelative = path.relative(toplevel, absolute).split(path.sep).join("/");
  if (!gitRelative || gitRelative.startsWith("..") || path.isAbsolute(gitRelative)) {
    return { ok: false, error: "That file is not in this folder." };
  }
	const tracked = await runGit(["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", gitRelative], toplevel);
	if (tracked.code !== 0 || !tracked.out.split("\0").includes(gitRelative)) {
		return { ok: false, error: "This file is new. Revert does not delete it." };
	}
	let filterOff = [];
	if (confirmFilter) {
		let approvedDrivers = new Set();
		const before = await revertFilterState(toplevel, gitRelative);
		if (!before) { return { ok: false, error: "This file's Git filter could not be checked." }; }
		if (before.needsApproval) {
			if (!await confirmFilter()) { return { ok: false, error: "Revert cancelled." }; }
			const after = await revertFilterState(toplevel, gitRelative);
			if (!after?.needsApproval || before.signature !== after.signature || !before.config.equals(after.config)) {
				return { ok: false, error: "Git filter settings changed while you were confirming. Try reverting again." };
			}
			approvedDrivers = new Set(after.drivers);
		}
		filterOff = await localFilterOff(toplevel, undefined, approvedDrivers);
		if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
	}
	try {
		if (!fileInside(fs.realpathSync(folder), resolvedEditPath(absolute))) { return { ok: false, error: "That file is not in this folder." }; }
	} catch {
		return { ok: false, error: "That file is not in this folder." };
	}
	const restored = await runGit([...filterOff, "--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", gitRelative], toplevel, 60000);
	if (restored.truncated) { return { ok: false, error: "Git took too long and was stopped. The file may be partly restored; check it before trying again." }; }
  if (restored.code !== 0) return { ok: false, error: "That file could not be restored." };
  return { ok: true };
}

async function revertHunk(cwd, relative, input) {
	const { locateFile, readText, writeText } = require("./files.cjs");
	const located = locateFile(cwd, relative);
	if (!located.ok) { return { ok: false, error: located.error }; }
	const stale = { ok: false, error: "This change is no longer in the file. Refresh, then try again." };
	if (!input || typeof input.id !== "string" || typeof input.loc !== "string" || !Array.isArray(input.lines)) { return stale; }
	const filterOff = await localFilterOff(cwd);
	if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
	const attributes = await runGit(["--literal-pathspecs", "check-attr", "-z", "filter", "--", relative], cwd);
	if (attributes.code !== 0 || attributes.truncated) { return { ok: false, error: "This file's Git attributes could not be checked." }; }
	if (!["unspecified", "unset"].includes(attributes.out.split("\0")[2])) { return { ok: false, error: "This file uses a Git filter. Revert it from a terminal." }; }
	const current = await require("./git.cjs").readChanges({ cwd, scope: "uncommitted", file: relative, full: true });
	if (!current.ok) { return { ok: false, error: current.error }; }
	const file = current.files?.find((entry) => entry.path === relative);
	const hunk = file?.hunks.find((entry) => entry.revertible === true && entry.id === input.id && entry.loc === input.loc && entry.lines.length === input.lines.length && entry.lines.every((line, index) => line.kind === input.lines[index]?.kind && line.text === input.lines[index]?.text));
	if (!hunk) { return stale; }
	const working = readText(cwd, relative);
	if (!working.ok) { return { ok: false, error: working.error }; }
	if (working.binary) { return { ok: false, error: "This change cannot be reverted on its own." }; }
	const index = await runGit(["--literal-pathspecs", "show", `:./${relative}`], cwd, 8000, true);
	if (index.code !== 0 || index.truncated || index.out.includes("\0")) { return { ok: false, error: "The file's index content could not be read." }; }
	if (!isUtf8(index.bytes)) { return { ok: false, error: "The file's index content is not valid UTF-8. Revert it from a terminal." }; }
	const split = (text) => (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => {
		const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
		return { raw, text: raw.slice(0, raw.length - ending.length), ending };
	});
	const now = split(working.text);
	const before = split(index.out);
	const endings = [...new Set(now.map((line) => line.ending).filter(Boolean))];
	const range = hunkRange(hunk.loc);
	let oldAt = range.oldCount === 0 ? range.oldStart : range.oldStart - 1;
	let newAt = range.newCount === 0 ? range.newStart : range.newStart - 1;
	const start = newAt;
	const replacement = [];
	for (const line of hunk.lines) {
		if (line.kind !== "add" && before[oldAt]?.text !== line.text) { return stale; }
		if (line.kind !== "del" && now[newAt]?.text !== line.text) { return stale; }
		if (line.kind === "context") {
			replacement.push(now[newAt].raw);
		} else if (line.kind === "del") {
			const original = before[oldAt];
			replacement.push(`${original.text}${original.ending ? endings.length === 1 ? endings[0] : original.ending : ""}`);
		}
		if (line.kind !== "add") { oldAt++; }
		if (line.kind !== "del") { newAt++; }
	}
	const text = `${now.slice(0, start).map((line) => line.raw).join("")}${replacement.join("")}${now.slice(newAt).map((line) => line.raw).join("")}`;
	if (text === working.text) { return { ok: false, error: "This change cannot be reverted on its own. Use Revert file instead." }; }
	return writeText(cwd, relative, text, working.version);
}

module.exports = { readDiff, parseUnified, parseGitDiff, parseInventory, mergeFiles, assignIds, untrackedHunk, checkRevertible, revertFile, revertHunk, localFilterOff, FILTER_NOT_OFF };
