export interface BrowserProblemInput {
	kind: "console" | "load" | "request" | "navigation";
	message: string;
	url?: string;
	source?: string;
	line?: number;
	level?: string;
	at?: number;
}

export interface BrowserProblem {
	kind: BrowserProblemInput["kind"];
	level: "warning" | "error" | "info";
	message: string;
	url: string;
	source: string;
	line: number;
	at: number;
	count: number;
}

export function cleanUrl(value: unknown): string {
	if (typeof value !== "string") { return ""; }
	const bare = value.replace(/[\r\n\t]/g, "").split(/[?#]/)[0];
	if (/^(data|javascript):/i.test(bare)) { return "[omitted URL]"; }
	let result = bare.replace(/(\/\/)[^/\s]*@/g, "$1");
	try {
		const url = new URL(result);
		url.username = "";
		url.password = "";
		result = url.toString();
	} catch { /* Relative source paths have no origin. */ }
	return result.slice(0, 2000);
}

export function cleanMessage(value: unknown): string {
	if (typeof value !== "string") { return ""; }
	const clipped = value.slice(0, 500);
	return clipped
		.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|data:|blob:|javascript:)[^\s<>"'`]+/gi, (url, offset: number) => {
			if (offset + url.length === clipped.length && /[^\s<>"'`]/.test(value.charAt(clipped.length))) { return "[omitted URL]"; }
			return cleanUrl(url);
		})
		.replace(/(^|[\s("'`])([^\s<>"'`]*[?#][^\s<>"'`]*)/g, (_match, prefix: string, url: string) => prefix + cleanUrl(url))
		.replace(/[\r\n]+/g, " ")
		.slice(0, 500);
}

export function sanitizeProblem(input: BrowserProblemInput): BrowserProblem {
	return {
		kind: input.kind,
		level: input.level === "warning" ? "warning" : input.kind === "navigation" ? "info" : "error",
		message: cleanMessage(input.message),
		url: cleanUrl(input.url),
		source: cleanUrl(input.source),
		line: Number.isInteger(input.line) && input.line! > 0 ? input.line! : 0,
		at: typeof input.at === "number" && Number.isFinite(new Date(input.at).getTime()) ? input.at : Date.now(),
		count: 1,
	};
}

export function addProblem(entries: BrowserProblem[], input: BrowserProblemInput): BrowserProblem[] {
	const entry = sanitizeProblem(input);
	const index = entries.findIndex((previous) => previous.kind === entry.kind && previous.level === entry.level && previous.message === entry.message && previous.url === entry.url && previous.source === entry.source && previous.line === entry.line);
	if (index !== -1) {
		return entries.map((previous, offset) => offset === index ? { ...previous, count: previous.count + 1 } : previous);
	}
	return [...entries, entry].slice(-100);
}

export function problemsPrompt(pageUrl: string, entries: BrowserProblem[], at = Date.now()): string {
	const lines = entries.map((stored) => {
		const entry = sanitizeProblem(stored);
		return `[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()} ${entry.kind}: ${entry.message}${entry.url ? ` — ${entry.url}` : ""}${entry.source ? ` (${entry.source}${entry.line ? `:${entry.line}` : ""})` : ""}${stored.count > 1 ? ` ×${stored.count}` : ""}`;
	});
	return `Browser diagnostics\nPage: ${cleanUrl(pageUrl) || "(unknown)"}\nCaptured: ${new Date(at).toISOString()}\n\n${lines.join("\n")}`;
}
