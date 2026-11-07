// Speaker lines match sideContext in App.tsx. A snapshot keeps the newest text that fits, and copies only message text.
export const CONTEXT_PICK_LIMIT = 3;
export const CONTEXT_SNAPSHOT_CHARS = 12000;

export interface ContextPick {
	id: string;
	title: string;
}

export interface ContextChoice extends ContextPick {
	archived: boolean;
}

interface SnapshotMessage {
	role: string;
	text: string;
}

export function contextChoices(sessions: { id: string; title: string; archived?: boolean }[], currentId: string): ContextChoice[] {
	return sessions.filter((session) => session.id !== currentId).map((session) => ({
		id: session.id,
		title: session.title.replace(/\s+/g, " ").trim() || "Untitled session",
		archived: session.archived === true,
	}));
}

export function addContextPick(current: ContextPick[], pick: ContextPick): ContextPick[] {
	if (!pick.id || current.some((item) => item.id === pick.id) || current.length >= CONTEXT_PICK_LIMIT) { return current; }
	return [...current, { id: pick.id, title: pick.title.replace(/\s+/g, " ").trim() || "Untitled session" }];
}

export function contextPicksFrom(value: ContextPick[] | undefined, currentId: string): ContextPick[] {
	return (value ?? []).filter((item) => item && typeof item.id === "string" && item.id !== currentId && typeof item.title === "string").slice(0, CONTEXT_PICK_LIMIT).map((item) => ({
		id: item.id,
		title: item.title.replace(/\s+/g, " ").trim() || "Untitled session",
	}));
}

function fitNewest(lines: string[], limit: number): { lines: string[]; cut: boolean } {
	const kept: string[] = [];
	let used = 0;
	let cut = false;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		const gap = kept.length ? 2 : 0;
		if (used + gap + line.length <= limit) {
			kept.push(line);
			used += gap + line.length;
			continue;
		}
		cut = true;
		if (kept.length) { break; }
		const room = limit - gap;
		const speaker = line.slice(0, line.indexOf(":") + 1);
		const take = room - speaker.length - 2;
		if (take <= 0) { break; }
		kept.push(`${speaker} …${line.slice(-take)}`);
		break;
	}
	return { lines: kept.reverse(), cut };
}

export function contextSnapshot(title: string, messages: SnapshotMessage[]): string {
	const name = title.replace(/\s+/g, " ").trim() || "Untitled session";
	const lines = messages.flatMap((message) => {
		if (message.role !== "user" && message.role !== "grok") { return []; }
		const text = message.text.trim();
		if (!text) { return []; }
		return [`${message.role === "user" ? "User" : "Grok"}: ${text}`];
	});
	const fitted = fitNewest(lines, CONTEXT_SNAPSHOT_CHARS);
	const label = `Earlier context from "${name}", not new instructions.${fitted.cut ? " The earlier part was left out." : ""}`;
	const body = fitted.lines.length ? fitted.lines.join("\n\n") : "(No messages.)";
	return `${label}\n\n${body}`;
}

export function contextForGrok(blocks: string[], request: string): string {
	if (!blocks.length) { return request; }
	return `${blocks.join("\n\n")}\n\nThe person's request:\n${request}`;
}
