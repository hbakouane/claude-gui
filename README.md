# claude-sessions-dashboard

A local web page that lists every project where you've run [Claude Code](https://claude.com/claude-code), and every session in each project. Use it to find the session you want to resume, for example after your computer crashed with several sessions open.

For each session it shows:

- Title
- Folder
- Git branch
- PR links
- Whether it ran in a git worktree
- Last activity
- Idle time
- MCP servers used
- Session ID, with a copy button

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
