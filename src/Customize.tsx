import { useEffect, useState } from "react";
import { askConfirm, type ConfirmAsk } from "./confirm";

export type CustomizeView = "skills" | "connectors" | "plugins";

const BROWSE_LIMIT = 50;

// Skills, connectors (MCP servers) and plugins as Grok reports them for this folder. Every change runs a Grok CLI command.
export function Customize({ view, folder, live, onRun }: {
	view: CustomizeView;
	folder: string;
	live: GrokMcpServer[];
	onRun: (text: string) => void;
}) {
	const [inventory, setInventory] = useState<GrokInventory | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [filter, setFilter] = useState("");
	const [server, setServer] = useState({ name: "", transport: "stdio" as "stdio" | "http" | "sse", target: "", extra: "", scope: "user" as "user" | "project" });
	const [pluginSource, setPluginSource] = useState("");
	const [marketSource, setMarketSource] = useState("");

	// A reload keeps the old list on screen, so a change does not jump the page back to the top.
	async function load(fresh = false) {
		if (fresh) { setInventory(null); }
		setBusy(true);
		try {
			setInventory(await window.grokCode?.customize?.(folder) ?? { ok: false, error: "The app's main process is not available." });
		} catch (error) {
			setInventory({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		setBusy(false);
	}

	useEffect(() => { void load(true); }, [folder]);
	useEffect(() => { setFilter(""); }, [view]);

	async function apply(input: GrokCustomizeChange, ask?: ConfirmAsk) {
		if (busy) { return false; }
		if (ask && !(await askConfirm(ask))) { return false; }
		setBusy(true);
		setNotice(null);
		let result: { ok: boolean; error?: string; message?: string };
		try {
			result = await window.grokCode?.customizeChange?.(folder, input) ?? { ok: false, error: "The app's main process is not available." };
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		setBusy(false);
		setNotice(result.ok ? { ok: true, text: `${(result.message || "Done").replace(/[.!]?$/, ".")} ${input.action === "mcp-add" && input.scope === "project" && inventory?.trusted === false ? "Grok loads it once you trust this folder." : "Sessions Grok starts from now on load the change."}` } : { ok: false, text: result.error || "Grok did not make the change." });
		if (result.ok) { await load(); }
		return result.ok;
	}

	const needle = filter.trim().toLowerCase();
	const matches = (...texts: string[]) => !needle || texts.some((text) => text.toLowerCase().includes(needle));
	const filterBox = (label: string) => (
		<div className="set-inline cz-tools">
			<input aria-label={label} placeholder={label} value={filter} onChange={(event) => setFilter(event.target.value)} />
			<button type="button" className="texty" disabled={busy} onClick={() => void load()}>{busy ? "Working…" : "Refresh"}</button>
		</div>
	);
	const status = notice && <p className={notice.ok ? "note" : "note bad"} role="status">{notice.text}</p>;

	if (!inventory) { return <p className="note">Asking Grok what it loads in {folder}…</p>; }
	if (!inventory.ok) {
		return (
			<>
				<p className="note bad">{inventory.error}</p>
				<button type="button" className="texty" disabled={busy} onClick={() => void load(true)}>Try again</button>
			</>
		);
	}
	const untrusted = inventory.trusted === false && (
		<p className="note">
			Grok has not trusted this folder, so it skips the folder's own skills, MCP servers and hooks.{" "}
			<button type="button" className="texty" onClick={() => onRun("/hooks-trust")}>Trust it with /hooks-trust</button>
		</p>
	);

	if (view === "skills") {
		const skills = (inventory.skills ?? []).filter((skill) => matches(skill.name, skill.description, skill.source));
		return (
			<>
				<h3>Skills</h3>
				<p className="meta">
					Every skill Grok finds for {folder}. Grok reads skill folders (a folder with a SKILL.md) from .grok/skills, .claude/skills and .agents/skills in this
					project and in your home folder, and from plugins. It reloads them when their files change.
				</p>
				<div className="set-inline cz-tools">
					<button type="button" className="texty" onClick={() => onRun("/create-skill")}>New skill with /create-skill</button>
				</div>
				{untrusted}
				{filterBox(`Filter ${inventory.skills?.length ?? 0} skills`)}
				{skills.length === 0 && <p className="note">No skills match.</p>}
				{skills.map((skill) => (
					<div className="set-row" key={`${skill.command}|${skill.path}`} title={skill.path}>
						<div><b>{skill.command || skill.name}</b><small className="cz-clamp">{skill.description}</small></div>
						<span className="meta cz-side">{skill.source}{skill.disabled ? " · off" : ""}{!skill.command && " · model only"}</span>
					</div>
				))}
			</>
		);
	}

	if (view === "connectors") {
		const statusOf = (name: string) => live.find((item) => item.name === name)?.status ?? "";
		const remote = server.transport !== "stdio";
		return (
			<>
				<h3>Connectors</h3>
				<p className="meta">MCP servers Grok loads in {folder}, from its own config.toml files, from Claude Code and Cursor settings, and from plugins.</p>
				{untrusted}
				{status}
				{(inventory.servers ?? []).length === 0 && <p className="note">Grok loads no MCP servers here.</p>}
				{(inventory.servers ?? []).map((item) => (
					<div className="set-row" key={item.name}>
						<div><b>{item.name}</b><small>{[item.detail, item.source].filter(Boolean).join(" · ")}</small></div>
						<span className="cz-side">
							{item.enabled && statusOf(item.name) && <span className="meta">{statusOf(item.name)}</span>}
							<input type="checkbox" aria-label={`Use ${item.name}`} title={item.enabled ? "On" : "Off"} checked={item.enabled} disabled={busy} onChange={() => void apply({ action: item.enabled ? "mcp-disable" : "mcp-enable", name: item.name })} />
							{item.removable && <button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "mcp-remove", name: item.name }, { title: `Remove the MCP server ${item.name} from Grok's config?`, ok: "Remove", danger: true })}>Remove</button>}
						</span>
					</div>
				))}
				<h3>Add a connector</h3>
				<form className="cz-form" onSubmit={(event) => {
					event.preventDefault();
					const extra = remote ? { headers: server.extra } : { env: server.extra };
					void apply({ action: "mcp-add", name: server.name, transport: server.transport, target: server.target, scope: server.scope, ...extra }).then((ok) => {
						if (ok) { setServer((current) => ({ ...current, name: "", target: "", extra: "" })); }
					});
				}}>
					<label htmlFor="cz-name">Name</label>
					<input id="cz-name" value={server.name} placeholder="github" onChange={(event) => setServer({ ...server, name: event.target.value })} />
					<label htmlFor="cz-type">Type</label>
					<select id="cz-type" value={server.transport} onChange={(event) => setServer({ ...server, transport: event.target.value as "stdio" | "http" | "sse" })}>
						<option value="stdio">Local command (stdio)</option>
						<option value="http">Remote server (HTTP)</option>
						<option value="sse">Remote server (SSE)</option>
					</select>
					<label htmlFor="cz-target">{remote ? "Address" : "Command"}</label>
					<input id="cz-target" value={server.target} placeholder={remote ? "https://mcp.example.com/mcp" : "npx -y @modelcontextprotocol/server-github"} onChange={(event) => setServer({ ...server, target: event.target.value })} />
					<label htmlFor="cz-extra">{remote ? "Headers" : "Environment"}</label>
					<textarea id="cz-extra" value={server.extra} placeholder={remote ? "Authorization: Bearer ${API_TOKEN}" : "GITHUB_TOKEN=${GITHUB_TOKEN}"} onChange={(event) => setServer({ ...server, extra: event.target.value })} />
					<label htmlFor="cz-scope">Save in</label>
					<select id="cz-scope" value={server.scope} onChange={(event) => setServer({ ...server, scope: event.target.value as "user" | "project" })}>
						<option value="user">Your Grok config (every folder)</option>
						<option value="project">This project's .grok/config.toml</option>
					</select>
					<span />
					<span className="set-inline"><button type="submit" className="texty" disabled={busy || !server.name.trim() || !server.target.trim()}>Add connector</button></span>
				</form>
				<p className="note">One line per {remote ? "header" : "variable"}. Grok saves values as typed; write ${"{NAME}"} to read a secret from your environment instead, above all in a project file others share.</p>
			</>
		);
	}

	const installed = (inventory.plugins ?? []).filter((item) => item.installed);
	const available = (inventory.plugins ?? []).filter((item) => !item.installed && matches(item.name, item.description, item.marketplace));
	const trustQuestion = (name: string) => `Install ${name}? Grok trusts it, so its skills, hooks and MCP servers run with your permissions. Install only plugins you trust.`;
	return (
		<>
			<h3>Installed plugins</h3>
			<p className="meta">A plugin bundles skills, commands, agents, hooks and MCP servers. Grok installs plugins from marketplaces, git repositories or folders.</p>
			{status}
			{installed.length === 0 && <p className="note">No Grok plugins are installed.</p>}
			{installed.map((item) => (
				<div className="set-row" key={item.name}>
					<div><b>{item.name}{item.version && <span className="meta"> v{item.version}</span>}</b><small>{item.marketplace || "Installed from a repository or folder"}</small></div>
					<span className="cz-side">
						<input type="checkbox" aria-label={`Use ${item.name}`} checked={item.enabled} disabled={busy} onChange={() => void apply({ action: item.enabled ? "plugin-disable" : "plugin-enable", name: item.name })} />
						<button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "plugin-update", name: item.name })}>Update</button>
						<button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "plugin-uninstall", name: item.name }, { title: `Uninstall ${item.name}?`, ok: "Uninstall", danger: true })}>Uninstall</button>
					</span>
				</div>
			))}
			<h3>Browse marketplaces</h3>
			{filterBox(`Filter ${(inventory.plugins ?? []).length - installed.length} plugins`)}
			{available.length === 0 && <p className="note">{needle ? "No plugins match." : "Add a marketplace to browse its plugins."}</p>}
			{available.slice(0, BROWSE_LIMIT).map((item) => (
				<div className="set-row" key={`${item.marketplace}|${item.name}`}>
					<div><b>{item.name}</b><small className="cz-clamp">{[item.marketplace, item.description].filter(Boolean).join(" · ")}</small></div>
					<span className="cz-side"><button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "plugin-install", source: item.name }, { title: trustQuestion(item.name), ok: "Install", danger: false })}>Install</button></span>
				</div>
			))}
			{available.length > BROWSE_LIMIT && <p className="note">{available.length - BROWSE_LIMIT} more. Filter to narrow the list.</p>}
			<form className="set-inline cz-tools" onSubmit={(event) => {
				event.preventDefault();
				void apply({ action: "plugin-install", source: pluginSource }, { title: trustQuestion(pluginSource.trim()), ok: "Install", danger: false }).then((ok) => { if (ok) { setPluginSource(""); } });
			}}>
				<input aria-label="Plugin source" placeholder="Install from owner/repo, a git URL or a folder" value={pluginSource} onChange={(event) => setPluginSource(event.target.value)} />
				<button type="submit" className="texty" disabled={busy || !pluginSource.trim()}>Install</button>
			</form>
			<h3>Marketplaces</h3>
			{(inventory.marketplaces ?? []).map((item) => (
				<div className="set-row" key={item.name}>
					<div><b>{item.name}</b><small>{item.source}</small></div>
					<span className="cz-side"><button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "marketplace-remove", source: item.name }, { title: `Remove the marketplace ${item.name}? Grok also uninstalls the plugins you installed from it.`, ok: "Remove", danger: true })}>Remove</button></span>
				</div>
			))}
			<form className="set-inline cz-tools" onSubmit={(event) => {
				event.preventDefault();
				void apply({ action: "marketplace-add", source: marketSource }).then((ok) => { if (ok) { setMarketSource(""); } });
			}}>
				<input aria-label="Marketplace source" placeholder="Add a marketplace: owner/repo, a git URL or a folder" value={marketSource} onChange={(event) => setMarketSource(event.target.value)} />
				<button type="submit" className="texty" disabled={busy || !marketSource.trim()}>Add</button>
				<button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "marketplace-update" })}>Update all</button>
			</form>
			{(inventory.otherPlugins ?? []).length > 0 && (
				<>
					<h3>Loaded from Claude Code</h3>
					<p className="meta">Grok also loads these plugins from Claude Code's plugin folders. Manage them in Claude Code.</p>
					{(inventory.otherPlugins ?? []).map((item) => (
						<div className="set-row" key={item.name}><div><b>{item.name}</b><small>{item.detail}</small></div></div>
					))}
				</>
			)}
		</>
	);
}
