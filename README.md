# Grok Desktop

An unofficial Windows desktop app for the [Grok CLI](https://x.ai). It runs `grok agent stdio` and gives it a desktop interface laid out like Claude Code Desktop: a session sidebar, a chat with tool rows and approval cards, and panes for changes, files, a terminal and a browser.

Grok Desktop is not made, endorsed or supported by xAI. "Grok" is a trademark of xAI.

## What it does

- Several sessions at once, each with its own folder, permission mode and message queue.
- Permission modes: Manual, Accept edits, Plan, Auto and Bypass permissions. New sessions start in Manual, and Bypass stays hidden until you allow it in Settings.
- Approval cards for edits and commands, with Allow, Deny and Always allow.
- A Changes pane with the diff, Revert, and line comments you can send to Grok.
- A Files pane with an editor, plus a terminal and a browser pane.
- A side chat (`/btw`) that asks a question without adding it to the main conversation.
- Worktree sessions, and pull request status through the GitHub CLI.
- A Context card that splits the context window into messages, tools, skills, system prompt and the rest, with the space left before auto-compact and Grok's spend over the last seven days.
- Grok's slash commands, with their replies shown in the chat.

## Requirements

- Windows 10 or 11.
- Node.js 20 or later, and Git.
- The Grok CLI, installed and signed in. Grok Desktop looks for it at `%USERPROFILE%\.grok\bin\grok.exe`; set `GROK_BIN` to use another path.
- Optional: the GitHub CLI (`gh`) for the pull request features.

## Run it

```
npm install
npm run desktop
```

`npm test` runs the test suites, and `npm run typecheck` checks the TypeScript.

## Limits

- Open only folders you trust. Grok and Git run that folder's own Git settings and hooks.
- Windows only for now. The terminal is PowerShell, processes are stopped with `taskkill`, and paths are handled the Windows way.
- The Context card's breakdown and the seven-day spend are read from the files Grok keeps under `%USERPROFILE%\.grok\sessions`. Grok does not document those files, so a Grok update can change them. When that happens the card falls back to the single total Grok reports.
- The spend covers Grok sessions on this computer only. It is not your account allowance, which Grok shows only in its own terminal app.
- Tested with Grok CLI 1.0.70.

## License

MIT. See [LICENSE](LICENSE).
