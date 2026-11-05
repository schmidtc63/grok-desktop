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

### macOS and Linux

Codewomplers Grok Desktop runs on macOS and Linux from source. On macOS it also installs as an app with `scripts/install-mac.sh`. Still open:

- The in-app updater is Windows-only: `scripts/update-helper.cjs` stops and relaunches the app with Windows tools, so `updatePrepare` refuses on macOS and Linux and shows the manual steps.
- The installed macOS app has not been run on a real Mac yet. If you try it, please report what happens.
- On macOS, a copy run from source and started from the Dock opens plain Electron, and the menu bar names it "Electron". The installed app avoids both.
- Open in VS Code has not been tried on macOS or Linux.

### Narrower window

The main window has a minimum width of 1100 px (`electron/main.cjs`), so it cannot sit beside an editor on a laptop screen. Check the composer, panes and sidebar at narrower widths, then lower the minimum.

### Collapse long messages like Claude Desktop (built)

A long user message shows eight lines, fades, and offers Show more / Show less. Grok's replies stay open. Known gap: the eight-line check counts characters instead of measuring the bubble, so a message that just fits can get a fade and a Show more that opens nothing.

### API-key sign-in

Grok accepts an API key in `XAI_API_KEY` when no saved sign-in exists, and the app passes its environment through to Grok. This has not been tested with a real key. The setup check at launch counts only a saved sign-in, so it may report "Grok is not signed in" to someone who uses a key. Test it, make the setup check accept a key, document it in the README, and consider showing which sign-in is in use.
