import type { Session } from "./types";

export type PrWatch = NonNullable<Session["prWatch"]>;
export type Alert = NonNullable<PrWatch["alert"]>;

export function prWatchStep(watch: PrWatch, status: PrStatus): { watch?: Session["prWatch"]; alert?: Alert; stop: boolean } {
	if (!status.ok) { return { watch, stop: false }; }
	const pr = status.pr;
	if (!pr || pr.state !== "OPEN") { return { stop: true }; }
	const failingNow = pr.checks.filter((check) => check.state === "fail").map((check) => check.name);
	const newFails = failingNow.filter((name) => !watch.failing.includes(name));
	const feedback = pr.feedback ?? [];
	const newFeedback = feedback.filter((item) => item.at > watch.seenAt);
	const seenAt = feedback.reduce((latest, item) => item.at > latest ? item.at : latest, watch.seenAt);
	const next: PrWatch = { ...watch, failing: failingNow, seenAt };
	if (newFails.length === 0 && newFeedback.length === 0) { return { watch: next, stop: false }; }
	const alert: Alert = {
		failed: [...new Set([...(watch.alert?.failed ?? []), ...newFails])],
		feedback: (watch.alert?.feedback ?? 0) + newFeedback.length,
		from: [...new Set([...(watch.alert?.from ?? []), ...newFeedback.map((item) => item.who)])],
	};
	next.alert = alert;
	return { watch: next, alert, stop: false };
}

export function prAlertText(number: number, alert: Alert): string {
	const parts: string[] = [];
	if (alert.failed.length > 0) { parts.push(`CI failed (${alert.failed.join(", ")})`); }
	if (alert.feedback > 0) { parts.push(`${alert.feedback} new review comment${alert.feedback === 1 ? "" : "s"}${alert.from.length > 0 ? ` from ${alert.from.join(", ")}` : ""}`); }
	return `PR #${number}: ${parts.join(" and ")}.`;
}

export function prFixPrompt(number: number, alert: Alert): string {
	const parts: string[] = [];
	if (alert.failed.length > 0) { parts.push(`Pull request #${number} has failing CI checks: ${alert.failed.join(", ")}. Read the failures with \`gh pr checks ${number}\` and \`gh run view <run id> --log-failed\`, find the cause and fix it.`); }
	if (alert.feedback > 0) { parts.push(`Pull request #${number} has new review feedback. Read it with \`gh pr view ${number} --comments\` and the inline comments with \`gh api repos/{owner}/{repo}/pulls/${number}/comments\`, then address each point. Say which points you disagree with instead of changing them.`); }
	return `${parts.join("\n\n")} Tell me what you changed. Don't push until I've looked at it.`;
}
