import { useCallback, useEffect, useRef, useState } from "react";
import { createGrokBotState, messageIdFor, reduceGrokBot, type GrokBotEvent, type GrokBotRow } from "./grok-bot-rows";

export function useGrokBot() {
	const [state, setState] = useState(createGrokBotState);
	const stateRef = useRef(state);
	const [selectedId, select] = useState("");
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const draftsRef = useRef(drafts);
	const [loadingByBot, setLoading] = useState<Record<string, boolean>>({});
	const [sendingByBot, setSending] = useState<Record<string, boolean>>({});
	const [hasEarlier, setHasEarlier] = useState<Record<string, boolean>>({});
	const [answering, setAnswering] = useState<Record<string, boolean>>({});
	const [note, setNote] = useState("");
	const epoch = useRef(0);
	const authVersion = useRef(0);
	const statusVersion = useRef(0);
	const mounted = useRef(true);
	const historyRequests = useRef(new Set<string>());
	const sendRequests = useRef(new Set<string>());
	const answerRequests = useRef(new Set<string>());

	const apply = useCallback((event: GrokBotEvent) => {
		const next = reduceGrokBot(stateRef.current, event);
		stateRef.current = next;
		setState(next);
	}, []);

	const onEvent = useCallback((value: unknown) => {
		if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || !value.type.startsWith("grokbot-")) { return; }
		const event = value as GrokBotEvent;
		if (event.type === "grokbot-status") {
			statusVersion.current++;
			if (!event.status.signedIn) {
				if (stateRef.current.status.signedIn) { epoch.current++; }
				draftsRef.current = {};
				setDrafts({});
				setLoading({});
				setSending({});
				setHasEarlier({});
				setAnswering({});
				historyRequests.current.clear();
				sendRequests.current.clear();
				answerRequests.current.clear();
				select("");
				setNote("");
			}
		}
		apply(event);
	}, [apply]);

	useEffect(() => {
		mounted.current = true;
		const version = statusVersion.current;
		const session = epoch.current;
		void window.grokCode?.grokBotStatus?.().then((result) => {
			if (result?.ok && mounted.current && session === epoch.current && version === statusVersion.current) {
				onEvent({ type: "grokbot-status", status: result });
			}
		}).catch(() => { if (mounted.current && session === epoch.current) { setNote("Grok Bot status could not be read."); } });
		return () => { mounted.current = false; epoch.current++; };
	}, [onEvent]);

	useEffect(() => {
		if (!state.status.signedIn) { return; }
		if (!state.status.bots.some((bot) => bot.agentId === selectedId)) {
			select(state.status.bots[0]?.agentId || "");
		}
	}, [state.status.signedIn, state.status.bots, selectedId]);

	const loadHistory = useCallback(async (agentId: string, earlier = false) => {
		const api = window.grokCode;
		if (!agentId || !stateRef.current.status.signedIn || !api?.grokBotHistory || historyRequests.current.has(agentId)) { return; }
		const session = epoch.current;
		const before = earlier ? stateRef.current.beforeSeq[agentId] : undefined;
		historyRequests.current.add(agentId);
		setLoading((current) => ({ ...current, [agentId]: true }));
		try {
			const result = await api.grokBotHistory(agentId, before);
			if (!mounted.current || session !== epoch.current) { return; }
			if (!result.ok) { setNote(result.error || "The conversation could not be loaded."); return; }
			const rows: GrokBotRow[] = result.rows || [];
			apply({ type: "grokbot-history", agentId, rows });
			setHasEarlier((current) => ({ ...current, [agentId]: rows.length === 100 && (!earlier || stateRef.current.beforeSeq[agentId] !== before) }));
		} catch {
			if (mounted.current && session === epoch.current) { setNote("The conversation could not be loaded."); }
		} finally {
			if (mounted.current && session === epoch.current) {
				historyRequests.current.delete(agentId);
				setLoading((current) => ({ ...current, [agentId]: false }));
			}
		}
	}, [apply]);

	useEffect(() => { if (selectedId && state.status.signedIn) { void loadHistory(selectedId); } }, [selectedId, state.status.signedIn, loadHistory]);
	const waitingForEcho = Object.values(state.pending).some((pending) => pending.some((item) => !item.error));
	useEffect(() => {
		if (!waitingForEcho) { return; }
		const timer = window.setInterval(() => apply({ type: "grokbot-tick", now: Date.now() }), 1000);
		return () => window.clearInterval(timer);
	}, [waitingForEcho, apply]);

	const setDraft = useCallback((agentId: string, text: string) => {
		draftsRef.current = { ...draftsRef.current, [agentId]: text };
		setDrafts(draftsRef.current);
	}, []);

	const send = useCallback(async (agentId: string) => {
		const text = draftsRef.current[agentId] || "";
		const api = window.grokCode;
		if (!text.trim() || !agentId || !api?.grokBotSend || !stateRef.current.status.signedIn || sendRequests.current.has(agentId)) { return; }
		const session = epoch.current;
		const messageId = messageIdFor(stateRef.current, agentId, text);
		sendRequests.current.add(agentId);
		setSending((current) => ({ ...current, [agentId]: true }));
		setNote("");
		apply({ type: "grokbot-send", agentId, messageId, text, at: Date.now() });
		try {
			const result = await api.grokBotSend({ agentId, messageId, text });
			if (!mounted.current || session !== epoch.current) { return; }
			apply({ type: "grokbot-send-result", agentId, messageId, ok: result.ok, error: result.error });
			if (result.ok && draftsRef.current[agentId] === text) { setDraft(agentId, ""); }
		} catch {
			if (mounted.current && session === epoch.current) {
				apply({ type: "grokbot-send-result", agentId, messageId, ok: false, error: "It may have been sent. Check the chat before sending again." });
			}
		} finally {
			if (mounted.current && session === epoch.current) {
				sendRequests.current.delete(agentId);
				setSending((current) => ({ ...current, [agentId]: false }));
			}
		}
	}, [apply, setDraft]);

	const stop = useCallback(async (agentId: string) => {
		const session = epoch.current;
		try {
			const result = await window.grokCode?.grokBotStop?.(agentId);
			if (!mounted.current || session !== epoch.current) { return; }
			setNote(result?.ok ? result.hadActiveRun === false ? "Grok Bot was not running." : "Stop requested." : result?.error || "Stop could not be confirmed. Check Grok Bot.");
		} catch { if (mounted.current && session === epoch.current) { setNote("Stop could not be confirmed. Check Grok Bot."); } }
	}, []);

	const answer = useCallback(async (agentId: string, entryId: string, value: string) => {
		const key = `${agentId}:${entryId}`;
		if (answerRequests.current.has(key)) { return; }
		const session = epoch.current;
		answerRequests.current.add(key);
		setAnswering((current) => ({ ...current, [key]: true }));
		try {
			const result = await window.grokCode?.grokBotAnswer?.({ agentId, entryId, value });
			if (!mounted.current || session !== epoch.current) { return; }
			setNote(result?.ok ? "Answer sent." : result?.error || "The answer could not be confirmed. Check Grok Bot.");
			if (result?.ok) { await loadHistory(agentId); }
		} catch { if (mounted.current && session === epoch.current) { setNote("The answer could not be confirmed. Check Grok Bot."); } }
		finally {
			if (mounted.current && session === epoch.current) {
				answerRequests.current.delete(key);
				setAnswering((current) => ({ ...current, [key]: false }));
			}
		}
	}, [loadHistory]);

	const openFile = useCallback(async (agentId: string, entryId: string) => {
		const session = epoch.current;
		try {
			const result = await window.grokCode?.grokBotOpenFile?.({ agentId, entryId });
			if (mounted.current && session === epoch.current) { setNote(result?.ok ? "Opened file." : result?.error || "Open Grok Bot to get this file."); }
		} catch { if (mounted.current && session === epoch.current) { setNote("Open Grok Bot to get this file."); } }
	}, []);

	const authAction = useCallback(async (action: "grokBotSignIn" | "grokBotCancelSignIn" | "grokBotSignOut") => {
		const request = ++authVersion.current;
		epoch.current++;
		setNote("");
		try {
			const result = await window.grokCode?.[action]?.();
			if (mounted.current && request === authVersion.current && !result?.ok) { setNote(result?.error || "Grok Bot sign-in could not be changed."); }
		} catch { if (mounted.current && request === authVersion.current) { setNote("Grok Bot sign-in could not be changed."); } }
	}, []);

	const retry = useCallback(async () => {
		const session = epoch.current;
		try {
			const result = await window.grokCode?.grokBotRetry?.();
			if (mounted.current && session === epoch.current && !result?.ok) { setNote(result?.error || "Grok Bot could not reconnect."); }
		} catch { if (mounted.current && session === epoch.current) { setNote("Grok Bot could not reconnect."); } }
	}, []);

	return {
		state, status: state.status, onEvent, selectedId, setSelectedId: select,
		rows: state.rows[selectedId] || [], pending: state.pending[selectedId] || [],
		draft: drafts[selectedId] || "", setDraft: (text: string) => setDraft(selectedId, text),
		loading: Boolean(loadingByBot[selectedId]), sending: Boolean(sendingByBot[selectedId]),
		hasEarlier: Boolean(hasEarlier[selectedId]), answering, note, setNote,
		loadEarlier: () => loadHistory(selectedId, true), send: () => send(selectedId),
		stop: () => stop(selectedId), answer: (entryId: string, value: string) => answer(selectedId, entryId, value),
		openFile: (entryId: string) => openFile(selectedId, entryId), retry,
		signIn: () => authAction("grokBotSignIn"), cancelSignIn: () => authAction("grokBotCancelSignIn"), signOut: () => authAction("grokBotSignOut"),
	};
}
