export interface MermaidApi {
	initialize: (config: { startOnLoad: boolean; securityLevel: "strict"; theme: "default" | "dark" }) => void;
	render: (id: string, source: string, container: HTMLDivElement) => Promise<{ svg: string }>;
}

export type DiagramResult = { ok: true; svg: string } | { ok: false };

// Tests replace this. The real library stays out of the main bundle until a diagram is drawn.
export const mermaidRuntime = {
	load(): Promise<MermaidApi> {
		return import("mermaid").then((mod) => (mod as { default: MermaidApi }).default);
	},
};

const drawn = new Map<string, Promise<DiagramResult>>();
let sequence = 0;

export function isMermaid(lang: string | undefined): boolean {
	return String(lang || "").trim().split(/\s+/)[0].toLowerCase() === "mermaid";
}

// Marked emits a code token for a fence that is still streaming. Draw only after its closing line arrives.
export function fenceClosed(raw: string): boolean {
	const open = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(raw);
	if (!open) { return false; }
	const marker = open[2][0];
	const size = open[2].length;
	const body = raw.slice(open[0].length);
	const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
	const breakAt = trimmed.lastIndexOf("\n");
	const line = breakAt === -1 ? trimmed : trimmed.slice(breakAt + 1);
	return new RegExp(`^ {0,3}${marker}{${size},}[ \\t]*$`).test(line);
}

export function diagramTheme(): "default" | "dark" {
	if (typeof document === "undefined") { return "dark"; }
	const chosen = document.documentElement?.getAttribute?.("data-theme");
	if (chosen === "light") { return "default"; }
	if (chosen === "dark") { return "dark"; }
	const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
	return media?.matches ? "default" : "dark";
}

export function drawDiagram(source: string, theme: "default" | "dark"): Promise<DiagramResult> {
	const key = `${theme}\n${source}`;
	const cached = drawn.get(key);
	if (cached) { return cached; }
	const job = (async (): Promise<DiagramResult> => {
		let container: HTMLDivElement | undefined;
		try {
			const api = await mermaidRuntime.load();
			api.initialize({ startOnLoad: false, securityLevel: "strict", theme });
			container = document.createElement("div");
			container.style.cssText = "position: fixed; inset: 0; overflow: hidden; visibility: hidden";
			document.body.append(container);
			sequence += 1;
			const rendered = await api.render(`mmd-${sequence}`, source, container);
			if (typeof rendered?.svg !== "string" || !rendered.svg.includes("<svg")) { return { ok: false }; }
			return { ok: true, svg: rendered.svg };
		} catch {
			return { ok: false };
		} finally {
			container?.remove();
		}
	})();
	drawn.set(key, job);
	return job;
}
