// Skills, MCP servers and plugins, read from and changed through the Grok CLI, so Settings shows what
// Grok itself loads for a folder and every change goes through Grok's own commands.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { folderProblem, grokHome, grokPath, probeGrok } = require("./agent.cjs");
const { run } = require("./git.cjs");

const LIST_TIMEOUT = 30000;
const CHANGE_TIMEOUT = 180000;
const LIST_BYTES = 8 * 1024 * 1024;
const MISSING = "Grok is not installed, or not on PATH. Set GROK_PATH to its full path.";
// Grok admits a server's tools only when its name starts with a letter or underscore; that also keeps a name from reading as a flag.
const SERVER_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PLUGIN_NAME = /^[A-Za-z0-9][\w.:-]{0,127}$/;

// One string array from config.toml: a top-level key when section is "", else a key inside [section].
function tomlList(text, section, key) {
	const body = section
		? ((new RegExp(`^\\[${section}\\][^\\S\\n]*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text) || [])[1] || "")
		: text.split(/^\[/m)[0];
	const value = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body);
	return value ? [...value[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2]) : [];
}

const SOURCES = { user: "Personal", local: "This folder", repo: "This repository", project: "This project", bundled: "Bundled with Grok", config: "Grok config path", server: "Workspace", configToml: "Grok config", claudeJson: "Claude Code", mcpJson: ".mcp.json" };
const VENDORS = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" };

function sourceLabel(source, vendor) {
	if (source && source.plugin_name) { return `Plugin · ${source.plugin_name}`; }
	const type = String((source && source.type) || "");
	const where = SOURCES[type] || type;
	const from = VENDORS[vendor] || vendor || "";
	return from && from !== where ? `${where} · ${from}` : where;
}

// Only the program or address: arguments, query strings, env and headers can hold secrets.
function serverTarget(item) {
	const target = String(item.url || item.command || item.target || "");
	if (!/^[a-z][\w+.-]*:\/\//i.test(target)) { return target; }
	try {
		const url = new URL(target);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "";
	}
}

function shape({ inspect, servers, plugins, marketplaces, config }) {
	const skills = (inspect.skills || []).map((skill) => ({
		name: String(skill.name || ""),
		command: skill.userInvocable === false ? "" : `/${skill.invocableAs || skill.name}`,
		description: String(skill.description || ""),
		source: sourceLabel(skill.source, skill.vendor),
		path: String((skill.source && skill.source.path) || ""),
		disabled: !!skill.disabled,
	})).filter((skill) => skill.name);

	const rows = new Map();
	for (const item of servers) {
		rows.set(item.name, { name: item.name, detail: serverTarget(item), source: item.scope === "project" ? "This project" : "Grok", enabled: item.enabled !== false, removable: true });
	}
	for (const item of inspect.mcpServers || []) {
		if (!rows.has(item.name)) {
			rows.set(item.name, { name: item.name, detail: [item.transport, serverTarget(item)].filter(Boolean).join(" · "), source: sourceLabel(item.source, item.vendor), enabled: true, removable: false });
		}
	}
	// Grok drops a disabled server from inspect, so the user's off list keeps it on screen to turn back on.
	for (const name of tomlList(config, "", "disabled_mcp_servers")) {
		const row = rows.get(name);
		if (row) { row.enabled = false; } else { rows.set(name, { name, detail: "", source: "Turned off", enabled: false, removable: false }); }
	}

	const off = new Set(tomlList(config, "plugins", "disabled"));
	const own = plugins.map((item) => ({
		name: String(item.name || ""),
		version: String(item.version || ""),
		description: String(item.description || ""),
		marketplace: String(item.marketplace || ""),
		installed: item.status === "installed",
		enabled: !off.has(item.name),
	})).filter((item) => item.name);
	const ownNames = new Set(own.filter((item) => item.installed).map((item) => item.name));
	const other = (inspect.plugins || []).filter((item) => !ownNames.has(item.name)).map((item) => {
		const provides = item.provides || {};
		const parts = [[provides.skills, "skill"], [provides.agents, "agent"], [provides.mcpServers, "MCP server"]].filter(([count]) => count).map(([count, word]) => `${count} ${word}${count === 1 ? "" : "s"}`);
		if (provides.hooks) { parts.push("hooks"); }
		return { name: String(item.name || ""), detail: parts.join(", ") || "nothing loaded" };
	});

	return {
		ok: true,
		trusted: inspect.projectTrusted !== false,
		skills,
		servers: [...rows.values()],
		plugins: own,
		otherPlugins: other,
		marketplaces: marketplaces.map((item) => ({ name: String(item.name || ""), source: String((item.source && (item.source.url || item.source.repo || item.source.path)) || "") })).filter((item) => item.name),
	};
}

function lastLine(text) {
	return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || "";
}

function failure(result, what) {
	if (result.missing) { return MISSING; }
	if (result.timedOut) { return `${what} timed out.`; }
	return (lastLine(result.err) || lastLine(result.out) || `${what} failed.`).replace(/^error:\s*/i, "").slice(0, 300);
}

async function inventory(cwd) {
	const problem = folderProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	const grok = grokPath();
	const read = async (args) => {
		const result = await run(grok, args, cwd, LIST_TIMEOUT, LIST_BYTES);
		if (result.code !== 0 || result.truncated) { throw new Error(failure(result, `grok ${args.join(" ")}`)); }
		try {
			return JSON.parse(result.out);
		} catch {
			throw new Error(`Grok's answer to grok ${args.join(" ")} could not be read.`);
		}
	};
	try {
		// One at a time: run together they wait on each other's locks (8 s instead of 1 s on Grok 1.0.70).
		const inspect = await read(["inspect", "--json"]);
		const servers = await read(["mcp", "list", "--json"]);
		const plugins = await read(["plugin", "list", "--json", "--available"]);
		const marketplaces = await read(["plugin", "marketplace", "list", "--json"]);
		let config = "";
		try { config = fs.readFileSync(path.join(grokHome(), "config.toml"), "utf8"); } catch { /* no user config yet */ }
		return shape({ inspect, servers: Array.isArray(servers) ? servers : [], plugins: Array.isArray(plugins) ? plugins : [], marketplaces: Array.isArray(marketplaces) ? marketplaces : [], config });
	} catch (error) {
		return { ok: false, error: error.message };
	}
}

function pick(value, pattern, message) {
	const text = String(value ?? "").trim();
	if (!pattern.test(text)) { throw new Error(message); }
	return text;
}

const serverName = (value) => pick(value, SERVER_NAME, "Use letters, numbers, hyphens and underscores for the name.");
const pluginName = (value) => pick(value, PLUGIN_NAME, "That is not a plugin name Grok lists.");

// A repository, git URL or folder. Never a flag, and never more than one line.
function source(value) {
	const text = String(value ?? "").trim();
	if (!text || text.length > 500 || text.startsWith("-") || /[\0\r\n]/.test(text)) { throw new Error("Enter a GitHub owner/repo, a git URL or a local folder."); }
	return text;
}

function lines(text) {
	return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// The command line split into words; quotes group words with spaces.
function words(text) {
	return [...String(text || "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function addServer(input) {
	const name = serverName(input.name);
	const transport = ["http", "sse"].includes(input.transport) ? input.transport : "stdio";
	const args = ["mcp", "add", "--scope", input.scope === "project" ? "project" : "user", "--transport", transport];
	if (transport === "stdio") {
		const command = words(input.target);
		if (!command.length) { throw new Error("Enter the command that starts the server."); }
		for (const item of lines(input.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) { throw new Error("Write each environment variable on its own line as NAME=value."); }
			args.push("-e", item);
		}
		// After --, the server's own flags (such as npx -y) never reach Grok.
		return [...args, name, "--", ...command];
	}
	const url = String(input.target || "").trim();
	if (!/^https?:\/\/[^\s]+$/i.test(url)) { throw new Error("Enter the server's http:// or https:// address."); }
	for (const item of lines(input.headers)) {
		if (!/^[A-Za-z0-9-]+:\s*\S/.test(item)) { throw new Error("Write each header on its own line as Name: value."); }
		args.push("-H", item);
	}
	return [...args, name, url];
}

const CHANGES = {
	"mcp-add": addServer,
	"mcp-remove": (input) => ["mcp", "remove", serverName(input.name)],
	"mcp-enable": (input) => ["mcp", "enable", serverName(input.name)],
	"mcp-disable": (input) => ["mcp", "disable", serverName(input.name)],
	// The renderer asks before it sends this: --trust lets the plugin's hooks and MCP servers run.
	"plugin-install": (input) => ["plugin", "install", source(input.source), "--trust"],
	"plugin-uninstall": (input) => ["plugin", "uninstall", pluginName(input.name), "--confirm"],
	"plugin-enable": (input) => ["plugin", "enable", pluginName(input.name)],
	"plugin-disable": (input) => ["plugin", "disable", pluginName(input.name)],
	"plugin-update": (input) => ["plugin", "update", pluginName(input.name)],
	"marketplace-add": (input) => ["plugin", "marketplace", "add", source(input.source)],
	"marketplace-remove": (input) => ["plugin", "marketplace", "remove", source(input.source)],
	"marketplace-update": () => ["plugin", "marketplace", "update"],
};

function changeArgs(input) {
	const action = input && typeof input.action === "string" ? input.action : "";
	if (!Object.prototype.hasOwnProperty.call(CHANGES, action)) { throw new Error("This app does not make that change."); }
	return CHANGES[action](input);
}

async function change(cwd, input) {
	const problem = folderProblem(cwd);
	if (problem) { return { ok: false, error: problem }; }
	let args;
	try {
		args = changeArgs(input);
	} catch (error) {
		return { ok: false, error: error.message };
	}
	const result = await run(grokPath(), args, cwd, CHANGE_TIMEOUT);
	if (result.code !== 0) { return { ok: false, error: failure(result, "Grok") }; }
	return { ok: true, message: String(result.out || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Done." };
}

async function signOut() {
	const result = await run(grokPath(), ["logout"], os.homedir(), LIST_TIMEOUT);
	if (result.code !== 0) { return { ok: false, error: failure(result, "Signing out") }; }
	return { ok: true };
}

function readinessOf({ grok, git, gh, ghAuth, platform }) {
	return {
		grok: grok.ok ? { ok: true, version: grok.version, signedIn: grok.signedIn } : { ok: false, error: grok.error },
		git: { ok: git.code === 0 },
		gh: gh.code === 0 ? { ok: true, signedIn: !!ghAuth && ghAuth.code === 0 } : { ok: false },
		install: platform === "win32" ? "irm https://x.ai/cli/install.ps1 | iex" : "curl -fsSL https://x.ai/cli/install.sh | bash",
	};
}

async function readiness() {
	const home = os.homedir();
	const [grok, git, gh] = await Promise.all([
		probeGrok(),
		run("git", ["--version"], home, LIST_TIMEOUT),
		run("gh", ["--version"], home, LIST_TIMEOUT),
	]);
	const ghAuth = gh.code === 0 ? await run("gh", ["auth", "status"], home, 5000) : null;
	return readinessOf({ grok, git, gh, ghAuth, platform: process.platform });
}

module.exports = { inventory, change, changeArgs, signOut, shape, tomlList, words, readiness, readinessOf };
