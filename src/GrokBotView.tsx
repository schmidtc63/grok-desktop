import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import { describeRow, showStop, statusLine } from "./grok-bot-rows";
import type { useGrokBot } from "./grok-bot";
import "./grok-bot.css";

export function GrokBotView({ bot, nav, onClose }: { bot: ReturnType<typeof useGrokBot>; nav?: ReactNode; onClose: () => void }) {
	const scroll = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	const nearBottom = useRef(true);
	const lastBot = useRef(bot.selectedId);
	const prepend = useRef<{ height: number; top: number } | null>(null);
	const mounted = useRef(true);
	const live = bot.status.live[bot.selectedId] || {};
	const selected = bot.status.bots.find((item) => item.agentId === bot.selectedId);
	const available = Boolean(selected && bot.status.signedIn && bot.status.connection !== "expired");
	const descriptions = bot.rows.map((row) => describeRow(row));

	useEffect(() => {
		mounted.current = true;
		composer.current?.focus();
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => { composer.current?.focus(); }, [bot.selectedId]);
	useLayoutEffect(() => {
		const node = scroll.current;
		if (!node) { return; }
		if (lastBot.current !== bot.selectedId) {
			lastBot.current = bot.selectedId;
			nearBottom.current = true;
			prepend.current = null;
		}
		if (prepend.current && !bot.loading) {
			node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height;
			prepend.current = null;
		} else if (!prepend.current && nearBottom.current) {
			node.scrollTop = node.scrollHeight;
		}
	}, [bot.rows, bot.pending, bot.selectedId, bot.loading]);

	const copy = async (text: string) => {
		try {
			const result = await window.grokCode?.copyText(text);
			if (mounted.current) { bot.setNote(result?.ok ? "Copied." : "Could not copy the text."); }
		} catch { if (mounted.current) { bot.setNote("Could not copy the text."); } }
	};
	const openLink = async (href: string) => {
		try {
			const result = await window.grokCode?.openExternal(href);
			if (mounted.current) { bot.setNote(result?.ok ? "Opened link." : "Only http and https links can be opened."); }
		} catch { if (mounted.current) { bot.setNote("The link could not be opened."); } }
	};

	return <section className="grok-bot-view" aria-label="Grok Bot conversation">
		<header className="grok-bot-header">
			{nav}
			{bot.status.bots.length > 1 ? <select aria-label="Grok Bot" value={bot.selectedId} onChange={(event) => bot.setSelectedId(event.target.value)}>
				{bot.status.bots.map((item) => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}
			</select> : <strong>{selected?.name || "Grok Bot"}</strong>}
			<span className="grok-bot-status note" role="status">{statusLine(live, bot.status.connection)}</span>
			<div className="grok-bot-actions">
				{bot.status.connection === "problem" && <button type="button" className="texty" onClick={() => void bot.retry()}>Try again</button>}
				{selected && showStop(live, bot.status.connection) && <button type="button" className="texty" onClick={() => void bot.stop()}>Stop</button>}
				<button type="button" className="texty" onClick={onClose}>Close</button>
			</div>
		</header>
		<div className="grok-bot-scroll" ref={scroll} onScroll={() => {
			const node = scroll.current;
			if (node) { nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }
		}}>
			<div className="chat-col">
				{bot.status.signedIn && bot.status.connection === "live" && bot.status.bots.length === 0 && <p className="note">There are no Bots on this account. Make one in the Grok Bot app.</p>}
				{bot.hasEarlier && <button type="button" className="texty grok-bot-earlier" disabled={bot.loading} onClick={() => {
					const node = scroll.current;
					if (node) { prepend.current = { height: node.scrollHeight, top: node.scrollTop }; }
					void bot.loadEarlier();
				}}>{bot.loading ? "Loading…" : "Load earlier"}</button>}
				{bot.loading && !bot.rows.length && <p className="note">Loading conversation…</p>}
				{bot.rows.map((row, index) => {
					const item = descriptions[index];
					const entryId = row.entryId;
					return <article className={`msg ${item.side}`} key={entryId || row.seq}>
						{item.label && <div className="who">{item.label}</div>}
						{item.kind === "message" ? item.side === "user" ? <div className="user-bubble message-text">{item.text}</div> : <Markdown text={item.text} onCopy={(text) => void copy(text)} onLink={(href) => void openLink(href)} /> : <div className={item.kind === "note" ? "note message-text" : "message-text"}>{item.text}</div>}
						{item.note && <p className="note">{item.note}</p>}
						{item.kind === "attachment" && entryId && <button type="button" className="texty" onClick={() => void bot.openFile(entryId)}>Open</button>}
						{item.kind === "widget" && !item.closed && entryId && <div className="grok-bot-options">
							{item.options?.map((option, optionIndex) => <button type="button" className="texty" key={`${option.value}:${optionIndex}`} disabled={!available || bot.answering[`${bot.selectedId}:${entryId}`]} onClick={() => void bot.answer(entryId, option.value)}>{option.label}</button>)}
						</div>}
						{item.kind === "widget" && item.closed && item.answer !== undefined && <p className="note">{item.answer}</p>}
					</article>;
				})}
				{bot.pending.map((pending) => <article className="msg user" key={`pending:${pending.messageId}`}>
					<div className="user-bubble message-text">{pending.text}</div>
					<p className="note">{pending.error || "Sending…"}</p>
				</article>)}
				{bot.state.notes[bot.selectedId] && <p className="note" role="status">{bot.state.notes[bot.selectedId]}</p>}
			</div>
		</div>
		<div className="grok-bot-dock">
			{bot.note && <p className="note" role="status">{bot.note}</p>}
			<form className="composer" onSubmit={(event) => { event.preventDefault(); void bot.send(); }}>
				<textarea ref={composer} aria-label="Message Grok Bot" placeholder={selected ? `Message ${selected.name}` : "Message Grok Bot"} value={bot.draft} disabled={!available} maxLength={100000} onChange={(event) => bot.setDraft(event.target.value)} onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!bot.sending && available) { void bot.send(); } }
				}} />
				<div className="composer-row"><span className="spacer" /><button type="submit" className="texty" disabled={!available || bot.sending || !bot.draft.trim()}>{bot.sending ? "Sending…" : "Send"}</button></div>
			</form>
		</div>
	</section>;
}
