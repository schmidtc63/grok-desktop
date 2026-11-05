# Codewomplers Grok Desktop

Codewomplers Grok Desktop is an unofficial desktop app for the Grok CLI on Windows, macOS and Linux. It brings chat, file editing, diffs, terminals, a browser pane and pull-request tools into one app.

It runs the Grok CLI coding agent on folders on your computer. It is not a wrapper for the grok.com website.

Not affiliated with or endorsed by xAI. Grok is a trademark of its owner.

![A session with Grok's reply beside the Changes pane showing its edit](assets/screenshot.png)

## A typical task

1. Choose **New session**, pick a project folder and describe the change.
2. Grok reads and edits files in that folder. In **Normal** mode it asks before each edit or command, and you choose **Allow** or **Deny**. **Plan** mode explores and writes a plan first. **Auto-review** lets Grok's safety check approve calls, and **Always-approve** runs tools without asking. Ctrl+Shift+M switches modes.
3. Open the **Changes** pane (Ctrl+Shift+D) to review the diff. Click **+** beside a line to comment, then **Send to Grok** to ask for fixes.
4. Choose **Commit** or **Commit and push**, and Grok makes the commit. With the GitHub CLI signed in, **Create PR** opens a pull request and **Merge when ready** merges it when its checks pass.

The **Files**, **Terminal** and **Browser** panes sit beside the chat for editing by hand, running commands and checking a dev server.

## Requirements

- Windows 10 or 11, macOS, or a 64-bit Linux desktop.
- Node.js 22.12 or later, except for the Windows and macOS install commands.
- Git 2.31 or later.
- The Grok CLI installed and signed in. If it is not on PATH, set `GROK_PATH` to its full executable path. The app's setup check shows the install command for your system.
- GitHub CLI (`gh`), optional, for pull-request features. Sign in with `gh auth login` to use them.

On Windows and macOS one command installs the app. On Linux, and on Windows or macOS if you prefer a plain install, install from this repository and run the app from its folder.

## Install on Windows

1. Install Git from [git-scm.com](https://git-scm.com/download/win) if `git` is not already available in PowerShell. The app uses Git for its file list, diffs and branches.
2. Install the Grok CLI: `irm https://x.ai/cli/install.ps1 | iex`, then sign in.
3. In PowerShell:

```powershell
irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex
```

The command puts Codewomplers Grok Desktop in `%LOCALAPPDATA%\Programs` and adds a Start menu shortcut. It doesn't need Node.js. Open it from the Start menu.

### Plain install on Windows

The same app can be installed from this repository. This needs Node.js from [nodejs.org](https://nodejs.org). In PowerShell:

```powershell
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

Start a copy installed this way with `npm run desktop` from its folder each time.

## Install on macOS

1. Install Git with the Xcode Command Line Tools (`xcode-select --install`) or Homebrew. The app uses Git for its file list, diffs and branches.
2. Install the Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`, then sign in.
3. In Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash
```

The command puts Codewomplers Grok Desktop in Applications, or in `~/Applications` when you can't write to Applications. Open it from Launchpad, Spotlight or the Dock. It doesn't need Node.js.

The app isn't signed by Apple. Installed this way it carries no download mark, so macOS opens it without the "can't be verified" block. Each update is a new build, so macOS may ask again for access to folders such as Documents.

### Run from source on macOS

For working on the app itself, install Node.js from [nodejs.org](https://nodejs.org) or Homebrew as well, then in Terminal:

```bash
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

Start a copy run from source this way each time, from Terminal in its folder. Started like that, it finds the tools on your PATH, such as Homebrew's `git`, `gh` and `code`. Keeping its icon in the Dock and starting it from there opens plain Electron instead. While it runs from source, the menu bar names the app "Electron".

Shortcuts use Cmd where Windows uses Ctrl, except Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+`, which macOS keeps for itself with Cmd.

## Install on Linux

1. Install Git and Node.js with your package manager, or Node.js from [nodejs.org](https://nodejs.org).
2. Electron needs GTK 3, NSS, ALSA and GBM. On Ubuntu 24.04 and later:

```bash
sudo apt install libnss3 libgtk-3-0t64 libasound2t64 libgbm1
```

3. Install the Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`, then sign in.
4. In a terminal:

```bash
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

If `npm run desktop` stops with an error about the SUID sandbox helper (`chrome-sandbox`), which Ubuntu 24.04 and later can show, give that helper the owner and mode it needs, once after each `npm install`:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Don't start the app with `--no-sandbox`: its Browser pane loads web pages.

## Terminal

On Windows the Terminal pane and the Run buttons use PowerShell (PowerShell 7 when it is installed). On macOS and Linux they use bash. Either way the shell starts without your profile, and programs that need a full terminal, such as `vim` or `top`, don't work there.

## Turns from local tools

In Settings > Sessions, turn on **Accept turns from local tools** to let programs on this computer that hold the private token add a message to an open session. This is off by default. Use **Copy Grok session ID** in a sidebar session's menu to get its ID after its first turn.

A message joins that session's queue and runs with its mode and approvals. In Auto-review or Always-approve, its tool calls run without approval cards. Every inbound message starts with this line, even when the supplied text starts with a slash command:

```text
[Sent by a local tool, not typed in Grok Code]
```

While enabled, the app writes `<appData>/grok-code/inbound.json`:

- Windows: `%APPDATA%\grok-code\inbound.json`
- macOS: `~/Library/Application Support/grok-code/inbound.json`
- Linux: `$XDG_CONFIG_HOME/grok-code/inbound.json`, or `~/.config/grok-code/inbound.json` when `XDG_CONFIG_HOME` is not set.

The registry contains `{ "version": 1, "pid": 1234, "pipe": "<local pipe or socket path>", "token": "<private token>" }`. Keep the token private. Connect to `pipe` and send one JSON line, ending with a newline:

```json
{ "token": "<private token>", "agentSessionId": "<Grok session ID>", "text": "Your message" }
```

`text` must be non-empty and at most 100,000 characters. Session IDs are 1–256 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit. The connection returns one JSON line and closes:

```json
{ "ok": true, "status": "queued" }
```

- `sent`: accepted into an idle session's queue, ready to run.
- `queued`: waiting behind an active turn or another queued message.
- `held`: the session is on hold. The message runs when you press Send now or send a message; an inbound turn does not release the hold.

These statuses confirm acceptance, not that Grok has answered. A rejected request returns `{ "ok": false, "error": "..." }`. If a window does not answer in time, the reply is `{ "ok": false, "outcome": "unknown", "error": "Grok Code did not answer in time; the message may have been queued." }`. An unknown outcome means the message may already be queued; do not retry it automatically.

Turning the setting off closes the listener and removes the registry.

## Update

Codewomplers Grok Desktop checks for new versions: a copy run from source asks its git origin, and an installed copy on Windows or macOS asks GitHub. When one is out, the account button at the bottom of the sidebar says Update available. Open its menu and choose Update. A copy run from source on Windows closes, updates and opens again.

On Windows, quit the installed app and run the install command again. To install an older release instead, set its tag first: `$GrokDesktopTag = "v0.6.0"; irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex`.

On macOS, quit the app and run the install command again. To install an older release instead, add its tag: `curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash -s -- v0.6.0`.

On Linux, in a copy run from source on macOS, and in versions before 0.2.0, update by hand: quit the app, then in its folder run:

```bash
git pull
npm install
npm run desktop
```

If the update can't run (local changes, another branch, or your own commits), the app shows these commands instead.

If the app doesn't start after an interrupted update, run `node scripts/update-helper.cjs --recover` in its folder.

## Tests

```powershell
npm run typecheck
npm run build
npm test
```

## Contributing

Open work and ideas are listed in [TODO.md](TODO.md). Pull requests are welcome.

## License

MIT. Copyright (c) 2026 Codewomplers. See [LICENSE](LICENSE).
