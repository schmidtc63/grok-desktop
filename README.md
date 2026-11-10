# Codewomplers Grok Desktop

Codewomplers Grok Desktop is an unofficial desktop app for the Grok CLI on Windows, macOS and Linux. It brings chat, file editing, diffs, terminals, a browser pane, pull-request tools, scheduled routines and sandboxed sessions into one app.

It runs the Grok CLI coding agent on folders on your computer. It is not a wrapper for the grok.com website.

Not affiliated with or endorsed by xAI. Grok is a trademark of its owner.

![A session where Grok added a command to a small CLI, with the Changes pane showing its edit](assets/screenshot.png)

## A typical task

1. Choose **New session**, pick a project folder and describe the change. **CLI…** beside it opens a conversation started in the Grok CLI and continues that same session.
2. Grok works in that folder. In **Normal** and **Plan** modes, its file-reading tools ask for approval outside the session folder, any folders you add, Grok's home and the temp folder. **Normal** also asks before edits and commands unless you've already granted permission. **Plan** mode explores and writes a plan first. **Auto-review** lets Grok's safety check approve calls and can still ask. **Always-approve** skips ordinary tool approvals. Browser permissions, deny rules and safety hooks still apply. Ctrl+Shift+M opens the mode menu.
3. Open the **Changes** pane (Ctrl+Shift+D) to review the diff. Click **+** beside a line to comment, then **Send to Grok** to ask for fixes.
4. Choose **Commit** or **Commit and push** to enter a message and commit the checked files directly, or hand the commit to Grok. With the GitHub CLI signed in, **Create PR** opens a pull request and **Merge when ready** merges it when its checks pass.

The **+** menu's **Context from another chat** attaches up to three earlier chats, including archived ones, to the message being written. Grok receives a labelled snapshot of each conversation, with the newest part kept when it is long. The chat shows your text and a chip for each source, not the snapshot.

The **Files**, **Terminal** and **Browser** panes sit beside the chat for editing by hand, running commands and checking a dev server.

Browser control is off by default. Enable **Settings > Let Grok use the Browser pane** to let Grok read pages and use navigate, click, fill, select and scroll in the current session's active tab. Grok uses your Browser-pane sign-ins, and what it reads goes to xAI as part of the conversation. Grok asks to read or act on non-local sites even in Always-approve unless you already granted that access. Entering a sensitive field asks separately.

A redirect to a site that needs permission can load before Grok asks to read it. A click can also load a new site, and any required read approval comes when Grok tries to read that page.

Grok's Problems tool includes only entries from the current page's origin. The pane keeps its full history for you to review.

The Browser pane shows each browser call with **Stop**. Stop blocks later browser calls immediately, but an already-sent action may still finish. A timed-out action has an uncertain outcome; browser calls stay blocked until it settles or the page navigates or closes. **Browser menu > Let Grok use this browser** resumes a stopped session.

Save reusable composer text from the **+** menu, insert it at the cursor with **Saved prompts** (Ctrl+Shift+P; Cmd+Shift+P on macOS), and rename, edit or delete it in **Settings → Saved prompts**. Inserting never sends the message.

Use **Settings → UI Configuration** to save named sets of fonts, sizes and colors, with separate colors for light and dark. Fonts and percent sizes under **Whole app** apply across the app, and a Font or Text size on one element overrides them. A Font can also be any font installed on your computer. Install it the usual way, then restart the app: on Windows, right-click the font file and choose **Install**; on macOS, open it in Font Book; on Linux, copy it to `~/.local/share/fonts`. A configuration that names a font this computer doesn't have uses a standard font instead. Changes save as you edit. Use the sample to see your changes, or press and hold **Hold to see the app** for the full window. **Revert** restores the configuration as it was when you first opened it in this window. **View → Use Default UI** restores the built-in look and keeps your saved configurations. Press Alt if the menu bar is hidden on Windows.

## Requirements

- Windows 10 or 11, macOS, or a 64-bit Linux desktop.
- Node.js 22.12 or later when running from source. Release downloads include their runtime.
- Git 2.31 or later. On Windows and macOS the app's setup check installs it.
- The Grok CLI, signed in. On Windows and macOS the app's setup check installs it. If it is installed somewhere else, set `GROK_PATH` to its full executable path.
- GitHub CLI (`gh`), optional, for pull-request features. Sign in with `gh auth login` to use them.

An xAI API key can stand in for `grok login`. Choose **xAI API key** under **Settings > General > Sign-in**. The key is encrypted with the system keyring and never shown. Saving it signs out of Grok first, after asking, because a saved sign-in wins over a key. You can instead set `XAI_API_KEY` in the environment this app starts with: a user environment variable, or the terminal you launch the app from. The setup check says when a key is in use.

Behind a proxy, set `HTTPS_PROXY` or `HTTP_PROXY`, and `NO_PROXY` for hosts that bypass it. A company certificate can be named in `NODE_EXTRA_CA_CERTS`. The app passes these through to Grok. The setup check shows the proxy's scheme, host and port, without a user name or password, and whether the certificate file is there.

Download the app for your platform below, or run it from this repository if you prefer a source install.

To check a download, run `Get-FileHash <file> -Algorithm SHA256` on Windows, `shasum -a 256 <file>` on macOS, or `sha256sum <file>` on Linux, replacing `<file>` with the downloaded file's name. Compare the result with its line in `SHA256SUMS.txt` on the release page.

The one-line Windows and macOS installers leave checksum verification to you.

## Install on Windows

Download [Codewomplers-Grok-Desktop-Setup.exe](https://github.com/schmidtc63/grok-desktop/releases/latest) from the latest release and run it. Windows says it protected your PC because the app isn't signed: click More info, then Run anyway.

Or run this in PowerShell, which shows no warning:

```powershell
irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex
```

Either one puts Codewomplers Grok Desktop in `%LOCALAPPDATA%\Programs` and adds a Start menu shortcut. It doesn't need Node.js. Open it from the Start menu.

The first launch opens the setup check. **Install Grok CLI** installs Grok and its Git. The first message opens Grok's sign-in.

### Plain install on Windows

The same app can be installed from this repository. This needs Git, the Grok CLI and Node.js.

1. Install Git from [git-scm.com](https://git-scm.com/download/win) if `git` is not already available in PowerShell. The app uses Git for its file list, diffs and branches.
2. Install the Grok CLI: `irm https://x.ai/cli/install.ps1 | iex`, then sign in.
3. Install Node.js from [nodejs.org](https://nodejs.org). In PowerShell:

```powershell
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

Start a copy installed this way with `npm run desktop` from its folder each time.

## Install on macOS

Download the disk image for your Mac from the [latest release](https://github.com/schmidtc63/grok-desktop/releases/latest): `Codewomplers-Grok-Desktop-mac-arm64.dmg` for Apple silicon, or `Codewomplers-Grok-Desktop-mac-x64.dmg` for Intel. Open it and drag the app to Applications.

The first time, macOS blocks the app because it isn't signed: open System Settings > Privacy & Security and click Open Anyway.

Or run this in Terminal, which shows no warning:

```bash
curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash
```

The command puts Codewomplers Grok Desktop in Applications, or in `~/Applications` when you can't write to Applications. Open it from Finder or Spotlight. Once it is open, you can keep its icon in the Dock. It doesn't need Node.js.

The first launch opens the setup check. **Install Grok CLI** installs Grok. **Install Git** opens Apple's window, which installs the Command Line Tools, including Git. The first message opens Grok's sign-in.

The app isn't signed by Apple. A copy installed by the Terminal command carries no download mark, so macOS opens it without the "can't be verified" block. A copy from the disk image needs Open Anyway, as above. Each update is a new build, so macOS may ask again for access to folders such as Documents.

### Run from source on macOS

For working on the app itself, install Git with the Xcode Command Line Tools (`xcode-select --install`) or Homebrew, install the Grok CLI with `curl -fsSL https://x.ai/cli/install.sh | bash` and sign in, and install Node.js from [nodejs.org](https://nodejs.org) or Homebrew as well, then in Terminal:

```bash
git clone https://github.com/schmidtc63/grok-desktop.git
cd grok-desktop
npm install
npm run desktop
```

Start a copy run from source this way each time, from Terminal in its folder. Started like that, it finds the tools on your PATH, such as Homebrew's `git`, `gh` and `code`. Keeping its icon in the Dock and starting it from there opens plain Electron instead. While it runs from source, the menu bar names the app "Electron".

Shortcuts use Cmd where Windows uses Ctrl, except Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+`, which macOS keeps for itself with Cmd.

## Install on Linux

Download the Linux x64 `.deb` or `Codewomplers-Grok-Desktop-linux-x64.tar.gz` from the [latest release](https://github.com/schmidtc63/grok-desktop/releases/latest). Both include Electron and need no separate Node.js install. Install Git with your package manager and install the Grok CLI with `curl -fsSL https://x.ai/cli/install.sh | bash`, then sign in.

### Debian or Ubuntu package

In the folder containing the downloaded `.deb`, run:

```bash
sudo apt install ./codewomplers-grok-desktop_*_amd64.deb
```

This installs the app under `/opt/codewomplers-grok-desktop`, its desktop menu entry and icon, and the `codewomplers-grok-desktop` command. Installation configures the sandbox helper's root ownership and mode 4755. Open the app from your desktop menu or run `codewomplers-grok-desktop`. To remove it, run `sudo apt remove codewomplers-grok-desktop`.

### Tar archive

Electron needs GTK 3, NSS, ALSA and GBM. On Ubuntu 24.04 and later:

```bash
sudo apt install libnss3 libgtk-3-0t64 libasound2t64 libgbm1
```

Extract the archive into a folder you want to keep, configure the sandbox helper, and start the app:

```bash
tar -xzf Codewomplers-Grok-Desktop-linux-x64.tar.gz
cd Codewomplers-Grok-Desktop-linux-x64
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
./codewomplers-grok-desktop
```

Repeat the sandbox commands after replacing the folder with a new release. To remove this copy, delete its extracted folder.

### Run from source on Linux

Install Node.js 22.12 or later as well. On Debian or Ubuntu, install `build-essential` and `python3` before `npm install` so node-pty can build the native terminal:

```bash
sudo apt install build-essential python3
```

If the native module cannot load, the Terminal pane falls back to pipes and says so. Then in a terminal:

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

## Cloud sessions

A session can also run through Cursor's Cloud Agents API instead of the Grok CLI. Choose the **Cloud** environment in the New session form. The agent runs on Cursor's computers, on the folder's GitHub repository and branch.

It needs a Cursor plan with cloud agents, the repository connected to Cursor, and a Cursor API key in **Settings > General > Cursor cloud**. The key is encrypted with the system keyring. Cloud sessions use your Cursor credit. They start from what's on GitHub, so uncommitted changes and unpushed commits aren't included. There are no approval cards: the agent works on its own and can push a branch. **Open a pull request** is a per-session switch, off by default.

**My machines** runs a Cloud session on a computer you own. Choose **My machine** under **Run on**. The form shows the commands that clone the repository and start Cursor's worker, and **Settings > General > My machines** has the install and sign-in steps. The agent works with that computer's files, tools and sign-ins and can change anything its user can, so only use computers you trust and give the worker its own clone. It is told to work on a branch of its own and not to push, so its commits stay in that clone.

## Grok Bot (unofficial, off by default)

Grok Bot has no public API. This feature uses the private service Grok Bot's own apps use, so it's unofficial and can stop working at any time. It signs in to your Cursor account, and messages count toward your Grok Bot plan. Cursor's [terms](https://cursor.com/terms-of-service) limit reverse engineering and extracting data from its service, and Cursor can suspend access, so read them and decide for yourself.

Sign in under **Settings > General > Grok Bot** to show its sidebar row. Until you sign in, it makes no Bot connection or background requests. The view shows your existing Bot conversation and current activity, sends messages, stops a running turn, answers supported button questions and opens attachments. Approval and credential cards direct you to Grok Bot. Your coding session stays open behind the view; closing it returns to that session.

The access token stays in the main process, encrypted with the system keyring. Sign in again when it expires; automatic token refresh is not built. Signing out removes the sign-in from this app, but it stays valid on Cursor's side until it expires. There is no bridge between the Bot and coding sessions.

The conversation view has fake-server and renderer tests. An earlier live Windows check with one Bot covered Cursor sign-in, history, sending and stopping a turn, answering a question, opening an attachment and reconnecting. Several live Bots, macOS and Linux remain untested. Deferred features and known limits are listed in [TODO.md](TODO.md).

### Showing the real Grok Bot app (Windows, off by default)

Turn on **Show the Grok Bot app here** under **Settings > General > Grok Bot**, and choosing Grok Bot in the sidebar moves the real app's window into this one, starting the app if it isn't running. Every card and button is the app's own. It needs Grok Bot installed but no sign-in here, and this app contacts no Cursor service for it. Closing this app closes Grok Bot too. If Grok Bot doesn't close within a few seconds, perhaps because it's asking you something, it goes back on your desktop. Closing only the window that holds it, or turning the setting off, also puts it back on your desktop as it was, and so does opening Grok Bot from the Start menu or one of its notifications while its view here is closed. While it's inside, Grok Bot has no taskbar icon.

Moving another app's window is unsupported, so any Grok Bot release could change how this behaves. If this app crashes, Grok Bot closes with it, and anything not yet sent there may be lost. Your Bot and its conversations aren't affected, and choosing Grok Bot in the sidebar starts the app again. Grok Bot's window doesn't get smaller than its own minimum size, so a very narrow main area cuts off its right side. macOS has no public way to do this. Linux could work on X11 but not on Wayland. Neither is built, so the setting is greyed out there.

## Scheduled routines

A routine sends saved instructions to Grok on a schedule: once, daily, on weekdays, weekly or monthly, at times you choose in this computer's time zone, or only when you press **Run now**. Open **Routines** from the clock button in the sidebar. A run that starts in the routine's folder gets a new chat. The sidebar's **Scheduled** section opens the latest chat for each routine with a chat. Its dot shows amber when that chat needs you, red when it failed, and blue when it has an unread result. A closed section shows the most urgent dot. A run that fails before it opens a chat, such as when its folder is missing, is marked Failed in **Routines** history.

A routine has its own model, effort and permission mode. Auto-review is preselected and can allow a command or web request without asking. In Normal, Grok asks before edits and commands unless you already granted permission. Always-approve skips ordinary tool approvals. Browser permissions still apply. Unanswered tool approval cards are denied after 8 minutes. An unanswered question or plan card ends a routine run after 8 minutes. Question and plan cards in ordinary chats wait for your answer.

Routines run only while this app is open. The latest run missed while the app is closed can run when it next opens, if it is within 7 days. A computer that is asleep, or waiting at the sign-in screen, runs nothing until it wakes or someone signs in. Each scheduled time is dispatched at most once. A crash can lose a run, which then shows as Interrupted or Unknown. While a run remains active, later runs of that routine are recorded as Skipped. A phrase such as "report only" gives Grok guidance. Tool permissions still follow the routine's mode.

**Settings > General > Open at sign-in** starts the app when you sign in to this computer, so routines can fire. It opens minimized on Windows and Linux, and as a normal window on macOS. On Windows it can be turned off in Windows' Startup apps, and the setting then says so. On macOS it needs the installed app, and an unsigned app's login item may not stick, so the setting shows what the system reports. On Linux it writes an autostart entry.

## Sandbox

Check **Sandbox** next to the message box to limit what Grok's shell commands can reach. It's off by default, and each Local session chooses for itself. The session's header shows when it's on. If the sandbox can't start, Grok doesn't start: the app never runs Grok unconfined instead.

On Windows, checking it opens a panel where you choose Docker, WSL or Windows Sandbox for that session, with the setup steps for each. Different sessions can use different sandboxes at the same time. On macOS and Linux, **Settings > Sandbox** sets up the sandbox those sessions use. **Test sandbox** sends one short message to Grok and shows what was blocked.

You can change the checkbox during a session, and the change applies with your next message. On Windows, uncheck it and check it again to choose a different sandbox. Grok can't change a running session's sandbox, so the app starts a new Grok session and hands it the newest 12,000 characters of the conversation. Older text, earlier tool results and commands running in the background don't carry over. The app still shows the whole conversation, but messages from before the change can't be rewound or forked, and an export covers only the new Grok session.

On macOS and Linux, Grok confines itself, with Seatbelt on macOS and Landlock with Bubblewrap on Linux. On Linux, install Bubblewrap first, for example with `sudo apt install -y bubblewrap`. **Workspace** lets commands change files only in the session's folder, Grok's own folder and the temp folders. **Strict** limits reads to the session's folder and system paths. [Grok sandbox profiles](https://docs.x.ai/build/features/sandbox#profiles)

The Windows build of Grok ignores the sandbox flag, so on Windows Grok runs somewhere else. The panel shows the setup steps for each choice:

| | Docker | WSL | Windows Sandbox |
| --- | --- | --- | --- |
| Best when | You want the strongest limit | Your Linux tools are already in WSL | You need Windows tools, or have nothing else installed |
| Needs | Docker Desktop, and the app's image or your own with `grok` in it | WSL 2, with Grok and Bubblewrap installed in the distribution | Windows Pro, Enterprise or Education, with the Windows Sandbox feature on |
| What Grok can see | Container files, the session's folder and a separate Grok home | Most of Windows and the WSL distribution in **Workspace**, with selected credential paths blocked. **Strict** narrows reads to the session's folder and system paths | The session's folder and sandbox Grok home are writable. Grok, Git and added tool folders are read-only |
| Tools | What the image holds | What the distribution holds | Grok, Git and the folders you add |

The WSL profiles block existing credential paths in both home folders, including `.git-credentials`, `.netrc`, `.npmrc`, `.config/gh` and `.config/gcloud`. The app skips paths that contain the session's folder.

A sandbox doesn't cover everything:

- The Terminal pane and Git actions still run on your computer. In sandbox sessions, Commit, Commit and push, Create PR, Add worktree, and Restore worktree start with Git hooks off. You can choose to run hooks for that action. The app takes a snapshot before the first sandboxed turn and compares it before each of these Git actions. Changes made during an action can trigger a warning before the next action. Upstream branch settings written by an app push are treated as part of that action.
- Turning Git hooks off reduces risk. Host Git can still run programs set in repository configuration, such as filters or signing commands, and sandboxed Grok may be able to change that configuration. It can also change what the next unsandboxed Grok loads from `.grok` or `.mcp.json` and what Dev server Start runs.
- Commands can reach the network, including your local network, in Docker, Windows Sandbox, **Workspace** and **Strict** on macOS. **Strict** blocks command networking on Linux and WSL.
- Browser control is off in a sandboxed session.
- Sandboxed sessions on Windows do not receive `NODE_EXTRA_CA_CERTS` yet.
- On Windows, a session can use a sandbox or a worktree, not both. On macOS and Linux, Grok can't commit in a worktree session, but the Commit button can.
- With Docker and WSL, Linux tools write Linux files into your Windows folder. For example, `npm install` leaves a `node_modules` that a Windows build can't use.
- Windows runs one Windows Sandbox at a time, so only one session can use it. Another session that asks for it is refused until the first has been idle for 10 minutes.
- On Windows, sessions on the same kind of sandbox share Grok's own folder, with its sign-in and session records, so one session's Grok could read another's.
- With Docker and Windows Sandbox, your skills, MCP servers and sign-in from this computer's Grok aren't used.

## Terminal

On Windows the Terminal pane and the Run buttons use PowerShell (PowerShell 7 when it is installed). On macOS and Linux they use bash. The shell starts without your profile. The native terminal supports interactive programs, colors, Ctrl+C and resizing. Run buttons open a fresh native terminal so they don't type into an existing program or unfinished command. If its native module cannot load, the pane says it is using a pipe terminal, where full-screen programs such as `vim` and `top` are unavailable. Closing the pane stops its terminals.

## Turns from local tools

In Settings > Sessions, turn on **Accept turns from local tools** to let programs on this computer that hold the private token add a message to an open session. This is off by default. Use **Copy Grok session ID** in a sidebar session's menu to get its ID after its first turn. **Export as Markdown…** in that menu saves the transcript.

A message joins that session's queue and runs with its mode and approvals. Auto-review can still ask, and Browser permissions apply in every mode. Every inbound message starts with this line, even when the supplied text starts with a slash command:

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

## Troubleshooting

Open Settings > Check setup, or run `/doctor`, to check Grok, its sign-in, its config files and whether a newer Grok is out, along with Git and the GitHub CLI. **Copy support report** copies a summary you can paste into an issue; it has no sign-in details.

## Update

Codewomplers Grok Desktop checks for newer stable releases. A copy run from source checks the published GitHub release, then looks for its tag in the copy's git origin. An installed copy asks GitHub. When one is out, the account button at the bottom of the sidebar says Update available. Open its menu and choose Update. Eligible Windows source copies close to update and usually reopen when the update or recovery finishes.

For an eligible installed copy, the app checks the downloaded installer or archive against the release's `SHA256SUMS.txt` while preparing the update. It asks before closing and tries to reopen after the update.

- **Windows.** A copy in `%LOCALAPPDATA%\Programs\Codewomplers Grok Desktop` can update itself. A copy unpacked from the zip somewhere else updates by hand.
- **macOS.** A copy in Applications or `~/Applications` can update itself. The installed update ran in CI. An interactive Mac desktop check is still open. If macOS blocks the update, the app explains where to allow it. You can also update by hand.
- **Linux package:** after the app closes, Linux asks for your password and installs the new `.deb`. If you cancel, the old version opens again.
- **Linux tar archive:** the app replaces its folder, and asks for your password only if you set up the sandbox helper with `sudo`. If you added files at the top of that folder, it leaves the folder alone, and you update by hand.

An update can delete files you added inside the app's own folders, such as `resources`, so keep your files somewhere else. Settings and chat history are stored separately in the app's data folder.

If the update can't run, the app tells you what to do instead. Versions up to 0.9.0 can't update themselves, so update those by hand once.

Use the steps below to update by hand or go back to an older release.

On Windows, quit the app and run Setup or the install command again for a standard install. If you keep a zip copy elsewhere, download the desired release's Windows zip, extract it to a fresh folder and open the app there. Running the install command while keeping a zip copy elsewhere creates a separate copy in the standard folder.

To install an older release in the standard Windows folder, set its tag first. Downloads start at v0.6.1. For example, run `$GrokDesktopTag = "v0.6.1"; irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex`.

On macOS, quit the app and run the install command again. To install an older release instead (downloads start at v0.6.1), add its tag: `curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash -s -- v0.6.1`.

On Linux, quit the app and install the new `.deb`, or extract the new tar archive and repeat its sandbox setup above. To go back to an older `.deb`, add `--allow-downgrades` to the `apt install` command.

In a copy run from source on Linux or macOS, and in versions before 0.2.0, update by hand: quit the app, then in its folder run:

```bash
git pull
npm install
npm run desktop
```

If the update can't run (local changes, another branch, or your own commits), the app shows these commands instead.

An interrupted Windows Setup update can leave the app unable to start if Setup stopped after removing the old `resources` folder. Rerun Setup or the Windows install command to repair the standard copy.

If a Windows source update leaves the app closed, run `node scripts/update-helper.cjs --recover` in its folder and follow the printed result. A locked update marker can prevent the app from reopening automatically. For other installed copies, use the platform's manual update steps above. For a macOS or Linux source copy, use the manual source steps above.

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
