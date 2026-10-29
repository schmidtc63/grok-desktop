import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface BrowserTab { id: string; url: string; title: string }

export interface DevServer { script: string; command: string; running: boolean }

export interface BrowserPaneProps {
	tabs: BrowserTab[];
	activeId: string;
	onActivate: (id: string) => void;
	onNewTab: () => void;
	onCloseTab: (id: string) => void;
	onNavigate: (id: string, url: string) => void;
	onPageChanged: (id: string, url: string, title: string) => void;
	error?: string;
	keepCookies: boolean;
	onKeepCookies: (on: boolean) => void;
	onClearData: () => void;
	linksInBuiltIn: boolean;
	onLinksInBuiltIn: (on: boolean) => void;
	devServers: DevServer[];
	onStartServer: (script: string) => void;
	onStopServer: (script: string) => void;
	onStopAll: () => void;
	selectTick: number;
	onPicked: (pick: { url: string; selector: string; html: string; text: string }) => void;
	onClose: () => void;
}

interface ElementPick { selector: string; html: string; text: string }

interface WebviewElement extends HTMLElement {
	getURL(): string;
	getTitle(): string;
	canGoBack(): boolean;
	canGoForward(): boolean;
	goBack(): void;
	goForward(): void;
	reload(): void;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

type ViewRef = (element: HTMLElement | null) => (() => void) | undefined;

const PAGE_EVENTS = ["did-navigate", "did-navigate-in-page", "page-title-updated"];

// Runs in the page's main world. Resolves the clicked element, or null on Escape or when a newer picker replaces it.
export const PICKER_SCRIPT: string = `(() => new Promise((resolve) => {
	if (typeof window.__grokPickerStop === "function") {
		window.__grokPickerStop();
	}
	const box = document.createElement("div");
	box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #e08a62;background:rgba(224,138,98,0.12);border-radius:2px;display:none;left:0;top:0;width:0;height:0";
	(document.body || document.documentElement).appendChild(box);
	const presses = ["pointerdown", "pointerup", "mousedown", "mouseup"];
	let done = false;
	function cssPath(node) {
		const parts = [];
		while (node && node.nodeType === 1 && parts.length < 5) {
			if (node.id) {
				parts.unshift("#" + CSS.escape(node.id));
				break;
			}
			let index = 1;
			for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
				if (sib.localName === node.localName) {
					index += 1;
				}
			}
			parts.unshift(node.localName + ":nth-of-type(" + index + ")");
			node = node.parentElement;
		}
		return parts.join(" > ");
	}
	function block(event) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
	}
	function move(event) {
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		const rect = target.getBoundingClientRect();
		box.style.display = "block";
		box.style.left = rect.left + "px";
		box.style.top = rect.top + "px";
		box.style.width = rect.width + "px";
		box.style.height = rect.height + "px";
	}
	function click(event) {
		block(event);
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		const text = target.innerText !== undefined ? target.innerText : target.textContent;
		finish({
			selector: cssPath(target),
			html: String(target.outerHTML || "").slice(0, 4000),
			text: String(text || "").slice(0, 500),
		});
	}
	function key(event) {
		if (event.key === "Escape") {
			block(event);
			finish(null);
		}
	}
	function stop() {
		finish(null);
	}
	function finish(value) {
		if (done) {
			return;
		}
		done = true;
		window.removeEventListener("mousemove", move, true);
		window.removeEventListener("click", click, true);
		window.removeEventListener("keydown", key, true);
		for (const name of presses) {
			window.removeEventListener(name, block, true);
		}
		box.remove();
		if (window.__grokPickerStop === stop) {
			delete window.__grokPickerStop;
		}
		resolve(value);
	}
	window.__grokPickerStop = stop;
	window.addEventListener("mousemove", move, true);
	window.addEventListener("click", click, true);
	window.addEventListener("keydown", key, true);
	for (const name of presses) {
		window.addEventListener(name, block, true);
	}
}))()`;

function attempt<T>(run: () => T, fallback: T): T {
	try {
		return run();
	} catch {
		return fallback;
	}
}

// The page is untrusted: accept only the expected string fields and re-clip them.
function asPick(value: unknown): ElementPick | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const { selector, html, text } = value as Record<string, unknown>;
	if (typeof selector !== "string" || typeof html !== "string" || typeof text !== "string") {
		return null;
	}
	return { selector: selector.slice(0, 1000), html: html.slice(0, 4000), text: text.slice(0, 500) };
}

function tabLabel(tab: BrowserTab): string {
	if (tab.title) {
		return tab.title;
	}
	return attempt(() => new URL(tab.url).host, "") || "New tab";
}

export function BrowserPane(props: BrowserPaneProps) {
	const { tabs, activeId, error, keepCookies, linksInBuiltIn, devServers, selectTick } = props;
	const latest = useRef(props);
	const views = useRef<Record<string, WebviewElement>>({});
	const viewRefs = useRef<Record<string, ViewRef>>({});
	const srcs = useRef<Record<string, string>>({});
	const srcPartition = useRef("");
	const known = useRef<Record<string, string>>({});
	const seen = useRef<Record<string, string>>({});
	const pick = useRef({ run: 0, tabId: "" });
	const lastTick = useRef(selectTick);
	const menuRoot = useRef<HTMLDivElement>(null);
	const addressRef = useRef<HTMLInputElement>(null);
	const active = tabs.find((tab) => tab.id === activeId);
	const activeUrl = active?.url ?? "";
	const [draft, setDraft] = useState(activeUrl);
	const [menu, setMenu] = useState<"" | "servers" | "more">("");
	const [pickingId, setPickingId] = useState("");
	const partition = keepCookies ? "persist:grok-code" : "temp:grok-code";

	// A webview cannot change partition, so the key carries it; a fresh partition starts every tab again from its url.
	if (srcPartition.current !== partition) {
		srcPartition.current = partition;
		srcs.current = {};
	}

	useLayoutEffect(() => {
		latest.current = props;
	});

	useEffect(() => {
		if (document.activeElement !== addressRef.current) {
			setDraft(activeUrl);
		}
	}, [activeId, activeUrl]);

	// The src attribute is set once per webview. Later url changes that did not come from the page itself
	// (typed address, dev server link) are pushed by hand, so page-reported urls never trigger a reload.
	useEffect(() => {
		for (const tab of tabs) {
			if (known.current[tab.id] === tab.url) {
				continue;
			}
			known.current[tab.id] = tab.url;
			const view = views.current[tab.id];
			if (view && tab.url && tab.url !== seen.current[tab.id] && view.getAttribute("src") !== tab.url) {
				view.setAttribute("src", tab.url);
			}
		}
	}, [tabs]);

	useEffect(() => {
		if (selectTick === lastTick.current) {
			return;
		}
		lastTick.current = selectTick;
		if (selectTick <= 0) {
			return;
		}
		const tabId = activeId;
		const view = views.current[tabId];
		if (!view || typeof view.executeJavaScript !== "function") {
			return;
		}
		const run = pick.current.run + 1;
		pick.current = { run, tabId };
		setPickingId(tabId);
		attempt(() => view.focus(), undefined);
		Promise.resolve()
			.then(() => view.executeJavaScript(PICKER_SCRIPT, true))
			.then((value) => {
				const picked = asPick(value);
				if (picked && run === pick.current.run) {
					latest.current.onPicked({ url: attempt(() => view.getURL(), seen.current[tabId] ?? ""), ...picked });
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (run === pick.current.run) {
					pick.current = { run, tabId: "" };
					setPickingId("");
				}
			});
	}, [selectTick]);

	useEffect(() => {
		if (!menu) {
			return undefined;
		}
		function away(event: Event) {
			if (!menuRoot.current?.contains(event.target as Node)) {
				setMenu("");
			}
		}
		function escape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setMenu("");
			}
		}
		document.addEventListener("mousedown", away);
		document.addEventListener("focusin", away);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("focusin", away);
			document.removeEventListener("keydown", escape);
		};
	}, [menu]);

	function srcFor(key: string, url: string): string {
		if (!(key in srcs.current)) {
			srcs.current[key] = url;
		}
		return srcs.current[key];
	}

	function viewRef(tabId: string, key: string): ViewRef {
		if (!viewRefs.current[key]) {
			viewRefs.current[key] = (element) => {
				if (!element) {
					return undefined;
				}
				const view = element as WebviewElement;
				views.current[tabId] = view;
				const sync = (event: Event) => {
					const info = event as Event & { url?: string; title?: string; isMainFrame?: boolean };
					if (info.isMainFrame === false) {
						return;
					}
					const url = attempt(() => view.getURL(), info.url ?? "");
					const title = attempt(() => view.getTitle(), info.title ?? "");
					if (!url) {
						return;
					}
					seen.current[tabId] = url;
					if (event.type === "did-navigate" && pick.current.tabId === tabId) {
						pick.current = { run: pick.current.run + 1, tabId: "" };
						setPickingId("");
					}
					latest.current.onPageChanged(tabId, url, title);
				};
				for (const name of PAGE_EVENTS) {
					view.addEventListener(name, sync);
				}
				return () => {
					for (const name of PAGE_EVENTS) {
						view.removeEventListener(name, sync);
					}
					if (views.current[tabId] === view) {
						delete views.current[tabId];
					}
				};
			};
		}
		return viewRefs.current[key];
	}

	function go(action: "back" | "forward" | "reload") {
		const view = views.current[activeId];
		if (!view) {
			return;
		}
		attempt(() => {
			if (action === "back" && typeof view.goBack === "function" && typeof view.canGoBack === "function" && view.canGoBack()) {
				view.goBack();
			}
			if (action === "forward" && typeof view.goForward === "function" && typeof view.canGoForward === "function" && view.canGoForward()) {
				view.goForward();
			}
			if (action === "reload" && typeof view.reload === "function") {
				view.reload();
			}
		}, undefined);
	}

	return (
		<section className="pane bp-pane" aria-label="Browser">
			<div className="pane-hd">
				<b>Browser</b>
				<span className="spacer" />
				<div className="bp-menus" ref={menuRoot}>
					<div className="bp-menu-wrap">
						<button
							className="bp-btn"
							aria-haspopup="true"
							aria-expanded={menu === "servers"}
							onClick={() => setMenu(menu === "servers" ? "" : "servers")}
						>
							{devServers.some((server) => server.running) && <span className="bp-dot" role="img" aria-label="Running" />}
							Dev servers
						</button>
						{menu === "servers" && (
							<div className="bp-menu" role="group" aria-label="Dev servers">
								{devServers.length === 0 && <p className="bp-empty">No dev scripts in package.json</p>}
								{devServers.map((server) => (
									<div className="bp-server" key={server.script}>
										<span className="bp-server-name" title={server.command}>
											{server.running && <span className="bp-dot" role="img" aria-label="Running" />}
											{`${server.script} \u2014 ${server.command}`}
										</span>
										<button
											className="texty"
											aria-label={`${server.running ? "Stop" : "Start"} ${server.script}`}
											onClick={() => (server.running ? props.onStopServer(server.script) : props.onStartServer(server.script))}
										>
											{server.running ? "Stop" : "Start"}
										</button>
									</div>
								))}
								{devServers.length > 0 && (
									<button
										className="bp-item"
										disabled={!devServers.some((server) => server.running)}
										onClick={() => {
											props.onStopAll();
											setMenu("");
										}}
									>
										Stop all
									</button>
								)}
							</div>
						)}
					</div>
					<div className="bp-menu-wrap">
						<button
							className="bp-icon"
							aria-label="Browser menu"
							aria-haspopup="true"
							aria-expanded={menu === "more"}
							onClick={() => setMenu(menu === "more" ? "" : "more")}
						>
							⋮
						</button>
						{menu === "more" && (
							<div className="bp-menu" role="group" aria-label="Browser options">
								<label className="bp-item">
									<input type="checkbox" checked={keepCookies} onChange={(event) => props.onKeepCookies(event.target.checked)} />
									Keep cookies
								</label>
								<button
									className="bp-item"
									onClick={() => {
										props.onClearData();
										setMenu("");
									}}
								>
									Clear browsing data
								</button>
								<label className="bp-item">
									<input type="checkbox" checked={linksInBuiltIn} onChange={(event) => props.onLinksInBuiltIn(event.target.checked)} />
									Open links in built-in browser
								</label>
							</div>
						)}
					</div>
				</div>
				<button className="pane-x" aria-label="Close pane" onClick={props.onClose}>×</button>
			</div>
			<div className="bp-tabs">
				{tabs.map((tab) => (
					<div className={tab.id === activeId ? "bp-tab on" : "bp-tab"} key={tab.id}>
						<button
							className="bp-tab-name"
							title={tab.url || "New tab"}
							aria-current={tab.id === activeId ? "true" : undefined}
							onClick={() => props.onActivate(tab.id)}
						>
							{tabLabel(tab)}
						</button>
						<button className="bp-tab-x" aria-label="Close browser tab" onClick={() => props.onCloseTab(tab.id)}>×</button>
					</div>
				))}
				<button className="bp-new" aria-label="New browser tab" onClick={props.onNewTab}>+</button>
			</div>
			<div className="bp-bar">
				<button className="bp-icon" aria-label="Back" disabled={!activeUrl} onClick={() => go("back")}>←</button>
				<button className="bp-icon" aria-label="Forward" disabled={!activeUrl} onClick={() => go("forward")}>→</button>
				<button className="bp-icon" aria-label="Reload" disabled={!activeUrl} onClick={() => go("reload")}>↻</button>
				<form
					className="bp-addr"
					onSubmit={(event) => {
						event.preventDefault();
						const url = draft.trim();
						if (!active || !url) {
							return;
						}
						props.onNavigate(active.id, url);
						if (url === active.url) {
							go("reload");
						}
					}}
				>
					<input
						ref={addressRef}
						aria-label="Address"
						placeholder="https://"
						value={draft}
						spellCheck={false}
						autoComplete="off"
						disabled={!active}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<button className="texty" type="submit" disabled={!active}>Go</button>
				</form>
			</div>
			<div className="bp-views">
				{error && <p className="note bp-note">{error}</p>}
				{pickingId !== "" && pickingId === activeId && <p className="note bp-note">Click an element in the page. Esc cancels.</p>}
				{!active && <p className="note bp-note">No browser tab open.</p>}
				{active && !active.url && <p className="note bp-note">Type an http or https address and press Go.</p>}
				{tabs.map((tab) => {
					if (!tab.url) {
						return null;
					}
					// ponytail: every tab with a url stays mounted (hidden ones too), so memory grows per open tab; unmount idle tabs if that bites.
					const key = `${partition}:${tab.id}`;
					return createElement("webview", {
						key,
						className: tab.id === activeId ? "bp-view" : "bp-view bp-off",
						src: srcFor(key, tab.url),
						partition,
						webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
						ref: viewRef(tab.id, key),
					});
				})}
			</div>
		</section>
	);
}
