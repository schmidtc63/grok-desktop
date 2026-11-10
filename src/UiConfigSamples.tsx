import type { JSX, ReactNode } from "react";
import { Icon } from "./Icon";

function Account() {
	return <button type="button" className="account-btn">
		<span className="avatar">G</span>
		<span className="who">Sample account<small>SuperGrok</small></span>
	</button>;
}

function TitleBar() {
	return <header className="topbar">
		<div className="session-title">
			<button type="button" className="title-btn">Polish the welcome page</button>
			<button type="button" className="icon-btn caret" aria-label="Session menu"><Icon name="chevron-down" /></button>
			<span className="meta">Demo project · main</span>
		</div>
		<div className="pane-switch">
			<button type="button" className="pane-tab" aria-label="Changes"><Icon name="diff" /></button>
			<button type="button" className="pane-tab on" aria-label="Files"><Icon name="editor" /></button>
		</div>
	</header>;
}

function UserMessage() {
	return <article className="msg user">
		<div className="user-bubble"><div className="user-clip"><div className="message-text">Make the welcome page easier to scan.</div></div></div>
	</article>;
}

function DiffLines() {
	return <>
		<div className="dp-line dp-context"><span className="dp-num">8</span><span className="dp-num">8</span><span className="dp-act" /><span className="dp-marker" /><span className="dp-text">{"<main>"}</span></div>
		<div className="dp-line dp-del"><span className="dp-num">9</span><span className="dp-num" /><span className="dp-act" /><span className="dp-marker">−</span><span className="dp-text">{"<h1>Home</h1>"}</span></div>
		<div className="dp-line dp-add"><span className="dp-num" /><span className="dp-num">9</span><span className="dp-act" /><span className="dp-marker">+</span><span className="dp-text">{"<h1>Welcome</h1>"}</span></div>
	</>;
}

function WholeApp() {
	return <>
		<TitleBar />
		<aside className="sidebar">
			<div className="session-scroll">
				<div className="session active"><span className="dot" /><button type="button" className="session-hit"><b>Polish the welcome page</b><small className="session-meta">Open session</small></button></div>
				<div className="session"><span className="dot needs-you" /><button type="button" className="session-hit"><b>Review the navigation</b><small className="needs-you">Needs you</small></button></div>
			</div>
			<div className="side-foot"><Account /></div>
		</aside>
		<UserMessage />
		<section className="pane">
			<div className="pane-hd"><b>Changes</b><button type="button" className="chip">Working tree</button></div>
			<div className="pane-bd">
				<input className="fp-filter" aria-label="Filter files" defaultValue="index.html" readOnly />
				<p className="md"><button type="button" className="file-link">index.html</button></p>
				<div className="dp-hunk"><DiffLines /></div>
				<div className="tool-head"><Icon className="tool-glyph" name="terminal" /><span className="tool-text">Checked project files</span></div>
				<pre className="tool-code cm-editor">
					<span className="tok-comment">{"// Welcome page"}</span>{"\n"}
					<span className="tok-keyword">function</span>{" "}<span className="tok-definition">welcome</span>
					{"("}<span className="tok-variableName">user</span>{": "}<span className="tok-typeName">User</span>{") {\n  "}
					<span className="tok-keyword">return</span>{" "}<span className="tok-string">{'"Hello "'}</span>
					{" + user."}<span className="tok-propertyName">name</span>{";\n}\n"}
					<span className="tok-meta">@example</span>{" "}<span className="tok-number">42</span>{" "}<span className="tok-invalid">?</span>
				</pre>
			</div>
		</section>
		<div className="actions">
			<button type="button" className="yes">Apply</button>
			<button type="button" className="bp-problems-btn">Problems<span className="bp-problem-count">1</span></button>
			<span className="usage-ring" style={{ ["--pct" as string]: "35" }} />
		</div>
		<div className="row-pop popup-menu">
			<button type="button" className="check-row">Show details<span className="menu-value check">✓</span></button>
			<button type="button" className="danger">Delete</button>
		</div>
	</>;
}

function SidebarSample() {
	return <aside className="sidebar">
		<div className="side-tools">
			<button type="button" className="new-btn"><Icon name="plus" /> New session</button>
			<span className="spacer" />
			<button type="button" className="side-icon" aria-label="Search sessions"><Icon name="search" /></button>
			<button type="button" className="side-icon" aria-label="Filter and group"><Icon name="sliders" /></button>
		</div>
		<div className="side-search"><input aria-label="Search sessions" defaultValue="Welcome" readOnly /></div>
		<div className="side-filter meta">Active · Last 7 days</div>
		<div className="session-scroll">
			<div className="group-head"><div className="group-label">Demo project</div></div>
			<div className="session active">
				<span className="dot" />
				<button type="button" className="session-hit"><b>Polish the welcome page</b><small className="session-meta">main · 2 minutes ago</small></button>
				<small className="loop-count">2</small>
			</div>
			<div className="session unread">
				<span className="dot unread" />
				<button type="button" className="session-hit"><b>Update the examples</b><small className="session-meta">main · 1 hour ago</small></button>
			</div>
			<div className="session">
				<span className="dot needs-you" />
				<button type="button" className="session-hit"><b>Review the navigation</b><small className="needs-you">Needs you</small></button>
			</div>
			<div className="session">
				<span className="dot failed" />
				<button type="button" className="session-hit"><b>Check the build</b><small className="failed">Stopped with an error</small></button>
			</div>
		</div>
		<div className="side-foot"><Account /></div>
	</aside>;
}

function ChatSample() {
	return <>
		<p className="chat-empty" style={{ margin: 0 }}>What should Grok work on?</p>
		<UserMessage />
		<article className="msg grok">
			<div className="thought">
				<button type="button" className="thought-hd"><Icon name="chevron-down" /> Thinking</button>
				<div className="thought-bd">I’ll look at the existing layout first.</div>
			</div>
			<div className="tool-row">
				<button type="button" className="tool-head">
					<Icon className="tool-glyph" name="editor" />
					<span className="tool-label">Read file</span>
					<span className="tool-text">index.html</span>
					<span className="tool-status">Completed</span>
				</button>
			</div>
			<div className="tool-row live">
				<button type="button" className="tool-head">
					<Icon className="tool-glyph" name="terminal" />
					<span className="tool-label">Run command</span>
					<span className="tool-text">Check the project</span>
					<span className="tool-status wait">Needs approval</span>
				</button>
				<div className="tool-body">
					<pre className="tool-code">npm run check</pre>
					<div className="tool-question">Which check should run first?
						<div className="tool-choices"><button type="button">Typecheck</button><button type="button">Build</button></div>
					</div>
				</div>
			</div>
			<div className="md">
				<h1>Welcome page</h1>
				<p>I updated the page in <button type="button" className="file-link">index.html</button>. Run <code>npm run dev</code> to see it.</p>
				<h2>Changes</h2>
				<blockquote>Keep the introduction short and put the next step first.</blockquote>
				<h3>Example</h3>
				<div className="md-code">
					<div className="md-code-hd"><span>html</span><span className="spacer" /><button type="button" className="texty">Copy</button></div>
					<pre><code>{"<h1>Welcome</h1>\n<p>Start with a tour.</p>"}</code></pre>
				</div>
				<h4>Preview</h4>
				<div className="md-table"><table><thead><tr><th>Section</th><th>Status</th></tr></thead><tbody><tr><td>Welcome</td><td>Ready</td></tr></tbody></table></div>
				<div className="md-code">
					<div className="md-code-hd">mermaid</div>
					<div className="md-diagram-body">
						<svg width="220" height="32" viewBox="0 0 220 32">
							<path d="M2 2h80v28H2zM138 2h80v28h-80zM82 16h56m-5-4 5 4-5 4" fill="none" stroke="currentColor" />
							<text x="42" y="21" textAnchor="middle" fill="currentColor">Start</text><text x="178" y="21" textAnchor="middle" fill="currentColor">Review</text>
						</svg>
					</div>
				</div>
				<p><a href="#ui-preview">Read the guide</a></p>
			</div>
			<div className="msg-foot"><time className="msg-time">10:42 AM</time><span className="msg-actions"><button type="button" className="texty">Copy</button><button type="button" className="texty">Quote</button></span></div>
		</article>
		<div className="task-list">
			<button type="button" className="task-list-hd"><Icon name="chevron-down" /> Tasks <span className="meta">1 of 2</span></button>
			<ul><li className="task-item completed"><span className="task-mark">✓</span><span>Read the current page</span></li><li className="task-item in_progress"><span className="task-mark">◐</span><span>Review the new copy</span></li></ul>
		</div>
		<div className="app-note"><Icon name="info" /><div className="app-note-body"><strong>Grok Code</strong>Draft saved.</div></div>
		<div className="working"><span className="spinner" /> Working…</div>
		<div className="steer-note"><small>You, while Grok worked</small><div className="message-text">Keep the existing links.</div></div>
		<div className="find-bar"><input aria-label="Find in chat" defaultValue="Welcome" readOnly /><button type="button" className="texty" aria-label="Close find"><Icon name="close" /></button></div>
	</>;
}

function ComposerSample() {
	return <>
		<div className="side-q">
			<div className="side-q-hd"><b>Side chat</b><span className="meta">Reads this session</span></div>
			<textarea aria-label="Side chat prompt" defaultValue="Where is this style defined?" readOnly />
		</div>
		<div className="composer">
			<div className="queue"><div className="queued"><span>Also check the small window layout.</span><button type="button" className="texty">Edit</button></div></div>
			<div className="attach-list"><span className="attach-chip">index.html<button type="button" aria-label="Remove attachment"><Icon name="close" /></button></span></div>
			<div className="mention pop-list">
				<div className="command-group">
					<div className="command-group-label">Session<span>1</span></div>
					<button type="button" className="item on">/plan<small>Make a plan first</small></button>
				</div>
			</div>
			<p className="loop-line">Check the build · every 30 minutes</p>
			<textarea aria-label="Prompt" defaultValue="Update the welcome page." readOnly />
			<div className="composer-row">
				<div className="composer-primary">
					<button type="button" className="chip"><Icon name="monitor" /><span className="chip-label">Local</span></button>
					<button type="button" className="chip"><Icon name="shield" /><span className="chip-label">Ask</span></button>
				</div>
				<div className="composer-actions">
					<span className="limit-meter">62% left</span>
					<button type="button" className="send-btn" aria-label="Send"><Icon name="send" /></button>
					<button type="button" className="send-btn stop" aria-label="Stop"><Icon name="stop" /></button>
				</div>
			</div>
		</div>
		<div className="note composer-note">The draft is saved on this computer.</div>
	</>;
}

function RailSample() {
	return <aside className="session-rail">
		<section className="rail-card">
			<button type="button" className="rail-hd">Workspace <Icon name="chevron-down" /></button>
			<div className="rail-bd">
				<div className="rail-row">Local · This computer</div>
				<div className="rail-row meta">main · up to date</div>
				<button type="button" className="rail-counts"><span>Changes</span><span className="add">+2</span></button>
				<button type="button" className="rail-file">index.html</button>
			</div>
		</section>
		<section className="rail-card">
			<button type="button" className="rail-hd">Usage <Icon name="chevron-down" /></button>
			<div className="rail-bd">
				<div className="rail-plan">
					<div className="rail-plan-row"><b>SuperGrok</b><span className="meta">Usage limit</span></div>
					<div className="rail-plan-bar"><span style={{ width: "35%" }} /></div>
				</div>
				<div className="ctx-head"><span>25% used</span><span className="meta">8k / 32k</span></div>
				<div className="ctx-rows"><div className="ctx-row"><span className="ctx-dot" style={{ background: "var(--accent)" }} /><span>Messages</span><span>8k</span><span>25%</span></div></div>
				<div className="rail-kv"><span>Session cost</span><span>$0.03</span></div>
			</div>
		</section>
	</aside>;
}

function PaneSample({ title, file, children }: { title: string; file?: string; children: ReactNode }) {
	return <section className="pane">
		<div className="pane-hd">
			<b>{title}</b>
			{file && <span className="fp-name">{file}</span>}
			<span className="spacer" />
			<button type="button" className="pane-x" aria-label="Close pane"><Icon name="close" /></button>
		</div>
		<div className="pane-bd">{children}</div>
	</section>;
}

function ChangesSample() {
	return <PaneSample title="Changes">
		<div className="dp-load"><span>Reading changed files…</span></div>
		<button type="button" className="file-row"><span>index.html</span><span className="dp-stat"><span className="dp-adds">+1</span> <span className="dp-dels">−1</span></span></button>
		<div className="dp-hunk">
			<div className="dp-hunk-hd"><span>@@ -8,2 +8,2 @@</span><button type="button" className="dp-goto">Open</button></div>
			<DiffLines />
			<div className="dp-note"><span>Keep this heading short.</span></div>
		</div>
		<div className="edit-diff">
			<div className="edit-split-row">
				<div className="edit-side dp-del"><span className="dp-num">9</span><span className="edit-marker">−</span><span className="dp-text">{"<h1>Home</h1>"}</span></div>
				<div className="edit-side dp-add"><span className="dp-num">9</span><span className="edit-marker">+</span><span className="dp-text">{"<h1>Welcome</h1>"}</span></div>
			</div>
		</div>
		<div className="dp-foot"><span>1 review note</span><button type="button" className="texty dp-send">Send to Grok</button></div>
	</PaneSample>;
}

function FilesSample() {
	return <PaneSample title="Files" file="index.html">
		<input className="fp-filter" aria-label="Filter files" defaultValue="index" readOnly />
		<div className="fp-list"><button type="button" className="fp-row">index.css</button><button type="button" className="fp-row on">index.html</button></div>
		<div className="fp-editor">
			<pre className="ui-sample-editor">{"<main>\n  <h1>Welcome</h1>\n</main>"}</pre>
			<select className="ce-lang" aria-label="Language" defaultValue="html"><option value="html">HTML</option></select>
		</div>
	</PaneSample>;
}

function TerminalSample() {
	return <section className="pane tp-pane">
		<div className="pane-hd">
			<b>Terminal</b>
			<div className="tp-tabs">
				<div className="tp-tab"><button type="button" className="tp-tab-name">Shell</button></div>
				<div className="tp-tab on"><button type="button" className="tp-tab-name"><span className="tp-dot" /> PowerShell</button></div>
			</div>
		</div>
		<pre className="tp-out">{"> npm run check\nChecking project files…\nDone in 1.2s."}</pre>
	</section>;
}

function BrowserSample() {
	return <section className="pane bp-pane">
		<div className="pane-hd"><b>Browser</b></div>
		<div className="bp-control"><div>Grok is using this browser<small>Reading the welcome page</small></div><button type="button" className="texty">Stop</button></div>
		<div className="bp-tabs">
			<div className="bp-tab"><button type="button" className="bp-tab-name">Docs</button></div>
			<div className="bp-tab on"><button type="button" className="bp-tab-name">Welcome</button></div>
		</div>
		<section className="bp-problems"><div className="bp-problems-hd"><b>Problems</b></div><ul><li>Image could not be loaded</li></ul></section>
		<div className="bp-bar">
			<button type="button" className="bp-icon" aria-label="Back"><Icon name="arrow-left" /></button>
			<div className="bp-addr"><input aria-label="Address" defaultValue="https://example.com/" readOnly /></div>
		</div>
	</section>;
}

function TasksSample() {
	return <PaneSample title="Background tasks">
		<div className="bg-task"><span className="dot" /><button type="button" className="bg-task-main"><b>Check the project</b><small>Completed · exit 0</small></button></div>
		<div className="task-details"><pre className="task-output">{"Checking project files…\nDone in 1.2s."}</pre></div>
	</PaneSample>;
}

function MenusSample() {
	return <>
		<div className="row-pop popup-menu">
			<div className="menu-label">Session</div>
			<button type="button">Rename<small>Change the session title</small></button>
			<button type="button" className="danger">Delete</button>
		</div>
		<div className="sheet">
			<h2>Delete session?</h2>
			<div className="shortcut-group"><h3>Details</h3></div>
			<p className="confirm-body">The session will be removed.</p>
			<div className="actions"><button type="button" className="yes">Delete</button><button type="button" className="texty">Cancel</button></div>
		</div>
	</>;
}

function NewSessionSample() {
	return <div className="new-page">
		<h1>Where should Grok work?</h1>
		<p className="new-folder-intro">Choose the project folder for this session.</p>
		<label className="field">Run on<select defaultValue="cloud"><option value="cloud">Cursor's cloud</option></select></label>
		<p className="new-send-note">Choose a folder to send. You can type your task now.</p>
		<p className="new-worktree-help">Worktree: choose a Git repository.</p>
		<div className="new-project-picks"><span>Projects:</span><button type="button"><Icon name="folder" /> Demo project</button><button type="button">Choose folder…</button></div>
		<div className="new-setup-status"><span><Icon name="check" /> Grok CLI installed</span><span><Icon name="check" /> Git installed</span></div>
	</div>;
}

export const UI_SAMPLES: Record<string, () => JSX.Element> = {
	app: WholeApp,
	sidebar: SidebarSample,
	title: TitleBar,
	chat: ChatSample,
	composer: ComposerSample,
	rail: RailSample,
	panes: () => <PaneSample title="Files" file="index.html">Review the welcome page, then update the heading.</PaneSample>,
	changes: ChangesSample,
	files: FilesSample,
	terminal: TerminalSample,
	browser: BrowserSample,
	tasks: TasksSample,
	menus: MenusSample,
	new: NewSessionSample,
};
