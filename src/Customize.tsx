import { useEffect, useRef, useState } from "react";
import { askConfirm, type ConfirmAsk } from "./confirm";
import { connectorCatalog } from "./connector-catalog";

export type CustomizeView = "skills" | "connectors" | "plugins";
type Skill = NonNullable<GrokInventory["skills"]>[number];
type Plugin = NonNullable<GrokInventory["plugins"]>[number];
type Connector = NonNullable<GrokInventory["servers"]>[number] & {
	transport?: string; target?: string; command?: string; args?: string[];
	env?: { name: string; value: string }[]; headers?: { name: string; value: string }[];
};
type Item = { id: string; name: string; description: string; source: string; enabled: boolean; skill?: Skill; connector?: Connector; plugin?: Plugin; other?: boolean };
type Sheet = "connector" | "plugin" | "marketplaces" | "skill" | "";

export function sourceGroup(source: string): string {
	if (/^plugin\s*[·:]/i.test(source)) { return source; }
	if (/claude code/i.test(source)) { return "Claude Code"; }
	if (/this (project|folder|repository)|workspace|^\.mcp\.json$/i.test(source)) { return "This project"; }
	if (/personal|^grok(?: config(?: path)?)?$|turned off/i.test(source)) { return "Personal"; }
	return source || "Personal";
}

export function groupItems<T extends { name: string; description?: string; source?: string }>(items: T[], query: string): { name: string; items: T[] }[] {
	const needle = query.trim().toLowerCase();
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = sourceGroup(item.source || "");
		if (needle && ![item.name, item.description || "", item.source || "", group].some((text) => text.toLowerCase().includes(needle))) { continue; }
		groups.set(group, [...(groups.get(group) || []), item]);
	}
	const rank = (name: string) => /^xai(?:[ ·/._-]|$)|^x\.ai/i.test(name) ? -1 : ["This project", "Personal", "Claude Code"].indexOf(name) === -1 ? 3 : ["This project", "Personal", "Claude Code"].indexOf(name);
	return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([name, grouped]) => ({ name, items: grouped.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function pluginSubtitle(name: string, marketplace: string): string {
	return marketplace && marketplace.toLowerCase() !== name.toLowerCase() && marketplace.split(/[/:]/).pop()?.toLowerCase() !== name.toLowerCase() ? marketplace : "";
}

export function Customize({ view, folder, live, onRun, onViewChange }: {
	view: CustomizeView;
	folder: string;
	live: GrokMcpServer[];
	onRun: (text: string) => void;
	onViewChange?: (view: CustomizeView) => void;
}) {
	const [inventory, setInventory] = useState<GrokInventory | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState("");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [pluginTab, setPluginTab] = useState<"installed" | "discover">("installed");
	const [sheet, setSheet] = useState<Sheet>("");
	const [addTab, setAddTab] = useState<"suggested" | "custom">("suggested");
	const [catalogNote, setCatalogNote] = useState("");
	const [server, setServer] = useState({ name: "", transport: "stdio" as "stdio" | "http" | "sse", target: "", extra: "", scope: "user" as "user" | "project" });
	const [pluginSource, setPluginSource] = useState("");
	const [marketSource, setMarketSource] = useState("");
	const [excerpt, setExcerpt] = useState<{ ok: boolean; text?: string; folder?: string; error?: string } | null>(null);
	const request = useRef(0);
	const mounted = useRef(true);
	const changing = useRef(false);
	const currentFolder = useRef(folder);
	currentFolder.current = folder;

	async function load(fresh = false) {
		const tick = ++request.current;
		if (fresh) { setInventory(null); }
		setBusy(true);
		let result: GrokInventory;
		try {
			result = await window.grokCode?.customize?.(folder) ?? { ok: false, error: "The app's main process is not available." };
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (mounted.current && tick === request.current) { setInventory(result); setBusy(false); }
	}

	useEffect(() => {
		mounted.current = true;
		setSelectedId("");
		setSheet("");
		setNotice(null);
		void load(true);
		return () => { mounted.current = false; request.current++; };
	}, [folder]);
	useEffect(() => { setFilter(""); setSelectedId(""); setSheet(""); }, [view, pluginTab]);

	async function apply(input: GrokCustomizeChange, ask?: ConfirmAsk) {
		if (busy || changing.current) { return false; }
		const cwd = folder;
		changing.current = true;
		try {
			if (ask && !(await askConfirm(ask))) { return false; }
			if (!mounted.current || currentFolder.current !== cwd) { return false; }
			setBusy(true);
			setNotice(null);
			let result: { ok: boolean; error?: string; message?: string };
			try {
				result = await window.grokCode?.customizeChange?.(cwd, input) ?? { ok: false, error: "The app's main process is not available." };
			} catch (error) {
				result = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			if (!mounted.current || currentFolder.current !== cwd) { return false; }
			setNotice(result.ok ? { ok: true, text: `${(result.message || "Done").replace(/[.!]?$/, ".")} ${input.action === "mcp-add" && input.scope === "project" && inventory?.trusted === false ? "Grok loads it once you trust this folder." : "Sessions Grok starts from now on load the change."}` } : { ok: false, text: result.error || "Grok did not make the change." });
			if (result.ok) { await load(); } else { setBusy(false); }
			return result.ok;
		} finally { changing.current = false; }
	}

	const skills = inventory?.skills ?? [];
	const connectors = inventory?.servers ?? [];
	const installed = (inventory?.plugins ?? []).filter((item) => item.installed);
	const available = (inventory?.plugins ?? []).filter((item) => !item.installed);
	const otherPlugins = inventory?.otherPlugins ?? [];
	const statusOf = (name: string) => live.find((item) => item.name === name)?.status || "Not reported by Grok";
	const marketplaceLabel = (name: string) => {
		const source = inventory?.marketplaces?.find((item) => item.name === name)?.source || "";
		return /xai-org[/:]|x\.ai/i.test(source) && !/^xai|^x\.ai/i.test(name) ? `xAI · ${name}` : name;
	};
	const items: Item[] = view === "skills"
		? skills.map((skill) => ({ id: `skill:${skill.path}|${skill.command}|${skill.name}`, name: skill.name, description: skill.description, source: skill.source, enabled: !skill.disabled, skill }))
		: view === "connectors"
			? connectors.map((connector) => ({ id: `connector:${connector.name}`, name: connector.name, description: connector.enabled ? statusOf(connector.name) : "Turned off", source: connector.source, enabled: connector.enabled, connector }))
			: pluginTab === "discover"
				? available.map((plugin) => ({ id: `available:${plugin.marketplace}|${plugin.name}`, name: plugin.name, description: plugin.description, source: marketplaceLabel(plugin.marketplace) || "Other marketplaces", enabled: true, plugin }))
				: [...installed.map((plugin) => ({ id: `plugin:${plugin.name}`, name: plugin.name, description: plugin.description || pluginSubtitle(plugin.name, plugin.marketplace), source: marketplaceLabel(plugin.marketplace) || "Personal", enabled: plugin.enabled, plugin })), ...otherPlugins.map((plugin) => ({ id: `claude:${plugin.name}`, name: plugin.name, description: plugin.detail, source: "Claude Code", enabled: true, other: true }))];
	const selected = items.find((item) => item.id === selectedId);
	const selectedPath = selected?.skill?.path;
	useEffect(() => {
		setExcerpt(null);
		if (!selectedPath) { return; }
		let cancelled = false;
		void Promise.resolve().then(() => window.grokCode?.skillExcerpt?.(folder, selectedPath) ?? { ok: false, error: "Reopen this window to read skills." }).then((result) => {
			if (!cancelled) { setExcerpt(result); }
		}).catch(() => { if (!cancelled) { setExcerpt({ ok: false, error: "The skill could not be read." }); } });
		return () => { cancelled = true; };
	}, [folder, selectedPath]);

	async function openFolder(path: string) {
		try {
			const result = await window.grokCode?.openIn({ target: "explorer", cwd: path });
			if (!result?.ok) { setNotice({ ok: false, text: result?.error || "That folder could not be opened." }); }
		} catch { setNotice({ ok: false, text: "That folder could not be opened." }); }
	}
	async function openSource(url: string) {
		try { await window.grokCode?.openExternal(url); } catch { setNotice({ ok: false, text: "That source could not be opened." }); }
	}
	const trustQuestion = (name: string): ConfirmAsk => ({ title: `Install ${name}? Grok trusts it, so its skills, hooks and MCP servers run with your permissions. Install only plugins you trust.`, ok: "Install", danger: false });
	const status = notice && <p className={notice.ok ? "note" : "note bad"} role="status">{notice.text}</p>;
	const groups = groupItems(items, filter);
	if (view === "plugins" && pluginTab === "installed") {
		groups.sort((a, b) => Number(a.name === "Claude Code") - Number(b.name === "Claude Code"));
	}
	const kind = view === "skills" ? "Skill" : view === "connectors" ? "Connector" : "Plugin";
	const remote = server.transport !== "stdio";
	const details = selected && (
		<>
			<button type="button" className="texty ct-back" onClick={() => setSelectedId("")}>Back to list</button>
			<h3>{selected.name}</h3>
			<p className="ct-description">{selected.description || "No description provided."}</p>
			<dl className="ct-facts"><dt>Source</dt><dd>{selected.source}</dd></dl>
			{selected.skill && <>
				<dl className="ct-facts"><dt>Command</dt><dd><code>{selected.skill.command || "Available to the model only"}</code></dd><dt>File</dt><dd><code>{selected.skill.path || "Not reported by Grok"}</code></dd><dt>Status</dt><dd>{selected.skill.disabled ? "Turned off" : "Available"}</dd></dl>
				{excerpt?.ok && excerpt.folder && <button type="button" className="texty" onClick={() => void openFolder(excerpt.folder!)}>Open folder</button>}
				<h4>SKILL.md preview</h4>
				{!excerpt && <p className="meta">Reading the skill…</p>}
				{excerpt?.error && <p className="note bad">{excerpt.error}</p>}
				{excerpt?.ok && <pre className="ct-excerpt">{excerpt.text}</pre>}
				<p className="meta">Grok reloads skills when their files change. Move or remove this skill in its folder to manage it.</p>
			</>}
			{selected.connector && <>
				<dl className="ct-facts"><dt>Status</dt><dd>{selected.enabled ? statusOf(selected.name) : "Turned off"}</dd><dt>Transport</dt><dd>{selected.connector.transport || "Not reported by Grok"}</dd><dt>{selected.connector.transport === "stdio" ? "Command" : "Address"}</dt><dd><code>{selected.connector.target || selected.connector.command || selected.connector.detail || "Not reported by Grok"}</code></dd>
					{!!selected.connector.args?.length && <><dt>Arguments</dt><dd><code>{selected.connector.args.join(" ")}</code></dd></>}
				</dl>
				{([['Environment', selected.connector.env], ['Headers', selected.connector.headers]] as const).map(([label, pairs]) => pairs?.length ? <div key={label}><h4>{label}</h4><dl className="ct-facts">{pairs.map((pair) => <div className="ct-setting" key={pair.name}><dt><code>{pair.name}</code></dt><dd><code>{pair.value}</code></dd></div>)}</dl></div> : null)}
				<h4>Tools</h4><p className="meta">Grok does not report a tool list for this connector.</p>
				<div className="ct-actions"><label className="ct-toggle"><input type="checkbox" aria-label={`Use ${selected.name}`} checked={selected.enabled} disabled={busy} onChange={() => void apply({ action: selected.enabled ? "mcp-disable" : "mcp-enable", name: selected.name })} />Use {selected.name}</label>
					{selected.connector.removable && <button type="button" className="texty" aria-label={`Remove ${selected.name}`} disabled={busy} onClick={() => void apply({ action: "mcp-remove", name: selected.name }, { title: `Remove the MCP server ${selected.name} from Grok's config?`, ok: "Remove", danger: true })}>Remove</button>}
				</div>
			</>}
			{selected.plugin && <>
				<dl className="ct-facts">{pluginSubtitle(selected.name, selected.plugin.marketplace) && <><dt>Marketplace</dt><dd>{selected.plugin.marketplace}</dd></>}{selected.plugin.version && <><dt>Version</dt><dd>{selected.plugin.version}</dd></>}</dl>
				{selected.plugin.installed ? <div className="ct-actions"><label className="ct-toggle"><input type="checkbox" aria-label={`Use ${selected.name}`} checked={selected.enabled} disabled={busy} onChange={() => void apply({ action: selected.enabled ? "plugin-disable" : "plugin-enable", name: selected.name })} />Use {selected.name}</label>
					<button type="button" className="texty" aria-label={`Update ${selected.name}`} disabled={busy} onClick={() => void apply({ action: "plugin-update", name: selected.name })}>Update</button>
					<button type="button" className="texty" aria-label={`Uninstall ${selected.name}`} disabled={busy} onClick={() => void apply({ action: "plugin-uninstall", name: selected.name }, { title: `Uninstall ${selected.name}?`, ok: "Uninstall", danger: true })}>Uninstall</button>
				</div> : <button type="button" className="texty" aria-label={`Install ${selected.name}`} disabled={busy} onClick={() => void apply({ action: "plugin-install", source: selected.name }, trustQuestion(selected.name))}>Install</button>}
			</>}
			{selected.other && <p className="meta">Loaded from Claude Code. Manage this plugin in Claude Code.</p>}
		</>
	);

	return (
		<div className="ct-page">
			<header className="ct-header"><h2>Skills and tools</h2><p className="meta">Manage what Grok loads for this folder.</p></header>
			<div className="ct-tabs" role="tablist" aria-label="Skills and tools">
				{([['skills', 'Skills', skills.length], ['connectors', 'Connectors', connectors.length], ['plugins', 'Plugins', installed.length + otherPlugins.length]] as const).map(([id, label, count]) => <button type="button" role="tab" aria-label={label} aria-selected={view === id} className={view === id ? "on" : ""} key={id} onClick={() => onViewChange?.(id)}>{label} ({count})</button>)}
			</div>
			{inventory?.trusted === false && <p className="note">Grok has not trusted this folder, so it skips the folder's own skills, MCP servers and hooks. <button type="button" className="texty" onClick={() => onRun("/hooks-trust")}>Trust it with /hooks-trust</button></p>}
			{status}
			{!inventory && <p className="note">Asking Grok what it loads in {folder}…</p>}
			{inventory && !inventory.ok && <p className="note bad">{inventory.error}</p>}
			<div className="ct-toolbar"><input aria-label={`Search ${view}`} placeholder={`Search ${view}`} value={filter} onChange={(event) => setFilter(event.target.value)} /><button type="button" className="texty" disabled={busy} onClick={() => void load()}>{busy ? "Working…" : "Refresh"}</button><button type="button" className="texty" disabled={!inventory?.ok} onClick={() => { setNotice(null); setSheet(view === "skills" ? "skill" : view === "connectors" ? "connector" : "plugin"); if (view === "connectors") { setAddTab("suggested"); } }}>{view === "skills" ? "New skill" : view === "connectors" ? "Add connector" : "Install plugin"}</button></div>
			{view === "plugins" && <div className="ct-subtabs" role="tablist" aria-label="Plugin lists"><button type="button" role="tab" aria-label="Installed" aria-selected={pluginTab === "installed"} className={pluginTab === "installed" ? "on" : ""} onClick={() => setPluginTab("installed")}>Installed ({installed.length + otherPlugins.length})</button><button type="button" role="tab" aria-label="Discover" aria-selected={pluginTab === "discover"} className={pluginTab === "discover" ? "on" : ""} onClick={() => setPluginTab("discover")}>Discover ({available.length})</button><button type="button" className="texty" onClick={() => { setNotice(null); setSheet("marketplaces"); }}>Manage marketplaces</button></div>}
			<div className={selected ? "ct-layout has-selection" : "ct-layout"}>
				<div className="ct-list" aria-label={`${kind} list`}>
					{inventory?.ok && !groups.length && <p className="meta">{filter ? "No matches." : `No ${view === "plugins" && pluginTab === "discover" ? "marketplace plugins" : view} found.`}</p>}
					{groups.map((group) => {
						const key = `${view}:${pluginTab}:${group.name}`;
						return <section className="ct-group" key={group.name}><button type="button" className="ct-group-heading" aria-label={`Toggle ${group.name}`} aria-expanded={!collapsed[key]} onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}><span>{collapsed[key] ? "▸" : "▾"} {group.name}</span><span>{group.items.length}</span></button>
							{view === "plugins" && pluginTab === "installed" && group.name === "Claude Code" && <p className="meta">Loaded from Claude Code. Manage these plugins in Claude Code.</p>}
							{!collapsed[key] && group.items.map((item) => <button type="button" className={selectedId === item.id ? "ct-item on" : "ct-item"} aria-label={`Details for ${item.name}`} aria-pressed={selectedId === item.id} key={item.id} onClick={() => setSelectedId(item.id)}><span className={item.enabled ? "ct-dot on" : "ct-dot"} role="img" aria-label={item.enabled ? "On" : "Off"} /><span><b>{item.name}</b><small>{item.description || "No description provided."}</small></span></button>)}
						</section>;
					})}
				</div>
				<section className="ct-details" aria-label={`${kind} details`}>{details || <p className="meta">Choose {view === "skills" ? "a skill" : view === "connectors" ? "a connector" : "a plugin"} to see its details.</p>}</section>
			</div>
			{sheet && <div className="overlay ct-overlay" onClick={() => { if (!busy) { setSheet(""); } }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); setSheet(""); } }}><div className="sheet ct-sheet" role="dialog" aria-modal="true" aria-label={sheet === "connector" ? "Add connector" : sheet === "plugin" ? "Install plugin" : sheet === "marketplaces" ? "Manage marketplaces" : "New skill"} onClick={(event) => event.stopPropagation()}>
				<div className="ct-sheet-header"><h2>{sheet === "connector" ? "Add connector" : sheet === "plugin" ? "Install plugin" : sheet === "marketplaces" ? "Manage marketplaces" : "New skill"}</h2><button type="button" className="texty" aria-label="Close sheet" autoFocus disabled={busy} onClick={() => setSheet("")}>Close</button></div>
				{status}
				{sheet === "skill" && <><p>Grok can help write a new skill for you. The request opens in your current conversation.</p><button type="button" className="texty" onClick={() => { setSheet(""); onRun("/create-skill"); }}>Create skill</button></>}
				{sheet === "connector" && <>
					<div className="ct-tabs" role="tablist" aria-label="Add connector"><button type="button" role="tab" aria-selected={addTab === "suggested"} onClick={() => setAddTab("suggested")}>Suggested</button><button type="button" role="tab" aria-selected={addTab === "custom"} onClick={() => setAddTab("custom")}>Custom</button></div>
					{addTab === "suggested" ? <div className="ct-catalog">{connectorCatalog.map((entry) => <article key={entry.id}><h3>{entry.name}</h3><small className="meta">{entry.vendor}</small><p>{entry.description}</p><p className="meta">{entry.note}</p><div className="ct-actions"><button type="button" className="texty" aria-label={`Use ${entry.name} settings`} onClick={() => { setServer((current) => ({ ...current, name: entry.id, transport: entry.transport, target: entry.target, extra: entry.extra })); setCatalogNote(entry.note); setAddTab("custom"); }}>Review settings</button><button type="button" className="texty" onClick={() => void openSource(entry.source)}>Source</button></div></article>)}</div> : <>
						{catalogNote && <p className="note">{catalogNote}</p>}
						<form className="cz-form" aria-label="Connector settings" onSubmit={(event) => { event.preventDefault(); if (!server.name.trim() || !server.target.trim()) { return; } void apply({ action: "mcp-add", name: server.name, transport: server.transport, target: server.target, scope: server.scope, ...(remote ? { headers: server.extra } : { env: server.extra }) }).then((ok) => { if (ok) { setSheet(""); setServer((current) => ({ ...current, name: "", target: "", extra: "" })); setCatalogNote(""); } }); }}>
							<label htmlFor="ct-name">Name</label><input id="ct-name" aria-label="Connector name" autoFocus value={server.name} onChange={(event) => setServer({ ...server, name: event.target.value })} />
							<label htmlFor="ct-transport">Transport</label><select id="ct-transport" aria-label="Connector transport" value={server.transport} onChange={(event) => setServer({ ...server, transport: event.target.value as "stdio" | "http" | "sse" })}><option value="stdio">Local command (stdio)</option><option value="http">Remote server (HTTP)</option><option value="sse">Remote server (SSE)</option></select>
							<label htmlFor="ct-target">{remote ? "Address" : "Command"}</label><input id="ct-target" aria-label="Connector target" value={server.target} onChange={(event) => setServer({ ...server, target: event.target.value })} />
							<label htmlFor="ct-extra">{remote ? "Headers" : "Environment"}</label><textarea id="ct-extra" aria-label="Connector extras" rows={3} value={server.extra} placeholder={remote ? "Authorization: Bearer ${API_TOKEN}" : "GITHUB_TOKEN=${GITHUB_TOKEN}"} onChange={(event) => setServer({ ...server, extra: event.target.value })} />
							<label htmlFor="ct-scope">Save in</label><select id="ct-scope" aria-label="Connector scope" value={server.scope} onChange={(event) => setServer({ ...server, scope: event.target.value as "user" | "project" })}><option value="user">Your Grok config (every folder)</option><option value="project">This project's .grok/config.toml</option></select><span /><button type="submit" className="texty" disabled={busy || !server.name.trim() || !server.target.trim()}>Add connector</button>
						</form><p className="meta">One line per {remote ? "header" : "variable"}. Use ${"{NAME}"} references for secrets, especially in a shared project file.</p>
					</>}
				</>}
				{sheet === "plugin" && <form className="ct-install" onSubmit={(event) => { event.preventDefault(); if (!pluginSource.trim()) { return; } void apply({ action: "plugin-install", source: pluginSource }, trustQuestion(pluginSource.trim())).then((ok) => { if (ok) { setPluginSource(""); setSheet(""); } }); }}><label htmlFor="ct-plugin-source">Repository, Git URL or folder</label><input id="ct-plugin-source" aria-label="Plugin source" autoFocus value={pluginSource} onChange={(event) => setPluginSource(event.target.value)} placeholder="owner/repo" /><button type="submit" className="texty" disabled={busy || !pluginSource.trim()}>Install</button></form>}
				{sheet === "marketplaces" && <>
					{inventory?.marketplaces?.map((item) => <div className="ct-marketplace" key={item.name}><div><b>{item.name}</b><p className="meta">{item.source}</p></div><button type="button" className="texty" aria-label={`Remove marketplace ${item.name}`} disabled={busy} onClick={() => void apply({ action: "marketplace-remove", source: item.name }, { title: `Remove the marketplace ${item.name}? Grok also uninstalls the plugins you installed from it.`, ok: "Remove", danger: true })}>Remove</button></div>)}
					<form className="ct-install" onSubmit={(event) => { event.preventDefault(); if (!marketSource.trim()) { return; } void apply({ action: "marketplace-add", source: marketSource }).then((ok) => { if (ok) { setMarketSource(""); } }); }}><label htmlFor="ct-market-source">Repository, Git URL or folder</label><input id="ct-market-source" aria-label="Marketplace source" value={marketSource} onChange={(event) => setMarketSource(event.target.value)} placeholder="owner/repo" /><div className="ct-actions"><button type="submit" className="texty" disabled={busy || !marketSource.trim()}>Add marketplace</button><button type="button" className="texty" disabled={busy} onClick={() => void apply({ action: "marketplace-update" })}>Update all</button></div></form>
				</>}
			</div></div>}
		</div>
	);
}
