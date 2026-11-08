function keySignInLabel(grok: GrokReadiness["grok"]): string {
	return grok.keySource === "app" || (grok.keySource !== "env" && grok.signInMode === "key") ? "API key (saved in this app)" : "API key (XAI_API_KEY)";
}

export function supportReport(result: GrokReadiness): string {
	const lines: string[] = [];
	const { app, grok, config, git, gh } = result;
	if (app) {
		const info = [app.version ? `Codewomplers Grok Desktop ${app.version}` : "", app.electron ? `Electron ${app.electron}` : "", app.os].filter(Boolean).join(", ");
		if (info) { lines.push(info); }
	}
	if (grok) {
		if (grok.ok) {
			lines.push([`Grok${grok.version ? ` ${grok.version}` : ""}`, grok.update?.channel ? `${grok.update.channel} channel` : "", grok.at ? `runs from ${grok.at.path} (${grok.at.source})` : ""].filter(Boolean).join(", "));
			if (grok.update) { lines.push(`Grok update: ${!grok.update.checked ? "not checked" : grok.update.available ? `${grok.update.latest ? `${grok.update.latest} ` : ""}available` : "up to date"}`); }
			if (grok.signInMode === "key" || grok.signIn === "key") { lines.push(`Grok sign-in: ${keySignInLabel(grok)}`); }
			else if (grok.signIn === "saved") { lines.push("Grok sign-in: saved sign-in"); }
			else if (grok.signIn === "none" || grok.signedIn === false) { lines.push("Grok sign-in: not signed in"); }
			else if (grok.signedIn === true) { lines.push("Grok sign-in: signed in"); }
			else if (grok.signInMode === "grok") { lines.push("Grok sign-in: Grok sign-in"); }
		} else {
			lines.push(`Grok: not installed${grok.error ? ` (${grok.error})` : ""}`);
		}
	}
	if (config) {
		lines.push(config.ok ? `Grok config: ${config.files?.map((file) => file.path).join(", ") || "none"}; can't read: ${config.files?.filter((file) => file.broken).map((file) => file.path).join(", ") || "none"}; warnings: ${config.warnings?.join(", ") || "none"}` : "Grok config: couldn't be read");
	}
	if (git) { lines.push(`Git: ${git.ok ? "installed" : "not installed"}`); }
	if (gh) { lines.push(`GitHub CLI: ${!gh.ok ? "not installed" : gh.signedIn === undefined ? "installed" : gh.signedIn ? "signed in" : "not signed in"}`); }
	if (result.network) {
		lines.push(`HTTPS proxy: ${result.network.httpsProxy}`);
		lines.push(`HTTP proxy: ${result.network.httpProxy}`);
		lines.push(`NO_PROXY: ${result.network.noProxy}`);
		lines.push(`Extra CA certificates: ${result.network.caCerts}`);
	}
	return lines.join("\n");
}

function focusSetupSheet(sheet: HTMLDivElement | null) {
	sheet?.focus({ preventScroll: true });
}

export function Setup({ result, checking, onCheck, onCopy, onClose, onInstallGrok, onInstallGit, onUpdateGrok, onOpenSignIn, installing }: {
	result?: GrokReadiness;
	checking: boolean;
	onCheck: () => void;
	onCopy: (text: string) => void;
	onClose: () => void;
	onInstallGrok: () => void;
	onInstallGit: () => void;
	onUpdateGrok: () => void;
	onOpenSignIn?: () => void;
	installing: "" | "grok" | "git" | "update";
}) {
	// Grok 1.0.77 warns that `hooks` and `privacy` are unrecognized while it still loads them, so the sheet shows only files it can't parse; the report keeps the warnings.
	const broken = result?.config?.files?.filter((file) => file.broken) ?? [];
	const keyMode = result?.grok.signInMode === "key";
	return (
		<div className="overlay" onClick={onClose}>
			<div ref={focusSetupSheet} tabIndex={-1} className="sheet setup-sheet" role="dialog" aria-modal="true" aria-label="Set up Grok" onClick={(event) => event.stopPropagation()}>
				<h2>Set up Grok</h2>
				{checking && <p className="meta" role="status">Checking setup…</p>}
				{result && (
					<>
						<div className="setup-row">
							<h3>Grok</h3>
							{result.grok.ok ? <>
								<p className="result">Grok{result.grok.version ? ` ${result.grok.version}` : ""} is installed.</p>
								{result.grok.at && <p className="meta">Runs from {result.grok.at.path}, {result.grok.at.source === "GROK_PATH" ? "set by GROK_PATH" : result.grok.at.source === "installer" ? "the Grok installer's copy" : "found on PATH"}.</p>}
								{result.grok.update?.available && <>
									<p className="note">Grok {result.grok.update.latest} is available.</p>
									<button type="button" disabled={installing !== ""} onClick={onUpdateGrok}>{installing === "update" ? "Updating…" : "Update Grok"}</button>
								</>}
								{result.grok.update?.checked === false && <p className="note">Grok couldn't check for a newer version.</p>}
							</> : (
								<>
									<p className="note">{result.grok.error}</p>
									<button type="button" disabled={installing !== ""} onClick={onInstallGrok}>{installing === "grok" ? "Installing…" : "Install Grok CLI"}</button>
									<p className="note">Or run this in a terminal:</p>
									<pre className="tool-code">{result.install}</pre>
									<button type="button" className="texty" onClick={() => onCopy(result.install)}>Copy</button>
									<p className="note">Then press Check again. If Grok is installed somewhere else, set GROK_PATH to its full path and restart this app.</p>
								</>
							)}
						</div>
						{(result.grok.ok || keyMode) && (
							<div className="setup-row">
								<h3>Sign-in</h3>
								{result.grok.signIn === "key" && <p className="result">{keySignInLabel(result.grok)}</p>}
								{result.grok.signIn !== "key" && result.grok.signedIn && <p className="result">Grok is signed in{result.grok.signIn === "saved" ? " with a saved sign-in" : ""}.</p>}
								{result.grok.keyIgnored && <p className="note">The API key isn't used while a Grok sign-in is saved.</p>}
								{result.grok.keyUnreadable && <p className="note">The saved API key can't be read. Enter it again in Settings.</p>}
								{result.grok.keyRejected && <p className="note">Grok rejected the API key, or couldn't reach xAI to check it.</p>}
								{!keyMode && result.grok.signIn === "saved" && result.grok.apiKey === true && <p className="note">XAI_API_KEY is also set. Grok uses the saved sign-in while it exists.</p>}
								{keyMode && onOpenSignIn && (!result.grok.signedIn || result.grok.keyIgnored || result.grok.keyUnreadable || result.grok.keyRejected) && <button type="button" onClick={onOpenSignIn}>Open sign-in settings</button>}
								{!keyMode && result.grok.signIn !== "key" && !result.grok.signedIn && (
									<>
										<p className="note">Grok is not signed in.</p>
										<pre className="tool-code">grok login</pre>
										<button type="button" className="texty" onClick={() => onCopy("grok login")}>Copy</button>
										<p className="note">Run it in a terminal and finish signing in in your browser, then press Check again. Sending a message also opens Grok's browser sign-in. An API key in XAI_API_KEY works instead, and this check never shows the key.</p>
									</>
								)}
							</div>
						)}
						{result.config && <div className="setup-row">
							<h3>Grok config</h3>
							{!result.config.ok ? <p className="note">Grok's config couldn't be read.</p> : <>
								{broken.map((file) => <p className="note" key={file.path}>Grok can't read {file.path}, so its settings aren't used.</p>)}
								{broken.length === 0 && <p className="result">Grok reads its config without problems.</p>}
							</>}
						</div>}
						<div className="setup-row">
							<h3>Git</h3>
							{result.git.ok ? <p className="result">Git is installed.</p> : (
								<>
									{result.platform === "win32" && !result.grok.ok ? <p className="note">Installing the Grok CLI also installs Git.</p> : <p className="note">Git is not installed. The Changes pane, worktrees and pull requests need it.</p>}
									{result.platform === "win32" && result.grok.ok && <p className="note">Install Git from git-scm.com.</p>}
									{result.platform === "darwin" && (
										<>
											<button type="button" disabled={installing !== ""} onClick={onInstallGit}>{installing === "git" ? "Installing…" : "Install Git"}</button>
											<p className="note">Apple's window installs the Command Line Tools, which include Git. Press Check again when it finishes.</p>
										</>
									)}
									{result.platform === "linux" && <p className="note">Install Git with your package manager.</p>}
								</>
							)}
						</div>
						{result.network && <div className="setup-row">
							<h3>Network</h3>
							<p className="meta">HTTPS proxy: {result.network.httpsProxy}</p>
							<p className="meta">HTTP proxy: {result.network.httpProxy}</p>
							<p className="meta">NO_PROXY: {result.network.noProxy}</p>
							<p className="meta">Extra CA certificates: {result.network.caCerts}</p>
						</div>}
						<div className="setup-row">
							<h3>GitHub CLI</h3>
							<p className={result.gh.ok && result.gh.signedIn ? "result" : "note"}>{!result.gh.ok ? "GitHub CLI is not installed. Only pull requests need it." : result.gh.signedIn ? "GitHub CLI is signed in." : <>GitHub CLI is not signed in, or GitHub can't be reached. Pull requests need <code>gh auth login</code>.</>}</p>
						</div>
					</>
				)}
				<div className="actions">
					<button type="button" disabled={!result} onClick={() => { if (result) { onCopy(supportReport(result)); } }}>Copy support report</button>
					<button type="button" disabled={checking} onClick={onCheck}>Check again</button>
					<button type="button" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}
