export interface MermaidApi {
	initialize: (config: { startOnLoad: boolean; securityLevel: "strict"; theme: "default" | "dark" }) => void;
	render: (id: string, source: string, container: HTMLDivElement) => Promise<{ svg: string; width?: number; height?: number }>;
}

export type DiagramResult = { ok: true; svg: string; width: number; height: number } | { ok: false };

export function diagramDocument(body: string): string {
	return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:transparent}svg{max-width:100%;height:auto;display:block}</style><body>${body}</body>`;
}

function renderIsolated(library: string, config: Parameters<MermaidApi["initialize"]>[0], id: string, source: string, container: HTMLDivElement): ReturnType<MermaidApi["render"]> {
	return new Promise((resolve, reject) => {
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.style.cssText = "width: 1000px; height: 1000px; border: 0";
		const finish = () => {
			clearTimeout(timeout);
			window.removeEventListener("message", receive);
			frame.remove();
		};
		const receive = (event: MessageEvent) => {
			if (event.source !== frame.contentWindow || event.data?.id !== id) { return; }
			if (event.data.ready === true) {
				frame.contentWindow?.postMessage({ id, config, source }, "*");
			} else if (typeof event.data.svg === "string") {
				finish();
				resolve({ svg: event.data.svg, width: event.data.width, height: event.data.height });
			} else {
				finish();
				reject(new Error("This diagram could not be drawn."));
			}
		};
		const timeout = setTimeout(() => { finish(); reject(new Error("This diagram took too long.")); }, 15000);
		window.addEventListener("message", receive);
		const script = `
			window.addEventListener("message", async (event) => {
				if (event.source !== parent || event.data?.id !== ${JSON.stringify(id)}) { return; }
				const { id, config, source } = event.data;
				try {
					mermaid.initialize(config);
					const { svg } = await mermaid.render(id, source);
					document.body.innerHTML = svg;
					const image = document.querySelector("svg");
					const box = image.viewBox.baseVal;
					const rect = image.getBoundingClientRect();
					parent.postMessage({ id, svg, width: box.width || rect.width, height: box.height || rect.height }, "*");
				} catch {
					parent.postMessage({ id, error: true }, "*");
				}
			});
			parent.postMessage({ id: ${JSON.stringify(id)}, ready: true }, "*");
		`;
		frame.srcdoc = diagramDocument(`<script>${library.replace(/<\/script/gi, "<\\/script")}</script><script>${script}</script>`);
		container.append(frame);
	});
}

// Tests replace this. The real library stays out of the main bundle until a diagram is drawn.
export const mermaidRuntime = {
	async load(): Promise<MermaidApi> {
		const { default: library } = await import("mermaid/dist/mermaid.min.js?raw");
		let config: Parameters<MermaidApi["initialize"]>[0] = { startOnLoad: false, securityLevel: "strict", theme: "dark" };
		return {
			initialize(value) { config = value; },
			render(id, source, container) { return renderIsolated(library, config, id, source, container); },
		};
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
			const width = Number(rendered.width);
			const height = Number(rendered.height);
			return { ok: true, svg: rendered.svg, width: Number.isFinite(width) && width > 0 ? width : 800, height: Number.isFinite(height) && height > 0 ? height : 400 };
		} catch {
			return { ok: false };
		} finally {
			container?.remove();
		}
	})();
	drawn.set(key, job);
	return job;
}
