# TODO

Open work and ideas for Codewomplers Grok Desktop. If you build one of these in a fork, please open a pull request against [schmidtc63/grok-desktop](https://github.com/schmidtc63/grok-desktop).

## Features

### Cloud sessions through Cursor's Cloud Agents API

The New session form shows a greyed-out Cloud environment. Grok itself has no public way to start a cloud session, but The X Subscription bundles Grok with Cursor, and Cursor's Cloud Agents API can run an agent in Cursor's cloud on a repository hosted on GitHub or a similar service.

- **What the API offers (v1, public beta):** start an agent on a repository and branch (`POST /v1/agents`), stream its text, thinking and tool calls (`GET /v1/agents/{id}/runs/{runId}/stream`), send follow-ups or add instructions to a running turn, cancel a run, and read the result branch or pull request and the token usage.
- **Prerequisites:** a Cursor plan that includes cloud agents (Cursor lists Premium and higher, Teams, Enterprise, or a legacy paid plan), a Cursor API key, and the repository connected to Cursor.
- **Open question:** whether Grok models are offered to cloud agents. `GET /v1/models` answers it.
- **Suggested design:**
  - A new `electron/cloud.cjs` that starts agents, reads the stream, sends follow-ups and cancels, and reconnects to a running agent after a restart.
  - The API key is stored with Electron `safeStorage`, never in browser storage, and Settings has a place to add and remove it.
  - Cloud is enabled in the New session form once a key is saved. The repository and branch come from the folder's `origin` and current branch. The form warns that unpushed and uncommitted work is not included.
  - Stream events map onto what the chat already shows: text, thinking, tool rows, and a final message with the branch or pull-request link.
  - No approval cards: the agent works on its own cloud computer and pushes to a new branch.
  - The Changes pane can show the cloud branch after a `git fetch`, and an "Open locally" action can reuse the existing worktree code.
- **Start with a spike:** list the models, run one small agent on a throwaway repository, and record the real stream events before building the UI.

### Run a session on another computer you own

Cursor's API can also run an agent on a registered machine, and `grok worker` registers a computer with Cursor. This could turn the greyed-out SSH environment into "My machines". Remote agents run commands on that machine, so it needs a clear opt-in.

### Installers and updates

Codewomplers Grok Desktop runs from source with `npm run desktop`. Packaging with electron-builder or Electron Forge, publishing GitHub Releases, code signing (unsigned installers trigger Windows SmartScreen) and an update path would let people run it without Node.js.

### macOS and Linux

Codewomplers Grok Desktop is Windows-only (`"os": ["win32"]` in `package.json`). The terminal, shell commands, path handling and window naming assume Windows.

### API-key sign-in

Grok accepts an API key in `XAI_API_KEY` when no saved sign-in exists, and the app passes its environment through to Grok. This has not been tested with a real key. Test it, document it in the README, and consider showing which sign-in is in use.
