import { useEffect, useState } from "react";
import { MODES, type PermissionMode } from "./types";

export interface AppSettings {
	appearance: "system" | "light" | "dark";
	autoSave: boolean;
	keepCookies: boolean;
	linksInBuiltIn: boolean;
	linkAsked: boolean;
	notifyPermission: "banner" | "off";
	notifyQuestion: "banner" | "off";
	notifyDone: "banner" | "off";
	attention: boolean;
	sound: "system" | "none";
	keepAwake: boolean;
	keepAwakeOnBattery: boolean;
	autoArchiveDays: number;
	branchPrefix: string;
	defaultMode: PermissionMode;
	allowBypass: boolean;
	model: string;
	effort: string;
	sideWidth: number;
	sidebarCollapsed: boolean;
	railOpen: boolean;
	modeByFolder: Record<string, PermissionMode>;
}

export const DEFAULT_SETTINGS: AppSettings = {
	appearance: "system",
	autoSave: true,
	keepCookies: true,
	linksInBuiltIn: true,
	linkAsked: false,
	notifyPermission: "banner",
	notifyQuestion: "banner",
	notifyDone: "banner",
	attention: true,
	sound: "system",
	keepAwake: true,
	keepAwakeOnBattery: true,
	autoArchiveDays: 14,
	branchPrefix: "grok",
	defaultMode: "Manual",
	allowBypass: false,
	model: "grok-4.7",
	effort: "high",
	sideWidth: 560,
	sidebarCollapsed: false,
	railOpen: true,
	modeByFolder: {},
};

export const settingsKey = "grok-code.settings.v1";

export function readSettings(): AppSettings {
	try {
		const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
		return saved && typeof saved === "object" ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function validPrefix(value: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value) && !/^(main|master|staging|warm|prod-.*|release.*)$/i.test(value);
}

type Tab = "general" | "notifications" | "sessions" | "customize" | "about";

export function SettingsPage({ settings, onChange, onClose, commands, servers }: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
	onClose: () => void;
	commands: GrokCommand[];
	servers: GrokMcpServer[];
}) {
	const [tab, setTab] = useState<Tab>("general");
	const [prefix, setPrefix] = useState(settings.branchPrefix);
	const [info, setInfo] = useState("");
	useEffect(() => {
		void window.grokCode?.appInfo?.().then((result) => {
			if (result.ok) { setInfo(`Grok Desktop ${result.version} · Electron ${result.electron}`); }
		});
	}, []);
	const row = (label: string, detail: string, control: React.ReactNode) => (
		<div className="set-row">
			<div><b>{label}</b><small>{detail}</small></div>
			{control}
		</div>
	);
	const toggle = (key: keyof AppSettings, label: string) => (
		<input type="checkbox" aria-label={label} checked={!!settings[key]} onChange={(event) => onChange({ [key]: event.target.checked } as Partial<AppSettings>)} />
	);
	const choose = <K extends keyof AppSettings>(key: K, label: string, options: [AppSettings[K], string][]) => (
		<select aria-label={label} value={String(settings[key])} onChange={(event) => {
			const picked = options.find(([value]) => String(value) === event.target.value);
			if (picked) { onChange({ [key]: picked[0] } as Partial<AppSettings>); }
		}}>
			{options.map(([value, text]) => <option key={String(value)} value={String(value)}>{text}</option>)}
		</select>
	);
	return (
		<div className="settings-page" role="dialog" aria-label="Settings">
			<nav className="settings-nav">
				<h2>Settings</h2>
				{([["general", "General"], ["notifications", "Notifications"], ["sessions", "Sessions"], ["customize", "Customize"], ["about", "About"]] as [Tab, string][]).map(([id, label]) => (
					<button key={id} type="button" className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
				))}
				<span className="spacer" />
				<button type="button" className="texty" onClick={onClose}>Done</button>
			</nav>
			<div className="settings-body">
				{tab === "general" && (
					<>
						<h3>General</h3>
						{row("Appearance", "Follow the system, or always light or dark.", choose("appearance", "Appearance", [["system", "System"], ["light", "Light"], ["dark", "Dark"]]))}
						{row("Keep computer awake while Grok works", "Prevents idle sleep while any session is working. A closed lid still sleeps.", toggle("keepAwake", "Keep computer awake while Grok works"))}
						{row("Keep awake on battery power", "When off, the hold drops while on battery.", toggle("keepAwakeOnBattery", "Keep awake on battery power"))}
						{row("Auto save in the Files pane", "Save edits shortly after you stop typing.", toggle("autoSave", "Auto save"))}
						<h3>Browser</h3>
						{row("Keep cookies", "Sign-ins in the Browser pane survive restarts.", toggle("keepCookies", "Keep cookies"))}
						{row("Open links in built-in browser", "Links in the chat open in the Browser pane. Ctrl+click opens your default browser.", toggle("linksInBuiltIn", "Open links in built-in browser"))}
					</>
				)}
				{tab === "notifications" && (
					<>
						<h3>Notifications</h3>
						{row("Permission requests", "When Grok needs approval and the window is in the background.", choose("notifyPermission", "Permission request notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Questions", "When Grok asks you to choose.", choose("notifyQuestion", "Question notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Task complete", "When a session finishes while you are not looking at it.", choose("notifyDone", "Task complete notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Draw attention", "Flash the taskbar button when Grok needs you.", toggle("attention", "Draw attention on notifications"))}
						{row("Notification sound", "The sound banners play.", choose("sound", "Notification sound", [["system", "System sound"], ["none", "None"]]))}
					</>
				)}
				{tab === "sessions" && (
					<>
						<h3>Sessions</h3>
						{row("Default permission mode", "The mode new sessions start in. A folder you used before keeps its last mode, except Plan.", choose("defaultMode", "Default permission mode", MODES.filter((item) => item.id !== "Bypass permissions" || settings.allowBypass).map((item) => [item.id, item.id])))}
						{row("Allow bypass permissions mode", "Show Bypass permissions in the mode menu.", toggle("allowBypass", "Allow bypass permissions mode"))}
						{row("Archive inactive sessions", "Archive sessions with no activity for this long. Pinned and running sessions stay.", choose("autoArchiveDays", "Archive inactive sessions", [[0, "Never"], [1, "1 day"], [2, "2 days"], [7, "7 days"], [14, "14 days"], [30, "30 days"]]))}
						{row("Branch prefix", "Added to the branch names of new worktree sessions.", (
							<span className="set-inline">
								<input aria-label="Branch prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} />
								<button type="button" className="texty" disabled={!validPrefix(prefix) || prefix === settings.branchPrefix} onClick={() => onChange({ branchPrefix: prefix })}>Save</button>
							</span>
						))}
						{!validPrefix(prefix) && <p className="note">Use 1–40 letters, digits, ".", "_" or "-", not a protected name such as main.</p>}
						{row("Worktree location", "New session worktrees are created inside the project.", <code>{"<repo>/.grok/worktrees"}</code>)}
					</>
				)}
				{tab === "customize" && (
					<>
						<h3>Connectors</h3>
						<p className="meta">MCP servers Grok loaded from its own configuration. Manage them with Grok's /plugins and its config files.</p>
						{servers.length === 0 && <p className="note">Grok has not reported any MCP servers yet. Send a message first.</p>}
						{servers.map((server) => <div className="set-row" key={server.name}><div><b>{server.name}</b><small>{server.source}</small></div><span className="meta">{server.status || "configured"}</span></div>)}
						<h3>Commands and skills</h3>
						{commands.length === 0 && <p className="note">Grok lists its commands after the first message in a session.</p>}
						{commands.map((command) => <div className="set-row" key={command.name}><div><b>/{command.name}</b><small>{command.description}</small></div></div>)}
					</>
				)}
				{tab === "about" && (
					<>
						<h3>About</h3>
						<p>{info || "Grok Desktop"}</p>
						<p className="meta">Help → Check for Updates explains how this build updates.</p>
					</>
				)}
			</div>
		</div>
	);
}
