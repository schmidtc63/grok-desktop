const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { folderProblem } = require("./agent.cjs");
const { readDiff, parseUnified } = require("./diff.cjs");

const GIT_TIMEOUT = 20000;
const SLOW_TIMEOUT = 60000;
const MAX_BYTES = 180000;
const MAX_FILES = 40;
const NOT_REPO = "This folder is not a git checkout.";
const GH_MISSING = "GitHub CLI (gh) is not installed.";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const EXCLUDE_LINE = ".grok/worktrees/";
const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--relative", "--raw", "-z", "-p", "-U3"];
const CHECK_STATES = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", CANCELLED: "fail", TIMED_OUT: "fail", ACTION_REQUIRED: "fail", STARTUP_FAILURE: "fail", NEUTRAL: "skip", SKIPPED: "skip", STALE: "skip", IN_PROGRESS: "run" };

function stop(child) {
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
	} else {
		child.kill();
	}
}

function run(command, args, cwd, timeout) {
	return new Promise((resolve) => {
		let settled = false;
		let size = 0;
		let err = "";
		const chunks = [];
		const result = (extra) => ({ code: -1, out: Buffer.concat(chunks).toString("utf8"), err, truncated: size > MAX_BYTES, timedOut: false, missing: false, ...extra });
		const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
		let child;
		try {
			child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
			resolve(value);
		};
		child.on("error", (error) => {
			finish(result({ err: error.message, missing: error.code === "ENOENT" }));
		});
		child.stdout.on("data", (buf) => {
			size += buf.length;
			if (size > MAX_BYTES) {
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
function git(args, cwd, timeout = GIT_TIMEOUT) {
	return run("git", ["-c", "core.fsmonitor=false", ...args], cwd, timeout);
}

function gh(args, cwd) {
	return run("gh", args, cwd, SLOW_TIMEOUT);
}

function failure(result, what) {
	if (result.timedOut) { return { ok: false, error: `${what} timed out.` }; }
	const line = result.err.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).pop() || `${what} failed.`;
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

async function currentBranch(cwd) {
	const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (head.code === 0) { return head.out.trim(); }
	return (await git(["branch", "--show-current"], cwd)).out.trim();
}

async function resolveBase(cwd) {
	const remote = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
	const name = remote.out.trim().replace(/^refs\/remotes\/origin\//, "");
	if (remote.code === 0 && name) { return { name, ref: `refs/remotes/origin/${name}` }; }
	for (const local of ["main", "master"]) {
		if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${local}`], cwd)).code === 0) { return { name: local, ref: `refs/heads/${local}` }; }
	}
	return null;
}

// Copied from diff.cjs (not exported there): raw -z inventory plus unified patch parsing, and hunk ids.
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

function assignIds(files) {
	for (const file of files) {
		for (const hunk of file.hunks) {
			const hash = createHash("sha256").update(JSON.stringify([file.path, hunk.id, hunk.loc, hunk.lines])).digest("hex");
			hunk.id = `${file.path}:${hash}`;
		}
	}
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
	const globalArgs = ["--literal-pathspecs", "-c", "core.quotepath=false"];
	if (scope !== "branch") {
		const commit = await git(["rev-parse", "--verify", "--quiet", `${scope}^{commit}`], cwd);
		if (commit.code !== 0) { return { ok: false, error: "That commit was not found." }; }
		const shown = await git([...globalArgs, "show", "--format=", "--diff-merges=first-parent", ...DIFF_ARGS, commit.out.trim()], cwd);
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

async function listCommits(cwd, limit = 30) {
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, commits: [] }; }
	if (problem) { return { ok: false, error: problem }; }
	const count = Math.min(Math.max(Math.floor(Number(limit)) || 30, 1), 200);
	const logArgs = ["log", "-z", `--max-count=${count}`, "--format=%H%x1f%h%x1f%s%x1f%cI"];
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

async function prStatus(cwd) {
	const problem = await repoProblem(cwd);
	if (problem === NOT_REPO) { return { ok: true, pr: null }; }
	if (problem) { return { ok: false, error: problem }; }
	const view = await gh(["pr", "view", "--json", "number,title,url,state,isDraft,mergeable,autoMergeRequest,statusCheckRollup"], cwd);
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
		},
	};
}

async function prCreate(cwd, options) {
	const { title, body, draft } = options || {};
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const [branch, base] = await Promise.all([currentBranch(cwd), resolveBase(cwd)]);
	if (!branch || branch === "HEAD" || (base && branch === base.name)) { return { ok: false, error: "Switch to a branch before creating a pull request." }; }
	const push = await git(["push", "-u", "origin", "HEAD"], cwd, SLOW_TIMEOUT);
	if (push.code !== 0) { return failure(push, "The push"); }
	const args = ["pr", "create"];
	if (typeof title === "string" && title.trim()) {
		args.push(`--title=${title.trim()}`, `--body=${typeof body === "string" ? body : ""}`);
	} else {
		args.push("--fill");
	}
	if (draft) { args.push("--draft"); }
	const created = await gh(args, cwd);
	if (created.missing) { return { ok: false, error: GH_MISSING }; }
	const urls = (created.code === 0 ? created.out : created.err).match(/https?:\/\/\S+/g);
	if (created.code === 0 || (urls && /already exists/i.test(created.err))) { return { ok: true, url: urls ? urls.pop() : "" }; }
	return failure(created, "GitHub CLI");
}

async function prMergeWhenReady(cwd) {
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const merged = await gh(["pr", "merge", "--auto", "--squash"], cwd);
	if (merged.missing) { return { ok: false, error: GH_MISSING }; }
	return merged.code === 0 ? { ok: true } : failure(merged, "GitHub CLI");
}

function validName(text) {
	return typeof text === "string" && NAME_PATTERN.test(text);
}

async function addWorktree(cwd, options) {
	const { name, prefix } = options || {};
	if (!validName(name) || !validName(prefix)) { return { ok: false, error: "Use up to 40 letters, numbers, dots, dashes or underscores, starting with a letter or number." }; }
	const problem = await repoProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const [top, exclude] = await Promise.all([git(["rev-parse", "--show-toplevel"], cwd), git(["rev-parse", "--git-path", "info/exclude"], cwd)]);
	if (top.code !== 0 || exclude.code !== 0 || !top.out.trim()) { return { ok: false, error: NOT_REPO }; }
	const folder = path.join(path.resolve(top.out.trim()), ".grok", "worktrees", name);
	const branch = `${prefix}/${name}`;
	if (fs.existsSync(folder)) { return { ok: false, error: "A worktree with that name already exists." }; }
	try {
		const file = path.resolve(cwd, exclude.out.trim());
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		if (!text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
		}
	} catch {
		return { ok: false, error: "The git exclude file could not be updated." };
	}
	// ponytail: checkout of a large repo can exceed the 20 s git limit, so worktree add gets the 60 s push limit.
	const added = await git(["worktree", "add", "-b", branch, folder, "HEAD"], cwd, SLOW_TIMEOUT);
	return added.code === 0 ? { ok: true, folder, branch } : failure(added, "Git");
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
	const status = await git(["-C", folder, "status", "--porcelain"], cwd);
	if (status.code !== 0) { return failure(status, "Git"); }
	const dirty = status.out.trim() !== "";
	const force = Boolean(options && options.force);
	if (dirty && !force) { return { ok: false, dirty: true, error: "This worktree has uncommitted changes." }; }
	const removed = await git(["worktree", "remove", ...(force ? ["--force"] : []), folder], cwd);
	return removed.code === 0 ? { ok: true, dirty } : { ...failure(removed, "Git"), dirty };
}

module.exports = { branchInfo, readScopedDiff, listCommits, prStatus, prCreate, prMergeWhenReady, addWorktree, removeWorktree };
