const assert = require("assert/strict");
const { changeArgs, shape, tomlList, words, readinessOf, installArgs } = require("../electron/customize.cjs");

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
assert.deepEqual(inventory.servers, [
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
const missing = { grok: { ok: false, error: "Missing", secret: "hidden" }, git: { code: -1, err: "hidden" }, gh: { code: -1, err: "hidden" }, ghAuth: null };
assert.deepEqual(readinessOf({ ...missing, platform: "win32" }), { grok: { ok: false, error: "Missing" }, git: { ok: false }, gh: { ok: false }, install: "irm https://x.ai/cli/install.ps1 | iex", platform: "win32" });
assert.equal(readinessOf({ ...missing, platform: "linux" }).install, "curl -fsSL https://x.ai/cli/install.sh | bash");
const ready = { grok: { ok: true, version: "1.0.70", signedIn: true, secret: "hidden" }, git: { code: 0 }, gh: { code: 0 }, ghAuth: { code: 0, out: "hidden" }, platform: "win32" };
assert.deepEqual(readinessOf(ready), { grok: { ok: true, version: "1.0.70", signedIn: true }, git: { ok: true }, gh: { ok: true, signedIn: true }, install: "irm https://x.ai/cli/install.ps1 | iex", platform: "win32" });
assert.deepEqual(installArgs("win32"), ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "irm https://x.ai/cli/install.ps1 | iex"]]);
assert.deepEqual(installArgs("darwin"), ["/bin/bash", ["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"]]);
assert.deepEqual(readinessOf({ ...ready, ghAuth: { code: 1, err: "Offline" } }).gh, { ok: true, signedIn: false });
assert.equal(readinessOf({ ...ready, grok: { ok: true, version: "1.0.70", signedIn: false } }).grok.signedIn, false);
console.log("PASS changeArgs and readiness: fixed Grok commands, invalid inputs refused, setup checks shape only safe fields");
