# Configuration and fixed limits

Defaults of one installation, the optional relay and the limits written in the code. All values are defaults; nothing here was measured on a particular machine. [The architecture overview](../ARCHITECTURE.md#5-deployment-view) keeps the short version.

## Defaults

Default installation on one machine. It requires Node.js 22.16 or newer. Tested on macOS with Apple silicon.

| What | Default | When it applies | How to change it |
|---|---|---|---|
| Background service | One `agent-memory serve` process | Started by the hook, `start` or `open`. It does not stop by itself. | `agent-memory stop` |
| Local API | `127.0.0.1:47821`, token required | While the service runs | `AGENT_MEMORY_PORT` |
| MCP server | One process per agent session | While the session lasts | `agent-memory uninstall claude-code` |
| Direct remote channel | Off. Port `47822` | With remote access turned on and the direct connection active | `agent-memory remote direct <address>` or `remote direct off` |
| Connection to the relay | Off | With remote access turned on and a relay configured | Web UI, **Remote access**, or `agent-memory remote relay <url>` |
| Data (database, token, logs, exports) | `~/.agent-memory/` | Always | `AGENT_MEMORY_HOME` |
| Embedding model cache | `~/.cache/agent-memory/models/`, a download of about 123 MB | After `agent-memory model fetch` | `AGENT_MEMORY_MODEL_CACHE` |
| Claude Code configuration (`settings.json`, `skills/agent-memory/`, `skills/agent-memory-import/`) | `~/.claude/` | After `agent-memory install claude-code` | `CLAUDE_CONFIG_DIR` |

Memory: the service loads the model at startup and keeps it in memory. There is no published reference figure.

## Relay

The relay is optional. It is the same package with the `relay` command, or its Docker image. It listens on port `8787` and goes behind an HTTPS proxy, for example at `relay.example.com`. The key comes from `AGENT_MEMORY_RELAY_KEY` or a `0600` file, never from an argument. [The relay guide](../deploy/relay/README.md) has the steps.

## Fixed limits

These values are in the code and do not change with configuration.

| What | Value | When it applies |
|---|---|---|
| One-time link of the web UI | Valid for 60 s; it leaves a session cookie | Each time the web UI opens |
| Failed attempts from one address | After 10 in 10 minutes, that address gets `429` for 15 minutes | On every rejected request |
| Link code of the remote link | Valid for 10 minutes | While pairing two installations |
| Read credential of the remote link | Valid for 30 days | After pairing |
| Copy of the database before a schema change | Deleted after 7 days | On each migration |
