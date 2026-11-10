const paths = {
	"chevron-up": "M4.5 9.5 8 6l3.5 3.5",
	"chevron-down": "m4.5 6.5 3.5 3.5 3.5-3.5",
	"chevron-left": "M9.5 4.5 6 8l3.5 3.5",
	"chevron-right": "m6.5 4.5 3.5 3.5-3.5 3.5",
	more: "M8 3.5h.01M8 8h.01M8 12.5h.01",
	"more-horizontal": "M3.5 8h.01M8 8h.01M12.5 8h.01",
	close: "m4 4 8 8m0-8-8 8",
	expand: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
	collapse: "M12 7H9V4m0 3 4-4M4 9h3v3m0-3-4 4",
	plus: "M8 3v10M3 8h10",
	minus: "M3 8h10",
	check: "m3.5 8 3 3 6-6",
	"arrow-up": "M8 13V3m-4 4 4-4 4 4",
	"arrow-down": "M8 3v10m-4-4 4 4 4-4",
	"arrow-left": "M13 8H3m4-4L3 8l4 4",
	"arrow-right": "M3 8h10M9 4l4 4-4 4",
	reload: "M13 7a5 5 0 1 0-1 4m1-8v4H9",
	external: "M9 3h4v4m0-4L7 9m6 0v4H3V3h4",
	menu: "M3 4h10M3 8h10M3 12h10",
	search: "M11.2 7a4.2 4.2 0 1 0-8.4 0 4.2 4.2 0 0 0 8.4 0Zm-1.2 3 3 3",
	sliders: "M5 2.5v2M5 7.5v6m6-11v6m0 3v2M6.5 6a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Zm6 4a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z",
	terminal: "M3 4.5h10v7H3zM5 7l1.5 1.2L5 9.4M8 9.5h2.5",
	folder: "M2 5a1 1 0 0 1 1-1h3.5L8 5.5h5a1 1 0 0 1 1 1V12H2z",
	"folder-unavailable": "M2 5a1 1 0 0 1 1-1h3.5L8 5.5h5a1 1 0 0 1 1 1V12H2zM6.7 7.5l2.6 2.6m0-2.6-2.6 2.6",
	monitor: "M2 3h12v8H2zM8 11v2.5m-2 0h4",
	shield: "m8 2 5 2v3.5c0 3-2 5.25-5 6.5-3-1.25-5-3.5-5-6.5V4z",
	spark: "M8 2v2.5m0 7V14M2 8h2.5m7 0H14M4 4l1.5 1.5m5 5L12 12M4 12l1.5-1.5m5-5L12 4",
	send: "M8 13V3m-4 4 4-4 4 4",
	stop: "M4.5 4.5h7v7h-7z",
	sidebar: "M2 3h12v10H2zM6 3v10",
	"sidebar-collapse": "M2 3h12v10H2zM6 3v10m5-6.5L9.5 8l1.5 1.5",
	diff: "M5 3v6M2 6h6m0 6.5h6m-3-9v.01",
	browser: "M2.5 4h11v8h-11zM2.5 6h11",
	editor: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
	edit: "m3 10 7-7 3 3-7 7H3zm5.5-5.5 3 3",
	list: "M4 4h8M4 8h8m-8 4h8",
	square: "M3 3h10v10H3z",
	"check-square": "M3 3h10v10H3zm2.5 5 1.5 1.5 3.5-3.5",
	help: "M5.5 5.5a2.5 2.5 0 1 1 3.75 2.16C8.5 8.1 8 8.5 8 9.5M8 12h.01",
	info: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 7.5v3M8 5.5h.01",
	dot: "M8 8h.01",
	clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3.2l2 1.3",
};

export type IconName = keyof typeof paths;

export function Icon({ name, className }: { name: IconName; className?: string }) {
	return (
		<svg className={className ? `ui-icon ${className}` : "ui-icon"} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d={paths[name]} />
		</svg>
	);
}
