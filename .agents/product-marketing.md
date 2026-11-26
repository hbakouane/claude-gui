# Product marketing context: claude-gui

## Product

- **Name:** claude-gui (npm package and command: `claude-gui`)
- **One-liner:** A local dashboard for your Claude Code history. Find any session, see what it did, and resume it in one click.
- **Category:** Developer tool, open source (MIT), runs locally.
- **Primary conversion:** run `npx claude-gui`. Secondary: star the GitHub repo.
- **Price:** free.

## Audience

- Developers who use Claude Code every day, usually across several projects at once.
- Power users run several sessions in parallel, often in git worktrees, and switch between them all day.
- They live in the terminal and are suspicious of anything that touches their code or sends data anywhere.

## Jobs to be done

1. After a crash or reboot: reopen the sessions that were open, without guessing.
2. Find the session where something was discussed or decided ("where did Claude explain the tax bug?").
3. Understand what a session actually did: files changed, PR opened, worktree used, cost.
4. Keep an eye on a long-running session without switching terminals.

## Pains, in their words

- "My laptop crashed with five Claude sessions open."
- "`claude --resume` shows titles for the folder I'm in. I don't remember which folder."
- "It's somewhere in the transcripts" (hundreds of megabytes of JSON in `~/.claude/projects`).
- "Which session opened that PR?" / "Which worktree was that in?"

## Alternatives people use today

- The `claude --resume` picker: a list of session titles for the current folder.
- Grepping the JSONL transcripts by hand.
- Other open-source session viewers (several exist). Compare fairly; never claim a competitor lacks something without checking.

## Differentiators (verified in the product)

- One-click **Resume in terminal** (Terminal, iTerm, Windows, Linux) and **Open in editor** (VS Code, Cursor, Zed, Windsurf, Sublime Text, PhpStorm, WebStorm, IntelliJ IDEA), including a session's worktrees.
- Per-session: git branch, worktrees (detected from `git worktree add` commands), pull requests, artifacts, skills, MCP servers, files changed with diffs, estimated cost.
- Full conversation view with markdown, expandable tool calls, and a live "Claude is working" indicator.
- Search across every session's conversation, opening at the matching message.
- Local and read-only: listens on 127.0.0.1, rejects other websites, no telemetry, no network calls, never writes to session files.
- Zero dependencies; the whole web app is one HTML file.

## Proof points (all measured or countable; keep them current)

Measured on a real history of 1.4 GB across 256 sessions, on a MacBook, first run of a fresh server:

- Overview: under 0.05 s. Recently active list: about 2 s the first time.
- Opening a project with 92 sessions: 3 ms.
- Searching all 1.4 GB: 3.6 s the first time, 0.08 s for the next search.
- Memory after searching everything and opening the largest session: about 310 MB.
- `grep -rl` over the same 1.4 GB: 16 s, file names only. claude-gui's repeat search: 0.05-0.16 s (about 200x faster).
- Opening the largest session (112 MB, 4,947 messages): 0.44 s cold, 0.14 s cached.
- Server start to first response: 0.09 s. npm download: 46 kB (172 kB unpacked, 11 files).
- 0 dependencies, 82 automated tests, about 2,900 lines of code in 8 files.

## Claims we can't make yet, and what would unlock them

- User counts, "used by X developers": unlock with npm download stats after launch.
- Testimonials or quotes: unlock with permission from real users after launch.
- GitHub star count: unlock once the repo is public.
- "Faster than X" comparisons: unlock with a like-for-like benchmark against that tool.

## Objections and answers

- **"Is it safe to point at my transcripts?"** Read-only, local-only, no network calls, open source with zero dependencies, so it's auditable.
- **"Will it be slow with my huge history?"** Use the measured numbers above.
- **"I'm on a subscription; is the cost real?"** It's what the tokens would cost at API list prices, a measure of how heavy a session was.
- **"Does it work on my OS / with my editor?"** macOS, Linux, Windows; the editors listed above.
- **"Is this from Anthropic?"** No. Independent project, not affiliated.

## Voice

- Developer to developer. Plain, specific, a little dry. Show the command, the number, the screenshot.
- Words they use: session, transcript, resume, worktree, PR, terminal.
- Avoid: hype words (powerful, seamless, supercharge), invented stats, exclamation points, em dashes in headlines.

## Learnings

- None yet. Record what each launch post and page change does to installs and stars here.
