# agent-memory

Local memory for coding agents. It keeps lessons, decisions, preferences and references in a
SQLite database on your machine, searches them by text and by meaning (local embeddings), and
serves them to agents through a local service, an MCP server and a Claude Code integration.

Everything runs on your machine. The only network step is downloading the embedding model once.
The command-line interface and its messages are in Spanish.

## Requirements

- Node.js **22.16.0 or newer**. With an older Node, `agent-memory` exits with a message that
  names the required and the found version.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) only if you want the Claude Code
  integration.

## Install

Install it globally, so the command and its files stay in a permanent place:

```sh
npm install -g @tacuchi/agent-memory
agent-memory --version
```

**Why not `npx`?** `npx @tacuchi/agent-memory …` runs the package from npm's temporary cache.
Claude Code would then be configured with paths inside that cache, and they break as soon as the
cache is cleaned. For that reason `agent-memory install claude-code` refuses to run from the `npx`
or `bunx` cache and tells you to install globally first. Other one-off commands work with `npx`,
but a global install is the supported way.

## Download the embedding model

```sh
agent-memory model fetch
```

It downloads the pinned model (about 123 MB) to the model cache and then checks that it loads
without network. Until the model is present, search still works by text, and both the search
warning and `agent-memory doctor` tell you to run this command.

## Connect Claude Code

```sh
agent-memory install claude-code
agent-memory doctor
```

`install claude-code` registers the MCP server (`claude mcp add --scope user agent-memory`), adds a
`SessionStart` hook to Claude Code's `settings.json` and copies the `agent-memory` skill. It never
asks questions and can be repeated safely. `doctor` checks Node, the token, the local service,
sqlite-vec, the model and the Claude Code integration, including whether the paths registered in
the hook still exist.

Run `agent-memory --help` for all commands.

## Paths it uses

| What | Default | Override |
|---|---|---|
| Data (database, token, logs, exports) | `~/.agent-memory/` | `AGENT_MEMORY_HOME` |
| Embedding model cache | `~/.cache/agent-memory/models/` | `AGENT_MEMORY_MODEL_CACHE` |
| Claude Code configuration (`settings.json`, `skills/agent-memory/`) | `~/.claude/` | `CLAUDE_CONFIG_DIR` |

The local service listens on `127.0.0.1:47821` (`AGENT_MEMORY_PORT`) and requires the token.

## Update

```sh
npm install -g @tacuchi/agent-memory@latest
agent-memory install claude-code
```

Repeating `install claude-code` after an update (or after changing Node versions) refreshes the
paths registered in Claude Code. `agent-memory doctor` reports when they no longer exist.

## Uninstall

Remove the Claude Code integration first, while the command still exists, then the package:

```sh
agent-memory uninstall claude-code
npm rm -g @tacuchi/agent-memory
```

`uninstall claude-code` removes exactly what `install` added and leaves `settings.json` as it was.
Your data in `~/.agent-memory/` and the model cache are kept; delete those folders if you want
them gone.

## Platforms

Tested on macOS (Apple silicon). Linux and Windows are not tested yet: they will be listed here as
supported once the CI workflow passes on them.

## License

[MIT](LICENSE)
