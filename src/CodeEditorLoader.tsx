import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./CodeEditor";

const Editor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })).catch(() => ({
	default: () => <p className="note" role="alert">The editor could not load. Restart the app to try again.</p>,
})));

export function CodeEditorLoader(props: CodeEditorProps) {
	return (
		<Suspense fallback={<p className="meta" role="status">Loading editor…</p>}>
			<Editor {...props} />
		</Suspense>
	);
}
