const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");

async function verify(temp) {
	const { app, BrowserWindow, ipcMain, net, session } = require("electron");
	app.setPath("userData", temp);
	const requests = new Set();
	const server = http.createServer((req, res) => {
		requests.add(req.url);
		res.writeHead(200, { "Content-Type": "text/plain" }).end("loopback test");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	await app.whenReady();
	session.defaultSession.protocol.handle("file", (request) => {
		if (/127\.0\.0\.1|wsl\.localhost/.test(request.url)) {
			requests.add(request.url);
			return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', { headers: { "Content-Type": "image/svg+xml" } });
		}
		return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
	});
	const url = `http://127.0.0.1:${server.address().port}`;
	const page = path.join(temp, "index.html");
	const appUrl = pathToFileURL(page).href;
	ipcMain.on("grok:home-dir", (event) => { event.returnValue = "test-home"; });
	const win = new BrowserWindow({
		show: false,
		webPreferences: {
			backgroundThrottling: false,
			sandbox: true,
			contextIsolation: true,
			webviewTag: true,
			preload: path.join(root, "electron", "preload.cjs"),
			additionalArguments: [`--grok-app-page=${appUrl.replace(/^file:\/\/\/([A-Z]):/, (_match, drive) => `file:///${drive.toLowerCase()}:`)}`],
		},
	});
	const pending = new Set([
		`${url}/label`,
		`${url}/css`,
		"file://127.0.0.1/grok-diagram-security/label.svg",
		"file://127.0.0.1/grok-diagram-security/css.svg",
	]);
	const blocked = Promise.withResolvers();
	const messages = [];
	win.webContents.on("console-message", ({ message = "" }) => {
		messages.push(message);
		const address = /^Not allowed to load local resource: (.+)$/.exec(message)?.[1]
			?? /'([^']+)'[^\n]*Content Security Policy/.exec(message)?.[1];
		if (pending.delete(address) && pending.size === 0) { blocked.resolve(); }
	});
	try {
		const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
			.replace("/src/main.tsx", "./draw.js");
		fs.writeFileSync(page, html);
		await Promise.all([once(win, "ready-to-show"), win.loadURL(`${appUrl}?session=restored`)]);
		assert.equal(await win.webContents.executeJavaScript("window.grokCode?.homeDir"), "test-home");
		const diagrams = [
			"graph TD\nA --> B",
			`graph TD\nA["<img src='${url}/label'>"] --> B`,
			`---\nconfig:\n  themeCSS: ".nodeLabel { background-image: url(${url}/css) }"\n---\ngraph TD\nA[CSS] --> B`,
			"graph TD\nA[\"<img src='//127.0.0.1/grok-diagram-security/label.svg'>\"] --> B",
			'---\nconfig:\n  themeCSS: ".nodeLabel { background-image: url(file://127.0.0.1/grok-diagram-security/css.svg) }"\n---\ngraph TD\nA[Share] --> B',
		];
		const result = await win.webContents.executeJavaScript(`(async () => {
			const drawn = [];
			for (const diagram of ${JSON.stringify(diagrams)}) {
				const result = await drawDiagram(diagram, "default");
				drawn.push(result.ok);
				if (result.ok) {
					const frame = document.createElement("iframe");
					frame.setAttribute("sandbox", "");
					frame.style.cssText = "width: 240px; height: 150px; border: 0";
					frame.srcdoc = diagramDocument(result.svg);
					await new Promise((resolve) => {
						frame.onload = () => resolve();
						document.body.append(frame);
					});
				}
			}
			return { drawn };
		})()`);
		assert.deepEqual(result.drawn, [true, true, true, true, true], "ordinary diagrams still render, including diagrams with blocked resources");
		// iframe load can precede the style and paint work that requests a CSS image.
		await win.webContents.capturePage();
		let timeout;
		await Promise.race([blocked.promise, new Promise((resolve) => { timeout = setTimeout(resolve, 5000); })]);
		clearTimeout(timeout);
		assert.deepEqual([...requests], [], "drawing and inserting Mermaid SVG makes no remote request");
		assert.deepEqual([...pending], [], `the isolated document reports blocking each probe\n${messages.join("\n")}`);
		await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("WSL thumbnail could not load"));
			image.src = imageSrc("//wsl.localhost/GrokDiagramTest/thumbnail.png");
			document.body.append(image);
		})`);
		const thumbnail = [...requests].find((request) => request.includes("wsl.localhost/GrokDiagramTest/thumbnail.png"));
		assert.ok(thumbnail, "WSL attachment thumbnail paths still load in the app page");
		requests.delete(thumbnail);
		await win.webContents.executeJavaScript(`new Promise((resolve) => {
			const preview = document.createElement("iframe");
			preview.setAttribute("sandbox", "");
			preview.srcdoc = "<p>Preview</p>";
			preview.onload = () => resolve();
			document.body.append(preview);
		})`);
		assert.ok(win.webContents.mainFrame.frames.some((frame) => frame.url === "about:srcdoc"), "sandboxed HTML previews still load");
		await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
			const guest = document.createElement("webview");
			guest.partition = "temp:grok-security-test";
			guest.src = "${url}/guest";
			guest.addEventListener("did-finish-load", () => resolve());
			guest.addEventListener("did-fail-load", () => reject(new Error("The guest could not load")));
			document.body.append(guest);
		})`);
		assert.deepEqual([...requests], ["/guest"], "the Browser guest can load a site under its own policy");
		await win.loadURL(`${url}/off-app`);
		assert.equal(await win.webContents.executeJavaScript("typeof window.grokCode"), "undefined");
		console.log("PASS diagram security: resource blocking, app-only preload, HTML preview and Browser guest");
	} finally {
		win.destroy();
		server.close();
	}
}

if (process.versions.electron) {
	const { app } = require("electron");
	verify(process.argv.at(-1)).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
} else {
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		console.log("SKIP diagram security: Electron needs an available display");
		return;
	}
	let electron;
	try {
		electron = require("electron");
	} catch {
		console.log("SKIP diagram security: Electron binary is unavailable");
		return;
	}
	if (!fs.existsSync(electron)) {
		console.log("SKIP diagram security: Electron binary is unavailable");
		return;
	}
	const parent = process.env.GROK_DIAGRAM_TEST_TEMP ?? os.tmpdir();
	fs.mkdirSync(parent, { recursive: true });
	const temp = fs.mkdtempSync(path.join(parent, "codex-diagram-security-"));
	try {
		const library = path.join(temp, "mermaid-source.js");
		fs.writeFileSync(library, `export default ${JSON.stringify(fs.readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8"))};`);
		require("esbuild").buildSync({
			stdin: { contents: 'import * as diagram from "./src/markdown-diagram"; import { imageSrc } from "./src/types"; Object.assign(globalThis, { drawDiagram: diagram.drawDiagram, diagramDocument: diagram.diagramDocument ?? ((svg) => svg), imageSrc });', resolveDir: root },
			alias: { "mermaid/dist/mermaid.min.js?raw": library },
			bundle: true,
			outfile: path.join(temp, "draw.js"),
			platform: "browser",
		});
		const result = spawnSync(electron, [__filename, temp], { stdio: "inherit", windowsHide: true, timeout: 60_000 });
		if (result.error) { throw result.error; }
		process.exitCode = result.status ?? 1;
	} finally {
		fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
