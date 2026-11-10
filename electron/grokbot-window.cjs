const path = require(`node:path`);

const HELPER = path.join(__dirname, `grokbot-window.ps1`);

function handleOf(win) {
	const raw = win.getNativeWindowHandle();
	return String(raw.length === 8 ? raw.readBigUInt64LE(0) : raw.readUInt32LE(0));
}

// Keeps Grok Bot's own window inside one of this app's windows, on Windows, through a helper process that lives only while it's held.
function createGrokBotWindow({ platform, spawn, exists, launch, env = process.env, retryMs = 1000, retryLimit = 30, watchMs = 2000, releaseMs = 5000 }) {
	let child = null;
	let holder = null;
	let saved = ``;
	let adopting = false;
	let viewOpen = false;
	let launched = false;
	let watching = false;
	let tries = 0;
	let timer = null;
	const waiting = [];

	const tell = (state) => {
		if (holder && !holder.isDestroyed()) { holder.webContents.send(`grok:grokbot-window`, state); }
	};
	const stopTimer = () => {
		clearTimeout(timer);
		timer = null;
	};
	const write = (line) => {
		if (child) { child.stdin.write(`${line}\n`); }
	};
	const adopt = () => {
		adopting = true;
		write(`adopt ${handleOf(holder)}${saved ? ` ${saved}` : ``}`);
	};
	const later = (ms) => {
		stopTimer();
		timer = setTimeout(() => {
			timer = null;
			if (viewOpen && holder && !holder.isDestroyed()) { adopt(); }
		}, ms);
	};
	const installedApp = () => [
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, `Programs`, `Grok Bot`, `Grok Bot.exe`),
		env.ProgramFiles && path.join(env.ProgramFiles, `Grok Bot`, `Grok Bot.exe`),
	].find((file) => file && exists(file));

	function onNone() {
		adopting = false;
		if (!viewOpen) { return; }
		if (saved) {
			saved = ``;
			adopt();
			return;
		}
		if (watching) {
			later(watchMs);
			return;
		}
		if (!launched) {
			const file = installedApp();
			if (!file) {
				tell(`missing`);
				return;
			}
			launched = true;
			launch(file);
		}
		tries++;
		if (tries > retryLimit) {
			tell(`notfound`);
			return;
		}
		later(retryMs);
	}

	function onLine(line) {
		const [word, ...rest] = line.trim().split(` `);
		if (word === `adopted`) {
			saved = rest.join(` `);
			adopting = false;
			launched = false;
			watching = false;
			tries = 0;
			stopTimer();
			tell(`open`);
		} else if (word === `none`) {
			onNone();
		} else if (word === `failed`) {
			adopting = false;
			saved = ``;
			tell(`problem`);
		} else if (word === `gone`) {
			saved = ``;
			if (viewOpen) {
				tell(`closed`);
				watching = true;
				later(watchMs);
			}
		} else if (word === `released`) {
			saved = ``;
			adopting = false;
			holder = null;
		}
	}

	function stopped(which) {
		if (child !== which) { return; }
		child = null;
		adopting = false;
		stopTimer();
		for (const done of waiting.splice(0)) { done(); }
		if (viewOpen) { tell(`problem`); }
	}

	function start() {
		if (child) { return; }
		const shell = path.join(env.SystemRoot || `C:\\Windows`, `System32`, `WindowsPowerShell`, `v1.0`, `powershell.exe`);
		const next = spawn(shell, [`-NoProfile`, `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-File`, HELPER], { stdio: [`pipe`, `pipe`, `ignore`], windowsHide: true });
		child = next;
		let buffer = ``;
		next.stdout.setEncoding(`utf8`);
		next.stdout.on(`data`, (text) => {
			buffer += text;
			const lines = buffer.split(`\n`);
			buffer = lines.pop();
			for (const line of lines) { onLine(line); }
		});
		next.stdin.on(`error`, () => {});
		next.on(`error`, () => stopped(next));
		next.on(`exit`, () => stopped(next));
	}

	function open(win) {
		if (platform !== `win32`) { return { ok: false }; }
		if (holder && holder !== win) { tell(`elsewhere`); }
		holder = win;
		viewOpen = true;
		launched = false;
		watching = false;
		tries = 0;
		stopTimer();
		tell(`starting`);
		start();
		adopt();
		return { ok: true };
	}

	function place(win, box) {
		if (win !== holder || !viewOpen || !saved || !box) { return; }
		const values = [box.x, box.y, box.width, box.height, box.viewHeight];
		if (!values.every((value) => Number.isInteger(value) && Math.abs(value) < 100000) || box.width < 1 || box.height < 1) { return; }
		write(`place ${values.join(` `)}`);
		write(box.visible ? `show` : `hide`);
	}

	function hide(win) {
		if (win !== holder) { return; }
		viewOpen = false;
		stopTimer();
		write(`away`);
	}

	const holding = () => Boolean(saved) || adopting;
	const holds = (win) => win === holder && holding();

	// Must finish before the holding window closes, because Windows would destroy Grok Bot's window along with it.
	function letGo(command) {
		viewOpen = false;
		stopTimer();
		if (!holding()) {
			if (child) { write(`release`); }
			holder = null;
			return Promise.resolve();
		}
		if (!child && holder && !holder.isDestroyed()) {
			start();
			adopt();
		}
		if (!child) {
			saved = ``;
			holder = null;
			return Promise.resolve();
		}
		const which = child;
		return new Promise((resolve) => {
			const limit = setTimeout(() => { which.kill(); }, releaseMs);
			waiting.push(() => {
				clearTimeout(limit);
				saved = ``;
				holder = null;
				resolve();
			});
			write(command);
		});
	}

	return { open, place, hide, release: () => letGo(`release`), close: () => letGo(`close`), holding, holds };
}

module.exports = { createGrokBotWindow };
