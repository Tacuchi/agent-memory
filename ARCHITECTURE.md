# Architecture of agent-memory

Reviewed on 2026-11-17 against version 0.6.1 (commit `59dd192`).

This document gives the overview: which parts exist, how they talk to each other and which rules never break. It does not describe every module or the screens of the web UI. All values are defaults; nothing here was measured on a particular machine.

## 1. Purpose and quality goals

agent-memory is the local memory of coding agents. It keeps lessons, decisions, conventions, references and preferences in a SQLite database on the machine. It hands them to agents at session start and when they search. The person decides what goes in and what stays valid.

What it is not:

- It does not sync memories. The link to another machine is read-only.
- It validates nothing by itself. What an agent creates starts as pending.
- It does not use a language model. The bundled model only turns text into vectors to compare meanings.

| Goal | Scenario |
|---|---|
| A session is never blocked | If the service does not answer, the hook waits 2 s by default and the session starts anyway, with a warning. |
| Search does not depend on the model | Without the model, or if its vectors come out broken on that CPU, search continues by text and says so. |
| The person governs the memory | An entry becomes validated only when the person approves it or confirms its exact draft. |
| Nobody in between reads the content | Two installations encrypt end to end. The relay only forwards ciphertext. |
| What is retrieved is data | Entry text reaches the agent inside a block marked as data, not as instructions. |

## 2. Context and scope

![Context diagram of agent-memory](docs/architecture/context.svg)

[Interactive version](https://tacuchi.github.io/agent-memory/architecture/context.html).

| External interface | Direction | When it happens |
|---|---|---|
| Hugging Face | Outbound | Only when you run `agent-memory model fetch`. |
| Relay | Outbound | Only with remote access turned on and a relay configured. |
| Another installation, direct | Inbound | Only with remote access turned on and the direct connection active. |
| Coding agent | Local | In every session, through the hook and the MCP server. |

## 3. Building blocks

![Container diagram of agent-memory](docs/architecture/containers.svg)

[Interactive version](https://tacuchi.github.io/agent-memory/architecture/containers.html).

| Block | Responsibility | Code |
|---|---|---|
| CLI | Commands for the service, the memory, agents and the remote link. | `src/cli.ts` |
| SessionStart hook | Resolves the session context and delivers the index. | `src/claude-code/` |
| MCP server | Translates the `memory_*` tools into calls to the local API. | `src/mcp/` |
| Local service | Serves the API and the web UI, and owns search and remote access. | `src/service/` |
| Store | Schema, migrations and the rules of entries. | `src/db/`, `src/store/`, `src/domain/` |
| Search | Text with FTS5 and vectors with `sqlite-vec`, fused by reciprocal rank. | `src/search/` |
| Remote access | Pairing, encryption, direct connection and the relay client. | `src/remoto/` |
| Web UI | The screens the person uses. | `web/src/` |
| Relay | Meeting point between two installations. Deployed separately. | `src/remoto/rele.ts`, `deploy/relay/` |

Rules that never break:

- The service listens on `127.0.0.1` only. Never on every interface.
- Every request to the API carries the local token. The web UI uses its own session.
- The hook, the MCP server and the web UI never open the database. They go through the service. The only exception is `agent-memory purge`, which opens it directly.
- The model never reaches the network in normal use. Only `model fetch` allows the download.
- The remote link never writes and never syncs.
- The relay does not read, store or log the content it forwards.

## 4. Runtime view

Session start of an agent:

1. Claude Code runs the `SessionStart` hook.
2. The hook resolves the repository and the project from the working directory.
3. If the service does not answer, the hook starts it in the background and waits for it to be healthy.
4. It asks the service for the index, capped at 1500 tokens by default.
5. It delivers the index to the agent and one visible line to the person.
6. If anything fails or takes too long, the session starts anyway with a warning.

Search from an agent:

1. The agent calls `memory_search` on the MCP server.
2. The MCP server sends the operation to the local API with the token.
3. Search queries the text with FTS5 and, when the model is available, the nearest neighbours in `sqlite-vec`.
4. It fuses both lists by reciprocal rank.
5. With remote links, it then adds the results of each origin, marked as external data.
6. It returns excerpts. `memory_get` returns the whole entry.

## 5. Deployment view

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

Relay, optional: it is the same package with the `relay` command, or its Docker image. It listens on port `8787` and goes behind an HTTPS proxy, for example at `relay.example.com`. The key comes from `AGENT_MEMORY_RELAY_KEY` or a `0600` file, never from an argument.

## 6. Cross-cutting concepts

### Data and privacy

| Question | Answer |
|---|---|
| What leaves the machine | The request that downloads the model. With remote access turned on, encrypted messages to the other installation and a metadata report to the relay: PC name, links, scope, expiry and usage counts. |
| What does not leave | The content of the memory in clear text. The code contains no telemetry or analytics. |
| When | The download, only with `model fetch`. Everything remote, only with remote access turned on. It is off by default. |
| Where it is stored and for how long | Everything stays in `~/.agent-memory/`. Whoever reads another memory stores nothing of what it read. The relay keeps its state in memory only. A link code is valid for 10 minutes and a read credential for 30 days. |
| How to see it | `agent-memory remote status` and the **Remote access** screen, which logs every read and every rejection. |
| How to turn it off | Turn remote access off or revoke a device in the web UI. `remote direct off` stops listening and `remote unlink <origin>` stops reading. |

### Local security

- The token lives in a file with `0600` permissions.
- The service rejects requests whose `Host` is not loopback.
- The web UI opens with a one-time link, valid for 60 s, that leaves a session cookie.
- The remote channel uses X25519, HKDF-SHA256 and ChaCha20-Poly1305.
- After 10 failed attempts in 10 minutes from one address, that address gets `429` for 15 minutes.

### Persistence

- A single SQLite database with text (FTS5) and vectors (`sqlite-vec`).
- Before changing the schema, the service makes a full copy of the database. It deletes the copy after 7 days.

## 7. Decisions

Decision records live in [`docs/decisions/`](docs/decisions/). These three were recorded from the comments the code already carried:

| Decision | Record |
|---|---|
| `node:sqlite` instead of `better-sqlite3` | [0001](docs/decisions/0001-use-node-sqlite-as-the-sqlite-driver.md) |
| The `granite-embedding-97m-multilingual-r2` model | [0002](docs/decisions/0002-pin-the-granite-multilingual-embedding-model.md) |
| The `uint8` variant of the model, not `q8` | [0003](docs/decisions/0003-use-the-uint8-variant-of-the-model.md) |

Not recorded yet:

- A single background service.
- A relay that does not read the content.

## Appendix: evidence

Line numbers refer to commit `59dd192`. Every row cites code or configuration; the text above does not link to the code on purpose.

| Section | Evidence |
|---|---|
| 1. Goals | `src/claude-code/hook.ts:22-44`, `src/config.ts:11`, `src/search/search.ts:52-56`, `src/remoto/canal.ts:7-22`, `src/remoto/rele.ts:1-9`, `src/domain/cerco.ts:10-16`, `src/mcp/server.ts:47-52` |
| 2. Context | `src/model-fetch.ts:14-17`, `src/service/app.ts:44-46`, `src/remoto/transporte.ts:2-3` |
| 3. Blocks | `src/cli.ts:102-126`, `src/mcp/server.ts:69-244`, `src/service/server.ts:33-70`, `src/db/schema.ts:15-223`, `web/src/App.tsx:1-12` |
| 3. Rules | `src/service/server.ts:11`, `src/client.ts:16-51`, `src/cli.ts:476-487`, `src/search/embedder.ts:67-79`, `src/mcp/server.ts:36-38`, `src/remoto/rele.ts:6-7` |
| 4. Runtime | `src/claude-code/hook.ts:22-44`, `src/config.ts:9`, `src/search/search.ts:52-56`, `src/remoto/remoto.ts:1076-1079` |
| 5. Deployment | `src/cli.ts:155-167`, `src/config.ts:7`, `src/config.ts:49-51`, `src/config.ts:56`, `src/search/models.ts:73-75`, `src/claude-code/install.ts:23-25`, `src/remoto/directo.ts:20`, `deploy/relay/Dockerfile:9-20` |
| 6. Privacy | `src/remoto/datos.ts:10-12`, `src/remoto/datos.ts:160-162`, `src/remoto/datos.ts:386-390`, `src/remoto/datos.ts:491-496`, `src/remoto/rele-estado.ts:1-6`, `src/remoto/canal.ts:7-22`. A search for telemetry and external URLs in `src/` found none |
| 7. Decisions | `src/db/driver.ts:4-8`, `src/search/models.ts:25-30`, `src/search/models.ts:44-48` |
