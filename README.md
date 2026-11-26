# claude-sessions-dashboard

A local web page that lists every project where you've run [Claude Code](https://claude.com/claude-code), and every session in each project. Use it to find the session you want to resume, for example after your computer crashed with several sessions open.

It answers the questions you have after a long day of sessions, or a crash:

- **What was I working on?** The overview starts with every session from the last 24 hours, across all projects, each with a **Resume** button that opens a terminal already running `claude --resume`.
- **Where did I stop?** Every session row shows your last prompt and Claude's last reply.
- **Which session talked about X?** Search on the overview looks through what you and Claude said in every session, and opens the session at the matching message.
- **What did it do?** Each session shows its git branch, worktrees, PRs, artifacts, skills, MCP servers, files changed (with diffs) and an API-equivalent cost estimate.

Click a session to open its page. It shows the full conversation: replies rendered as markdown, slash commands, and tool calls you can expand. Open pages refresh on their own, so you can watch a running session, including what Claude is doing right now.

## Usage

```sh
npx claude-sessions-dashboard
```

Or install it globally:

```sh
npm i -g claude-sessions-dashboard
claude-sessions-dashboard
```

It opens `http://127.0.0.1:4321`. Click **Resume** on a session, or copy its ID and run:

```sh
claude --resume <session-id>
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--no-open` | off | Don't open the browser |
| `--terminal <app>` | `terminal` | Where Resume opens on macOS: `terminal` or `iterm` |

It reads `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` if that variable is set. Projects in temporary folders such as `/tmp` and `/var/folders` are hidden.

## Cost estimates

Costs are what the tokens would cost at Anthropic's API list prices, including cache reads and writes. If you use Claude Code on a subscription plan you are billed differently, so treat the number as a measure of how heavy a session was. Subagent work isn't included, and models without a known price show tokens only.

## Privacy

Your session files contain everything you and Claude wrote. This tool:

- only reads them locally
- listens on `127.0.0.1` only
- rejects requests from other sites
- only opens a terminal when the dashboard page itself asks, never for another website
- sends nothing anywhere

## Requirements

Node.js 18.3 or newer. No dependencies.

## License

MIT
