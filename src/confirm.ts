export interface ConfirmAsk {
	title: string;
	body?: string;
	ok: string;
	cancel?: string;
	danger?: boolean;
}

export type PendingConfirm = ConfirmAsk & { resolve: (yes: boolean) => void };

let host: ((pending: PendingConfirm) => void) | null = null;

export function setConfirmHost(next: (pending: PendingConfirm) => void): () => void {
	host = next;
	return () => { if (host === next) { host = null; } };
}

export function askConfirm(ask: ConfirmAsk): Promise<boolean> {
	if (!host) {
		return Promise.resolve(window.confirm([ask.title, ask.body].filter(Boolean).join("\n\n")));
	}
	const show = host;
	return new Promise((resolve) => show({ ...ask, resolve }));
}
