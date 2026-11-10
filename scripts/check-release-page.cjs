async function pageReady() {
	const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
	const page = targets.find(({ type, url }) => type === "page" && url.startsWith("file:") && new URL(url).pathname.endsWith("/dist/index.html"));
	if (!page?.webSocketDebuggerUrl) { return false; }
	return new Promise((resolve) => {
		const socket = new WebSocket(page.webSocketDebuggerUrl);
		const finish = (ready) => {
			resolve(ready);
			socket.close();
		};
		socket.onopen = () => socket.send(JSON.stringify({
			id: 1,
			method: "Runtime.evaluate",
			params: {
				expression: 'typeof window.grokCode?.appInfo === "function" && !!document.querySelector("#root > .app")',
				returnByValue: true,
			},
		}));
		socket.onmessage = ({ data }) => {
			const reply = JSON.parse(data);
			if (reply.id === 1) { finish(reply.result?.result?.value === true); }
		};
		socket.onerror = () => finish(false);
		socket.onclose = () => resolve(false);
	});
}

pageReady().then((ready) => { process.exitCode = ready ? 0 : 1; }, () => { process.exitCode = 1; });
