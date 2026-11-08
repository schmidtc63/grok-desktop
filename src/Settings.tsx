import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Customize } from "./Customize";
import { keyLabel } from "./data";
import { DEFAULT_FILE_TYPES, PLAIN_TEXT } from "./editor-defaults";
import { mapMode, MODES, validMachineName, type PermissionMode, type TranscriptView } from "./types";
import { SavedPromptsSettings } from "./SavedPromptsSettings";
import { normalizeSavedPrompts, type SavedPrompt } from "./saved-prompts";
import { askConfirm } from "./confirm";
import { Icon } from "./Icon";

const EditorSettings = lazy(() => import("./EditorSettings").then((module) => ({ default: module.EditorSettings })).catch(() => ({
	default: () => <p className="note" role="alert">Editor file types could not load. Restart the app to try again.</p>,
})));

export interface AppSettings {
	appearance: "system" | "light" | "dark";
	autoSave: boolean;
	terminalScreenReader: boolean;
	editorFileTypes: Record<string, string>;
	promptSuggestions: boolean;
	savedPrompts: SavedPrompt[];
	cursorMachines: { name: string; repo: string }[];
	keepCookies: boolean;
	linksInBuiltIn: boolean;
	browserControl: boolean;
	linkAsked: boolean;
	notifyPermission: "banner" | "off";
	notifyQuestion: "banner" | "off";
	notifyDone: "banner" | "off";
	notifyPr: "banner" | "off";
	attention: boolean;
	sound: "system" | "none";
	keepAwake: boolean;
	keepAwakeOnBattery: boolean;
	autoArchiveDays: number;
	acceptLocalTurns: boolean;
	branchPrefix: string;
	defaultMode: PermissionMode;
	defaultView: TranscriptView;
	allowBypass: boolean;
	// Set once so an older saved Manual default is not applied again after this choice.
	bypassDefaultApplied: boolean;
	model: string;
	effort: string;
	sideWidth: number;
	sidebarWidth: number;
	railWidth: number;
	sidebarCollapsed: boolean;
	railOpen: boolean;
	diffView: "unified" | "split";
}

export const DEFAULT_SETTINGS: AppSettings = {
	appearance: "system",
	autoSave: true,
	terminalScreenReader: false,
	editorFileTypes: DEFAULT_FILE_TYPES,
	promptSuggestions: true,
	savedPrompts: [],
	cursorMachines: [],
	keepCookies: true,
	linksInBuiltIn: true,
	browserControl: false,
	linkAsked: false,
	notifyPermission: "banner",
	notifyQuestion: "banner",
	notifyDone: "banner",
	notifyPr: "banner",
	attention: true,
	sound: "system",
	keepAwake: true,
	keepAwakeOnBattery: true,
	autoArchiveDays: 14,
	acceptLocalTurns: false,
	branchPrefix: "grok",
	defaultMode: "Normal",
	defaultView: "normal",
	allowBypass: true,
	bypassDefaultApplied: true,
	model: "grok-4.7",
	effort: "high",
	sideWidth: 560,
	sidebarWidth: 268,
	railWidth: 280,
	sidebarCollapsed: false,
	railOpen: true,
	diffView: "unified",
};

export const settingsKey = "grok-code.settings.v1";

export function normalizeCursorMachines(value: unknown): AppSettings["cursorMachines"] {
	const machines: AppSettings["cursorMachines"] = [];
	if (!Array.isArray(value)) { return machines; }
	const seen = new Set<string>();
	for (const entry of value) {
		const name = entry?.name;
		const repo = typeof entry?.repo === "string" ? entry.repo.trim().toLowerCase() : "";
		if (!validMachineName(name) || !repo) { continue; }
		const key = JSON.stringify([name, repo]);
		if (seen.has(key)) { continue; }
		seen.add(key);
		machines.push({ name, repo });
		if (machines.length === 20) { break; }
	}
	return machines;
}

export function readSettings(): AppSettings {
	try {
		const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
		const settings: AppSettings = saved && typeof saved === "object" ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
		const fileTypes = saved && saved.editorFileTypes;
		settings.editorFileTypes = fileTypes && typeof fileTypes === "object" && Object.getPrototypeOf(fileTypes) === Object.prototype && Object.values(fileTypes).every((value) => typeof value === "string") ? fileTypes : { ...DEFAULT_FILE_TYPES };
		settings.defaultMode = mapMode(settings.defaultMode) ?? "Normal";
		if (!["normal", "thinking", "verbose"].includes(settings.defaultView)) { settings.defaultView = "normal"; }
		if (settings.diffView !== "split") { settings.diffView = "unified"; }
		if (!Number.isFinite(settings.sidebarWidth)) { settings.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth; }
		if (!Number.isFinite(settings.railWidth)) { settings.railWidth = DEFAULT_SETTINGS.railWidth; }
		settings.savedPrompts = normalizeSavedPrompts(settings.savedPrompts);
		settings.cursorMachines = normalizeCursorMachines(settings.cursorMachines);
		return settings;
	} catch {
		return { ...DEFAULT_SETTINGS, editorFileTypes: { ...DEFAULT_FILE_TYPES } };
	}
}

export function validPrefix(value: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value) && !/^(main|master|staging|warm|prod-.*|release.*)$/i.test(value);
}

export type SettingsTab = "general" | "editor" | "notifications" | "sessions" | "prompts" | "skills" | "connectors" | "plugins" | "about";

const SIGN_IN_ERRORS = new Set([
	"Grok is still answering. Press Stop or wait, then save.",
	"Grok is still answering. Press Stop or wait, then remove the key.",
	"Grok couldn't be checked, so nothing was saved. Try again.",
	"Choose Grok sign-in or an xAI API key.",
	"Enter an API key of 1 to 512 characters with no spaces.",
	"This computer has no keyring the app can use, so the key can't be saved. Set XAI_API_KEY in your environment instead.",
	"Enter an API key to use API-key mode.",
	"The sign-in choice couldn't be saved.",
	"The API key couldn't be encrypted.",
]);

export function SettingsPage({ settings, onChange, onClose, onCheckSetup, servers, folder, onRun, signInStatus, signInCheck, onSignInChanged, cloudKeyStatus, initialTab = "general" }: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => boolean;
	onClose: () => void;
	onCheckSetup: () => void;
	servers: GrokMcpServer[];
	folder: string;
	onRun: (text: string) => void;
	signInStatus?: GrokSignInStatus;
	signInCheck?: GrokReadiness["grok"];
	onSignInChanged?: () => void;
	cloudKeyStatus?: CursorKeyStatus;
	initialTab?: SettingsTab;
}) {
	const [tab, setTab] = useState<SettingsTab>(initialTab);
	const toolsOpen = tab === "skills" || tab === "connectors" || tab === "plugins";
	const section = toolsOpen ? "skills" : tab;
	const selectedButton = useRef<HTMLButtonElement | null>(null);
	useEffect(() => { selectedButton.current?.focus(); }, [section]);
	const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
	const prefix = prefixDraft ?? settings.branchPrefix;
	const prefixInvalid = !validPrefix(prefix);
	const [saveNotice, setSaveNotice] = useState<{ key: keyof AppSettings; ok: boolean } | null>(null);
	const [extension, setExtension] = useState("");
	const [newLanguage, setNewLanguage] = useState(PLAIN_TEXT);
	const [info, setInfo] = useState("");
	const [rules, setRules] = useState<GrokAlwaysRules[] | null>(null);
	const [rulesError, setRulesError] = useState("");
	const [signInChoice, setSignInChoice] = useState<GrokSignInStatus["mode"] | null>(null);
	const [replaceKey, setReplaceKey] = useState(false);
	const [signInBusy, setSignInBusy] = useState(false);
	const [signInNotice, setSignInNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const keyInput = useRef<HTMLInputElement | null>(null);
	const signInPending = useRef(false);
	const cursorKeyInput = useRef<HTMLInputElement | null>(null);
	const cursorKeyPending = useRef(false);
	const [cursorKeyBusy, setCursorKeyBusy] = useState(false);
	const [cursorKeyNotice, setCursorKeyNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [machineHelpNotice, setMachineHelpNotice] = useState("");
	const signInOpen = useRef(tab === "general");
	useEffect(() => {
		signInOpen.current = tab === "general";
		return () => { signInOpen.current = false; };
	}, [tab]);
	const signInMode = signInChoice ?? signInStatus?.mode ?? "grok";
	const showKeyInput = signInMode === "key" && signInStatus?.keyring && (replaceKey || !signInStatus.keyReadable);
	async function changeSignIn(mode: GrokSignInStatus["mode"] | "remove", useSavedKey = false) {
		if (!signInStatus || signInPending.current) { return; }
		const field = keyInput.current;
		const needsKey = mode === "key" && !useSavedKey && showKeyInput;
		if (needsKey && !field?.value.trim()) {
			setSignInNotice({ ok: false, text: "Enter an xAI API key." });
			return;
		}
		const api = window.grokCode;
		if (mode === "remove" ? !api?.removeSignInKey : !api?.saveSignIn) {
			if (field) { field.value = ""; }
			setSignInNotice({ ok: false, text: "Reopen this window to change how Grok signs in." });
			return;
		}
		signInPending.current = true;
		setSignInBusy(true);
		setSignInNotice(null);
		try {
			const accepted = await askConfirm({ title: "Change how Grok signs in?", body: "Every session's Grok stops, and Grok's background commands and scheduled loops stop.", ok: mode === "remove" ? "Remove" : "Continue", danger: mode === "remove" });
			if (!accepted || !signInOpen.current) { return; }
			let result: { ok: boolean; error?: string; needsSignOut?: boolean } | undefined;
			if (mode === "remove") {
				result = await api?.removeSignInKey?.();
			} else {
				const save = (confirmed = false) => {
					const key = needsKey && field === keyInput.current ? field?.value.trim() : undefined;
					if (needsKey && !key) { return { ok: false, error: "Enter an xAI API key." }; }
					return api?.saveSignIn?.({ mode, ...(key ? { key } : {}) }, confirmed ? { signOutConfirmed: true } : undefined);
				};
				result = await save();
				if (mode === "key" && result?.needsSignOut && signInOpen.current) {
					const signOut = await askConfirm({ title: "Sign out of Grok so the API key is used?", body: "This signs Grok out on this computer, in a terminal too. Grok only uses the key when no Grok sign-in is saved. To use your Grok sign-in again later, choose Grok sign-in and sign in.", ok: "Sign out and save", danger: true });
					if (!signOut || !signInOpen.current) { return; }
					result = await save(true);
				}
			}
			if (result?.ok) {
				onSignInChanged?.();
				setSignInChoice(null);
				setReplaceKey(false);
				setSignInNotice({ ok: true, text: mode === "remove" ? "API key removed." : "Sign-in settings saved." });
			} else if (signInOpen.current) {
				const error = result?.error;
				setSignInNotice({ ok: false, text: error && SIGN_IN_ERRORS.has(error) ? error : "The sign-in change could not be saved. Try again." });
			}
		} catch {
			setSignInNotice({ ok: false, text: "The sign-in change could not be saved. Try again." });
		} finally {
			if (field) { field.value = ""; }
			signInPending.current = false;
			setSignInBusy(false);
		}
	}
	async function changeCursorKey(remove: boolean) {
		if (!cloudKeyStatus || cursorKeyPending.current) { return; }
		const api = window.grokCode;
		const field = cursorKeyInput.current;
		const key = field?.value.trim() ?? "";
		if (!remove && !key) { setCursorKeyNotice({ ok: false, text: "Enter a Cursor API key." }); return; }
		cursorKeyPending.current = true;
		setCursorKeyBusy(true);
		setCursorKeyNotice(null);
		const fallback = "The Cursor key change could not be saved. Try again.";
		try {
			const result = await (remove ? api?.cloudKeyRemove?.() : api?.cloudKeySave?.(key));
			setCursorKeyNotice(result?.ok
				? { ok: true, text: remove ? "Cursor API key removed." : "Cursor API key saved." }
				: { ok: false, text: result?.error || fallback });
		} catch {
			setCursorKeyNotice({ ok: false, text: fallback });
		} finally {
			if (field) { field.value = ""; }
			cursorKeyPending.current = false;
			setCursorKeyBusy(false);
		}
	}
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
	function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
		const ok = onChange({ [key]: value } as Partial<AppSettings>);
		setSaveNotice({ key, ok });
		return ok;
	}
	function savePrefix() {
		if (prefixDraft === null || prefixInvalid) { return; }
		const retry = saveNotice?.key === "branchPrefix" && !saveNotice.ok;
		if ((prefix !== settings.branchPrefix || retry) && !saveSetting("branchPrefix", prefix)) { return; }
		setPrefixDraft(null);
	}
	const saved = (key: keyof AppSettings) => (
		<span role="status" className={`set-status${saveNotice?.ok ? "" : " bad"}`}>
			{saveNotice?.key === key && (saveNotice.ok ? <><Icon name="check" /> Saved</> : "Not saved.")}
		</span>
	);
	const toggle = (key: keyof AppSettings, label: string) => (
		<span className="set-inline">
			{saved(key)}
			<input type="checkbox" role="switch" className="set-switch" aria-label={label} checked={!!settings[key]} onChange={(event) => saveSetting(key, event.target.checked)} />
		</span>
	);
	const choose = <K extends keyof AppSettings>(key: K, label: string, options: [AppSettings[K], string][]) => (
		<span className="set-inline">
			{saved(key)}
			<select aria-label={label} value={String(settings[key])} onChange={(event) => {
				const picked = options.find(([value]) => String(value) === event.target.value);
				if (picked) { saveSetting(key, picked[0]); }
			}}>
				{options.map(([value, text]) => <option key={String(value)} value={String(value)}>{text}</option>)}
			</select>
		</span>
	);
	const copyMachineCommand = (command: string) => (
		<><code>{command}</code> <button type="button" className="texty" aria-label={`Copy ${command}`} onClick={async () => {
			try {
				const result = await window.grokCode?.copyText(command);
				setMachineHelpNotice(result?.ok ? "Command copied." : "The command could not be copied.");
			} catch { setMachineHelpNotice("The command could not be copied."); }
		}}>Copy</button></>
	);
	return (
		<div className="settings-page" role="dialog" aria-label="Settings">
			<nav className="settings-nav">
				<h2>Settings</h2>
				{([["general", "General"], ["editor", "Editor"], ["notifications", "Notifications"], ["sessions", "Sessions"], ["prompts", "Saved prompts"], ["skills", "Skills and tools"], ["about", "About"]] as [SettingsTab, string][]).map(([id, label]) => (
					<button key={id} type="button" ref={section === id ? selectedButton : undefined} aria-current={section === id ? "page" : undefined} className={section === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
				))}
				<span className="spacer" />
				<button type="button" className="texty" onClick={onClose}>Done</button>
			</nav>
			<div className={toolsOpen ? "settings-body customize" : "settings-body"}>
				{tab === "general" && (
					<>
						<h3>General</h3>
						{row("Appearance", "Follow the system, or always light or dark.", choose("appearance", "Appearance", [["system", "System"], ["light", "Light"], ["dark", "Dark"]]))}
						{row("Keep computer awake while Grok works", "Prevents idle sleep while any session is working. A closed lid still sleeps.", toggle("keepAwake", "Keep computer awake while Grok works"))}
						{row("Keep awake on battery power", "When off, the hold drops while on battery. On battery, the computer may still sleep a few minutes after its own sleep timeout.", toggle("keepAwakeOnBattery", "Keep awake on battery power"))}
						{row("Auto save in the Files pane", "Save edits shortly after you stop typing.", toggle("autoSave", "Auto save"))}
						{row("Screen reader support in the terminal", "Turns on by itself when Windows or macOS reports a screen reader. Turn it on here for Linux, or for a screen reader that isn't detected.", toggle("terminalScreenReader", "Screen reader support in the terminal"))}
						{row("Suggest your next prompt", "Show a suggested next message after Grok replies. Press Tab to use it. Predictions may use model quota.", toggle("promptSuggestions", "Suggest your next prompt"))}
						<h3>Sign-in</h3>
						{signInStatus ? (
							<form aria-label="Sign-in settings" onSubmit={(event) => { event.preventDefault(); void changeSignIn(signInMode); }}>
								<div role="radiogroup" aria-label="Sign-in mode">
									<label className="toggle"><input type="radio" name="grok-sign-in-mode" aria-label="Grok sign-in" value="grok" checked={signInMode === "grok"} disabled={signInBusy} onChange={() => { setSignInChoice("grok"); setReplaceKey(false); setSignInNotice(null); }} />Grok sign-in</label>
									<label className="toggle"><input type="radio" name="grok-sign-in-mode" aria-label="xAI API key" value="key" checked={signInMode === "key"} disabled={signInBusy} onChange={() => { setSignInChoice("key"); setSignInNotice(null); }} />xAI API key</label>
								</div>
								{signInStatus.hasKey && <>
									<p className="note">{signInStatus.keyReadable ? "A key is saved. It is never shown." : "The saved key can't be read on this computer. Enter it again."}</p>
									<div className="actions"><button type="button" className="texty" disabled={signInBusy || !signInStatus.keyring} onClick={() => { setSignInChoice("key"); setReplaceKey(true); setSignInNotice(null); }}>Replace</button><button type="button" className="texty" disabled={signInBusy} onClick={() => void changeSignIn("remove")}>Remove</button></div>
								</>}
								{showKeyInput && <div className="cz-form"><label htmlFor="sign-in-key">API key</label><input id="sign-in-key" aria-label="xAI API key value" aria-describedby="sign-in-key-risk" type="password" autoComplete="off" maxLength={512} required ref={keyInput} disabled={signInBusy} /></div>}
								{signInMode === "key" && <p className="note" id="sign-in-key-risk">Grok, the commands it runs, and its MCP servers and hooks can read this key. This app hides the key if Grok prints it, but Grok's own session files keep what Grok wrote.</p>}
								{!signInStatus.keyring && <p className="note">This computer has no keyring the app can use, so the key can't be saved. Set XAI_API_KEY in your environment instead.</p>}
								{signInCheck?.keyIgnored && signInStatus.mode === "key" && <p className="note">A Grok sign-in is saved, so the key isn't used. <button type="button" className="texty" disabled={signInBusy || !signInStatus.keyReadable} onClick={() => void changeSignIn("key", true)}>Use the key</button></p>}
								{signInCheck?.keyRejected && <p className="note">Grok rejected the API key, or couldn't reach xAI to check it.</p>}
								{signInNotice && <p className="note" role={signInNotice.ok ? "status" : "alert"}>{signInNotice.text}</p>}
								<button type="submit" className="texty" disabled={signInBusy || (signInMode === "key" && !signInStatus.keyring && !signInStatus.keyReadable)}>Save</button>
							</form>
						) : <p className="meta">Sign-in settings are unavailable.</p>}
						<h3>Cursor cloud</h3>
						<form aria-label="Cursor cloud settings" onSubmit={(event) => { event.preventDefault(); void changeCursorKey(false); }}>
							<p className="note">Cloud sessions run on Cursor's computers and can push branches to your repository. With My machines, they run on a computer of yours instead.</p>
							{cloudKeyStatus?.hasKey && <p className="note">{cloudKeyStatus.name ? `Saved key: ${cloudKeyStatus.name}` : "A Cursor API key is saved."}{!cloudKeyStatus.keyReadable && " The saved key can't be read on this computer. Enter it again."}</p>}
							{cloudKeyStatus && !cloudKeyStatus.keyring && <p className="note">This computer has no keyring the app can use, so the Cursor key can't be saved.</p>}
							<div className="cz-form"><label htmlFor="cursor-key">Cursor API key</label><input id="cursor-key" aria-label="Cursor API key" type="password" autoComplete="off" maxLength={512} required ref={cursorKeyInput} disabled={cursorKeyBusy || !cloudKeyStatus?.keyring} /></div>
							{cursorKeyNotice && <p className="note" role={cursorKeyNotice.ok ? "status" : "alert"}>{cursorKeyNotice.text}</p>}
							<div className="actions"><button type="submit" className="texty" disabled={cursorKeyBusy || !cloudKeyStatus?.keyring}>Save</button><button type="button" className="texty" disabled={cursorKeyBusy || !cloudKeyStatus?.hasKey} onClick={() => void changeCursorKey(true)}>Remove</button></div>
						</form>
						<h3>My machines</h3>
						<p className="note">Run Cloud sessions on a computer you own. Cursor's agent works there with that computer's files, tools and sign-ins, and can change anything its user can. Only use computers you trust, and give the worker its own clone.</p>
						<p className="note">1. Turn on Enable my machines on Cursor's dashboard. <button type="button" className="texty" onClick={async () => {
							try {
								const result = await window.grokCode?.openExternal?.("https://cursor.com/dashboard?tab=cloud-agents");
								setMachineHelpNotice(result?.ok ? "" : "Cursor's dashboard could not open.");
							} catch { setMachineHelpNotice("Cursor's dashboard could not open."); }
						}}>Open Cursor's dashboard</button></p>
						<p className="note">2. Install Cursor's CLI on that computer.</p>
						<p className="note">For macOS, Linux or WSL, run {copyMachineCommand("curl https://cursor.com/install -fsS | bash")}</p>
						<p className="note">On Windows, install Git for Windows and run this in PowerShell. {copyMachineCommand("irm 'https://cursor.com/install?win32=true' | iex")}</p>
						<p className="note">3. Sign in with the same Cursor account as the key above. {copyMachineCommand("cursor-agent login")}</p>
						<p className="note">4. In the New session form, choose My machine under Run on. It shows the commands that clone the repository and start the worker.</p>
						<p className="note">Use <code>cursor-agent</code>. Grok installs its own <code>agent</code> command.</p>
						<p className="note">Run one Cursor worker at a time on each computer. To use another repository there, stop the worker with Ctrl+C and start it in that repository's clone.</p>
						{machineHelpNotice && <p className="note" role="status">{machineHelpNotice}</p>}
						<h3>Browser</h3>
						{row("Keep cookies", "Sign-ins in the Browser pane survive restarts.", toggle("keepCookies", "Keep cookies"))}
						{row("Open links in built-in browser", keyLabel("Links in the chat open in the Browser pane. Ctrl+click opens your default browser."), toggle("linksInBuiltIn", "Open links in built-in browser"))}
						{row("Let Grok use the Browser pane", "Grok uses sites where you are signed in. What it reads goes to xAI as part of the conversation. Other sites ask for permission; Stop pauses browser access.", toggle("browserControl", "Let Grok use the Browser pane"))}
					</>
				)}
				{tab === "editor" && (
					<Suspense fallback={<p className="meta" role="status">Loading editor file types...</p>}>
						<EditorSettings fileTypes={settings.editorFileTypes} onChange={(fileTypes) => saveSetting("editorFileTypes", fileTypes)} extension={extension} setExtension={setExtension} newLanguage={newLanguage} setNewLanguage={setNewLanguage} />
						{saved("editorFileTypes")}
					</Suspense>
				)}
				{tab === "prompts" && <><SavedPromptsSettings prompts={settings.savedPrompts} onChange={(savedPrompts) => saveSetting("savedPrompts", savedPrompts)} />{saved("savedPrompts")}</>}
				{tab === "notifications" && (
					<>
						<h3>Notifications</h3>
						{row("Permission requests", "When Grok needs approval and the window is in the background.", choose("notifyPermission", "Permission request notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Questions", "When Grok asks you to choose.", choose("notifyQuestion", "Question notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Task complete", "When a session finishes while you are not looking at it.", choose("notifyDone", "Task complete notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Pull requests", "When CI fails or new review feedback arrives on a pull request a session opened.", choose("notifyPr", "Pull request notifications", [["banner", "Banners"], ["off", "Off"]]))}
						{row("Draw attention", "Flash the taskbar button when Grok needs you.", toggle("attention", "Draw attention on notifications"))}
						{row("Notification sound", "The sound banners play.", choose("sound", "Notification sound", [["system", "System sound"], ["none", "None"]]))}
					</>
				)}
				{tab === "sessions" && (
					<>
						<h3>Sessions</h3>
						{row("Default permission mode", `The mode each new session starts in. ${MODES.find((item) => item.id === settings.defaultMode)?.detail ?? ""}`, choose("defaultMode", "Default permission mode", MODES.map((item) => [item.id, item.id])))}
						{row("Transcript view", keyLabel("How much each session shows until you change it with Ctrl+O. Thinking adds Grok's reasoning; Verbose also opens tool details."), choose("defaultView", "Transcript view", [["normal", "Normal"], ["thinking", "Thinking"], ["verbose", "Verbose"]]))}
						{row("Archive inactive sessions", "Archive sessions with no activity for this long. Clean worktree folders are removed; their branches stay. Pinned and running sessions stay.", choose("autoArchiveDays", "Archive inactive sessions", [[0, "Never"], [1, "1 day"], [2, "2 days"], [7, "7 days"], [14, "14 days"], [30, "30 days"]]))}
						{row("Accept turns from local tools", "Lets programs on this computer that hold the private token add a message to an open session. The message waits in that session's queue and runs with that session's mode and approvals. Off by default.", toggle("acceptLocalTurns", "Accept turns from local tools"))}
						{row("Branch prefix", "Added to the branch names of new worktree sessions.", (
							<span className="set-inline">
								{!prefixInvalid && saved("branchPrefix")}
								<input aria-label="Branch prefix" aria-invalid={prefixInvalid} aria-describedby={prefixInvalid ? "branch-prefix-rule" : undefined} value={prefix} onChange={(event) => {
									setPrefixDraft(event.target.value);
									if (saveNotice?.key === "branchPrefix") { setSaveNotice(null); }
								}} onBlur={savePrefix} onKeyDown={(event) => {
									if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); savePrefix(); }
								}} />
							</span>
						))}
						{prefixInvalid && <p className="note bad" id="branch-prefix-rule" role="status">Not saved. Use 1–40 letters, digits, periods, underscores or hyphens. Start with a letter or digit and avoid protected names such as main.</p>}
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
				{(tab === "skills" || tab === "connectors" || tab === "plugins") && <Customize key={folder} view={tab} onViewChange={setTab} folder={folder} live={servers} onRun={onRun} />}
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
