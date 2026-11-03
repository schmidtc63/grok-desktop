const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { folderProblem, resolvedEditPath, killTree } = require("./agent.cjs");

const MAX_BYTES = 180000;
const MAX_LINES = 700;
const MAX_FILES = 40;
const MAX_UNTRACKED_BYTES = 48 * 1024;
const FILTER_NOT_OFF = "This repository's git config names a filter the app cannot turn off.";

function runGit(args, cwd, timeout = 8000) {
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
      resolve(value);
    };
    // A repo's own config must not start a program just because the Changes pane opened.
		// core.hooksPath stops hook files only; a hook set in config ignores it, so the event an index refresh fires is off too.
		const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", "diff.suppressBlankEmpty=false", "-c", `core.hooksPath=${os.devNull}`, "-c", "hook.post-index-change.enabled=false", ...args], { cwd, env: { ...process.env, GROK_CODE_EMPTY: "", GROK_CODE_FALSE: "false" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function localFilterOff(cwd) {
	const config = await runGit(["config", "--show-scope", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], cwd);
	// A cut-off listing could miss a driver, so it is refused like a name that cannot be turned off.
	if (config.truncated) { return null; }
	const names = new Set();
	for (const line of config.out.split(/\r?\n/)) {
		// The s flag lets "." match U+2028 and U+2029, which a driver name may hold.
		const found = /^(?:local|worktree)\s+filter\.(.*)\.(?:clean|smudge|process)$/s.exec(line);
		if (found) { names.add(found[1]); }
	}
	// A name that is not valid UTF-8 decodes with U+FFFD, so --config-env would name a different driver.
	if ([...names].some((name) => name.includes("\uFFFD"))) { return null; }
	// `-c` splits at the first "=", so a driver named "a=b" would stay on; --config-env splits at the last.
	return [...names].flatMap((name) => [
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

function parseNames(text) {
	const parts = text.split("\0");
	const names = [];
	for (let index = 0; index < parts.length - 1;) {
		const header = parts[index++];
		const status = header.split(" ").pop();
		const first = parts[index++];
		if (!status || !first) { break; }
		if (/^[RC]/.test(status)) {
			const next = parts[index++];
			if (!next) { break; }
			names.push({ path: next, from: first, status });
		} else {
			names.push({ path: first, status, unmerged: header.startsWith("::") || status === "U" });
		}
	}
	return names;
}

function parseGitDiff(text, label, inputTruncated = false) {
	const boundary = text.indexOf("\0\0");
	const inventory = parseNames(boundary < 0 ? text : text.slice(0, boundary + 1));
	const unmerged = new Set(inventory.filter((change) => change.unmerged).map((change) => change.path));
	const parsed = parseUnified(boundary < 0 ? "" : text.slice(boundary + 2), label, inventory.filter((change) => !unmerged.has(change.path)), inputTruncated);
	for (const file of unmerged) {
		if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; break; }
		parsed.files.push({ path: file, additions: 0, deletions: 0, conflicted: true, hunks: [{ id: "", loc: "Unresolved merge conflict", reviewable: false, lines: [{ kind: "context", text: "Unresolved merge conflict. Combined conflict content is not shown here; resolve it in the editor or a Git merge tool." }] }] });
	}
	return parsed;
}

function parseUnified(text, label, inventory = [], inputTruncated = false) {
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
      if (linesUsed >= MAX_LINES) {
        truncated = true;
        break;
      }
      hunk = { id: "", loc: label ? `${label} ${line}` : line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    if (linesUsed >= MAX_LINES) {
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

function mergeFiles(into, files) {
  for (const file of files) {
    const found = into.find((item) => item.path === file.path);
    if (!found) {
      into.push(file);
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
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(toplevel, folder, gitRelative) {
  const absolute = path.resolve(toplevel, gitRelative);
  const relative = path.relative(folder, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/");
}

function untrackedHunk(folder, absolute) {
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
  if (stat.size > MAX_UNTRACKED_BYTES) {
		return { additions: 0, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This new file is too large to show here." }] } };
  }
	let buf;
	try {
		buf = fs.readFileSync(absolute);
	} catch {
		return { additions: 0, hunk: { id: "", loc: "New file", reviewable: false, lines: [{ kind: "context", text: "This file could not be read." }] } };
	}
	const fingerprint = createHash("sha256").update(buf).digest("hex");
  if (buf.includes(0)) {
		return { additions: 0, hunk: { id: fingerprint, loc: "New file", lines: [{ kind: "context", text: "Binary file" }] } };
  }
  const body = buf.toString("utf8").replace(/\n$/, "");
  const all = body.length ? body.split(/\r?\n/) : [];
  const shown = all.slice(0, 80);
  const lines = shown.map((text) => ({ kind: "add", text }));
  if (shown.length < all.length) lines.push({ kind: "context", text: "Further lines were left out." });
	return { additions: shown.length, hunk: { id: fingerprint, loc: "New file", lines } };
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
  assignIds(visible);
  return { ok: true, repo: true, truncated, files: visible };
}

function fileInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function revertFile(cwd, relative) {
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
	const tracked = await runGit(["--literal-pathspecs", "ls-tree", "--name-only", "-z", "HEAD", "--", gitRelative], toplevel);
	if (tracked.code !== 0 || !tracked.out.split("\0").includes(gitRelative)) {
		return { ok: false, error: "This file is new. Revert does not delete it." };
	}
	try {
		if (!fileInside(fs.realpathSync(folder), resolvedEditPath(absolute))) { return { ok: false, error: "That file is not in this folder." }; }
	} catch {
		return { ok: false, error: "That file is not in this folder." };
	}
	const restored = await runGit(["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", gitRelative], toplevel, 60000);
	if (restored.truncated) { return { ok: false, error: "Git took too long and was stopped. The file may be partly restored; check it before trying again." }; }
  if (restored.code !== 0) return { ok: false, error: "That file could not be restored." };
  return { ok: true };
}

module.exports = { readDiff, parseUnified, revertFile, localFilterOff, FILTER_NOT_OFF };
