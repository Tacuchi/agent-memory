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
the hook still exist and whether the installed skill matches this version.

What the agent gets:

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

Run `agent-memory --help` for all commands.

## Read another machine's memory (remote link)

You can let one installation read another one's memory, for example a home PC reading what you shared from your work
laptop. The link is **read-only**: it never writes and never syncs, and nothing read is stored on the reading side.

How it works:

- There are two ways to connect, with the same pairing codes and the same encryption: **direct**, where the owner
  listens on its Tailscale or local-network address, and **relay**, where both machines connect outbound to a small
  relay you host.
- The two installations encrypt end to end (X25519, HKDF-SHA256, ChaCha20-Poly1305). The network, or the relay, only
  carries ciphertext. Nobody in between can read queries or entries or impersonate either side.
- Remote access is **off by default**. While it is off, the owner neither listens nor connects to a relay.

### Choose how to connect

| | Direct | Relay |
|---|---|---|
| When | Both machines are on the same [Tailscale](https://tailscale.com/) tailnet, or on the same local network | They cannot reach each other, for example a work laptop outside your tailnet |
| What you set up | Nothing else: pick an address on the owner | A relay with HTTPS: one step with the published image ([guide](deploy/relay/README.md)) |
| What listens | The owner, on the one address you pick, only for the encrypted channel | Nothing on either machine: both go out to the relay |

Start with direct. Each link keeps the way it was paired: a direct link never falls back to a relay.

### Direct connection

1. Put both machines on the same tailnet, or on the same local network.
2. On the machine that **owns** the memory, open **Remote access** (*Acceso remoto*) → **This PC** → **Direct
   connection** (*Conexión directa*). Pick the address (Tailscale's comes first), keep port `47822` or change it,
   and turn sharing on. From a terminal instead:

   ```sh
   agent-memory remote direct 100.101.102.103      # or 100.101.102.103:47900; "remote direct off" turns it off
   agent-memory remote status
   ```

3. [Pair](#pair) the machines. With the direct connection listening, the code comes as a **direct invitation**,
   `<code>@<address>:<port>`: paste it on the reading machine as you would paste a code.

What to know:

- Only the encrypted remote channel listens on that address. The local API stays on `127.0.0.1`, and the service never
  listens on every interface.
- The local network is treated as untrusted: the code and the keys pinned at pairing are the defense. After 10 failed
  attempts in 10 minutes from one address, the owner answers it `429` for 15 minutes.
- If the address is missing (Tailscale is down, the laptop changed networks), the owner listens nowhere else and tries
  again until it is back. **Remote access** and `remote status` say why it is not listening.
- Your system firewall may ask whether `node` can accept incoming connections. Allow it on the network you use.
- If the owner's address changes, which is common on a local network without Tailscale, pair again.

### Relay

#### Deploy the relay

**In one step:** run the published image on Fly.io, Render or Coolify. The platform gives it HTTPS and keeps the key
as a secret: [`deploy/relay/README.md`](deploy/relay/README.md).

**On your own server:** run the relay behind an HTTPS reverse proxy that forwards WebSocket upgrades:

```sh
openssl rand -base64 32 > relay.key && chmod 600 relay.key
agent-memory relay --clave-archivo relay.key --puerto 8787   # listens on 127.0.0.1:8787
```

- The key comes from `AGENT_MEMORY_RELAY_KEY` or a `0600` file. It is never passed as an argument.
- Without the key the relay answers `401` on every path. `curl -i https://<relay>/` should return `401`.
- The relay keeps nothing and logs no content. It pairs at most two connections per mailbox and caps message size and
  idle time.
- The relay limits failed key attempts by itself. After 10 wrong keys in 10 minutes from one IP, that IP gets `429`
  for 15 minutes, even with the right key. Requests without a key are not counted and keep getting `401`.
- Behind a proxy, tell the relay which header carries the client IP: `--cabecera-ip <header>` or
  `AGENT_MEMORY_RELAY_IP_HEADER`. The default is `cf-connecting-ip` (Cloudflare); `ninguna` uses the connection's
  address. Never trust a header the client can set: check it as the [guide](deploy/relay/README.md#check-it) shows.
- A health check or uptime monitor can treat the `401` as "up": it proves the proxy and the relay answer without
  knowing the key.

[`deploy/relay/`](deploy/relay/) has the `Dockerfile` of the published image (key only from
`AGENT_MEMORY_RELAY_KEY`), and a Traefik file-provider route for Coolify behind Cloudflare that accepts only
Cloudflare's ranges and rate-limits by the real client IP.

#### Configure the relay on both machines

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

### Pair

1. On the machine that **owns** the memory, open **Remote access**, turn sharing on and choose **Connect another PC**
   (*Conectar otra PC*) → **Share your memory**. Tick what the other PC will read (global, projects, repos, unvalidated
   entries) and generate a code. The code is valid for 10 minutes and allows 5 attempts.
2. On the **reading** machine, open **Remote access** → **Connect another PC** → **Read its memory** and paste the
   code or the direct invitation, or run `agent-memory remote link <code-or-invitation>`. A direct invitation needs no
   relay on either machine; a plain code goes through the relay.

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

The local service listens on `127.0.0.1:47821` (`AGENT_MEMORY_PORT`) and requires the token. With the direct
connection on, the encrypted remote channel also listens on the address you picked (port `47822` by default).

## Update

```sh
npm install -g @tacuchi/agent-memory@latest
agent-memory install claude-code
```

Repeating `install claude-code` after an update (or after changing Node versions) refreshes the
paths registered in Claude Code and copies the skill of the new version. `agent-memory doctor`
reports when those paths no longer exist or the installed skill is from another version.

When a new version changes the database layout, the first start makes a full copy of the database
next to it (`~/.agent-memory/copia-previa-esquema-N.db`, readable only by your account) before
changing anything. If the update fails, the database stays as it was and the error names the copy.
The copy is deleted after 7 days, and `agent-memory purge` deletes it at once, since it still holds
the purged entry.

`indice.tope_tokens` in `~/.agent-memory/config.json` (the index budget, 1500 by default) must be
at least 400.

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
