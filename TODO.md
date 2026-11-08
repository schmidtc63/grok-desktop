# TODO

Open work and ideas for Codewomplers Grok Desktop. If you build one of these in a fork, please open a pull request against [schmidtc63/grok-desktop](https://github.com/schmidtc63/grok-desktop).

## Features

### Cloud sessions: still open

Cloud sessions and My machines run through Cursor's Cloud Agents API (`electron/cloud.cjs`). Still open:

- An "Open locally" action that fetches the agent's branch into a worktree.
- Stop cancels the run, but a command already running on a machine keeps running.
- A worker that stops during a run stalls the run until the worker restarts, and the app doesn't say why.

### SSH environment

The New session form shows a greyed-out SSH environment. Running a session on another computer over SSH isn't built. My machines, in Cloud sessions, covers part of this through Cursor.

### macOS and Linux

Codewomplers Grok Desktop runs on macOS and Linux from source. On macOS it also installs as an app with `scripts/install-mac.sh`. Still open:

- The in-app updater is Windows-only: `scripts/update-helper.cjs` stops and relaunches the app with Windows tools, so `updatePrepare` refuses on macOS and Linux and shows the manual steps.
- The installed macOS app has not been run on a real Mac yet. If you try it, please report what happens.
- On macOS, a copy run from source and started from the Dock opens plain Electron, and the menu bar names it "Electron". The installed app avoids both.
- Open in VS Code has not been tried on macOS or Linux.
- The Dock badge that shows when Grok needs you has not been tried on a real Mac.
- The Linux `.tar.gz` and `.deb` packages have not been installed and run on Linux yet.

