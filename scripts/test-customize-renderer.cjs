const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function catalogExtrasSafe(extra) {
	return extra.split(/\r?\n/).filter((line) => line.trim()).every((line) => {
		const match = /^[^:=]+[:=]\s*(.*)$/.exec(line);
		return match && /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(match[1]);
	});
}

module.exports = async function checkCustomizeRenderer({ harness, button, textOf }) {
	const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
	const inventory = {
		ok: true,
		trusted: true,
		skills: [
			{ name: "release", command: "/release", description: "Project release checks.\nThe complete description stays available.", source: "This project", path: "C:/project/.grok/skills/release/SKILL.md", disabled: false },
			{ name: "docs", command: "/docs", description: "Personal documentation helper.", source: "Personal", path: "C:/home/.grok/skills/docs/SKILL.md", disabled: false },
			{ name: "review", command: "/user:review", description: "Review changed code.", source: "Personal · Claude Code", path: "C:/home/.claude/skills/review/SKILL.md", disabled: false },
			{ name: "ship", command: "/ship", description: "Plugin release helper.", source: "Plugin · tools", path: "C:/plugins/tools/skills/ship/SKILL.md", disabled: true },
			{ name: "pathless", command: "/pathless", source: "Personal", path: "", disabled: false },
		],
		servers: [
			{ name: "github", source: "Personal", detail: "https://api.githubcopilot.com/mcp/", target: "https://api.githubcopilot.com/mcp/", transport: "http", enabled: true, removable: true, env: [{ name: "PRIVATE_KEY", value: "Hidden" }], headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }] },
			{ name: "project-tools", source: "This project", detail: "tool.exe", target: "tool.exe", command: "tool.exe", transport: "stdio", enabled: false, removable: true, env: [], headers: [] },
		],
		plugins: [
			{ name: "ponytail", version: "2.0.0", description: "Keep changes small.", marketplace: "ponytail", installed: true, enabled: true },
			{ name: "community-helper", version: "", description: "Community helper.", marketplace: "community", installed: false, enabled: true },
			{ name: "xai-helper", version: "", description: "First-party helper.", marketplace: "xai", installed: false, enabled: true },
		],
		otherPlugins: [{ name: "claude-tools", detail: "2 skills, hooks" }],
		marketplaces: [{ name: "community", source: "community/plugins" }, { name: "xai", source: "xai-org/grok-plugins" }],
	};
	const labelled = (app, label) => {
		const visibleLabel = app.node((item) => item.type === "label" && item.props.htmlFor && textOf(item) === label);
		const node = app.node((item) => item.props["aria-label"] === label || (visibleLabel && item.props.id === visibleLabel.props.htmlFor && !item.props["aria-label"]));
		assert.ok(node, `Missing ${label}`);
		return node;
	};
	const click = (app, label) => {
		const node = button(app, label);
		assert.ok(node, `Missing button ${label}`);
		node.props.onClick();
	};
	const change = (app, label, value) => {
		const target = { value };
		labelled(app, label).props.onChange({ target, currentTarget: target });
	};
	async function open(view, width = 1400) {
		const app = harness();
		const changes = [];
		const excerpts = [];
		const opened = [];
		const runs = [];
		app.window.innerWidth = width;
		app.api.customize = async () => inventory;
		app.api.customizeChange = async (folder, input) => { changes.push({ folder, input }); return { ok: true }; };
		app.api.skillExcerpt = async (folder, skillPath) => { excerpts.push({ folder, skillPath }); return { ok: true, folder: "C:/project/.grok/skills/release", text: "# Release skill\nFirst excerpt line." }; };
		app.api.openIn = async (input) => { opened.push(input); return { ok: true }; };
		const props = { view, folder: "C:/project", live: [{ name: "github", source: "Personal", status: "connected" }], onRun: (text) => runs.push(text) };
		props.onViewChange = (next) => { props.view = next; app.customizeView(props); };
		app.customizeView(props);
		for (const label of ["Skills", "Connectors", "Plugins", ...(view === "plugins" ? ["Installed", "Discover"] : [])]) {
			assert.equal(textOf(labelled(app, label)), `${label} (…)`);
		}
		await app.settle();
		return { app, props, changes, excerpts, opened, runs };
	}

	const skill = await open("skills");
	const skillApp = skill.app;
	assert.match(textOf(labelled(skillApp, "Skills")), /\(5\)/);
	assert.match(textOf(labelled(skillApp, "Connectors")), /\(2\)/);
	assert.match(textOf(labelled(skillApp, "Plugins")), /\(\d+\)/);
	for (const group of ["This project", "Personal", "Claude Code", "Plugin · tools"]) {
		assert.equal(button(skillApp, `Toggle ${group}`).props["aria-expanded"], true);
	}
	click(skillApp, "Toggle This project");
	await skillApp.settle();
	assert.equal(button(skillApp, "Details for release"), undefined, "a collapsed group hides its rows");
	click(skillApp, "Toggle This project");
	await skillApp.settle();
	change(skillApp, "Search skills", "DOCUMENTATION");
	await skillApp.settle();
	assert.ok(button(skillApp, "Details for docs"));
	assert.equal(button(skillApp, "Details for release"), undefined, "search includes descriptions and ignores case");
	change(skillApp, "Search skills", "");
	await skillApp.settle();
	click(skillApp, "Details for release");
	await skillApp.settle();
	assert.match(textOf(labelled(skillApp, "Skill details")), /The complete description stays available/);
	assert.match(textOf(labelled(skillApp, "Skill details")), /\/release/);
	assert.match(textOf(labelled(skillApp, "Skill details")), /First excerpt line/);
	same(skill.excerpts.at(-1), { folder: "C:/project", skillPath: inventory.skills[0].path });
	assert.equal(skillApp.node((item) => item.type === "input" && item.props.type === "checkbox"), undefined, "unsupported skill switches are absent");
	click(skillApp, "Open folder");
	await skillApp.settle();
	same(skill.opened.at(-1), { target: "explorer", cwd: "C:/project/.grok/skills/release" });
	click(skillApp, "Details for pathless");
	await skillApp.settle();
	assert.match(textOf(labelled(skillApp, "Skill details")), /Not reported by Grok/);
	assert.doesNotMatch(textOf(labelled(skillApp, "Skill details")), /Reading the skill|First excerpt line/);
	assert.equal(skill.excerpts.length, 1, "a skill without a path does not request a file");
	assert.equal(skillApp.customizeModule().pluginSubtitle("ponytail", "ponytail"), "", "a plugin does not repeat its own name as its marketplace subtitle");
	click(skillApp, "New skill");
	await skillApp.settle();
	assert.ok(skillApp.node((item) => item.props.role === "dialog" && item.props["aria-label"] === "New skill"));
	assert.equal(skill.runs.length, 0, "opening the skill sheet does not send a request");
	click(skillApp, "Create skill");
	await skillApp.settle();
	same(skill.runs, ["/create-skill"]);
	skillApp.unmount();
	console.log("PASS customize skills: grouped search, collapsible sources, full details, safe excerpt and folder action");

	const connector = await open("connectors");
	const connectorApp = connector.app;
	click(connectorApp, "Details for github");
	await connectorApp.settle();
	const connectorText = textOf(labelled(connectorApp, "Connector details"));
	for (const value of ["connected", "Personal", "http", "https://api.githubcopilot.com/mcp/", "PRIVATE_KEY", "Hidden", "Authorization", "${GITHUB_TOKEN}"]) {
		assert.ok(connectorText.includes(value), `connector details show ${value}`);
	}
	assert.equal(labelled(connectorApp, "Use github").props.checked, true);
	labelled(connectorApp, "Use github").props.onChange({ target: { checked: false } });
	await connectorApp.settle();
	same(connector.changes.at(-1), { folder: "C:/project", input: { action: "mcp-disable", name: "github" } });
	connectorApp.confirmAnswer = false;
	const beforeRemove = connector.changes.length;
	click(connectorApp, "Remove github");
	await connectorApp.settle();
	assert.equal(connector.changes.length, beforeRemove, "declining removal makes no change");
	click(connectorApp, "Add connector");
	await connectorApp.settle();
	assert.ok(connectorApp.node((item) => item.props.role === "dialog" && item.props["aria-label"] === "Add connector"));
	assert.equal(button(connectorApp, "Suggested").props["aria-selected"], true);
	const catalog = connectorApp.catalog().connectorCatalog;
	assert.equal(catalog.length, 8);
	for (const entry of catalog) {
		assert.ok(catalogExtrasSafe(entry.extra), `${entry.name} must contain only environment references in extra settings`);
		assert.match(entry.source, /^https:\/\//);
	}
	for (const bad of ["Authorization: Bearer ghp_literal_token", "API_TOKEN=sk_live_literal", "X-Key: ${TOKEN}literal"]) {
		assert.equal(catalogExtrasSafe(bad), false, "the catalog check rejects literal secret values");
	}
	assert.equal(catalogExtrasSafe("TOKEN=${TOKEN}\nAuthorization: Bearer ${TOKEN}"), true);
	const github = catalog.find((entry) => entry.id === "github");
	const beforeAdd = connector.changes.length;
	click(connectorApp, "Use GitHub settings");
	await connectorApp.settle();
	assert.equal(button(connectorApp, "Custom").props["aria-selected"], true);
	assert.equal(labelled(connectorApp, "Connector name").props.value, github.id);
	assert.equal(labelled(connectorApp, "Connector transport").props.value, github.transport);
	assert.equal(labelled(connectorApp, "Address").props.value, github.target);
	assert.equal(labelled(connectorApp, "Headers").props.value, github.extra);
	assert.equal(labelled(connectorApp, "Save in").props.value, "user");
	assert.equal(connector.changes.length, beforeAdd, "choosing a suggestion only fills the review form");
	const connectorForm = connectorApp.node((item) => item.type === "form");
	connectorForm.props.onSubmit({ preventDefault() {} });
	await connectorApp.settle();
	assert.equal(connector.changes.length, beforeAdd + 1);
	same(connector.changes.at(-1).input, { action: "mcp-add", name: "github", transport: "http", target: github.target, scope: "user", headers: github.extra });
	connectorApp.unmount();
	console.log("PASS customize connectors: live details, labelled controls, catalog review before Add and reference-only secret checks");

	const plugins = await open("plugins");
	const pluginApp = plugins.app;
	assert.equal(labelled(pluginApp, "Installed").props["aria-selected"], true);
	assert.ok(button(pluginApp, "Details for ponytail"));
	assert.equal(button(pluginApp, "Details for community-helper"), undefined);
	assert.ok(textOf(pluginApp.nodes()).includes("Loaded from Claude Code"));
	const installedGroups = pluginApp.nodes().filter((item) => item.type === "button" && item.props["aria-expanded"] !== undefined);
	assert.equal(installedGroups.at(-1).props["aria-label"], "Toggle Claude Code", "read-only Claude Code plugins appear below installed Grok plugins");
	click(pluginApp, "Details for ponytail");
	await pluginApp.settle();
	assert.match(textOf(labelled(pluginApp, "Plugin details")), /Keep changes small/);
	assert.equal(labelled(pluginApp, "Use ponytail").props.checked, true);
	click(pluginApp, "Update ponytail");
	await pluginApp.settle();
	assert.equal(plugins.changes.at(-1).input.action, "plugin-update");
	click(pluginApp, "Discover");
	await pluginApp.settle();
	assert.equal(labelled(pluginApp, "Discover").props["aria-selected"], true);
	const groups = pluginApp.nodes().filter((item) => item.type === "button" && item.props["aria-expanded"] !== undefined);
	assert.match(groups[0].props["aria-label"], /xai/i, "xAI's marketplace is listed before community marketplaces");
	assert.ok(button(pluginApp, "Details for community-helper"));
	assert.equal(button(pluginApp, "Details for ponytail"), undefined);
	change(pluginApp, "Search plugins", "FIRST-PARTY");
	await pluginApp.settle();
	assert.ok(button(pluginApp, "Details for xai-helper"));
	assert.equal(button(pluginApp, "Details for community-helper"), undefined);
	click(pluginApp, "Details for xai-helper");
	await pluginApp.settle();
	pluginApp.confirmAnswer = false;
	const beforeInstall = plugins.changes.length;
	click(pluginApp, "Install xai-helper");
	await pluginApp.settle();
	assert.equal(plugins.changes.length, beforeInstall, "declining trust never installs a plugin");
	assert.match(pluginApp.confirms.at(-1), /trust|permissions/i);
	click(pluginApp, "Manage marketplaces");
	await pluginApp.settle();
	assert.ok(pluginApp.node((item) => item.props.role === "dialog" && item.props["aria-label"] === "Manage marketplaces"));
	assert.equal(plugins.changes.length, beforeInstall, "opening marketplace management makes no change");
	pluginApp.unmount();
	console.log("PASS customize plugins: Installed/Discover, marketplace grouping, details and declined trust");

	for (const view of ["skills", "connectors", "plugins"]) {
		const app = harness();
		app.settingsView({ settings: app.readSettings(), onChange() {}, onClose() {}, onCheckSetup() {}, servers: [], folder: "C:/project", onRun() {}, initialTab: view });
		await app.settle();
		const nav = app.node((item) => item.type === "nav");
		const navButtons = app.nodes(nav).filter((item) => item.type === "button");
		assert.equal(navButtons.filter((item) => textOf(item) === "Skills and tools").length, 1);
		assert.equal(navButtons.some((item) => ["Skills", "Connectors", "Plugins"].includes(textOf(item))), false);
		assert.equal(button(app, "Skills and tools").props["aria-current"], "page");
		assert.equal(app.node((item) => item.type?.name === "Customize").props.view, view, "old Settings destinations preserve their tab");
		assert.equal(navButtons.some((item) => item.props.autoFocus), false);
		click(app, "Notifications");
		await app.settle();
		assert.equal(button(app, "Skills and tools").props["aria-current"], undefined);
		assert.equal(button(app, "Notifications").props["aria-current"], "page");
		app.unmount();
	}
	console.log("PASS customize navigation: one Settings entry, preserved tab destinations and current-section focus target");

	for (const width of [680, 900, 1400]) {
		const { app } = await open("skills", width);
		click(app, "Details for release");
		await app.settle();
		labelled(app, "Skill details");
		assert.ok(app.node((item) => item.props.className === "ct-layout has-selection"));
		click(app, "Back to list");
		await app.settle();
		assert.ok(app.node((item) => item.props.className === "ct-layout"), `Back returns to the list at ${width}px`);
		assert.match(textOf(labelled(app, "Skill details")), /Choose a skill/);
		assert.ok(button(app, "Details for release"));
		app.unmount();
	}
	const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
	const narrow = /@media\s*\(max-width:\s*899px\)\s*\{([\s\S]*?)\n\}/.exec(css);
	assert.ok(narrow, "the list/detail fallback is scoped below 900px");
	assert.match(narrow[1], /\.ct-layout\.has-selection\s+\.ct-list,\s*\.ct-layout:not\(\.has-selection\)\s+\.ct-details\s*\{\s*display:\s*none/);
	assert.match(narrow[1], /\.ct-back\s*\{\s*display:\s*inline-block/);
	console.log("PASS customize narrow layout: selection and Back at 680/900/1400, with a below-900px media fallback");
};
