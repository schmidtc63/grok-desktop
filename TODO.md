# TODO

Open work and ideas for Codewomplers Grok Desktop. If you build one of these in a fork, please open a pull request against [schmidtc63/grok-desktop](https://github.com/schmidtc63/grok-desktop).

## Known problems

### Windows notifications can name "Electron" as the sender

Run from source, the app's exe is `node_modules/electron/dist/electron.exe`, and only `scripts/windows-name.mjs` gives it the name Codewomplers Grok Desktop. The script runs in `npm run desktop` and in the in-app updater, but not after `npm install` or `npm ci`. After a fresh clone or an Electron upgrade, the taskbar pin and Open at sign-in show "Electron" on notifications until the script runs. The packaged build is not affected. One option is to run the script from `postinstall`.

## Features

### Scheduled routines and Open at sign-in: still open

- A real Windows sign-out and sign-in, a real notification click, and Open at sign-in on macOS and Linux are untested.
- A crash during a run can lose that run, and a run that hangs has no overall timer.
- Nothing runs while the computer sleeps, and a run right after waking is not retried if the network is down.

### Grok Bot: still open

- Several live Bots at once, macOS and Linux are untested.
- Showing the real Grok Bot window inside the app works on Windows only. Linux on X11 could use the same idea; the setting stays greyed out on Linux and macOS until someone builds it.

### Cloud sessions: still open

Cloud sessions and My machines run through Cursor's Cloud Agents API (`electron/cloud.cjs`). Still open:

- An "Open locally" action that fetches the agent's branch into a worktree.
- Stop cancels the run, but a command already running on a machine keeps running.
- A worker that stops during a run stalls the run until the worker restarts, and the app doesn't say why.

### SSH environment

The New session form shows a greyed-out SSH environment. Running a session on another computer over SSH isn't built. My machines, in Cloud sessions, covers part of this through Cursor.

### macOS and Linux

Codewomplers Grok Desktop runs on macOS and Linux from source. On macOS it also installs as an app with `scripts/install-mac.sh`. Still open:

- In-app updates for source checkouts are Windows-only. Installed copies can update in the app on Windows, macOS and Linux.
- The installed macOS app has run and updated on a CI runner, but not on a real Mac desktop yet. If you try it, please report what happens.
- On macOS, a copy run from source and started from the Dock opens plain Electron, and the menu bar names it "Electron". The installed app avoids both.
- Open in VS Code has not been tried on macOS or Linux.
- The Dock badge that shows when Grok needs you has not been tried on a real Mac.
- The Linux `.tar.gz` and `.deb` packages have not been installed and run on Linux yet.

