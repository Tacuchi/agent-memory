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
warning and `agent-memory doctor` tell you to run this command. On startup the service embeds
three fixed phrases as a self-check; if the vectors come out broken on your CPU, search falls back
to text only, and both the search warning and `agent-memory doctor` say why and what to do.

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

## Read another machine's memory (remote link)

You can let one installation read another one's memory, for example a home PC reading what you shared from your work
laptop. The link is **read-only**: it never writes and never syncs, and nothing read is stored on the reading side.

How it works:

- Both machines connect **outbound** to a small relay that you host (`agent-memory relay`). Neither machine opens a
  port.
- The two installations encrypt end to end (X25519, HKDF-SHA256, ChaCha20-Poly1305). The relay only forwards
  ciphertext. It cannot read queries or entries, and it cannot impersonate either side.
- Remote access is **off by default**. While it is off, the owner does not connect to the relay at all.

### 1. Deploy the relay

Run the relay on a server you control, behind an HTTPS reverse proxy that forwards WebSocket upgrades:

```sh
openssl rand -base64 32 > relay.key && chmod 600 relay.key
agent-memory relay --clave-archivo relay.key --puerto 8787   # listens on 127.0.0.1:8787
```

- The key comes from `AGENT_MEMORY_RELAY_KEY` or a `0600` file. It is never passed as an argument.
- Without the key the relay answers `401` on every path. `curl -i https://<relay>/` should return `401`.
- The relay keeps nothing and logs no content. It pairs at most two connections per mailbox and caps message size and
  idle time.
- **Limit failed attempts before exposing it.** The relay compares the key in constant time but does not count
  attempts. Put a per-IP rate limit in front of it, in the reverse proxy. Repeated `curl -i https://<relay>/` without
  the key should end in `429`, not in endless `401`s.
- A health check or uptime monitor can treat the `401` as "up": it proves the proxy and the relay answer without
  knowing the key.

[`deploy/relay/`](deploy/relay/) has an example: a `Dockerfile` that runs the published package (key only from
`AGENT_MEMORY_RELAY_KEY`), and a Traefik file-provider route for Coolify behind Cloudflare that accepts only
Cloudflare's ranges and rate-limits by the real client IP.

### 2. Configure the relay on both machines

In the web UI (`agent-memory open` → **Remote access**, *Acceso remoto*), enter the relay URL and key in the **This
PC** bar. The key is written once and never shown again; the bar tells you whether the relay answers or rejects the
key. From a terminal instead:

```sh
agent-memory remote relay wss://<relay> < relay.key
agent-memory remote status
```

Give each PC a name in the same bar (it defaults to the hostname). The other PC and the relay dashboard show that
name.

If your network requires a proxy, set `HTTPS_PROXY`. The connection goes out through an HTTP `CONNECT` tunnel, with
TLS inside it.

### 3. Pair

1. On the machine that **owns** the memory, open **Remote access**, turn sharing on and choose **Connect another PC**
   (*Conectar otra PC*) → **Share your memory**. Tick what the other PC will read (global, projects, repos, unvalidated
   entries) and generate a code. The code is valid for 10 minutes and allows 5 attempts.
2. On the **reading** machine, open **Remote access** → **Connect another PC** → **Read its memory** and paste the
   code, or run `agent-memory remote link <code>`.

**Remote access** shows this PC (the only local one) and one card per connected PC. Each card shows both directions,
like location sharing: what you share with that PC and what it shares with you. Each card has its own activity: what
that PC read from your memory and what you read from its memory. The reading side keeps its half locally: the tool
and the entry ids, never the search text or the content.

No names to type: each PC sends the name it has configured. The reader gets an identifier derived from the owner's
name (`Work laptop` → `work-laptop`, `-2` if taken). That identifier is how agents refer to that origin; rename it
from the web UI or pick it with `remote link <code> --nombre <id>`. If either PC renames itself, the other shows the
new name after their next read.

The reader gets a read-only credential valid for 30 days. The owner can renew it from the web UI. To stop reading a
memory, use **Remove** in the web UI or `agent-memory remote unlink <id>`.

### What is shared, and how to revoke

- A new link sees what the owner ticked when generating the code, or **nothing** if nothing was ticked. In the web UI
  the owner can change it per device at any time:
  - which scopes it can read: global, specific projects, specific repos;
  - whether unvalidated entries are included.
- Rejected, expired and superseded entries are never shared.
- On the reading side, `memory_search` adds linked results after local ones. `memory_get`, `memory_list` and
  `memory_revisions` take an `origen` argument.
- Every remote result carries `origen` and `dato_externo: true`. Agents are told to treat it as data, never as
  instructions.
- If a link is down, the search still returns local results and reports that link's state.
- Every read and every rejection is logged on the owner, under **Remote access**.
- **Revoke** or **turn access off** in the web UI. The next request from that device is rejected.

### Relay dashboard (optional)

The relay can serve a dashboard at `https://<relay>/dashboard` that lists every PC using it, by name:

- who reads each PC's memory (scope, expiry, last use) and which memories it reads;
- active link codes (expiry only, never the code), current connections and 7-day usage;
- IPs that fail the relay key, and blocked PCs or IPs.

From there you can close a PC's connections, close all, block a PC or an IP for 1 h, 24 h or until unblocked,
revoke a link and remove a link. Actions that **widen** access (renew, change scope, new code) are only requests:
they wait in **Remote access → *Pedidos del panel*** on the owner's web UI until you accept them there. A code accepted
there is shown only on that PC.

Each PC 0.3.0 reports metadata to the relay (name, links, scope, expiry, usage counts) over its own channel. Memory
content stays end-to-end encrypted; the relay keeps the dashboard state in memory only. The PC name defaults to the
host name and can be changed in **Remote access** (*Nombre de esta PC*). PCs on 0.2.0 keep working and show as "no report".

The dashboard is protected by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/),
and the relay verifies the Access JWT itself:

1. Create a self-hosted Access application for `<relay host>/dashboard*` with a policy that allows only you.
2. Start the relay with `AGENT_MEMORY_RELAY_ACCESS_TEAM=<team name>` (from `<team>.cloudflareaccess.com`) and
   `AGENT_MEMORY_RELAY_ACCESS_AUD=<application audience tag>`. Without both, `/dashboard` answers `404`.
3. Requests without a valid Access JWT get `401`; actions also require the page's own origin.

The dashboard refreshes every 10 seconds; keep any per-IP rate limit in front of the relay above that.

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
