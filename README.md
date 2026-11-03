# Codewomplers Grok Desktop

Codewomplers Grok Desktop is an unofficial desktop app for the Grok CLI on Windows, macOS and Linux. It brings chat, file editing, diffs, terminals, a browser pane and pull-request tools into one app.

Not affiliated with or endorsed by xAI. Grok is a trademark of its owner.

## Requirements

- Windows 10 or 11, macOS, or a 64-bit Linux desktop.
- Node.js 22.12 or later.
- Git 2.31 or later.
- The Grok CLI installed and signed in. If it is not on PATH, set `GROK_PATH` to its full executable path. The app's setup check shows the install command for your system.
- GitHub CLI (`gh`), optional, for pull-request features. Sign in with `gh auth login` to use them.

Everyone installs from this repository and runs the app from its folder. There are no installers.

## Install on Windows

In PowerShell:

```powershell
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

## Install on macOS

1. Install Git with the Xcode Command Line Tools (`xcode-select --install`) or Homebrew, and Node.js from [nodejs.org](https://nodejs.org) or Homebrew.
2. Install the Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`, then sign in.
3. In Terminal:

```bash
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

Start the app this way each time, from Terminal in its folder. Started like that, it finds the tools on your PATH, such as Homebrew's `git`, `gh` and `code`. Keeping its icon in the Dock and starting it from there opens plain Electron instead. While it runs from source, the menu bar names the app "Electron".

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

## Update

Codewomplers Grok Desktop checks its git origin for new versions. When one is out, the account button at the bottom of the sidebar says Update available. Open its menu and choose Update. On Windows the app closes, updates and opens again.

On macOS and Linux, and in versions before 0.2.0, update by hand: quit the app, then in its folder run:

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
