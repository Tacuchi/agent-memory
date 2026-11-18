# agent-memory

> Local memory for coding agents: SQLite with hybrid search, an MCP server, a CLI and a web UI.

Local memory for coding agents. It keeps lessons, decisions, preferences and references in a
SQLite database on your machine, searches them by text and by meaning (local embeddings), and
serves them to agents through a local service, an MCP server and a Claude Code integration.

Everything runs on your machine. The only network step is downloading the embedding model once.
The command-line interface and its messages are in Spanish.

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

## Install

### Requirements

- Node.js **22.16.0 or newer**. With an older Node, `agent-memory` exits with a message that
  names the required and the found version.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) only if you want the Claude Code
  integration.

### Install the package

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

### Download the embedding model

```sh
agent-memory model fetch
```

It downloads the pinned model (about 123 MB) to the model cache and then checks that it loads
without network. Until the model is present, search still works by text, and both the search
warning and `agent-memory doctor` tell you to run this command. On startup the service embeds
three fixed phrases as a self-check; if the vectors come out broken on your CPU, search falls back
to text only, and both the search warning and `agent-memory doctor` say why and what to do.

### Connect Claude Code

```sh
agent-memory install claude-code
agent-memory doctor
```

`install claude-code` registers the MCP server (`claude mcp add --scope user agent-memory`), adds a
`SessionStart` hook to Claude Code's `settings.json` and copies two skills: `agent-memory` (how to
use the memory) and `agent-memory-import` (how to merge an imported zip). It never asks questions
and can be repeated safely. `doctor` checks Node, the token, the local service,
sqlite-vec, the model and the Claude Code integration, including whether the paths registered in
the hook still exist and whether the installed skills match this version.

### Update

```sh
npm install -g @tacuchi/agent-memory@latest
agent-memory install claude-code
```

Repeating `install claude-code` after an update (or after changing Node versions) refreshes the
paths registered in Claude Code and copies the skills of the new version. `agent-memory doctor`
reports when those paths no longer exist or an installed skill is from another version.

When a new version changes the database layout, the first start makes a full copy of the database
next to it (`~/.agent-memory/copia-previa-esquema-N.db`, readable only by your account) before
changing anything. If the update fails, the database stays as it was and the error names the copy.
The copy is deleted after 7 days, and `agent-memory purge` deletes it at once, since it still holds
the purged entry.

`indice.tope_tokens` in `~/.agent-memory/config.json` (the index budget, 1500 by default) must be
at least 400.

### Uninstall

Remove the Claude Code integration first, while the command still exists, then the package:

```sh
agent-memory uninstall claude-code
npm rm -g @tacuchi/agent-memory
```

`uninstall claude-code` removes exactly what `install` added and leaves `settings.json` as it was.
Your data in `~/.agent-memory/` and the model cache are kept; delete those folders if you want
them gone.

### Platforms

Tested on macOS (Apple silicon). Linux and Windows are not tested yet: they will be listed here as
supported once the CI workflow passes on them.

## Usage

### What the agent gets

- **At session start**, a compact index in four sections: work in progress, then the current
  project and repo, then global entries, then entries still pending your review. Each section says
  how many entries it left out; the agent finds those with `memory_search`.
- **After the conversation is compacted**, the same index plus an instruction to propose at most
  three things worth saving, as exact drafts in a single structured question (`AskUserQuestion` in
  Claude Code), or to say nothing. Nothing is saved until you confirm a draft.
- **On your screen**, one line each time the index loads (start, `/clear`, resume, compact), such
  as `agent-memory · índice cargado: 55 entradas (46 fuera, con memory_search)`, or the warning
  when the service did not answer.
- **From `memory_search`**, excerpts (`extracto`, `largo`, `recortado`) instead of full contents;
  `memory_get` returns the whole entry.
- Entry text always arrives inside a delimited data block, marked as data and not instructions.
- A linked machine that did not answer is reported as `omitido` for a while (30 s, doubling up to
  5 min) instead of making every search wait for it; reading an entry from it retries right away.

### CLI

```sh
agent-memory open            # open the local web UI with a one-time link
agent-memory search <query>  # search in the context of the current directory
agent-memory status          # port, pid and version of the service
agent-memory doctor          # check Node, the token, the service, sqlite-vec, the model and Claude Code
agent-memory stop            # stop the background service
```

Run `agent-memory --help` for all commands.

### Read another machine's memory

You can let one installation read another one's memory, for example a home PC reading what you shared from your work
laptop. The link is **read-only**: it never writes and never syncs, and nothing read is stored on the reading side.

Guide: [docs/remote-link.md](docs/remote-link.md).

### Share memory: export and import

Export part of your memory as a zip, and merge someone else's zip (or your own, from another machine) into
yours. Importing merges knowledge through your agent; it never restores or overwrites a database.

Guide: [docs/export-import.md](docs/export-import.md).

## How it works

A background service on `127.0.0.1` owns the database, search and remote access. The CLI, the MCP server, the Claude Code hook and the web UI all go through it.

![Context diagram of agent-memory](docs/architecture/context.svg)

[ARCHITECTURE.md](ARCHITECTURE.md) describes the building blocks, the rules that never break and the decisions behind them. Default paths and ports, and how to change them, are in its [deployment view](ARCHITECTURE.md#5-deployment-view).

## Contributing

Bug reports and questions: [GitHub issues](https://github.com/Tacuchi/agent-memory/issues).

## License

[MIT](LICENSE)
