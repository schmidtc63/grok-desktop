import { useEffect, useRef, useState, type ReactNode } from "react";
import "./grok-bot.css";

// Grok Bot's window sits above this page, so it steps aside when one of these would be under it.
const COVERS = `.settings-page, .overlay, .row-pop, .file-menu, .popup-menu, [role="dialog"], [aria-modal="true"]`;
const DOWNLOAD = `https://cursor.com/download/bot`;

const MESSAGES: Record<GrokBotWindowState, string> = {
	starting: `Opening Grok Bot…`,
	open: ``,
	missing: `Grok Bot isn't installed on this computer.`,
	notfound: `Grok Bot didn't open a window. If it's running in the background, open it, then try again.`,
	closed: `Grok Bot was closed. It comes back here when it reopens.`,
	elsewhere: `Grok Bot is showing in another window.`,
	problem: `The helper that holds Grok Bot's window stopped.`,
};
const ACTIONS: Partial<Record<GrokBotWindowState, string>> = {
	missing: `Try again`,
	notfound: `Try again`,
	closed: `Open Grok Bot`,
	elsewhere: `Show it here`,
	problem: `Try again`,
};

export function GrokBotWindow({ nav, onClose }: { nav?: ReactNode; onClose: () => void }) {
	const area = useRef<HTMLDivElement>(null);
	const refresh = useRef<() => void>(() => {});
	const [state, setState] = useState<GrokBotWindowState>(`starting`);
	const api = window.grokCode;

	useEffect(() => api?.onGrokBotWindow?.((next) => {
		setState(next);
		if (next === `open`) { refresh.current(); }
	}), []);
	useEffect(() => {
		const node = area.current;
		if (!node) { return; }
		let frame = 0;
		let last = ``;
		const report = () => {
			frame = 0;
			const box = node.getBoundingClientRect();
			const visible = ![...document.querySelectorAll(COVERS)].some((item) => {
				if (!item.checkVisibility({ checkVisibilityCSS: true })) { return false; }
				const cover = item.getBoundingClientRect();
				return cover.right > box.left && cover.left < box.right && cover.bottom > box.top && cover.top < box.bottom;
			});
			const scale = window.devicePixelRatio;
			const place = { x: Math.round(box.left * scale), y: Math.round(box.top * scale), width: Math.round(box.width * scale), height: Math.round(box.height * scale), viewHeight: Math.round(window.innerHeight * scale), visible };
			const text = JSON.stringify(place);
			if (text !== last) {
				last = text;
				void api?.grokBotWindowPlace?.(place);
			}
		};
		const soon = () => {
			if (!frame) { frame = requestAnimationFrame(report); }
		};
		refresh.current = () => {
			last = ``;
			soon();
		};
		const sizes = new ResizeObserver(soon);
		sizes.observe(node);
		const changes = new MutationObserver(soon);
		changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [`hidden`, `class`, `style`] });
		window.addEventListener(`resize`, soon);
		void api?.grokBotWindowOpen?.();
		return () => {
			cancelAnimationFrame(frame);
			sizes.disconnect();
			changes.disconnect();
			window.removeEventListener(`resize`, soon);
			refresh.current = () => {};
			void api?.grokBotWindowHide?.();
		};
	}, []);

	const action = ACTIONS[state];
	return <section className="grok-bot-view" aria-label="Grok Bot app">
		<header className="grok-bot-header">
			{nav}
			<strong>Grok Bot</strong>
			<div className="grok-bot-actions">
				<button type="button" className="texty" onClick={onClose}>Close</button>
			</div>
		</header>
		<div className="grok-bot-window-area" ref={area}>
			{MESSAGES[state] && <p className="note" role="status">{MESSAGES[state]}</p>}
			{state === `missing` && <button type="button" className="texty" onClick={() => void api?.openExternal(DOWNLOAD)}>Get Grok Bot</button>}
			{action && <button type="button" className="texty" onClick={() => void api?.grokBotWindowOpen?.()}>{action}</button>}
		</div>
	</section>;
}
