const assert = require("assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { changeArgs, shape, tomlList, words, readinessOf, tilde, installArgs } = require("../electron/customize.cjs");

const config = [
	"disabled_mcp_servers = [\"chrome\", 'gone']",
	"",
	"[mcp_servers.docs]",
	"command = \"npx\"",
	"",
	"[plugins]",
	"enabled = []",
	"disabled = [",
	"    \"hello\",",
	"]",
	"",
].join("\n");
assert.deepEqual(tomlList(config, "", "disabled_mcp_servers"), ["chrome", "gone"], "a top-level list, both quote styles");
assert.deepEqual(tomlList(config, "plugins", "disabled"), ["hello"], "a list inside a section, over several lines");
assert.deepEqual(tomlList(config, "plugins", "missing"), []);
assert.deepEqual(tomlList("", "", "disabled_mcp_servers"), []);
console.log("PASS tomlList: top-level and section lists");

const inventory = shape({
	inspect: {
		projectTrusted: false,
		skills: [
			{ name: "commit", description: "Write commits.", source: { type: "user", path: "/home/me/.grok/skills/commit/SKILL.md" }, userInvocable: true },
			{ name: "docs", description: "Docs.", source: { type: "user", path: "/home/me/.claude/skills/docs/SKILL.md" }, vendor: "claude", userInvocable: true, collidesWith: "docs", invocableAs: "user:docs" },
			{ name: "release", description: "", source: { type: "plugin", plugin_name: "tools", path: "/p/SKILL.md" }, userInvocable: false },
		],
		mcpServers: [
			{ name: "docs", transport: "stdio", target: "npx", source: { type: "configToml" } },
			{ name: "browser", transport: "http", target: "https://mcp.example.com/mcp?token=secret", source: { type: "claudeJson" }, vendor: "claude" },
		],
		plugins: [
			{ name: "hello", provides: { skills: 1 } },
			{ name: "foreign", provides: { skills: 2, agents: 1, mcpServers: 0, hooks: true } },
		],
	},
	servers: [{ name: "docs", command: "npx", args: ["-y", "--api-key", "secret"], env: { TOKEN: "secret" }, enabled: true, scope: "project" }],
	plugins: [
		{ status: "installed", name: "hello", version: "1.0.0", marketplace: "market" },
		{ status: "available", name: "other", description: "Other.", marketplace: "market" },
	],
	marketplaces: [{ name: "market", kind: "git", source: { url: "https://example.com/market.git" } }],
	config,
});
assert.equal(inventory.trusted, false);
assert.deepEqual(inventory.skills.map((skill) => [skill.command, skill.source]), [["/commit", "Personal"], ["/user:docs", "Personal · Claude Code"], ["", "Plugin · tools"]], "skills keep Grok's own names and sources");
assert.deepEqual(inventory.servers.map(({ name, detail, source, enabled, removable }) => ({ name, detail, source, enabled, removable })), [
	{ name: "docs", detail: "npx", source: "This project", enabled: true, removable: true },
	{ name: "browser", detail: "http · https://mcp.example.com/mcp", source: "Claude Code", enabled: true, removable: false },
	{ name: "chrome", detail: "", source: "Turned off", enabled: false, removable: false },
	{ name: "gone", detail: "", source: "Turned off", enabled: false, removable: false },
], "Grok's servers can be removed, others only turned off; turned-off servers stay listed");
assert.ok(!JSON.stringify(inventory).includes("secret"), "no argument, env value, header or query string reaches the renderer");
assert.deepEqual(inventory.plugins.map((item) => [item.name, item.installed, item.enabled]), [["hello", true, false], ["other", false, true]]);
assert.deepEqual(inventory.otherPlugins, [{ name: "foreign", detail: "2 skills, 1 agent, hooks" }], "plugins Grok finds in other tools' folders are listed apart");
assert.deepEqual(inventory.marketplaces, [{ name: "market", source: "https://example.com/market.git" }]);
console.log("PASS shape: skills, servers, plugins and marketplaces from Grok's reports");

const connectorDetails = shape({
	inspect: { mcpServers: [{ name: "imported", transport: "sse", target: "https://user:password@imported.example/mcp?api_key=private#secret", headers: { Authorization: "Bearer ${IMPORTED_TOKEN}", "X-Secret": "literal-header-secret" } }] },
	servers: [
		{ name: "local", command: "C:/Program Files/node/node.exe", args: ["-y", "@vendor/server", "--api-key=literal-argument-secret", "--token=${TOKEN}", "${ARG}", "literal-positional-secret"], env: { TOKEN: "literal-env-secret", REFERENCE: "${TOKEN}", FALLBACK: "${TOKEN:-literal-fallback-secret}" }, headers: { Authorization: "Bearer literal-bearer-secret" } },
		{ name: "remote", transport: "http", url: "https://user:password@remote.example/mcp?api_key=private#secret", headers: { Authorization: "Bearer ${TOKEN}", "X-Key": "${HEADER_TOKEN}", Cookie: "literal-cookie-secret" } },
		{ name: "inline", command: "node --token literal-command-secret" },
	], plugins: [], marketplaces: [], config: "",
});
const localConnector = connectorDetails.servers.find((item) => item.name === "local");
assert.equal(localConnector.transport, "stdio");
assert.equal(localConnector.command, "C:/Program Files/node/node.exe");
assert.deepEqual(localConnector.args, ["-y", "[hidden]", "--api-key=[hidden]", "--token=${TOKEN}", "${ARG}", "[hidden]"]);
assert.deepEqual(localConnector.env, [{ name: "TOKEN", value: "[hidden]" }, { name: "REFERENCE", value: "${TOKEN}" }, { name: "FALLBACK", value: "[hidden]" }]);
const remoteConnector = connectorDetails.servers.find((item) => item.name === "remote");
assert.equal(remoteConnector.target, "https://remote.example/mcp");
assert.deepEqual(remoteConnector.headers, [{ name: "Authorization", value: "Bearer ${TOKEN}" }, { name: "X-Key", value: "${HEADER_TOKEN}" }, { name: "Cookie", value: "[hidden]" }]);
assert.equal(connectorDetails.servers.find((item) => item.name === "imported").target, "https://imported.example/mcp");
assert.equal(connectorDetails.servers.find((item) => item.name === "inline").command, "[hidden]");
for (const secret of ["literal-", "password", "user:", "api_key=", "#secret"]) { assert.ok(!JSON.stringify(connectorDetails).includes(secret), secret); }
console.log("PASS connector details: transport, safe command/options, variable references and hidden literal settings");

assert.deepEqual(words("npx -y \"@scope/a b\" 'c d' C:\\dir"), ["npx", "-y", "@scope/a b", "c d", "C:\\dir"]);
assert.deepEqual(changeArgs({ action: "mcp-add", name: "files", transport: "stdio", target: "npx -y server", env: "A=1\n\nB=two words", scope: "project" }),
	["mcp", "add", "--scope", "project", "--transport", "stdio", "-e", "A=1", "-e", "B=two words", "files", "--", "npx", "-y", "server"], "a local server's command goes after --");
assert.deepEqual(changeArgs({ action: "mcp-add", name: "api", transport: "http", target: "https://x.example/mcp", headers: "Authorization: Bearer t" }),
	["mcp", "add", "--scope", "user", "--transport", "http", "-H", "Authorization: Bearer t", "api", "https://x.example/mcp"]);
assert.deepEqual(changeArgs({ action: "plugin-install", source: "owner/repo@v1" }), ["plugin", "install", "owner/repo@v1", "--trust"]);
assert.deepEqual(changeArgs({ action: "plugin-uninstall", name: "hello" }), ["plugin", "uninstall", "hello", "--confirm"]);
assert.deepEqual(changeArgs({ action: "marketplace-update" }), ["plugin", "marketplace", "update"]);
for (const [input, why] of [
	[{ action: "mcp-add", name: "--scope", target: "x" }, "a name that is a flag"],
	[{ action: "mcp-add", name: "a b", target: "x" }, "a name with a space"],
	[{ action: "mcp-add", name: "ok", target: "" }, "no command"],
	[{ action: "mcp-add", name: "ok", target: "x", env: "NOEQUALS" }, "an env line without ="],
	[{ action: "mcp-add", name: "ok", transport: "http", target: "file:///etc/passwd" }, "a remote address that is not http"],
	[{ action: "mcp-add", name: "ok", transport: "sse", target: "https://x", headers: "bad header" }, "a header without a colon"],
	[{ action: "plugin-install", source: "--upload-pack=evil" }, "a source that is a flag"],
	[{ action: "plugin-install", source: "a\nb" }, "a source over two lines"],
	[{ action: "plugin-enable", name: "-x" }, "a plugin name that is a flag"],
	[{ action: "constructor" }, "an inherited property is not an action"],
	[{ action: "login" }, "an action the app does not make"],
	[null, "no input"],
]) {
	assert.throws(() => changeArgs(input), undefined, why);
}
const network = { httpsProxy: "not set", httpProxy: "not set", noProxy: "not set", caCerts: "not set" };
const missing = { grok: { ok: false, error: "Missing", secret: "hidden" }, git: { code: -1, err: "hidden" }, gh: { code: -1, err: "hidden" }, ghAuth: null };
assert.deepEqual(readinessOf({ ...missing, platform: "win32" }), { grok: { ok: false, error: "Missing" }, git: { ok: false }, gh: { ok: false }, install: "irm https://x.ai/cli/install.ps1 | iex", platform: "win32", network });
assert.equal(readinessOf({ ...missing, platform: "linux" }).install, "curl -fsSL https://x.ai/cli/install.sh | bash");
const ready = { grok: { ok: true, version: "1.0.70", signedIn: true, secret: "hidden" }, git: { code: 0 }, gh: { code: 0 }, ghAuth: { code: 0, out: "hidden" }, platform: "win32" };
assert.deepEqual(readinessOf(ready), { grok: { ok: true, version: "1.0.70", signedIn: true }, git: { ok: true }, gh: { ok: true, signedIn: true }, install: "irm https://x.ai/cli/install.ps1 | iex", platform: "win32", network });
assert.deepEqual(installArgs("win32"), ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "irm https://x.ai/cli/install.ps1 | iex"]]);
assert.deepEqual(installArgs("darwin"), ["/bin/bash", ["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"]]);
assert.deepEqual(readinessOf({ ...ready, ghAuth: { code: 1, err: "Offline" } }).gh, { ok: true, signedIn: false });
assert.equal(readinessOf({ ...ready, grok: { ok: true, version: "1.0.70", signedIn: false } }).grok.signedIn, false);
console.log("PASS changeArgs and readiness: fixed Grok commands, invalid inputs refused, setup checks shape only safe fields");

const home = "C:/Users/me";
const updateAnswer = { currentVersion: "1.0.77", latestVersion: "1.0.78", updateAvailable: true, autoUpdate: true, channel: "stable", error: null, token: "hidden" };
const updateResult = (value) => ({ code: 0, out: JSON.stringify(value) });
assert.deepEqual(readinessOf({ ...ready, update: updateResult(updateAnswer) }).grok.update, { checked: true, current: "1.0.77", latest: "1.0.78", available: true, autoUpdate: true, channel: "stable" });
assert.deepEqual(readinessOf({ ...ready, update: updateResult({ ...updateAnswer, latestVersion: "1.0.77", updateAvailable: false }) }).grok.update, { checked: true, current: "1.0.77", latest: "1.0.77", available: false, autoUpdate: true, channel: "stable" });
for (const update of [
	{ ...updateResult(updateAnswer), code: 1 },
	{ code: 0, out: "not json" },
	updateResult({ ...updateAnswer, error: "Offline" }),
]) {
	assert.deepEqual(readinessOf({ ...ready, update }).grok.update, { checked: false });
}
console.log("PASS readiness update: available, current, nonzero exit, invalid JSON and CLI errors");

const inspectAnswer = {
	configSources: { layers: [{ role: "user", path: "c:/USERS/ME/.grok\\config.toml", note: "parse error" }, { role: "project", path: "C:/project/.grok/config.toml", token: "hidden" }] },
	configWarnings: [{ target: "configKey", path: "hooks", kind: "unknown-field", reason: "unrecognized config key" }, { target: "configKey", path: "privacy", kind: "unknown-field", reason: "unrecognized config key" }],
	hooks: { command: "hidden" }, permissions: ["hidden"], mcpServers: [{ token: "hidden" }], instructions: "hidden",
};
const projected = readinessOf({ ...ready, home, inspect: updateResult(inspectAnswer) });
assert.deepEqual(projected.config, { ok: true, files: [{ role: "user", path: "~/.grok/config.toml", broken: true }, { role: "project", path: "C:/project/.grok/config.toml", broken: false }], warnings: ["hooks (unrecognized config key)", "privacy (unrecognized config key)"] });
assert.ok(!JSON.stringify(projected).includes("hidden"), "only config paths and warnings reach the sheet, without inspect hooks, permissions, MCP or instructions");
assert.deepEqual(readinessOf({ ...ready, home, inspect: { code: 1, out: JSON.stringify(inspectAnswer) } }).config, { ok: false });
assert.deepEqual(readinessOf({ ...ready, home, inspect: { code: 0, out: "not json" } }).config, { ok: false });
assert.deepEqual(readinessOf({ ...ready, home, inspect: updateResult({ configSources: { layers: [] } }) }).config, { ok: true, files: [], warnings: [] });
console.log("PASS readiness config: broken files, warnings, safe projection, failed reads and absent warnings");

for (const source of ["GROK_PATH", "installer", "PATH"]) {
	assert.deepEqual(readinessOf({ ...ready, home, grokAt: { source, path: "C:/Users/me/.grok/bin/grok.exe" } }).grok.at, { source, path: "~/.grok/bin/grok.exe" });
}
assert.equal(readinessOf({ ...missing, platform: "win32", home, grokAt: { source: "PATH", path: "grok" } }).grok.at, undefined);
assert.equal(tilde("c:/USERS/ME/.grok\\config.toml", home), "~/.grok/config.toml");
assert.equal(tilde("/Users/me/.grok/config.toml", "/Users/me"), "~/.grok/config.toml");
assert.equal(tilde("D:\\outside\\config.toml", home), "D:\\outside\\config.toml");
assert.equal(tilde("C:/Users/member/config.toml", home), "C:/Users/member/config.toml", "a shared prefix is not the home folder");
console.log("PASS readiness paths: all Grok sources and home shortening with mixed case and separators");

const password = "s3cret-pass";
const apiKey = "key-value-should-not-appear";
const proxied = readinessOf({
	...ready,
	home,
	grok: { ok: true, version: "1.0.70", signedIn: true, signIn: "saved", apiKey: true, token: "SECRET" },
	env: {
		HTTPS_PROXY: `http://proxyuser:${password}@proxy.corp:8080/${password}`,
		HTTP_PROXY: "proxy.corp:8080",
		NO_PROXY: "localhost,127.0.0.1,.corp",
		NODE_EXTRA_CA_CERTS: "C:/Users/me/certs/corp.pem",
		XAI_API_KEY: apiKey,
	},
	certExists: (file) => file === "C:/Users/me/certs/corp.pem",
});
assert.equal(proxied.network.httpsProxy, "http://proxy.corp:8080");
assert.equal(proxied.network.httpProxy, "http://proxy.corp:8080");
assert.equal(proxied.network.noProxy, "localhost,127.0.0.1,.corp");
assert.equal(proxied.network.caCerts, "~/certs/corp.pem (found)");
assert.equal(proxied.grok.apiKey, true);
assert.equal(proxied.grok.signIn, "saved");
const blankKey = readinessOf({ ...ready, grok: { ok: true, version: "1.0.70", signedIn: false, signIn: "none", apiKey: "   " }, env: { XAI_API_KEY: "   ", HTTPS_PROXY: "not a url", NO_PROXY: "user:pass@proxy" } });
assert.equal(blankKey.grok.apiKey, undefined, "a blank or non-boolean API key is dropped");
assert.equal(blankKey.grok.signIn, "none");
assert.equal(blankKey.network.httpsProxy, "set");
assert.equal(blankKey.network.noProxy, "set");
assert.equal(readinessOf({ ...ready, home, env: { NODE_EXTRA_CA_CERTS: "C:/Users/me/missing.pem" }, certExists: () => false }).network.caCerts, "~/missing.pem (missing)");
const dumped = JSON.stringify(proxied) + JSON.stringify(blankKey);
assert.equal(dumped.includes(password), false, "a proxy password never reaches the setup result");
assert.equal(dumped.includes("proxyuser"), false);
assert.equal(dumped.includes(apiKey), false, "the API key value never reaches the setup result");
assert.equal(dumped.includes("SECRET"), false);
const signIn = readinessOf({ ...ready, signInMode: "key", grok: {
	...ready.grok, signIn: "none", signedIn: false, apiKey: true, keySource: "app",
	keyIgnored: true, keyUnreadable: true, keyRejected: true, key: apiKey,
} }).grok;
assert.deepEqual(signIn, {
	ok: true, version: ready.grok.version, signedIn: false, signIn: "none", apiKey: true,
	signInMode: "key", keySource: "app", keyIgnored: true, keyUnreadable: true, keyRejected: true,
});
console.log("PASS readiness network: proxy credentials stripped, blank API key dropped, certificate path only");

async function checkReadinessCalls() {
	const source = fs.readFileSync(path.join(__dirname, "../electron/customize.cjs"), "utf8");
	const load = ({ grok = ready.grok, grokFile = "grok", env = {}, beforeUpdate } = {}) => {
		const calls = [];
		const loaded = { exports: {} };
		vm.runInNewContext(source, {
			module: loaded,
			process: { platform: "win32", env },
			require: (name) => {
				if (name === "os") { return { homedir: () => home }; }
				if (name === "./agent.cjs") {
					return { grokPath: () => grokFile, folderProblem: (folder) => folder === "C:/project" ? "" : "Invalid folder", probeGrok: async () => { calls.push(["probe"]); return grok; }, signInStatus: () => ({ mode: "grok" }) };
				}
				if (name === "./redact.cjs") { return require("../electron/redact.cjs"); }
				if (name === "./git.cjs") {
					return { run: async (command, args, cwd, timeout, maxBytes) => {
						calls.push([command, [...args], cwd, timeout, maxBytes]);
						if (args[0] === "update") {
							assert.deepEqual([...args], ["update", "--check", "--json"], "readiness never updates the real CLI");
							if (beforeUpdate) { await beforeUpdate(); }
							return updateResult(updateAnswer);
						}
						return args[0] === "inspect" ? updateResult(inspectAnswer) : { code: 0, out: "" };
					} };
				}
				return require(name);
			},
		});
		return { readiness: loaded.exports.readiness, calls };
	};
	const probes = [["probe"], ["git", ["--version"], home, 30000, undefined], ["gh", ["--version"], home, 30000, undefined], ["gh", ["auth", "status"], home, 5000, undefined]];
	const light = load();
	const lightResult = await light.readiness("C:/project", false);
	assert.deepEqual(light.calls, probes, "launch readiness adds no Grok process or network check");
	assert.equal(lightResult.grok.at.source, "PATH");
	assert.equal(lightResult.grok.update, undefined);
	assert.equal(lightResult.config, undefined);
	let releaseUpdate;
	let startedUpdate;
	const updatePending = new Promise((resolve) => { releaseUpdate = resolve; });
	const updateStarted = new Promise((resolve) => { startedUpdate = resolve; });
	const full = load({ grokFile: "C:/Users/me/.grok/bin/grok.exe", beforeUpdate: () => { startedUpdate(); return updatePending; } });
	const fullPending = full.readiness("C:/project", true);
	await updateStarted;
	assert.equal(full.calls.some((call) => call[1]?.[0] === "inspect"), false, "inspect waits until the update check finishes");
	releaseUpdate();
	const fullResult = await fullPending;
	assert.deepEqual(full.calls, [...probes, ["C:/Users/me/.grok/bin/grok.exe", ["update", "--check", "--json"], home, 20000, undefined], ["C:/Users/me/.grok/bin/grok.exe", ["inspect", "--json"], "C:/project", 30000, 8 * 1024 * 1024]]);
	assert.equal(fullResult.grok.at.source, "installer");
	const fallback = load({ env: { GROK_PATH: "C:/custom/grok.exe" }, grokFile: "C:/custom/grok.exe" });
	assert.equal((await fallback.readiness("missing folder", true)).grok.at.source, "GROK_PATH");
	assert.equal(fallback.calls.at(-1)[2], home, "inspect uses home when the session folder is invalid");
	const absent = load({ grok: missing.grok });
	const absentResult = await absent.readiness("C:/project", true);
	assert.deepEqual(absent.calls, probes, "a failed Grok probe skips both full-check commands");
	assert.equal(absentResult.grok.at, undefined);
	assert.equal(absentResult.grok.update, undefined);
	assert.equal(absentResult.config, undefined);
	console.log("PASS readiness execution: light probes, sequential full checks, session cwd, home fallback and missing Grok");
}

async function checkSkillExcerpts() {
	const source = fs.readFileSync(path.join(__dirname, "../electron/customize.cjs"), "utf8");
	const cwd = path.resolve("C:/project");
	const folder = path.resolve("C:/fixture-skills/one");
	const skillFile = path.join(folder, "SKILL.md");
	const calls = [];
	let inspect = { skills: [{ name: "one", source: { path: skillFile } }] };
	let commandResult;
	let body = Buffer.from("---\nname: one\n---\n# Skill instructions\n");
	let canonicalFolder = folder;
	let canonicalFile = skillFile;
	let fileOpened = false;
	let closed = 0;
	let regularFile = true;
	let readLimit = 0;
	const loaded = { exports: {} };
	vm.runInNewContext(source, {
		module: loaded, Buffer, URL, process: { platform: "win32", env: {} },
		require(name) {
			if (name === "./agent.cjs") { return { folderProblem: (value) => value === cwd ? "" : "Invalid folder", grokPath: () => "fake-grok" }; }
			if (name === "./redact.cjs") { return require("../electron/redact.cjs"); }
			if (name === "./git.cjs") {
				return { run: async (command, args, folderArg, timeout, maxBytes) => {
					calls.push([command, [...args], folderArg, timeout, maxBytes]);
					return commandResult || { code: 0, out: JSON.stringify(inspect) };
				} };
			}
			if (name === "fs") {
				return {
					realpathSync(file) { if (file === folder) { return canonicalFolder; } if (file === skillFile) { return canonicalFile; } throw new Error("Unknown fixture path"); },
					openSync(file, mode) { assert.equal(file, canonicalFile); assert.equal(mode, "r"); fileOpened = true; return 7; },
					fstatSync(fd) { assert.equal(fd, 7); return { isFile: () => regularFile }; },
					readSync(fd, buffer, offset, length, position) { assert.equal(fd, 7); assert.equal(position, 0); readLimit = length; return body.copy(buffer, offset, 0, length); },
					closeSync(fd) { assert.equal(fd, 7); closed++; },
				};
			}
			return require(name);
		},
	});
	const skillsOnly = await loaded.exports.inventory(cwd, true);
	assert.equal(skillsOnly.ok, true);
	assert.equal(skillsOnly.skills[0].command, "/one");
	assert.equal(calls.length, 1, "slash grouping inspects skills without loading connectors or plugins");
	assert.deepEqual(calls.pop(), ["fake-grok", ["inspect", "--json"], cwd, 30000, 8 * 1024 * 1024]);
	const excerpt = loaded.exports.skillExcerpt;
	let answer = await excerpt(cwd, skillFile);
	assert.equal(answer.ok, true);
	assert.equal(answer.text, body.toString("utf8"));
	assert.equal(answer.folder, folder);
	assert.deepEqual(calls[0], ["fake-grok", ["inspect", "--json"], cwd, 30000, 8 * 1024 * 1024]);
	assert.equal(readLimit, 16 * 1024);
	assert.equal(closed, 1);
	body = Buffer.from(Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"));
	answer = await excerpt(cwd, skillFile);
	assert.equal(answer.text.split("\n").length, 80);
	assert.ok(answer.text.endsWith("line 80"));
	body = Buffer.alloc(100000, 97);
	assert.equal((await excerpt(cwd, skillFile)).text.length, 16 * 1024, "the read itself is bounded, rather than slicing an unbounded read");
	for (const target of [path.join(folder, "other.txt"), path.resolve("C:/outside/SKILL.md"), `${folder}/../one/SKILL.md`, "relative/SKILL.md"]) {
		fileOpened = false;
		assert.equal((await excerpt(cwd, target)).ok, false);
		assert.equal(fileOpened, false, "arbitrary files and traversal never get opened");
	}
	inspect = { skills: [] };
	fileOpened = false;
	assert.equal((await excerpt(cwd, skillFile)).ok, false);
	assert.equal(fileOpened, false, "inventory provenance is freshly checked on every request");
	inspect = { skills: [{ name: "one", source: { path: skillFile } }] };
	canonicalFile = path.resolve("C:/outside/SKILL.md");
	assert.equal((await excerpt(cwd, skillFile)).ok, false, "a symlink to another folder is refused");
	canonicalFile = path.join(folder, "other.txt");
	assert.equal((await excerpt(cwd, skillFile)).ok, false, "a skill-file link to an arbitrary same-folder file is refused");
	canonicalFolder = path.resolve("C:/canonical-skills/one");
	canonicalFile = path.join(canonicalFolder, "SKILL.md");
	assert.equal((await excerpt(cwd, skillFile)).folder, canonicalFolder, "an inventoried skill folder may itself be a junction");
	regularFile = false;
	assert.equal((await excerpt(cwd, skillFile)).ok, false, "only a regular skill file is read");
	regularFile = true;
	for (const result of [{ code: 1, out: "", err: "private stderr" }, { code: 0, out: "not JSON" }, { code: 0, out: JSON.stringify(inspect), truncated: true }]) {
		commandResult = result;
		answer = await excerpt(cwd, skillFile);
		assert.equal(answer.ok, false);
		assert.ok(!JSON.stringify(answer).includes("private stderr"));
	}
	assert.equal((await excerpt("invalid folder", skillFile)).ok, false);
	assert.throws(() => changeArgs({ action: "skill-enable", name: "one" }), undefined, "unsupported skill toggles are not invented");
	console.log("PASS skill excerpts: fresh inventory provenance, line/byte caps, own-file containment, symlinks and failed reads");
}

void (async () => { await checkReadinessCalls(); await checkSkillExcerpts(); })().catch((error) => { console.error(error); process.exitCode = 1; });
