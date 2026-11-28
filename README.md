<div align="center">

<img src=".github/assets/logo.svg" width="88" height="88" alt="claude-gui logo">

# claude-gui

**Every Claude Code session, one click away.**

A local dashboard for your [Claude Code](https://claude.com/claude-code) history. Search every conversation, see what each session changed and cost, and resume any of them in one click, even after your laptop crashes with five sessions open.

[![npm downloads](https://img.shields.io/npm/dm/claude-gui.svg)](https://www.npmjs.com/package/claude-gui)
![Runs locally](https://img.shields.io/badge/runs-100%25%20locally-1c1917.svg)

```sh
npx claude-gui
```

<img src=".github/assets/hero-dark.png" alt="claude-gui showing a session's conversation, resume command, pull request and artifact" width="900">

</div>

## Why

Claude Code saves every session on your disk as a raw transcript. That's great, until you need to find one:

- **Your computer crashed mid-work.** Five sessions were open in three projects. Which one was fixing the checkout bug, and what was its ID?
- **`claude --resume` only sees one folder.** It lists titles for the folder you're in. It can't search, and it shows nothing else about a session.
- **"Where did Claude explain that?"** The answer is in last Tuesday's transcript, somewhere in hundreds of megabytes of JSON.
- **No idea what a session did.** Which files did it change? Which PR did it open? Did it make a worktree? What did it cost?

claude-gui reads the transcripts already on your disk and turns them into a dashboard you can browse, search and resume from. It never changes them.

## Features

- **Every project at a glance.** The overview lists every folder you've used Claude Code in, with the sessions active in the last 24 hours right below.
- **Where you stopped.** Every session row shows your last prompt and Claude's last reply. Hover to see them in full.
- **One click back to work.** **Resume** opens a new window of your terminal (Terminal, iTerm2, Ghostty, WezTerm, kitty, Alacritty and more) running `claude --resume` in the right folder. **Open in editor** opens the session's folder, or any of its worktrees, in your editor.
- **The whole conversation.** Replies rendered as markdown, with tables and code. Tool calls you can expand to see their input and output. Slash commands, background tasks and context summaries, in place.
- **Search everything.** Find any word you or Claude wrote, across every project. Narrow it down by project, date, or who wrote it. Results open the session at the matching message.
- **What each session did.** Git branch, worktrees, pull requests, artifacts, skills, MCP servers, files changed with diffs, and an estimated cost.
- **Live sessions.** Pages refresh on their own. While Claude is still working, you see it, and what it's doing right now. Sessions waiting for your answer say **Needs you**.
- **Notifications.** A desktop notification when a session finishes, asks you a question or has a plan for you to approve. Click it to open that session. On by default: your browser asks for permission once.
- **Sessions that outlive Claude's cleanup.** Claude Code deletes sessions after 30 days by default. claude-gui keeps a compressed copy, so old sessions stay searchable, and **Restore and resume** brings one back into Claude Code.
- **Made to fit how you work.** Pin the boxes you check most. Choose your Claude folder, editor, port and theme in Settings. Keyboard shortcuts for everything.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/hover-card.png" alt="Session list with a hover card showing the last prompt and reply"><br><sub><b>Where you stopped</b>, on every session</sub></td>
    <td width="50%"><img src=".github/assets/files-and-pins.png" alt="Files changed with a diff, and pinned usage and files boxes"><br><sub><b>Files changed</b> with diffs, and the estimated cost</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/tool-calls.png" alt="Conversation with an expanded tool call and a markdown table"><br><sub><b>The full conversation</b>, tool calls included</sub></td>
    <td width="50%"><img src=".github/assets/search.png" alt="Search results with highlighted matches"><br><sub><b>Search</b> across every session</sub></td>
  </tr>
</table>

## Quick start

You need **Node.js 18.3 or newer** and at least one Claude Code session on your machine.

```sh
npx claude-gui
```

Your browser opens at `http://127.0.0.1:4321`. Pick a project, open a session, then click **Resume in terminal** or **Open in editor**.

To have the command always available, for example right after a crash, install it globally:

```sh
npm install -g claude-gui
claude-gui
```

To update, run the install command again. To remove it, run `npm uninstall -g claude-gui`.

## Usage

### Options

| Flag | Default | What it does |
|---|---|---|
| `--port <n>` | `4321` | The port to listen on |
| `--no-open` | off | Don't open the browser on start |
| `--claude-dir <path>` | `~/.claude` | The folder Claude Code keeps its data in |
| `--terminal <app>` | asks once | Where Resume opens a session, overriding Settings. macOS: `terminal`, `iterm`, `ghostty`, `wezterm`, `kitty`, `alacritty`. Linux: `default`, `gnome-terminal`, `konsole`, `ghostty`, `wezterm`, `kitty`, `alacritty`. Windows: `cmd`, `wt` |
| `-h`, `--help` | | Show usage |

### Settings

Click the gear icon in the top bar to change these without touching the command line:

- **Claude folder:** the folder Claude Code keeps its data in. The dashboard switches to it right away.
- **Editor:** used by the "Open in editor" buttons. VS Code, Cursor, Zed, Windsurf, Sublime Text, PhpStorm, WebStorm or IntelliJ IDEA.
- **Port:** used the next time the dashboard starts.
- **Open the browser on start:** on by default.
- **Terminal:** where Resume opens a session. The first time you click Resume, claude-gui asks which one to use if more than one is installed.
- **Notifications:** on by default. Desktop notifications when a session finishes or asks you something, while the dashboard is open in a browser tab. The dashboard asks for your browser's permission once.
- **Keep a copy of every session:** on by default. See [Archive](#archive).
- **Keep copies for:** how many days after a session's last activity to keep its copy. Empty keeps them forever.

Settings are saved in `~/.config/claude-gui/config.json`, or under `$XDG_CONFIG_HOME` if you set it. A command-line flag always wins over a saved setting.

### Using a different Claude folder

The dashboard reads the `projects` folder inside your Claude folder. If more than one of these is set, the first one wins:

1. the `--claude-dir` flag
2. the folder saved in Settings
3. the `CLAUDE_CONFIG_DIR` environment variable, which Claude Code uses too
4. `~/.claude`

Projects in temporary folders, such as `/tmp` and `/var/folders`, are hidden.

### Archive

Claude Code deletes a session's transcript when it hasn't been used for 30 days (its `cleanupPeriodDays` setting). To keep your history, claude-gui copies each session once it has been quiet for 10 minutes, then every 30 minutes while the dashboard runs:

- Copies are gzip-compressed, in `~/.local/share/claude-gui/archive` (or under `$XDG_DATA_HOME`), and only your user can read them.
- A session Claude Code deleted still shows up, marked **Archived**. You can read and search it like any other.
- **Restore and resume** puts the transcript back in Claude Code's folder, then resumes it. It never overwrites a transcript that's already there.
- Set **Keep copies for** in Settings to delete copies after a number of days, or turn archiving off. Since this deletes data, Settings shows it as a danger zone: it tells you how many copies Save would delete, and how many of them are the last copy left, then asks you to confirm.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd> | Search |
| <kbd>J</kbd> / <kbd>K</kbd> or <kbd>↓</kbd> / <kbd>↑</kbd> | Move between projects or sessions |
| <kbd>↵</kbd> | Open the selected project or session |
| <kbd>C</kbd> | Copy the selected session's ID |
| <kbd>Esc</kbd> | Clear the search, or go back to the session list |

### Cost estimates

Costs are what a session's tokens would cost at Anthropic's API list prices, including cache reads and writes. If you use Claude Code on a subscription plan, you're billed differently, so treat the number as a measure of how heavy a session was. Subagent work isn't included yet, and models without a known price show token counts only.

### Troubleshooting

- **"Port 4321 is in use."** Another copy is already running. Open `http://127.0.0.1:4321`, or start this one with `--port 4400`.
- **The page is blank after an update.** The server still has the old version loaded. Stop it with <kbd>Ctrl</kbd> <kbd>C</kbd> and start it again.
- **A project is missing.** Check which folder the dashboard reads in Settings. Sessions in temporary folders are hidden on purpose.
- **Resume or Open in editor does nothing on Linux.** Resume uses `x-terminal-emulator` unless you pick another terminal in Settings, and editors are opened with their command-line launcher (`code`, `cursor`, …), which must be on your `PATH`.

## Privacy

Your transcripts hold everything you and Claude wrote: code, secrets in logs, customer data. claude-gui treats them that way:

- It never changes or deletes the files Claude Code saved. The one time it writes in Claude Code's folder is when you click **Restore and resume** on an archived session, to put back the transcript Claude Code deleted.
- It keeps compressed copies of your sessions in `~/.local/share/claude-gui/archive`, readable only by you. You can turn this off, or limit how long copies are kept, in Settings.
- It listens on `127.0.0.1` only, so other computers can't reach it.
- It rejects requests from other websites, even ones open in your browser.
- It only opens a terminal or an editor when the dashboard page itself asks, and only for the session's own folders.
- It has no accounts, no telemetry and makes no network calls. It sends nothing anywhere. Notifications are shown by your own browser.
- It has zero dependencies, so there's no third-party code to audit.

## Contributing

Contributions are welcome. There's nothing to install, since claude-gui has no dependencies:

```sh
git clone https://github.com/hbakouane/claude-gui.git
cd claude-gui
npm test                        # run the test suite
node bin/cli.js --port 4400     # run your local copy
```

The page in `public/index.html` is read on every request, so a reload shows your changes. Anything in `src/` needs a restart.

To work on screenshots or demos without showing your own sessions, point the dashboard at a folder of fake transcripts:

```sh
CLAUDE_CONFIG_DIR=/path/to/fake-claude node bin/cli.js --port 4400
```

### Project structure

```text
bin/cli.js          Command line: flags, saved settings, starts the server, opens the browser
src/server.js       Local HTTP server and JSON API
src/sessions.js     Reads session transcripts: titles, PRs, worktrees, files, search
src/config.js       Saved settings and where the Claude folder comes from
src/pricing.js      Model prices and token cost estimates
src/resume.js       Opens a terminal window that resumes a session
src/archive.js      Keeps compressed copies of sessions, and restores them for resume
src/notify.js       Spots sessions that finished or are waiting for you
src/editor.js       Opens a folder in your editor
public/index.html   The whole web app: one file, no build step
test/               Tests, using Node's built-in test runner
```

### Principles

- **Zero dependencies.** Node's standard library only, and no build step for the page.
- **Local, and hands off Claude's files.** Never change a session file, never call the network. The only write in Claude Code's folder is restoring a deleted transcript, and only when the user asks.
- **Every change is tested.** Add or update a test in `test/` for each behavior you change, including edge cases and failures.
- **Forgiving parsing.** Transcripts can be half-written after a crash, or come from older Claude Code versions. Skip what you can't read; never fail the whole page.

### Pull requests

1. Create a branch from `main`.
2. Keep commits small, one change each, with [conventional commit](https://www.conventionalcommits.org) titles such as `feat:`, `fix:` or `docs:`.
3. Make sure `npm test` passes.
4. Open a pull request that explains what changed and why. Add a screenshot for anything visual.

## License

[MIT](LICENSE) © [Haytam Bakouane](https://haytambakouane.com/)

claude-gui is an independent project. It isn't affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic, PBC.
