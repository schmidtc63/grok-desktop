import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";

interface PopupMenuProps extends ComponentPropsWithoutRef<"div"> {
	onDismiss: () => void;
	opener?: HTMLElement | null;
	focusOnOpen?: boolean;
	onBack?: () => void;
}

function controls(menu: HTMLElement) {
	return Array.from(menu.querySelectorAll<HTMLElement>("button, input, [role^='menuitem']")).filter((item) =>
		item.closest(".popup-menu") === menu && !item.matches(":disabled, [aria-disabled='true']"));
}

export function PopupMenu({ className, role = "menu", onDismiss, opener, focusOnOpen = true, onBack, onKeyDown, ...props }: PopupMenuProps) {
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLElement | null>(null);

	useLayoutEffect(() => {
		const menu = root.current;
		if (!menu) { return; }
		const doc = menu.ownerDocument;
		const previous = opener ?? doc.activeElement as HTMLElement | null;
		trigger.current = previous;
		return () => {
			queueMicrotask(() => {
				if (menu.isConnected || !previous?.isConnected) { return; }
				const active = doc.activeElement;
				if (!active || active === doc.body || menu.contains(active)) { previous.focus(); }
			});
		};
	}, [opener]);

	useLayoutEffect(() => {
		const menu = root.current;
		if (focusOnOpen && menu && !menu.contains(menu.ownerDocument.activeElement)) {
			(controls(menu)[0] ?? menu).focus();
		}
	}, [focusOnOpen, opener]);

	return <div {...props} ref={root} className={className ? `popup-menu ${className}` : "popup-menu"} role={role} tabIndex={-1} onKeyDown={(event) => {
		onKeyDown?.(event);
		if (event.defaultPrevented) { return; }
		if (event.key === "Escape" || (event.key === "ArrowLeft" && onBack)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "ArrowLeft" && onBack) { onBack(); }
			else { onDismiss(); }
			return;
		}
		if (event.key === "Tab" && role === "menu") {
			trigger.current?.focus();
			onDismiss();
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) { return; }
		event.preventDefault();
		event.stopPropagation();
		const items = controls(event.currentTarget);
		if (!items.length) { return; }
		const current = items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement);
		let next = 0;
		if (event.key === "End" || (event.key === "ArrowUp" && current <= 0)) { next = items.length - 1; }
		else if (event.key === "ArrowUp") { next = current - 1; }
		else if (event.key === "ArrowDown") { next = (current + 1) % items.length; }
		items[next].focus();
	}} />;
}
