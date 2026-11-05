export function Setup({ result, checking, onCheck, onCopy, onClose, onInstallGrok, onInstallGit, installing }: {
	result?: GrokReadiness;
	checking: boolean;
	onCheck: () => void;
	onCopy: (text: string) => void;
	onClose: () => void;
	onInstallGrok: () => void;
	onInstallGit: () => void;
	installing: "" | "grok" | "git";
}) {
	return (
		<div className="overlay" onClick={onClose}>
			<div className="sheet setup-sheet" role="dialog" aria-modal="true" aria-label="Set up Grok" onClick={(event) => event.stopPropagation()}>
				<h2>Set up Grok</h2>
				{checking && <p className="meta" role="status">Checking setup…</p>}
				{result && (
					<>
						<div className="setup-row">
							<h3>Grok</h3>
							{result.grok.ok ? <p className="result">Grok{result.grok.version ? ` ${result.grok.version}` : ""} is installed.</p> : (
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
						{result.grok.ok && (
							<div className="setup-row">
								<h3>Sign-in</h3>
								{result.grok.signedIn ? <p className="result">Grok is signed in.</p> : (
									<>
										<p className="note">Grok is not signed in.</p>
										<pre className="tool-code">grok login</pre>
										<button type="button" className="texty" onClick={() => onCopy("grok login")}>Copy</button>
										<p className="note">Run it in a terminal and finish signing in in your browser, then press Check again. Sending a message also opens Grok's browser sign-in.</p>
									</>
								)}
							</div>
						)}
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
						<div className="setup-row">
							<h3>GitHub CLI</h3>
							<p className={result.gh.ok && result.gh.signedIn ? "result" : "note"}>{!result.gh.ok ? "GitHub CLI is not installed. Only pull requests need it." : result.gh.signedIn ? "GitHub CLI is signed in." : <>GitHub CLI is not signed in, or GitHub can't be reached. Pull requests need <code>gh auth login</code>.</>}</p>
						</div>
					</>
				)}
				<div className="actions">
					<button type="button" disabled={checking} onClick={onCheck}>Check again</button>
					<button type="button" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}
