import { useState, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { PopupMenu } from "./PopupMenu";

export interface PaneLayoutControls {
	expanded: boolean;
	onToggleExpand: () => void;
	moveEarlier?: () => void;
	moveLater?: () => void;
}

export type PaneMenuSpot = { top: number; left: number; opener: HTMLElement };

export function paneMenuSpot(opener: HTMLElement): PaneMenuSpot {
	const rect = opener.getBoundingClientRect();
	const width = 200;
	return { top: rect.bottom + 4, left: Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8), opener };
}

export function paneMenuButton(name: string, open: boolean, onClick: (event: MouseEvent<HTMLButtonElement>) => void, menuRole = true) {
	return <button type="button" className="pane-x" aria-label={`${name} menu`} title={`${name} menu`} aria-haspopup={menuRole ? "menu" : undefined} aria-expanded={open} onClick={onClick}><Icon name="more" /></button>;
}

export function paneExpandButton(name: string, expanded: boolean, onClick: () => void, expandLabel = `Expand ${name}`) {
	return <button type="button" className="pane-x" aria-label={expanded ? `Return ${name} to the side` : expandLabel} title={expanded ? "Restore pane (Esc)" : expandLabel} aria-pressed={expanded} onClick={onClick}><Icon name={expanded ? "collapse" : "expand"} /></button>;
}

export function paneCloseButton(onClick: () => void) {
	return <button type="button" className="pane-x" aria-label="Close pane" title="Close pane" onClick={onClick}><Icon name="close" /></button>;
}

export function paneMoveItems(layout: PaneLayoutControls, onDismiss: () => void, menuRole = true) {
	return ([
		["Move earlier", "Already first", layout.moveEarlier],
		["Move later", "Already last", layout.moveLater],
	] as const).map(([label, reason, move]) => (
		<button type="button" key={label} className={menuRole ? undefined : "bp-item"} role={menuRole ? "menuitem" : undefined} disabled={!move} onClick={() => { onDismiss(); move?.(); }}>
			<span>{label}{!move && <small className="menu-reason">{reason}</small>}</span>
		</button>
	));
}

export function PaneActions({ name, layout, onClose }: { name: string; layout?: PaneLayoutControls; onClose: () => void }) {
	const [menu, setMenu] = useState<PaneMenuSpot | null>(null);
	return (
		<div className="pane-actions">
			{layout && <>
				{paneMenuButton(name, !!menu, (event) => setMenu(menu ? null : paneMenuSpot(event.currentTarget)))}
				{paneExpandButton(name, layout.expanded, layout.onToggleExpand)}
			</>}
			{paneCloseButton(onClose)}
			{layout && menu && <>
				<button type="button" className="menu-back" aria-label="Close menu" tabIndex={-1} onClick={() => setMenu(null)} />
				<PopupMenu className="row-pop" aria-label={`${name} menu`} style={{ top: menu.top, left: menu.left }} opener={menu.opener} onDismiss={() => setMenu(null)}>
					{paneMoveItems(layout, () => setMenu(null))}
				</PopupMenu>
			</>}
		</div>
	);
}
