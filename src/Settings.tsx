import { lazy, Suspense, useEffect, useState } from "react";
import { Customize } from "./Customize";
import { DEFAULT_FILE_TYPES, PLAIN_TEXT } from "./editor-defaults";
import { mapMode, MODES, type PermissionMode, type TranscriptView } from "./types";

const EditorSettings = lazy(() => import("./EditorSettings").then((module) => ({ default: module.EditorSettings })).catch(() => ({
	default: () => <p className="note" role="alert">Editor file types could not load. Restart the app to try again.</p>,
})));

export interface AppSettings {
	appearance: "system" | "light" | "dark";
	autoSave: boolean;
	editorFileTypes: Record<string, string>;
	promptSuggestions: boolean;
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
	defaultView: TranscriptView;
	allowBypass: boolean;
	// Set once so an older saved Manual default is not applied again after this choice.
	bypassDefaultApplied: boolean;
	model: string;
	effort: string;
	sideWidth: number;
	sidebarCollapsed: boolean;
	railOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
	appearance: "system",
	autoSave: true,
	editorFileTypes: DEFAULT_FILE_TYPES,
	promptSuggestions: true,
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
	defaultMode: "Normal",
	defaultView: "normal",
	allowBypass: true,
	bypassDefaultApplied: true,
	model: "grok-4.7",
	effort: "high",
	sideWidth: 560,
	sidebarCollapsed: false,
	railOpen: true,
};

export const settingsKey = "grok-code.settings.v1";

export function readSettings(): AppSettings {
	try {
		const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
		const settings: AppSettings = saved && typeof saved === "object" ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
		const fileTypes = saved && saved.editorFileTypes;
		settings.editorFileTypes = fileTypes && typeof fileTypes === "object" && Object.getPrototypeOf(fileTypes) === Object.prototype && Object.values(fileTypes).every((value) => typeof value === "string") ? fileTypes : { ...DEFAULT_FILE_TYPES };
		settings.defaultMode = mapMode(settings.defaultMode) ?? "Normal";
		if (!["normal", "thinking", "verbose"].includes(settings.defaultView)) { settings.defaultView = "normal"; }
		return settings;
	} catch {
		return { ...DEFAULT_SETTINGS, editorFileTypes: { ...DEFAULT_FILE_TYPES } };
	}
}

export function validPrefix(value: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value) && !/^(main|master|staging|warm|prod-.*|release.*)$/i.test(value);
}

export type SettingsTab = "general" | "editor" | "notifications" | "sessions" | "skills" | "connectors" | "plugins" | "about";

export function SettingsPage({ settings, onChange, onClose, onCheckSetup, servers, folder, onRun, initialTab = "general" }: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
	onClose: () => void;
	onCheckSetup: () => void;
	servers: GrokMcpServer[];
	folder: string;
	onRun: (text: string) => void;
	initialTab?: SettingsTab;
}) {
	const [tab, setTab] = useState<SettingsTab>(initialTab);
	const [prefix, setPrefix] = useState(settings.branchPrefix);
	const [extension, setExtension] = useState("");
	const [newLanguage, setNewLanguage] = useState(PLAIN_TEXT);
	const [info, setInfo] = useState("");
	const [rules, setRules] = useState<GrokAlwaysRules[] | null>(null);
	const [rulesError, setRulesError] = useState("");
	useEffect(() => {
		void window.grokCode?.appInfo?.().then((result) => {
			if (result.ok) { setInfo(`Codewomplers Grok Desktop ${result.version} · Electron ${result.electron}`); }
		});
	}, []);
	const loadRules = () => { void window.grokCode?.alwaysRules?.().then(setRules).catch(() => setRules([])); };
	useEffect(() => { if (tab === "sessions") { loadRules(); } }, [tab]);
	const removeRule = (folder: string, command: string) => {
		void window.grokCode?.removeAlwaysRule?.(folder, command).then((result) => {
			setRulesError(result.ok ? "" : result.error || "That command could not be removed.");
			loadRules();
		});
	};
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
				{([["general", "General"], ["editor", "Editor"], ["notifications", "Notifications"], ["sessions", "Sessions"], ["skills", "Skills"], ["connectors", "Connectors"], ["plugins", "Plugins"], ["about", "About"]] as [SettingsTab, string][]).map(([id, label]) => (
					<button key={id} type="button" autoFocus={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
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
						{row("Keep awake on battery power", "When off, the hold drops while on battery. On battery, Windows may still sleep a few minutes after its own sleep timeout.", toggle("keepAwakeOnBattery", "Keep awake on battery power"))}
						{row("Auto save in the Files pane", "Save edits shortly after you stop typing.", toggle("autoSave", "Auto save"))}
						{row("Suggest your next prompt", "Show a suggested next message after Grok replies. Press Tab to use it. Predictions may use model quota.", toggle("promptSuggestions", "Suggest your next prompt"))}
						<h3>Browser</h3>
						{row("Keep cookies", "Sign-ins in the Browser pane survive restarts.", toggle("keepCookies", "Keep cookies"))}
						{row("Open links in built-in browser", "Links in the chat open in the Browser pane. Ctrl+click opens your default browser.", toggle("linksInBuiltIn", "Open links in built-in browser"))}
					</>
				)}
				{tab === "editor" && (
					<Suspense fallback={<p className="meta" role="status">Loading editor file types...</p>}>
						<EditorSettings fileTypes={settings.editorFileTypes} onChange={(fileTypes) => onChange({ editorFileTypes: fileTypes })} extension={extension} setExtension={setExtension} newLanguage={newLanguage} setNewLanguage={setNewLanguage} />
					</Suspense>
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
						{row("Default permission mode", `The mode each new session starts in. ${MODES.find((item) => item.id === settings.defaultMode)?.detail ?? ""}`, choose("defaultMode", "Default permission mode", MODES.map((item) => [item.id, item.id])))}
						{row("Transcript view", "How much each session shows until you change it with Ctrl+O. Thinking adds Grok's reasoning; Verbose also opens tool details.", choose("defaultView", "Transcript view", [["normal", "Normal"], ["thinking", "Thinking"], ["verbose", "Verbose"]]))}
						{row("Archive inactive sessions", "Archive sessions with no activity for this long. Clean worktree folders are removed; their branches stay. Pinned and running sessions stay.", choose("autoArchiveDays", "Archive inactive sessions", [[0, "Never"], [1, "1 day"], [2, "2 days"], [7, "7 days"], [14, "14 days"], [30, "30 days"]]))}
						{row("Branch prefix", "Added to the branch names of new worktree sessions.", (
							<span className="set-inline">
								<input aria-label="Branch prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} onBlur={() => { if (validPrefix(prefix) && prefix !== settings.branchPrefix) { onChange({ branchPrefix: prefix }); } }} />
								<button type="button" className="texty" disabled={!validPrefix(prefix) || prefix === settings.branchPrefix} onClick={() => onChange({ branchPrefix: prefix })}>Save</button>
							</span>
						))}
						{!validPrefix(prefix) && <p className="note">Use 1–40 letters, digits, ".", "_" or "-", not a protected name such as main.</p>}
						{row("Worktree location", "New session worktrees are created inside the project.", <code>{"<repo>/.grok/worktrees"}</code>)}
						<h3>Allowed commands</h3>
						<p className="meta">Commands you allowed with Always allow in this folder. Grok runs each one in its folder without asking, in every session. Tools you allowed last only for their conversation, so they are not listed.</p>
						{rules && !rules.length && <p className="meta">None yet.</p>}
						{rules && rules.length > 0 && (
							<div className="set-rules">
								{rules.flatMap((entry) => entry.commands.map((command) => (
									<div key={`${entry.folder}|${command}`}>
										{row(command, entry.folder, <button type="button" className="texty" aria-label={`Remove ${command} in ${entry.folder}`} onClick={() => removeRule(entry.folder, command)}>Remove</button>)}
									</div>
								)))}
							</div>
						)}
						{rulesError && <p className="note" role="alert">{rulesError}</p>}
					</>
				)}
				{(tab === "skills" || tab === "connectors" || tab === "plugins") && <Customize key={folder} view={tab} folder={folder} live={servers} onRun={onRun} />}
				{tab === "about" && (
					<>
						<h3>About</h3>
						<p>{info || "Codewomplers Grok Desktop"}</p>
						<p className="meta">Copyright (c) 2026 Codewomplers. Not affiliated with or endorsed by xAI. Grok is a trademark of its owner.</p>
						<p className="meta">Help → Check for Updates explains how this build updates.</p>
						<button type="button" className="texty" onClick={onCheckSetup}>Check setup</button>
					</>
				)}
			</div>
		</div>
	);
}
