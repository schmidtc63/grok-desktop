# Codewomplers Grok Desktop

Codewomplers Grok Desktop is an unofficial desktop app for the Grok CLI on Windows. It brings chat, file editing, diffs, terminals, a browser pane and pull-request tools into one app.

Not affiliated with or endorsed by xAI. Grok is a trademark of its owner.

## Requirements

- Windows 10 or 11.
- Node.js 22.12 or later.
- Git 2.31 or later.
- The Grok CLI installed and signed in. If it is not on PATH, set `GROK_PATH` to its full executable path.
- GitHub CLI (`gh`), optional, for pull-request features. Sign in with `gh auth login` to use them.

## Install

```powershell
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

## Update

Codewomplers Grok Desktop checks its git origin for new versions. When one is out, the account button at the bottom of the sidebar says Update available. Open its menu and choose Update. The app closes, updates and opens again.

Versions before 0.2.0 have no updater. Update them once by hand:

```powershell
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
