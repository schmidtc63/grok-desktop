import { useEffect, useState, type ReactNode } from "react";
import { PLATFORM } from "./data";
import { configuredSandbox } from "./sandbox";
import type { AppSettings } from "./Settings";

const OPTIONS: { id: AppSettings["sandboxOption"]; label: string; detail: string }[] = [
	{ id: "docker", label: "Docker", detail: "The session folder and Grok's home are writable. Docker sessions share that home, and commands can use the network. Tools come from the image." },
	{ id: "wsl", label: "WSL", detail: "Best if your Linux tools are already in WSL. Grok can still read most of Windows." },
	{ id: "windows-sandbox", label: "Windows Sandbox", detail: "Best for Windows tools, with nothing else to install. Needs Windows Pro, Enterprise or Education." },
];
const SIGN_IN_LINK = /https:\/\/(?:[\w-]+\.)*x\.ai\/\S+/;
type Job = "" | "build" | "sign-in" | "test";

function focusSheet(sheet: HTMLDivElement | null) {
	sheet?.focus();
}

// On Windows this opens as a panel when a session's Sandbox checkbox turns on, with `picker` set. On macOS and Linux it is a Settings tab.
export function SandboxSettings({ settings, onChange, picker }: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => boolean;
	picker?: { sessionId: string; sessions: { id: string; title: string }[]; onUse: (choice: GrokSandboxChoice) => void; onClose: () => void };
}) {
	const api = window.grokCode;
	const isWindows = PLATFORM === "win32";
	const option = isWindows ? settings.sandboxOption : "profile";
	const choice = configuredSandbox(settings);
	const choiceKey = JSON.stringify(choice);
	const [check, setCheck] = useState<GrokSandboxCheck | null>(null);
	const [checking, setChecking] = useState(false);
	const [recheck, setRecheck] = useState(0);
	const [job, setJob] = useState<Job>("");
	const [output, setOutput] = useState("");
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [testResult, setTestResult] = useState<GrokSandboxTest | null>(null);
	const [holder, setHolder] = useState("");
	const signInLink = job === "sign-in" ? SIGN_IN_LINK.exec(output)?.[0] : undefined;
	const holderTitle = picker?.sessions.find((item) => item.id === holder)?.title;
	const heldBy = picker && holder && holder !== picker.sessionId ? holderTitle ? `"${holderTitle}"` : "another session" : "";
	const blocked = option === "windows-sandbox" && !!heldBy;

	useEffect(() => {
		let current = true;
		setChecking(true);
		void (api?.sandboxCheck?.(choice) ?? Promise.resolve<GrokSandboxCheck>({ ready: false, problem: "Reopen this window to use the sandbox." }))
			.catch((): GrokSandboxCheck => ({ ready: false, problem: "The sandbox could not be checked." }))
			.then((result) => {
				if (!current) { return; }
				setCheck(result);
				setChecking(false);
				if (option === "wsl" && result.distro && result.distro !== settings.sandboxWslDistro) { onChange({ sandboxWslDistro: result.distro }); }
			});
		return () => { current = false; };
	// eslint-disable-next-line react-hooks/exhaustive-deps -- the check depends only on what is being checked.
	}, [choiceKey, recheck]);
	useEffect(() => {
		if (!picker) { return; }
		let current = true;
		void api?.sandboxHolder?.().then((id) => { if (current) { setHolder(id); } }).catch(() => {});
		return () => { current = false; };
	// eslint-disable-next-line react-hooks/exhaustive-deps -- it depends only on when to look again.
	}, [choiceKey, recheck]);
	useEffect(() => api?.onSandboxText?.((text) => setOutput((current) => `${current}${text}`.slice(-20000))), [api]);
	// Leaving this panel stops a build or a sign-in. Nothing else shows its progress.
	useEffect(() => () => { void api?.sandboxCancel?.(); }, [api]);
	// Starting a job disables the button that was pressed, which drops focus out of the panel. Then Escape misses the panel, even after the job ends.
	useEffect(() => { if (job) { document.querySelector<HTMLElement>("[data-sandbox-job]")?.focus(); } }, [job]);

	async function run(kind: Job, work: (() => Promise<{ ok: boolean; error?: string }>) | undefined, done: string) {
		if (!work || job) { return; }
		setJob(kind);
		setOutput("");
		setNotice(null);
		try {
			const result = await work();
			setNotice(result.ok ? { ok: true, text: done } : { ok: false, text: result.error || "That didn't finish." });
		} catch {
			setNotice({ ok: false, text: "That didn't finish." });
		} finally {
			setJob("");
			setRecheck((value) => value + 1);
		}
	}
	async function runTest() {
		if (!api?.sandboxTest || job) { return; }
		setJob("test");
		setTestResult(null);
		setNotice(null);
		try {
			setTestResult(await api.sandboxTest(choice, settings.model));
		} catch {
			setTestResult({ ok: false, checks: [], error: "The test couldn't finish." });
		} finally {
			setJob("");
		}
	}
	function chooseOption(id: AppSettings["sandboxOption"]) {
		onChange({ sandboxOption: id });
		setCheck(null);
		setTestResult(null);
		setOutput("");
		setNotice(null);
	}
	async function addFolder() {
		const picked = await api?.pickFolder?.();
		if (picked && !settings.sandboxMappedFolders.includes(picked)) { onChange({ sandboxMappedFolders: [...settings.sandboxMappedFolders, picked] }); }
	}
	const command = (text: string) => (
		<><code>{text}</code> <button type="button" className="texty" aria-label={`Copy ${text}`} onClick={async () => {
			try {
				const result = await api?.copyText(text);
				setNotice(result?.ok ? { ok: true, text: "Command copied." } : { ok: false, text: "The command could not be copied." });
			} catch { setNotice({ ok: false, text: "The command could not be copied." }); }
		}}>Copy</button></>
	);
	// A setup step says it's done once the check finds the software. It stays hidden until the first check answers.
	const setupStep = (found: boolean | undefined, done: string, todo: ReactNode) => (check ? <p className="note">{found ? done : todo}</p> : null);
	const signInButton = (
		<button type="button" className="texty" disabled={!!job || !check?.ready || blocked} onClick={() => void run("sign-in", () => api!.sandboxSignIn!(choice), "Signed in.")}>Sign in</button>
	);
	const statusText = !check || checking ? "Checking…" : check.ready ? `${check.detail ?? "Ready."}${option !== "profile" && check.signedIn ? " Signed in." : ""}` : check.problem ?? "Not ready.";
	const profileRow = (
		<div className="set-row">
			<div><b>Profile</b><small>Workspace keeps the session folder, Grok's home and temporary folders writable. Strict limits reads to the session folder and system paths.</small></div>
			<span className="set-inline">
				<select aria-label="Sandbox profile" value={settings.sandboxProfile} disabled={!!job} onChange={(event) => onChange({ sandboxProfile: event.target.value === "strict" ? "strict" : "workspace" })}>
					<option value="workspace">Workspace</option>
					<option value="strict">Strict</option>
				</select>
			</span>
		</div>
	);

	const body = (
		<>
			{!picker && <h3>Sandbox</h3>}
			<p className="note">A sandbox restricts what Grok's shell commands can access. The limits depend on the sandbox and profile you choose. Builds, installs and tools that need other folders or system access may fail.</p>
			{!picker && <p className="note">Each session chooses for itself: check <b>Sandbox</b> next to the message box, in a new session or during one. This page sets up the sandbox those sessions use. If it can't start, Grok doesn't start.</p>}
			<p className="note">Changing it during a session starts a new Grok session with the newest part of the conversation. Earlier tool results and commands running in the background don't carry over.</p>
			{isWindows && (
				<>
					<p className="note">The Windows build of Grok can't sandbox itself, so Grok runs in one of these instead. Each session uses its own. If it can't start, Grok doesn't start.</p>
					<div role="radiogroup" aria-label="Sandbox type">
						{OPTIONS.map((item) => {
							const held = item.id === "windows-sandbox" && !!heldBy;
							return (
								<label key={item.id} className="toggle">
									<input type="radio" name="grok-sandbox-option" value={item.id} checked={settings.sandboxOption === item.id} disabled={!!job || held} onChange={() => chooseOption(item.id)} />
									<span><b>{item.label}.</b> {item.detail}{held && <> <b>In use by {heldBy}.</b> Windows runs only one at a time, so choose Docker or WSL, or try again after that session has been idle for 10 minutes.</>}</span>
								</label>
							);
						})}
					</div>
				</>
			)}
			<p className={`note${check && !checking && !check.ready ? " bad" : ""}`} role="status">{statusText} <button type="button" className="texty" disabled={checking} onClick={() => setRecheck((value) => value + 1)}>Check again</button></p>
			{option === "docker" && (
				<>
					<h3>Set up Docker</h3>
					{setupStep(check?.installed, "1. Docker Desktop is installed.", <>1. Install Docker Desktop. Larger companies need a paid license, so check Docker's terms. <button type="button" className="texty" onClick={() => void api?.openExternal?.("https://www.docker.com/products/docker-desktop/")}>Open Docker's site</button></>)}
					<p className="note">2. Build the app's small Linux image with git and Grok. This downloads Grok from x.ai. <button type="button" className="texty" disabled={!!job} onClick={() => void run("build", () => api!.sandboxBuild!(), "The image is built.")}>Build image</button></p>
					<div className="cz-form">
						<label htmlFor="sandbox-image">Or your image</label>
						<input id="sandbox-image" key={settings.sandboxDockerImage} defaultValue={settings.sandboxDockerImage} placeholder="Leave blank for the app's image" maxLength={200} spellCheck={false} onBlur={(event) => {
							const value = event.target.value.trim();
							if (value !== settings.sandboxDockerImage) { onChange({ sandboxDockerImage: value }); }
						}} />
					</div>
					<p className="note">To add languages or tools, build your own image. It must contain <code>grok</code>.</p>
					<p className="note">3. Sign in here, or choose an xAI API key in Settings under General. {signInButton}</p>
				</>
			)}
			{option === "wsl" && (
				<>
					<h3>Set up WSL</h3>
					{setupStep(check?.installed, "1. WSL is installed.", <>1. In an administrator terminal, run this. It needs a restart the first time. {command("wsl --install -d Ubuntu")}</>)}
					{setupStep(check?.ready, `2. Grok and Bubblewrap are installed in ${check?.distro}.`, <>2. Inside Ubuntu, install Grok and Bubblewrap, and your build tools. {command("curl -fsSL https://x.ai/cli/install.sh | bash")} {command("sudo apt install -y bubblewrap")}</>)}
					{!!check?.distros?.length && (
						<div className="cz-form">
							<label htmlFor="sandbox-distro">Distribution</label>
							<select id="sandbox-distro" value={settings.sandboxWslDistro} disabled={!!job} onChange={(event) => onChange({ sandboxWslDistro: event.target.value })}>
								{check.distros.map((name) => <option key={name} value={name}>{name}</option>)}
							</select>
						</div>
					)}
					{profileRow}
					<p className="note">3. Sign in here, or choose an xAI API key in Settings under General. {signInButton}</p>
					<p className="note">The app adds its own two profiles to <code>~/.grok/sandbox.toml</code> in that distribution, and leaves yours alone. They block Windows programs and selected existing credential paths in both home folders, such as <code>.git-credentials</code>, <code>.netrc</code>, <code>.npmrc</code>, <code>.config/gh</code> and <code>.config/gcloud</code>. The app skips credential paths that contain the session's folder.</p>
				</>
			)}
			{option === "windows-sandbox" && (
				<>
					<h3>Set up Windows Sandbox</h3>
					{setupStep(check?.installed, "1. Windows Sandbox is turned on.", <>1. In an administrator PowerShell, run this, then restart. {command("Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All")}</>)}
					<p className="note">2. There is nothing to install. The app shares Grok and Git read-only. To add tools such as Node or Python, add their folders here, also read-only.</p>
					{settings.sandboxMappedFolders.map((folder) => (
						<p key={folder} className="note"><code>{folder}</code> <button type="button" className="texty" aria-label={`Remove ${folder}`} onClick={() => onChange({ sandboxMappedFolders: settings.sandboxMappedFolders.filter((item) => item !== folder) })}>Remove</button></p>
					))}
					<p className="note"><button type="button" className="texty" onClick={() => void addFolder()}>Add a folder</button></p>
					<p className="note">3. Sign in here, or choose an xAI API key in Settings under General. {signInButton}</p>
				</>
			)}
			{option === "profile" && profileRow}
			{signInLink && <p className="note"><button type="button" className="texty" onClick={() => void api?.openExternal?.(signInLink)}>Open the sign-in page</button></p>}
			{(job === "build" || job === "sign-in") && <p className="note">{picker ? "Keep this open until it finishes. Closing it stops it." : "Stay on this page until it finishes. Leaving stops it."}</p>}
			{output && <pre className="sandbox-output" tabIndex={0} aria-label="Output">{output}</pre>}
			{notice && <p className={`note${notice.ok ? "" : " bad"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}
			<h3>Test it</h3>
			<p className="note">Grok runs a small script that tries to write inside and outside a test folder, and the app looks at what landed. This sends one short message to Grok, which uses a little of your quota.</p>
			<p className="note"><button type="button" className="texty" disabled={!!job || blocked} onClick={() => void runTest()}>{job === "test" ? "Testing…" : "Test sandbox"}</button></p>
			{testResult && (
				<div role="status">
					{testResult.error && <p className="note bad">{testResult.error}</p>}
					{testResult.checks.map((item) => <p key={item.label} className={`note${item.pass ? "" : " bad"}`}>{item.pass ? "Passed" : "Failed"}: {item.label}.</p>)}
					{testResult.canReadOutside !== undefined && <p className="note">{testResult.canReadOutside ? "Grok could read a file outside the folder, which this setup allows." : "Grok couldn't read a file outside the folder."}</p>}
				</div>
			)}
			<h3>What it doesn't cover</h3>
			<p className="note">The Terminal pane and the Commit buttons still run on this computer. Browser control is off in a sandboxed session. Strict blocks command networking on Linux and WSL. Docker, Windows Sandbox, Workspace and Strict on macOS allow commands to reach the network, including your local network.</p>
			{(option === "profile" || option === "wsl") && <p className="note">Grok's default home is <code>~/.grok</code> in the environment where it runs.</p>}
			{option === "profile" && <p className="note">In a worktree session, Grok can't commit, because the commit touches the main checkout. The Commit button can.</p>}
			{(option === "docker" || option === "wsl") && <p className="note">Linux tools write Linux files into your Windows folder. For example, <code>npm install</code> leaves a <code>node_modules</code> that a Windows build can't use. Worktree sessions aren't available.</p>}
			{option === "wsl" && <p className="note">With Workspace, Grok can read most mounted Windows files.</p>}
			{option === "windows-sandbox" && <p className="note">Windows runs one Windows Sandbox at a time, so only one session can use it. It starts empty each time, so anything installed inside it is lost when it stops. A file changed on this computer can take a few seconds to show up inside it. Worktree sessions aren't available.</p>}
			{(option === "docker" || option === "windows-sandbox") && <p className="note">Grok keeps its own settings here, so your skills, MCP servers and sign-in from this computer's Grok aren't used.</p>}
			{isWindows && <p className="note">Sessions on the same kind of sandbox share Grok's own folder, with its sign-in and session records, so one session's Grok could read another's.</p>}
		</>
	);
	if (!picker) { return body; }
	return (
		<div className="overlay" onClick={() => { if (!job) { picker.onClose(); } }}>
			<div ref={focusSheet} tabIndex={-1} className="sheet sandbox-sheet" role="dialog" aria-modal="true" aria-label="Choose a sandbox for this session" data-sandbox-job={job || undefined} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
				if (event.key === "Escape" && !job) { event.preventDefault(); event.stopPropagation(); picker.onClose(); }
				if (event.key === "Tab") {
					const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)"));
					const first = controls[0];
					const last = controls[controls.length - 1];
					if (event.shiftKey && (event.target === first || event.target === event.currentTarget)) { event.preventDefault(); last?.focus(); }
					if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
				}
			}}>
				<h2>Choose a sandbox for this session</h2>
				<div className="sandbox-sheet-body">{body}</div>
				<div className="actions">
					<button type="button" className="yes" disabled={!check?.ready || checking || !!job || blocked} onClick={() => picker.onUse(choice)}>{`Use ${OPTIONS.find((item) => item.id === option)?.label}`}</button>
					<button type="button" onClick={picker.onClose}>Cancel</button>
				</div>
			</div>
		</div>
	);
}
