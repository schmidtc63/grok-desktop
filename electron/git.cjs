const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { URL } = require("url");
const { folderProblem, killTree, OWN_GROUP } = require("./agent.cjs");
const { readDiff, parseUnified, parseGitDiff: parseWorkingDiff, parseInventory, mergeFiles, assignIds, untrackedHunk, checkRevertible, localFilterOff, FILTER_NOT_OFF } = require("./diff.cjs");

const GIT_TIMEOUT = 20000;
const SLOW_TIMEOUT = 60000;
const MAX_BYTES = 180000;
const MAX_FILES = 40;
const CHANGE_LIST_BYTES = 2 * 1024 * 1024;
const CHANGE_LIST_FILES = 5000;
const FULL_DIFF_BYTES = 2 * 1024 * 1024;
const FULL_DIFF_LINES = 6000;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_ENTRIES = 512;
const NOT_REPO = "This folder is not a git checkout.";
const GH_MISSING = "GitHub CLI (gh) is not installed.";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const EXCLUDE_LINE = ".grok/worktrees/";
const committing = new Set();
const HOST_WRITE_HOOKS = [
	"pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "pre-push", "post-checkout", "reference-transaction", "pre-auto-gc",
	"pre-receive", "update", "proc-receive", "post-receive", "post-update", "push-to-checkout",
];
// A dirty-submodule check runs git status inside the submodule, which loads that submodule's own filters.
const DIFF_READ_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=dirty", "--relative", "--raw", "-z"];
const DIFF_ARGS = [...DIFF_READ_ARGS, "-p", "-U3"];
const CHECK_STATES = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", CANCELLED: "fail", TIMED_OUT: "fail", ACTION_REQUIRED: "fail", STARTUP_FAILURE: "fail", NEUTRAL: "skip", SKIPPED: "skip", STALE: "skip", IN_PROGRESS: "run" };

function stop(child) {
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
	} else {
		killTree(child);
	}
}

function run(command, args, cwd, timeout, maxBytes = MAX_BYTES, options = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let size = 0;
		let err = "";
		const chunks = [];
		const result = (extra) => ({ code: -1, out: Buffer.concat(chunks).toString(options.encoding ?? "utf8"), err, truncated: size > maxBytes, timedOut: false, missing: false, ...extra });
		const signal = options.signal;
		if (signal?.aborted) { resolve(result()); return; }
		const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GROK_CODE_EMPTY: "", GROK_CODE_FALSE: "false", ...options.env };
		let child;
		try {
			child = spawn(command, args, { ...OWN_GROUP, cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve(result({ err: error.message }));
			return;
		}
		const timer = setTimeout(() => {
			stop(child);
			finish(result({ timedOut: true }));
		}, timeout);
		const finish = (value) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = () => { stop(child); finish(result()); };
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			finish(result({ err: error.message, missing: error.code === "ENOENT" }));
		});
		child.stdout.on("data", (buf) => {
			if (settled || size > maxBytes) { return; }
			size += buf.length;
			if (size > maxBytes) {
				stop(child);
				return;
			}
			chunks.push(buf);
		});
		child.stderr.on("data", (buf) => {
			err = `${err}${buf.toString("utf8")}`.slice(-4000);
		});
		child.on("close", (code) => {
			finish(result({ code: code === null ? -1 : code }));
		});
	});
}

// A repo's own core.fsmonitor program never runs from here.
// core.hooksPath stops hook files only; a hook set in config ignores it, so the event an index refresh fires is off too.
function git(args, cwd, timeout = GIT_TIMEOUT, options = {}) {
	const hookArgs = options.hooks ? [] : ["-c", `core.hooksPath=${os.devNull}`, "-c", "hook.post-index-change.enabled=false"];
	if (options.hooks === false) {
		for (const hook of HOST_WRITE_HOOKS) { hookArgs.push("-c", `hook.${hook}.enabled=false`); }
	}
	return run("git", ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "diff.suppressBlankEmpty=false", ...hookArgs, ...args], cwd, timeout, options.maxBytes, options);
}

// Tracked and untracked files, relative to cwd; ignored and deleted files are left out.
async function repoFiles(cwd) {
	const [listed, deleted] = await Promise.all([
		git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd, 10000, { maxBytes: 2 * 1024 * 1024 }),
		git(["ls-files", "--deleted", "-z"], cwd, 10000, { maxBytes: 2 * 1024 * 1024 }),
	]);
	if ((listed.code !== 0 && !listed.truncated) || deleted.code !== 0) { return null; }
	const entries = listed.out.split("\0");
	if (listed.truncated || !listed.out.endsWith("\0")) { entries.pop(); }
	const gone = new Set(deleted.out.split("\0").filter(Boolean));
	const files = [...new Set(entries)].filter((file) => file && !file.endsWith("/") && !gone.has(file));
	return files.length ? { files, truncated: listed.truncated } : null;
}

function gh(args, cwd, options) {
	return run("gh", args, cwd, SLOW_TIMEOUT, MAX_BYTES, options);
}

async function prRepository(cwd, target) {
	const args = ["repo", "view", "--json", "id,nameWithOwner,url,defaultBranchRef"];
	let env;
	if (target) {
		const remotes = await git(["remote"], cwd);
		if (remotes.code !== 0 || remotes.truncated) { return failure(remotes, "Reading Git remotes"); }
		const names = remotes.out.split(/\r?\n/).filter(Boolean);
		let selected = "grok-pr-target";
		while (names.includes(selected)) { selected += "-"; }
		const config = [];
		for (const name of names) {
			config.push([`remote.${name}.gh-resolved`, ""]);
		}
		config.push([`remote.${selected}.url`, target], [`remote.${selected}.gh-resolved`, "base"]);
		const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
		const parameters = config.map(([key, value]) => `${quote(key)}=${quote(value)}`).join(" ");
		env = { GH_REPO: "", GIT_CONFIG_PARAMETERS: `${process.env.GIT_CONFIG_PARAMETERS || ""} ${parameters}`.trim() };
	}
	const result = await gh(args, cwd, { env });
	if (result.missing) { return { ok: false, error: GH_MISSING }; }
	if (result.code !== 0) { return failure(result, "GitHub CLI"); }
	try {
		const repository = JSON.parse(result.out);
		const url = new URL(repository.url);
		if (typeof repository.id !== "string" || !repository.id || typeof repository.nameWithOwner !== "string" || !["https:", "http:"].includes(url.protocol) || url.pathname.replace(/\/$/, "").toLowerCase() !== `/${repository.nameWithOwner}`.toLowerCase()) { throw new Error(); }
		return { ok: true, repository: { ...repository, host: url.host } };
	} catch {
		return { ok: false, error: "GitHub did not return the repository details." };
	}
}

function failure(result, what) {
	if (result.timedOut) { return { ok: false, error: `${what} timed out.` }; }
	const line = result.err.split(/\r?\n/).map((text) => text.trim()).filter((text) => text && !/^warning:/i.test(text)).find((text, index, lines) => /^(fatal|error):/i.test(text) || (what === "GitHub CLI" && /^To get started with GitHub CLI,.*\bgh auth login\b/.test(text)) || index === lines.length - 1) || `${what} failed.`;
	return { ok: false, error: line.replace(/^(fatal|error):\s*/i, "").slice(0, 300) };
}

async function repoProblem(cwd) {
	const problem = folderProblem(cwd);
	if (problem) { return problem; }
	const probe = await git(["rev-parse", "--is-inside-work-tree"], cwd);
	if (probe.missing) { return "Git is not available in this window."; }
	if (probe.timedOut) { return "Git timed out."; }
	return probe.code === 0 && probe.out.trim() === "true" ? "" : NOT_REPO;
}

async function fingerprintGitPath(file, hash, budget, depth = 0) {
	if (--budget.entries < 0 || depth > 12) { throw new Error("Git snapshot is too large"); }
	let info;
	try {
		info = await fs.promises.lstat(file);
	} catch (error) {
		if (depth === 0 && error.code === "ENOENT") { hash.update(`${file}\0missing\0`); return; }
		throw error;
	}
	hash.update(`${file}\0${info.mode}\0`);
	if (info.isSymbolicLink()) {
		hash.update(`${await fs.promises.readlink(file)}\0`);
		info = await fs.promises.stat(file);
		hash.update(`${info.mode}\0`);
	}
	if (info.isDirectory()) {
		const children = [];
		for await (const entry of await fs.promises.opendir(file)) {
			if (children.length >= budget.entries) { throw new Error("Git snapshot is too large"); }
			children.push(entry.name);
		}
		for (const name of children.sort()) { await fingerprintGitPath(path.join(file, name), hash, budget, depth + 1); }
		const after = await fs.promises.stat(file);
		if (after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) { throw new Error("Git directory changed during the snapshot"); }
		return;
	}
	if (!info.isFile() || info.size > budget.bytes) { throw new Error("Git path cannot be fingerprinted"); }
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.ino !== info.ino || before.size > budget.bytes) { throw new Error("Git file changed during the snapshot"); }
		const content = Buffer.alloc(before.size + 1);
		const { bytesRead } = await handle.read(content, 0, content.length, 0);
		const after = await handle.stat();
		if (bytesRead !== before.size || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) { throw new Error("Git file changed during the snapshot"); }
		hash.update(`${before.mode}\0${bytesRead}\0`).update(content.subarray(0, bytesRead));
		budget.bytes -= bytesRead;
	} finally {
		await handle.close();
	}
}

function upstreamSnapshot(top, commonConfig, effective, base) {
	const entries = effective.split("\0");
	return (branch) => {
		const encode = (value) => Buffer.from(value).toString("latin1");
		const remote = encode(`branch.${branch}.remote`);
		const merge = encode(`branch.${branch}.merge`);
		const hash = createHash("sha256").update(base);
		const expected = new Set();
		let ignored = 0;
		for (let index = 0; index + 1 < entries.length; index += 2) {
			const [origin, entry] = [entries[index], entries[index + 1]];
			const key = entry.split("\n", 1)[0];
			if ((key === remote || key === merge) && origin.startsWith("file:") &&
				path.relative(commonConfig, path.resolve(top, Buffer.from(origin.slice(5), "latin1").toString("utf8"))) === "") {
				ignored += 1;
				if (entry === (key === remote ? `${remote}\norigin` : `${merge}\n${encode(`refs/heads/${branch}`)}`)) { expected.add(key); }
			} else {
				hash.update(`${origin}\0${entry}\0`, "latin1");
			}
		}
		return { config: hash.digest("hex"), established: ignored === 2 && expected.size === 2 };
	};
}

async function gitSecuritySnapshot(cwd, compareUpstream = false) {
	const unavailable = { ok: false, error: "The repository's Git config and hooks could not be checked." };
	if (await repoProblem(cwd)) { return unavailable; }
	const [paths, effective] = await Promise.all([
		git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", "config.worktree", "--git-path", "hooks", "--show-toplevel"], cwd, GIT_TIMEOUT, { hooks: true }),
		git(["config", "--includes", "--null", "--show-origin", "--list"], cwd, GIT_TIMEOUT, { hooks: true, maxBytes: SNAPSHOT_BYTES, encoding: "latin1" }),
	]);
	const [common, worktree, configuredHooks, top, extra] = paths.out.replace(/\r?\n$/, "").split(/\r?\n/);
	if (paths.code !== 0 || paths.truncated || effective.code !== 0 || effective.truncated || extra !== undefined || ![common, worktree, configuredHooks, top].every((entry) => entry && path.isAbsolute(entry))) { return unavailable; }
	const budget = { bytes: SNAPSHOT_BYTES - effective.out.length, entries: SNAPSHOT_ENTRIES };
	const config = createHash("sha256").update(effective.out, "latin1");
	const hooks = createHash("sha256");
	try {
		const commonConfig = path.join(common, "config");
		for (const file of [commonConfig, worktree]) { await fingerprintGitPath(file, config, budget); }
		for (const folder of new Set([path.join(common, "hooks"), path.resolve(configuredHooks)])) { await fingerprintGitPath(folder, hooks, budget); }
		const result = { ok: true, config: config.digest("hex"), hooks: hooks.digest("hex") };
		if (compareUpstream) {
			const info = await fs.promises.lstat(commonConfig);
			if (info.isFile()) {
				const base = createHash("sha256").update(`${await fs.promises.realpath(commonConfig)}\0${info.mode}\0`);
				await fingerprintGitPath(worktree, base, { bytes: SNAPSHOT_BYTES, entries: SNAPSHOT_ENTRIES });
				result.upstream = upstreamSnapshot(top, commonConfig, effective.out, base.digest("hex"));
			}
		}
		return result;
	} catch {
		return unavailable;
	}
}

async function currentBranch(cwd) {
	const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (head.code === 0) { return head.out.trim(); }
	return (await git(["branch", "--show-current"], cwd)).out.trim();
}

async function resolveBase(cwd, read = (args) => git(args, cwd)) {
	const remote = await read(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	const ref = remote.out.trim();
	if (remote.code === 0 && ref.startsWith("refs/remotes/origin/") && (await read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) {
		return { name: ref.slice("refs/remotes/origin/".length), ref };
	}
	for (const local of ["main", "master"]) {
		if ((await read(["rev-parse", "--verify", "--quiet", `refs/heads/${local}`])).code === 0) { return { name: local, ref: `refs/heads/${local}` }; }
	}
	return null;
}

// Copied from diff.cjs: raw -z inventory plus unified patch parsing.
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

function parseGitDiff(text, label) {
	const boundary = text.indexOf("\0\0");
	const inventory = parseNames(boundary < 0 ? text : text.slice(0, boundary + 1));
	const unmerged = new Set(inventory.filter((change) => change.unmerged).map((change) => change.path));
	const parsed = parseUnified(boundary < 0 ? "" : text.slice(boundary + 2), label, inventory.filter((change) => !unmerged.has(change.path)));
	for (const file of unmerged) {
		if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; break; }
		parsed.files.push({ path: file, additions: 0, deletions: 0, conflicted: true, hunks: [{ id: "", loc: "Unresolved merge conflict", reviewable: false, lines: [{ kind: "context", text: "Unresolved merge conflict. Combined conflict content is not shown here; resolve it in the editor or a Git merge tool." }] }] });
	}
	return parsed;
}

async function branchInfo(cwd) {
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, repo: false }; }
	if (problem) { return { ok: false, error: problem }; }
	const [branch, base, upstream] = await Promise.all([currentBranch(cwd), resolveBase(cwd), git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)]);
	let ahead = 0;
	let behind = 0;
	if (base) {
		const counts = await git(["rev-list", "--left-right", "--count", `${base.ref}...HEAD`], cwd);
		if (counts.code === 0) { [behind, ahead] = counts.out.trim().split(/\s+/).map(Number); }
	}
	return { ok: true, repo: true, branch, base: base ? base.name : null, ahead, behind, upstream: upstream.code === 0 ? upstream.out.trim() : null };
}

async function readScopedDiff(cwd, scope) {
	if (scope === "uncommitted") { return readDiff(cwd); }
	if (scope !== "branch" && !(typeof scope === "string" && SHA_PATTERN.test(scope))) { return { ok: false, error: "Choose uncommitted changes, this branch, or a commit." }; }
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, repo: false, files: [] }; }
	if (problem) { return { ok: false, error: problem }; }
	const filterOff = await localFilterOff(cwd);
	if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
	const globalArgs = [...filterOff, "--literal-pathspecs", "-c", "core.quotepath=false"];
	if (scope !== "branch") {
		const commit = await git(["rev-parse", "--verify", "--quiet", `${scope}^{commit}`], cwd);
		if (commit.code !== 0) { return { ok: false, error: "That commit was not found." }; }
		// A repo's log.showSignature would run its gpg.program on a signed commit.
		const shown = await git([...globalArgs, "show", "--no-show-signature", "--format=", "--diff-merges=first-parent", ...DIFF_ARGS, commit.out.trim()], cwd);
		if (shown.code !== 0 && !shown.truncated) { return failure(shown, "Git"); }
		const parsed = parseGitDiff(shown.out, "");
		assignIds(parsed.files);
		return { ok: true, repo: true, truncated: shown.truncated || parsed.truncated, files: parsed.files };
	}
	const base = await resolveBase(cwd);
	if (!base) { return { ok: false, error: "No base branch was found." }; }
	const merge = await git(["merge-base", base.ref, "HEAD"], cwd);
	if (merge.code !== 0) { return { ok: false, error: `This branch shares no history with ${base.name}.` }; }
	// Working tree against the merge-base covers committed, staged and unstaged work in one patch; untracked files come from readDiff.
	const [tracked, fresh, listed] = await Promise.all([
		git([...globalArgs, "diff", ...DIFF_ARGS, merge.out.trim()], cwd),
		readDiff(cwd),
		git(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"], cwd),
	]);
	if (tracked.code !== 0 && !tracked.truncated) { return failure(tracked, "Git"); }
	if (!fresh.ok) { return fresh; }
	const parsed = parseGitDiff(tracked.out, "");
	const files = parsed.files;
	let truncated = tracked.truncated || parsed.truncated || listed.truncated || Boolean(fresh.truncated);
	assignIds(files);
	const untracked = new Set(listed.out.split("\0").filter(Boolean));
	for (const file of fresh.files) {
		if (!untracked.has(file.path) || files.some((item) => item.path === file.path)) { continue; }
		if (files.length >= MAX_FILES) {
			truncated = true;
			break;
		}
		files.push(file);
	}
	return { ok: true, repo: true, truncated, files };
}

function isChangePath(cwd, name) {
	if (typeof name !== "string" || !name || name.includes("\0") || path.isAbsolute(name)) { return false; }
	const relative = path.relative(cwd, path.resolve(cwd, name)).split(path.sep).join("/");
	return relative === name && !relative.split("/").includes("..");
}

async function readChanges({ cwd, scope, file, from, full }, cancellation) {
	if (scope !== "uncommitted" && scope !== "branch" && !(typeof scope === "string" && SHA_PATTERN.test(scope))) {
		return { ok: false, error: "Choose uncommitted changes, this branch, or a commit." };
	}
	const problem = folderProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	if ((file !== undefined && !isChangePath(cwd, file)) || (from !== undefined && (!file || !isChangePath(cwd, from)))) {
		return { ok: false, error: "Choose a changed file in this folder." };
	}
	const deadline = AbortSignal.timeout(GIT_TIMEOUT);
	const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
	const timedOut = new Error("Git timed out.");
	const read = async (args, maxBytes) => {
		signal.throwIfAborted();
		const result = await git(args, cwd, GIT_TIMEOUT, { maxBytes, signal });
		signal.throwIfAborted();
		if (result.timedOut) { throw timedOut; }
		return result;
	};
	try {
		const probe = await read(["rev-parse", "--is-inside-work-tree"]);
		if (probe.missing) { return { ok: false, error: "Git is not available in this window." }; }
		if (probe.code !== 0 || probe.out.trim() !== "true") { return { ok: true, repo: false, files: [] }; }
		const filterOff = await localFilterOff(cwd, read);
		if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
		const globals = [...filterOff, "--literal-pathspecs", "-c", "core.quotepath=false"];
		const diffArgs = file ? DIFF_ARGS : [...DIFF_READ_ARGS, "--numstat"];
		const paths = file ? [...new Set([file, ...(from ? [from] : [])])] : [];
		const maxBytes = file ? full === true ? FULL_DIFF_BYTES : MAX_BYTES : CHANGE_LIST_BYTES;
		const working = scope === "uncommitted";
		const branch = scope === "branch";
		const diff = ["diff", ...diffArgs];
		let commands;
		if (working) {
			commands = [diff, [...diff, "--cached"]];
		} else if (branch) {
			const base = await resolveBase(cwd, read);
			if (!base) { return { ok: false, error: "No base branch was found." }; }
			const merge = await read(["merge-base", base.ref, "HEAD"]);
			if (merge.code !== 0) { return { ok: false, error: `This branch shares no history with ${base.name}.` }; }
			commands = [[...diff, merge.out.trim()]];
		} else {
			const commit = await read(["rev-parse", "--verify", "--quiet", `${scope}^{commit}`]);
			if (commit.code !== 0) { return { ok: false, error: "That commit was not found." }; }
			commands = [["show", "--no-show-signature", "--format=", "--diff-merges=first-parent", ...diffArgs, commit.out.trim()]];
		}
		const [results, untracked] = await Promise.all([
			Promise.all(commands.map((command) => read([...globals, ...command, "--", ...paths], maxBytes))),
			working || branch ? read([...globals, "ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], CHANGE_LIST_BYTES) : null,
		]);
		const listTooLarge = { ok: false, error: "There are too many changed files to list here." };
		if (!file && (results.some((result) => result.truncated) || untracked?.truncated)) { return listTooLarge; }
		const files = [];
		let truncated = false;
		for (const [index, result] of results.entries()) {
			if (result.code !== 0 && !result.truncated) { return failure(result, "Git"); }
			if (file) {
				const parsed = parseWorkingDiff(result.out, index ? "Staged" : "", result.truncated, full === true ? FULL_DIFF_LINES : undefined);
				truncated ||= parsed.truncated;
				mergeFiles(files, parsed.files.filter((entry) => entry.path === file));
			} else {
				const entries = parseInventory(result.out);
				if (entries.length > CHANGE_LIST_FILES) { return listTooLarge; }
				mergeFiles(files, entries);
				if (files.length > CHANGE_LIST_FILES) { return listTooLarge; }
			}
		}
		if (untracked && untracked.code !== 0 && !untracked.truncated) { return failure(untracked, "Git"); }
		if (!file) {
			const byPath = new Set(files.map((entry) => entry.path));
			for (const name of untracked?.out.split("\0").filter(Boolean) ?? []) {
				if (name.endsWith("/") || byPath.has(name)) { continue; }
				if (files.length === CHANGE_LIST_FILES) { return listTooLarge; }
				files.push({ path: name, hunks: [] });
				byPath.add(name);
			}
			return { ok: true, repo: true, files };
		}
		const folder = fs.realpathSync(cwd);
		if (!files.length && untracked?.out.split("\0").includes(file)) {
			const built = untrackedHunk(folder, path.resolve(folder, file), full === true ? FULL_DIFF_BYTES : undefined, full === true ? FULL_DIFF_LINES : undefined);
			if (built) {
				files.push({ path: file, additions: built.truncated ? undefined : built.additions, deletions: 0, hunks: [built.hunk] });
				truncated ||= built.truncated === true;
			}
		}
		if (!files.length) { return { ok: false, error: "This file's changes could not be read. Refresh the file list." }; }
		if (truncated || !working) { for (const hunk of files[0].hunks) { delete hunk.revertible; } }
		else { await checkRevertible(cwd, folder, files, read); }
		if (truncated) {
			files[0].truncated = true;
			delete files[0].additions;
			delete files[0].deletions;
		}
		assignIds(files);
		return { ok: true, repo: true, files };
	} catch (error) {
		if (cancellation?.aborted) { return { ok: false, error: "Loading changes was stopped." }; }
		if (deadline.aborted || error === timedOut) { return { ok: false, error: "Git timed out while loading changes." }; }
		return { ok: false, error: "The changes could not be read." };
	}
}

async function listCommits(cwd, limit = 30) {
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, commits: [] }; }
	if (problem) { return { ok: false, error: problem }; }
	const count = Math.min(Math.max(Math.floor(Number(limit)) || 30, 1), 200);
	// A repo's log.showSignature would run its gpg.program on each signed commit.
	const logArgs = ["log", "--no-show-signature", "-z", `--max-count=${count}`, "--format=%H%x1f%h%x1f%s%x1f%cI"];
	const [branch, base] = await Promise.all([currentBranch(cwd), resolveBase(cwd)]);
	let log = { code: -1, out: "" };
	if (base && branch !== base.name) { log = await git([...logArgs, `${base.ref}..HEAD`], cwd); }
	if (log.code !== 0 || !log.out.trim()) { log = await git([...logArgs, "HEAD"], cwd); }
	if (log.timedOut) { return failure(log, "Git"); }
	if (log.code !== 0) { return { ok: true, commits: [] }; }
	const commits = log.out.split("\0").filter((record) => record.trim()).map((record) => {
		const [sha, short, subject, when] = record.split("\x1f");
		return { sha, short, subject, when };
	});
	return { ok: true, commits };
}

function checkState(entry) {
	const key = entry.__typename === "StatusContext" ? entry.state : (entry.status === "COMPLETED" ? entry.conclusion : entry.status);
	return CHECK_STATES[key] || "wait";
}

const PR_FEEDBACK_JQ = ".comments |= map({author, createdAt, isMinimized}) | .reviews |= map({author, submittedAt, state})";

async function prStatus(cwd, number) {
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, pr: null }; }
	if (problem) { return { ok: false, error: problem }; }
	// gh drops comment and review bodies itself, so a PR with long bot reviews stays under MAX_BYTES.
	const view = await gh(["pr", "view", ...(Number.isInteger(number) && number > 0 ? [String(number)] : []), "--json", "number,title,url,state,isDraft,mergeable,autoMergeRequest,statusCheckRollup,author,comments,reviews", "--jq", PR_FEEDBACK_JQ], cwd);
	if (view.missing) { return { ok: false, error: GH_MISSING }; }
	if (view.code !== 0 && /no pull requests found/i.test(view.err)) { return { ok: true, pr: null }; }
	if (view.code !== 0) { return failure(view, "GitHub CLI"); }
	let data;
	try {
		data = JSON.parse(view.out);
	} catch {
		return { ok: false, error: "GitHub CLI sent an answer that could not be read." };
	}
	const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
	const comments = Array.isArray(data.comments) ? data.comments : [];
	const reviews = Array.isArray(data.reviews) ? data.reviews : [];
	const author = data.author && data.author.login;
	const feedback = [
		...comments.filter((entry) => entry && typeof entry.author?.login === "string" && entry.author.login !== author && entry.isMinimized !== true && typeof entry.createdAt === "string").map((entry) => ({ at: entry.createdAt, who: entry.author.login, kind: "comment" })),
		...reviews.filter((entry) => entry && typeof entry.author?.login === "string" && entry.author.login !== author && !["APPROVED", "DISMISSED", "PENDING"].includes(entry.state) && typeof entry.submittedAt === "string").map((entry) => ({ at: entry.submittedAt, who: entry.author.login, kind: "review" })),
	];
	return {
		ok: true,
		pr: {
			number: data.number,
			title: data.title,
			url: data.url,
			state: data.state,
			isDraft: Boolean(data.isDraft),
			mergeable: data.mergeable,
			autoMerge: Boolean(data.autoMergeRequest),
			checks: rollup.map((entry) => ({ name: entry.name || entry.context || "Check", state: checkState(entry), url: entry.detailsUrl || entry.targetUrl || "" })),
			feedback,
		},
	};
}

async function prCreate(cwd, options) {
	const { title, body, draft, expected, hooks, onUpstream } = options || {};
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const [head, base] = await Promise.all([git(["symbolic-ref", "--quiet", "HEAD"], cwd), resolveBase(cwd)]);
	const ref = head.out.trim();
	const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
	if (head.code !== 0 || !branch || (base && branch === base.name)) { return { ok: false, error: "Switch to a branch before creating a pull request." }; }
	if (expected && branch !== expected) {
		const display = await git(["rev-parse", "--abbrev-ref", ref], cwd);
		if (display.code !== 0 || display.out.trim() !== expected) {
			return { ok: false, error: `The checkout changed to ${branch}. Refresh, then create the pull request again.` };
		}
	}
	// origin/HEAD can be stale after a rename, and a local main or master may not be the default, so GitHub names it before the push.
	const remote = await prRepository(cwd);
	if (!remote.ok) { return remote; }
	const baseRepository = remote.repository;
	if (!baseRepository.defaultBranchRef?.name) { return { ok: false, error: "GitHub did not say which branch is the default, so nothing was pushed." }; }
	if (baseRepository.defaultBranchRef.name === branch) { return { ok: false, error: "Switch to a branch before creating a pull request." }; }
	const pushUrl = await git(["remote", "get-url", "--push", "origin"], cwd);
	if (pushUrl.code !== 0 || pushUrl.truncated || !pushUrl.out.trim()) { return failure(pushUrl, "Git"); }
	const destination = await prRepository(cwd, pushUrl.out.trim());
	if (!destination.ok) { return destination; }
	const headRepository = destination.repository;
	if (headRepository.host !== baseRepository.host) { return { ok: false, error: "The push destination and pull request repository are on different GitHub hosts." }; }
	// Pre-push hooks (git-lfs, husky, secret scanners) run as they would in a terminal push, so they get a long limit.
	const push = await git(["push", "-u", "origin", `${ref}:${ref}`], cwd, 10 * 60 * 1000, { hooks: hooks !== false });
	if (push.code !== 0) { return failure(push, "The push"); }
	onUpstream?.(branch);
	const notCreated = (error) => ({ ok: false, error: `The branch was pushed, but the pull request was not created: ${error}` });
	const configuredBase = await git(["config", "--get", `branch.${branch}.gh-merge-base`], cwd);
	const baseBranch = configuredBase.code === 0 && configuredBase.out.trim() ? configuredBase.out.trim() : baseRepository.defaultBranchRef.name;
	let prTitle = typeof title === "string" ? title.trim() : "";
	let prBody = typeof body === "string" ? body : "";
	if (!prTitle) {
		const remotes = await git(["remote", "-v"], cwd);
		if (remotes.code !== 0 || remotes.truncated) { return notCreated(failure(remotes, "Reading Git remotes").error); }
		let baseRemote;
		for (const line of remotes.out.split(/\r?\n/)) {
			const entry = /^(\S+)\s+(.+)\s+\(fetch\)$/.exec(line);
			if (!entry) { continue; }
			const candidate = entry[2].trim() === pushUrl.out.trim() ? destination : await prRepository(cwd, entry[2].trim());
			if (candidate.ok && candidate.repository.id === baseRepository.id && candidate.repository.host === baseRepository.host) { baseRemote = entry[1]; break; }
		}
		const baseRef = baseRemote ? `refs/remotes/${baseRemote}/${baseBranch}` : `refs/heads/${baseBranch}`;
		const log = await git(["log", "--no-show-signature", "--format=%s%x00%b%x00", "--cherry", `${baseRef}...${ref}`, "--"], cwd);
		if (log.code !== 0 || log.truncated) { return notCreated(failure(log, "Reading pull request commits").error); }
		const parts = log.out.split("\0");
		const commits = [];
		for (let i = 0; i + 1 < parts.length; i += 2) { commits.push({ title: parts[i].trim(), body: parts[i + 1].trim() }); }
		if (!commits.length) { return notCreated("There are no commits to use for the pull request title and body."); }
		prTitle = commits.length === 1 ? commits[0].title : branch.replace(/[_-]/g, " ");
		prBody = commits.length === 1 ? commits[0].body : commits.reverse().map((commit) => `- **${commit.title}**\n`).join("");
	}
	const prHead = headRepository.id === baseRepository.id ? branch : `${headRepository.nameWithOwner.split("/")[0]}:${branch}`;
	const args = ["pr", "create", "--repo", baseRepository.url, "--head", prHead, "--base", baseBranch, `--title=${prTitle}`, `--body=${prBody}`];
	if (draft) { args.push("--draft"); }
	const created = await gh(args, cwd);
	const urls = (created.code === 0 ? created.out : created.err).match(/https?:\/\/\S+/g);
	if (created.code === 0 && !urls) { return notCreated("GitHub did not return a pull request URL. Check GitHub before trying again."); }
	if (created.code === 0 || (urls && /already exists/i.test(created.err))) {
		const status = await git(["status", "--porcelain"], cwd);
		const count = status.out.split(/\r?\n/).filter(Boolean).length;
		return { ok: true, url: urls ? urls.pop() : "", message: `Pull request opened.${count ? ` ${count} uncommitted files are not in this pull request.` : ""}` };
	}
	return notCreated(created.missing ? GH_MISSING : failure(created, "GitHub CLI").error);
}

async function commitFiles(cwd, options, limits = {}) {
	if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) { return { ok: false, error: "Choose files and enter a commit message." }; }
	if (!Array.isArray(options.paths) || options.paths.length < 1 || options.paths.length > 1000) { return { ok: false, error: "Choose between 1 and 1000 files to commit." }; }
	if (typeof cwd !== "string" || !cwd) { return { ok: false, error: "Choose a folder to commit from." }; }
	const folder = path.resolve(cwd);
	const hooks = options.hooks !== false;
	const paths = [];
	for (const file of options.paths) {
		if (typeof file !== "string" || !file || /[\0\r\n]/.test(file) || path.isAbsolute(file)) { return { ok: false, error: "Commit paths must be relative files inside this folder." }; }
		const relative = path.relative(folder, path.resolve(folder, file));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return { ok: false, error: "Commit paths must stay inside this folder." }; }
		paths.push(relative.split(path.sep).join("/") || ".");
	}
	if (typeof options.message !== "string" || !options.message.trim() || options.message.length > 10000 || options.message.includes("\0")) { return { ok: false, error: "Enter a commit message of at most 10000 characters without NUL." }; }
	if (options.push !== undefined && typeof options.push !== "boolean") { return { ok: false, error: "Choose whether to push with a boolean value." }; }
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const branch = await currentBranch(cwd);
	if (options.expected && options.expected !== branch) { return { ok: false, error: `The checkout changed to ${branch}. Refresh, then commit again.` }; }
	if (options.push && (!branch || branch === "HEAD")) { return { ok: false, error: "Switch to a branch before pushing." }; }
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0 || !top.out.trim()) { return failure(top, "Git"); }
	const repo = path.resolve(top.out.trim());
	const repository = process.platform === "win32" ? repo.toLowerCase() : repo;
	if (committing.has(repository)) { return { ok: false, error: "A commit is already running in this repository." }; }
	committing.add(repository);
	let temporary;
	try {
		temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grok-commit-"));
		const writePaths = (name, files) => {
			const file = path.join(temporary, name);
			fs.writeFileSync(file, `${files.map((entry) => `:(literal)${entry}`).join("\0")}\0`);
			return file;
		};
		const list = writePaths("paths", paths);
		const message = path.join(temporary, "message");
		fs.writeFileSync(message, options.message.trim());
		const key = (file) => process.platform === "win32" ? file.toLowerCase() : file;
		const selected = new Set(paths.map(key));
		const includes = (file) => selected.has(key(file)) || paths.some((entry) => entry === "." || key(file).startsWith(`${key(entry)}/`));
		const unmerged = await git(["ls-files", "--unmerged", "-z"], cwd, GIT_TIMEOUT, { maxBytes: 2 * 1024 * 1024 });
		if (unmerged.code !== 0 || unmerged.truncated) { return failure(unmerged, "Checking unmerged files"); }
		const unmergedPaths = new Set(unmerged.out.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
		for (const file of unmergedPaths) {
			if (!includes(file)) { continue; }
			const attr = await git(["check-attr", "-z", "conflict-marker-size", "--", file], cwd);
			if (attr.code !== 0 || attr.truncated) { return failure(attr, "Checking conflict marker size"); }
			const size = Number(attr.out.split("\0")[2]);
			const count = Number.isSafeInteger(size) && size > 0 ? size : 7;
			const markers = await git(["--literal-pathspecs", "grep", "-q", "-I", "-E", "--no-textconv", "--no-recurse-submodules", `^(<{${count}}|>{${count}}|={${count}}|[|]{${count}})([[:space:]]|$)`, "--", file], cwd);
			if (markers.code === 0) { return { ok: false, error: `Resolve the conflict markers in ${file} before committing.` }; }
			if (markers.code !== 1 || markers.timedOut) { return failure(markers, "Checking conflict markers"); }
		}
		const staged = await git(["diff", "--cached", "--relative", "--raw", "--no-renames", "-z"], cwd, GIT_TIMEOUT, { maxBytes: 2 * 1024 * 1024 });
		if (staged.code !== 0 || staged.truncated) { return failure(staged, "Checking staged files"); }
		const modes = new Map();
		for (const [, oldMode, mode, status, file] of staged.out.matchAll(/(?:^|\0):(\d+) (\d+) \w+ \w+ (\w)\0([^\0]+)(?=\0)/g)) {
			if (status === "D" && selected.has(key(file)) && fs.existsSync(path.resolve(cwd, file))) { return { ok: false, error: `${file} is staged to be deleted but is still on disk, so committing it here would commit the file. Commit it from a terminal.` }; }
			if (oldMode !== mode && (mode === "100755" || (oldMode === "100755" && mode === "100644")) && includes(file) && fs.lstatSync(path.resolve(cwd, file), { throwIfNoEntry: false })?.isFile()) { modes.set(file, mode); }
		}
		if (modes.size) {
			const fileMode = await git(["config", "--type=bool", "--get", "core.fileMode"], cwd);
			if (fileMode.code !== 0 && (fileMode.code !== 1 || fileMode.timedOut)) { return failure(fileMode, "Checking the file mode setting"); }
			if (fileMode.out.trim() !== "false") { modes.clear(); }
		}
		const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd, GIT_TIMEOUT, { maxBytes: 2 * 1024 * 1024 });
		if (untracked.truncated) { return { ok: false, error: "This folder has too many untracked files to check. Commit from a terminal." }; }
		if (untracked.code !== 0) { return failure(untracked, "Checking untracked files"); }
		const newPaths = untracked.out.split("\0").filter((entry) => entry && selected.has(key(entry)));
		const newList = newPaths.length ? writePaths("new-paths", newPaths) : "";
		const rollback = async (error) => {
			if (newList) {
				const reset = await git(["reset", "-q", `--pathspec-from-file=${newList}`, "--pathspec-file-nul"], cwd);
				if (reset.code !== 0) { error += ` The files ${newPaths.join(", ")} were left marked as new in the index: ${failure(reset, "Resetting new files").error}`; }
			}
			return { ok: false, error };
		};
		if (newList) {
			const added = await git(["add", "--intent-to-add", `--pathspec-from-file=${newList}`, "--pathspec-file-nul"], cwd);
			if (added.code !== 0) { return await rollback(failure(added, "Adding new files").error); }
		}
		const before = await git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
		const timeout = limits.timeout ?? 10 * 60 * 1000;
		const commitIdArgs = modes.size ? ["-c", "core.abbrev=no"] : [];
		const modeRef = modes.size ? (await git(["symbolic-ref", "--quiet", "HEAD"], cwd)).out.trim() : "";
		const modeConfig = modes.size ? await git(["config", "--includes", "--null", "--get-regexp", "^(commit\\.gpgsign|i18n\\.commitencoding|user\\.(name|email|signingkey|useconfigonly)|committer\\.(name|email)|gpg\\..*)$"], cwd) : null;
		if (modeConfig && (modeConfig.truncated || (modeConfig.code !== 0 && modeConfig.code !== 1))) { return await rollback(failure(modeConfig, "Reading commit settings").error); }
		const committed = await git([...commitIdArgs, "commit", "--only", ...(modes.size ? ["--allow-empty"] : []), "-F", message, `--pathspec-from-file=${list}`, "--pathspec-file-nul"], cwd, timeout, { hooks });
		if (committed.code !== 0) {
			const after = await git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
			const error = failure(committed, "Git").error;
			const detail = error === "Git failed." ? committed.out.match(/^(?:nothing to commit|no changes added to commit|nothing added to commit)\b[^\r\n]*/m)?.[0] ?? error : error;
			const reason = `${detail}${committed.timedOut ? " Git was stopped. If git later says .git/index.lock exists and no git program is running, delete that file." : ""}`;
			if (after.code === 0 && after.out.trim() !== before.out.trim()) {
				const short = await git(["rev-parse", "--short", "HEAD"], cwd);
				const sha = short.out.trim() || after.out.trim();
				return { ok: false, committed: true, sha, error: `Committed ${sha}, but git did not finish cleanly: ${reason}${modes.size ? " The staged executable modes could not be checked." : ""}` };
			}
			return await rollback(reason);
		}
		if (modes.size) {
			const commitId = (result) => [...result.out.matchAll(/^\[[^\r\n]* ([0-9a-f]{40}|[0-9a-f]{64})\] /gm)].at(-1)?.[1];
			const first = commitId(committed);
			const incomplete = (reason) => ({ ok: false, committed: true, sha: first?.slice(0, 12), error: `The commit landed, but the staged executable modes could not be included. ${reason}` });
			if (!modeRef.startsWith("refs/heads/")) { return incomplete("An attached branch is required to preserve the modes safely."); }
			const dirs = await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", "config.worktree"], cwd);
			const [common, worktreeConfig] = dirs.out.trimEnd().split(/\r?\n/);
			if (!first || dirs.code !== 0 || !common || !worktreeConfig) { return incomplete("The temporary checkout could not be prepared."); }
			try {
				fs.writeFileSync(path.join(temporary, "HEAD"), `${first}\n`);
				fs.mkdirSync(path.join(temporary, "reftable"));
				if (fs.existsSync(worktreeConfig)) { fs.writeFileSync(path.join(temporary, "config.worktree"), `[include]\n\tpath = ${JSON.stringify(worktreeConfig)}\n`); }
			} catch (error) { return incomplete(error.message); }
			const env = { GIT_DIR: temporary, GIT_COMMON_DIR: common, GIT_WORK_TREE: repo, GIT_INDEX_FILE: path.join(temporary, "mode-index") };
			const refHooksOff = ["-c", "hook.reference-transaction.enabled=false"];
			if ((await git([...refHooksOff, "update-ref", "--no-deref", "HEAD", first], repo, GIT_TIMEOUT, { env })).code !== 0) { return incomplete("The temporary checkout could not be prepared."); }
			if ((await git(["read-tree", first], repo, GIT_TIMEOUT, { env })).code !== 0) { return incomplete("The temporary index could not be prepared."); }
			for (const [file, mode] of modes) {
				const tree = await git(["--literal-pathspecs", "ls-tree", "-z", first, "--", file], cwd);
				const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(tree.out)?.[1];
				if (tree.code !== 0 || !blob) { return incomplete(`The committed file at ${file} could not be read.`); }
				const relative = path.relative(repo, path.resolve(cwd, file)).split(path.sep).join("/");
				const updated = await git(["update-index", "--cacheinfo", `${mode},${blob},${relative}`], repo, GIT_TIMEOUT, { env });
				if (updated.code !== 0) { return incomplete(failure(updated, "Updating the executable mode").error); }
			}
			const commitSettings = modeConfig.out.split("\0").filter(Boolean).flatMap((entry) => ["-c", entry.replace("\n", "=")]);
			const amended = await git([...commitIdArgs, ...commitSettings, ...refHooksOff, "-c", "hook.prepare-commit-msg.enabled=false", "-c", "hook.post-commit.enabled=false", "commit", "--amend", "--no-edit", "--no-verify", "--no-post-rewrite", "--cleanup=verbatim"], repo, timeout, hooks ? { env } : { env, hooks: false });
			const corrected = commitId(amended);
			if (amended.code !== 0 || !corrected) { return incomplete(failure(amended, "Amending the executable modes").error); }
			const activeRef = async () => (await git(["symbolic-ref", "--quiet", "HEAD"], cwd)).out.trim();
			const head = async () => (await git(["rev-parse", "--verify", "HEAD"], cwd)).out.trim();
			if (await activeRef() !== modeRef || await head() !== first) { return incomplete("The checkout changed after committing."); }
			const published = await git([...refHooksOff, "update-ref", "--no-deref", "-m", "commit (amend): preserve executable modes", modeRef, corrected, first], cwd);
			if (published.code !== 0) { return incomplete(failure(published, "Updating the branch").error); }
			if (await activeRef() !== modeRef || await head() !== corrected) {
				return { ok: false, committed: true, sha: corrected.slice(0, 12), error: "The executable modes were committed, but the checkout changed before the operation finished." };
			}
		}
		const short = await git(["rev-parse", "--short", "HEAD"], cwd);
		const sha = short.out.trim();
		if (options.push) {
			const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
			const head = upstream.code !== 0 && typeof options.onUpstream === "function" ? await git(["symbolic-ref", "--quiet", "HEAD"], cwd) : null;
			const pushed = await git(upstream.code === 0 ? ["push"] : ["push", "-u", "origin", "HEAD"], cwd, timeout, { hooks });
			if (pushed.code !== 0) { return { ok: false, committed: true, sha, error: `Committed ${sha}, but the push failed: ${failure(pushed, "Git").error}` }; }
			if (head?.code === 0 && head.out.trim().startsWith("refs/heads/")) {
				const after = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
				if (after.code === 0 && after.out === head.out) { options.onUpstream(head.out.trim().slice("refs/heads/".length)); }
			}
		}
		const status = await git(["status", "--porcelain"], cwd);
		const count = status.out.split(/\r?\n/).filter(Boolean).length;
		return { ok: true, committed: true, sha, message: `Committed ${sha}${options.push ? ` and pushed ${branch}` : ""}.${count ? ` ${count} other changed files are not in this commit.` : ""}` };
	} catch (error) {
		return { ok: false, error: `The commit could not be completed: ${error.message}` };
	} finally {
		committing.delete(repository);
		try { if (temporary) { fs.rmSync(temporary, { recursive: true, force: true }); } } catch { /* Cleanup must not replace the commit result. */ }
	}
}

async function prMergeWhenReady(cwd, number) {
	if (!Number.isInteger(number) || number <= 0) { return { ok: false, error: "Choose a pull request by its number." }; }
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const repo = await gh(["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], cwd);
	if (repo.missing) { return { ok: false, error: GH_MISSING }; }
	if (repo.code !== 0) { return failure(repo, "GitHub CLI"); }
	let methods;
	try {
		methods = JSON.parse(repo.out);
	} catch {
		return { ok: false, error: "GitHub CLI sent an answer that could not be read." };
	}
	const method = methods.squashMergeAllowed ? "--squash" : methods.mergeCommitAllowed ? "--merge" : methods.rebaseMergeAllowed ? "--rebase" : "";
	if (!method) { return { ok: false, error: "This repository allows no merge method the app can use." }; }
	const view = await gh(["pr", "view", String(number), "--json", "state,mergeStateStatus"], cwd);
	if (view.code !== 0) { return failure(view, "GitHub CLI"); }
	let pr;
	try {
		pr = JSON.parse(view.out);
	} catch {
		return { ok: false, error: "GitHub CLI sent an answer that could not be read." };
	}
	if (pr.state !== "OPEN") { return { ok: false, error: "This pull request is not open." }; }
	// gh merges at once unless GitHub would make it wait, and only required checks or reviews (BLOCKED) do that.
	if (pr.mergeStateStatus === "UNSTABLE") { return { ok: false, error: "Checks are not passing, and this repository does not require them, so GitHub would merge now. Merge after the checks pass." }; }
	if (!["BLOCKED", "CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus)) { return { ok: false, error: `GitHub cannot merge this pull request yet (${String(pr.mergeStateStatus || "unknown").toLowerCase()}).` }; }
	const merged = await gh(["pr", "merge", String(number), "--auto", method], cwd);
	if (merged.missing) { return { ok: false, error: GH_MISSING }; }
	if (merged.code !== 0) { return failure(merged, "GitHub CLI"); }
	const latest = await gh(["pr", "view", String(number), "--json", "state,autoMergeRequest"], cwd);
	if (latest.code === 0) {
		try {
			const state = JSON.parse(latest.out);
			if (state?.state === "MERGED") { return { ok: true, message: "Merged." }; }
			if (state?.state === "OPEN" && state.autoMergeRequest) {
				return { ok: true, message: "Auto-merge is on. GitHub merges this pull request when its required checks and reviews pass." };
			}
		} catch { /* The merge command succeeded, but the current PR state is unknown. */ }
	}
	return { ok: true, message: "Merge command completed. Refresh to check the pull request." };
}

function validName(text) {
	return typeof text === "string" && NAME_PATTERN.test(text);
}

async function addWorktree(cwd, options) {
	const { name, prefix, hooks } = options || {};
	if (!validName(name) || !validName(prefix)) { return { ok: false, error: "Use up to 40 letters, numbers, dots, dashes or underscores, starting with a letter or number." }; }
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const dirs = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], cwd);
	const [top, common, extra] = dirs.out.replace(/\r?\n$/, "").split(/\r?\n/);
	if (dirs.code !== 0 || dirs.truncated || extra !== undefined || !top || !common || !path.isAbsolute(top) || !path.isAbsolute(common)) { return { ok: false, error: NOT_REPO }; }
	const folder = path.join(top, ".grok", "worktrees", name);
	const branch = `${prefix}/${name}`;
	if (fs.existsSync(folder)) { return { ok: false, error: "A worktree with that name already exists." }; }
	const unsafeExclude = { ok: false, error: "Git info/exclude must be a regular file inside the repository's Git folder." };
	const hardlinkedExclude = { ok: false, error: "Git info/exclude has more than one link and cannot be updated safely." };
	try {
		const gitFolder = fs.realpathSync.native(common);
		const info = path.join(gitFolder, "info");
		if (!fs.lstatSync(info, { throwIfNoEntry: false })) { fs.mkdirSync(info); }
		const resolvedInfo = fs.realpathSync.native(info);
		const relative = path.relative(gitFolder, resolvedInfo);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return unsafeExclude; }
		const file = path.join(resolvedInfo, "exclude");
		const existing = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
		if (existing && !existing.isFile()) { return unsafeExclude; }
		if (existing && existing.nlink > 1n) { return hardlinkedExclude; }
		const { O_NOFOLLOW = 0, O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_EXCL } = fs.constants;
		const text = existing ? fs.readFileSync(file, { encoding: "utf8", flag: O_RDONLY | O_NOFOLLOW }) : "";
		if (!text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) {
			const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_NOFOLLOW | (existing ? 0 : O_CREAT | O_EXCL));
			try {
				const opened = fs.fstatSync(fd, { bigint: true });
				if (!opened.isFile()) { return unsafeExclude; }
				if (opened.nlink > 1n) { return hardlinkedExclude; }
				if (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino)) { return unsafeExclude; }
				if (path.relative(file, fs.realpathSync.native(file)) !== "") { return unsafeExclude; }
				fs.appendFileSync(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		return { ok: false, error: "The git exclude file could not be updated." };
	}
	// ponytail: checkout of a large repo can exceed the 20 s git limit, so worktree add gets the 60 s push limit.
	const added = await git(["worktree", "add", "-b", branch, folder, "HEAD"], cwd, SLOW_TIMEOUT, { hooks: hooks !== false });
	return added.code === 0 ? { ok: true, folder, branch } : failure(added, "Git");
}

async function restoreWorktree(folder, branch, confirm) {
	const [prefix, name, extra] = typeof branch === "string" ? branch.split("/") : [];
	if (!validName(name) || !validName(prefix) || extra !== undefined || typeof folder !== "string" || path.basename(folder) !== name || path.basename(path.dirname(folder)) !== "worktrees" || path.basename(path.dirname(path.dirname(folder))) !== ".grok") {
		return { ok: false, error: "Choose a session worktree with a valid branch name." };
	}
	const cwd = path.dirname(path.dirname(path.dirname(path.resolve(folder))));
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	if (fs.existsSync(path.join(folder, ".git"))) { return { ok: true, folder, branch }; }
	const listed = await git(["worktree", "list", "--porcelain"], cwd);
	const registrations = listed.out.split(/\r?\n\r?\n/).map((record) => record.split(/\r?\n/)).filter((record) => record.includes(`branch refs/heads/${branch}`));
	const stale = listed.code === 0 && !listed.truncated && registrations.length === 1 && registrations[0][0].startsWith("worktree ")
		&& path.relative(folder, registrations[0][0].slice("worktree ".length)) === "" && !registrations[0].some((line) => /^locked(?: |$)/.test(line));
	const add = async (hooks) => {
		const restored = await git(["worktree", "add", ...(stale ? ["--force"] : []), folder, branch], cwd, SLOW_TIMEOUT, { hooks });
		return restored.code === 0 ? { ok: true, folder, branch } : failure(restored, "Git");
	};
	return confirm ? confirm(cwd, add) : add();
}

async function removeWorktree(cwd, folder, options) {
	const problem = folderProblem(cwd) || folderProblem(folder);
	if (problem) { return { ok: false, error: problem }; }
	const within = (from) => {
		const relative = path.relative(path.resolve(folder), path.resolve(from));
		return !relative.startsWith("..") && !path.isAbsolute(relative);
	};
	if (within(cwd)) {
		// A worktree session's folder is the worktree itself, so git runs from the main checkout.
		const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], folder);
		cwd = common.code === 0 && common.out.trim() ? path.dirname(common.out.trim()) : cwd;
		if (within(cwd)) { return { ok: false, error: "Remove a worktree from another folder, not from inside it." }; }
	}
	const filterOff = await localFilterOff(folder);
	if (filterOff === null) { return { ok: false, error: FILTER_NOT_OFF }; }
	const status = await git([...filterOff, "-C", folder, "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "-z"], cwd);
	if (status.code !== 0) { return failure(status, "Git"); }
	const entries = status.out.split("\0").filter(Boolean);
	const safe = new Set(["node_modules", "dist", "build", "out", "target", ".next", "coverage", "__pycache__", ".cache"]);
	const ignored = entries.filter((entry) => entry.startsWith("!! ") && !safe.has(entry.slice(3).split("/")[0])).map((entry) => entry.slice(3));
	const dirty = entries.some((entry) => !entry.startsWith("!! ")) || ignored.length > 0;
	const force = Boolean(options && options.force);
	if (dirty && !force) { return { ok: false, dirty: true, ...(ignored.length ? { ignored: ignored.slice(0, 5) } : {}), error: "This worktree has uncommitted changes." }; }
	if (!force) {
		if (!options?.branch) { return { ok: false, dirty: true, error: "The session branch could not be verified." }; }
		const head = await git(["symbolic-ref", "--quiet", "HEAD"], folder);
		if (head.code !== 0 || head.out.trim() !== `refs/heads/${options.branch}`) { return { ok: false, dirty: true, error: "This worktree is not on its session branch." }; }
	}
	// A non-force remove runs its own git status, which inherits these settings.
	// Removing a large ignored node_modules can take minutes, and killing git part-way leaves a half-deleted worktree.
	if (options?.beforeRemove?.() === false) { return { ok: false, skipped: true }; }
	const removed = await git([...filterOff, "worktree", "remove", ...(force ? ["--force"] : []), folder], cwd, 10 * 60 * 1000);
	return removed.code === 0 ? { ok: true, dirty } : { ...failure(removed, "Git"), dirty };
}

// The Grok CLI installer puts a portable Git in %LOCALAPPDATA%\grok\git\<version>\cmd on Windows.
// ponytail: Grok's own layout, not a documented interface; if it moves, the setup check shows Git as missing again.
function bundledGitDir(localAppData = process.env.LOCALAPPDATA) {
	if (!localAppData) { return ""; }
	const root = path.join(localAppData, "grok", "git");
	try {
		return fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((name) => path.join(root, name, "cmd")).find((dir) => fs.existsSync(path.join(dir, "git.exe"))) || "";
	} catch {
		return "";
	}
}

// Appended, so a Git already on PATH still wins. The app, its terminals and Grok inherit it.
function useBundledGit() {
	const dir = bundledGitDir();
	if (dir && !(process.env.PATH || "").split(path.delimiter).includes(dir)) { process.env.PATH = `${process.env.PATH}${path.delimiter}${dir}`; }
}

module.exports = { branchInfo, readScopedDiff, readChanges, listCommits, repoFiles, prStatus, prCreate, commitFiles, prMergeWhenReady, addWorktree, restoreWorktree, removeWorktree, gitSecuritySnapshot, run, git, bundledGitDir, useBundledGit };
