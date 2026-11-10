const { execFileSync } = require("node:child_process");

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
	const tag = process.env.GITHUB_REF_NAME;
	if (!tag) { throw new Error("No release tag was supplied."); }
	const commit = git("rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}^{commit}`);
	if (commit !== git("rev-parse", "HEAD")) { throw new Error(`The checkout does not match ${tag}.`); }
	const { version } = JSON.parse(git("show", `${commit}:package.json`));
	if (typeof version !== "string" || !version || tag !== `v${version}`) { throw new Error(`Release tag ${tag} does not match package.json version ${version}.`); }
	try {
		git("merge-base", "--is-ancestor", "refs/remotes/origin/main", commit);
	} catch (error) {
		if (error.status === 1) { throw new Error(`The commit for ${tag} does not contain origin/main.`); }
		throw error;
	}
} catch (error) {
	console.error(error.stderr?.trim() || error.message);
	process.exitCode = 1;
}
