# claude-sessions-dashboard

A local web page that lists every project where you've run [Claude Code](https://claude.com/claude-code), and every session in each project. Use it to find the session you want to resume, for example after your computer crashed with several sessions open.

For each session it shows:

- Title
- Folder
- Git branch
- PR links
- Git worktrees it created or entered, and whether they're still on disk
- Artifacts it created, updated or opened
- Whether Claude is still working on it
- Last activity
- Idle time
- MCP servers used
- Session ID, with a copy button

Click a session to open its page. It shows the full conversation between you and Claude: replies rendered as markdown, tool calls you can expand to see their input and output, and slash commands. Next to it is a ready-to-copy `claude --resume` command. Open pages refresh every 30 seconds, so you can watch a running session.

## Usage

```sh
npx claude-sessions-dashboard
```

Or install it globally:

```sh
npm i -g claude-sessions-dashboard
claude-sessions-dashboard
```

It opens `http://127.0.0.1:4321`. Pick a project, find the session, copy its ID, then run:

```sh
claude --resume <session-id>
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `4321` | Port to listen on |
| `--no-open` | off | Don't open the browser |

It reads `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` if that variable is set. Projects in temporary folders such as `/tmp` and `/var/folders` are hidden.

## Privacy

Your session files contain everything you and Claude wrote. This tool:

- only reads them locally
- listens on `127.0.0.1` only
- rejects requests from other sites
- sends nothing anywhere

## Requirements

Node.js 18.3 or newer. No dependencies.

## License

MIT
