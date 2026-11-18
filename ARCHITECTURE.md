# Architecture of agent-memory

Reviewed on 2026-11-17 against version 0.6.1 (commit `59dd192`).

This document gives the overview: which parts exist, how they talk to each other and which rules never break. It does not describe every module or the screens of the web UI. All values are defaults; nothing here was measured on a particular machine.

In short:

- A local memory for coding agents: lessons, decisions, conventions, references and preferences.
- Agents use it through a session-start hook and an MCP server; the person uses a web UI.
- It talks to nothing outside by default; the model download and the remote link are opt-in.
- The data lives in one SQLite database under `~/.agent-memory/`.
- The person decides what is validated; retrieved text always reaches the agent as data.

## 1. Purpose and quality goals

agent-memory is the local memory of coding agents. It keeps lessons, decisions, conventions, references and preferences in a SQLite database on the machine. It hands them to agents at session start and when they search. The person decides what goes in and what stays valid.

What it is not:

- It does not sync memories. The link to another machine is read-only.
- It validates nothing by itself. What an agent creates starts as pending.
- It does not use a language model. The bundled model only turns text into vectors to compare meanings.

| Goal | Scenario |
|---|---|
| A session is never blocked | If the service does not answer, the hook waits 2 s by default and the session starts anyway, with a warning. |
| The person governs the memory | An entry becomes validated only when the person approves it or confirms its exact draft. |
| Nobody in between reads the content | Two installations encrypt end to end; the relay forwards ciphertext and does not read, store or log it. |

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
| Agent side | The SessionStart hook delivers the index; the MCP server turns `memory_*` tools into API calls. | `src/claude-code/`, `src/mcp/` |
| Local service | Serves the API and the web UI, and owns search and remote access. | `src/service/` |
| Store and search | Schema, migrations and entry rules; text (FTS5) and vectors (`sqlite-vec`) fused by reciprocal rank. | `src/db/`, `src/store/`, `src/domain/`, `src/search/` |
| Remote access | Pairing, encryption, direct connection and the relay client. | `src/remoto/` |
| Web UI | The screens the person uses. | `web/src/` |
| Relay | Meeting point between two installations. Deployed separately. | `src/remoto/rele.ts`, `deploy/relay/` |

Rules that never break:

- The service listens on `127.0.0.1` only. Never on every interface.
- Every request to the API carries the local token. The web UI uses its own session.
- The hook, the MCP server and the web UI never open the database. They go through the service. The only exception is `agent-memory purge`, which opens it directly.
- The model never reaches the network in normal use. Only `model fetch` allows the download.
- The remote link never writes and never syncs.

## 4. Runtime view

Session start of an agent:

1. Claude Code runs the `SessionStart` hook.
2. The hook resolves the repository and the project from the working directory.
3. If the service does not answer, the hook starts it in the background and waits for it to be healthy.
4. It asks the service for the index, capped at 1500 tokens by default.
5. It delivers the index to the agent inside a block marked as data, not as instructions, and one visible line to the person.
6. If anything fails or takes too long, the session starts anyway with a warning.

A search from an agent fuses text and vector results, continues by text alone when the model is missing or its vectors come out broken on that CPU, and marks results from remote links as external data. [The search guide](docs/search.md) walks through it.

## 5. Deployment view

Default installation on one machine. It requires Node.js 22.16 or newer. Tested on macOS with Apple silicon.

| What | Default | When it applies | How to change it |
|---|---|---|---|
| Background service | One `agent-memory serve` process | Started by the hook, `start` or `open`. It does not stop by itself. | `agent-memory stop` |
| Local API | `127.0.0.1:47821`, token required | While the service runs | `AGENT_MEMORY_PORT` |
| MCP server | One process per agent session | While the session lasts | `agent-memory uninstall claude-code` |
| Remote channels, direct and relay | Off | With remote access turned on | Web UI, **Remote access** |
| Data (database, token, logs, exports) | `~/.agent-memory/` | Always | `AGENT_MEMORY_HOME` |
| Embedding model cache | `~/.cache/agent-memory/models/` | After `agent-memory model fetch` | `AGENT_MEMORY_MODEL_CACHE` |

[The configuration guide](docs/configuration.md) has the full table, with the remote ports, the Claude Code files, the model's memory and the optional relay.

## 6. Cross-cutting concepts

### Data and privacy

| Question | Answer |
|---|---|
| What leaves the machine | The request that downloads the model. With remote access turned on, encrypted messages to the other installation and a metadata report to the relay: PC name, links, scope, expiry and usage counts. |
| What does not leave | The content of the memory in clear text. The code contains no telemetry or analytics. |
| When | The download, only with `model fetch`. Everything remote, only with remote access turned on. It is off by default. |
| Where it is stored and for how long | Everything stays in `~/.agent-memory/`. Whoever reads another memory stores nothing of what it read. The relay keeps its state in memory only. Link codes and read credentials expire; see [the fixed limits](docs/configuration.md#fixed-limits). |
| How to see it | `agent-memory remote status` and the **Remote access** screen, which logs every read and every rejection. |
| How to turn it off | Turn remote access off or revoke a device in the web UI. `remote direct off` stops listening and `remote unlink <origin>` stops reading. |

### Local security

- The token lives in a file with `0600` permissions.
- The service rejects requests whose `Host` is not loopback.
- The web UI opens with a short-lived one-time link that leaves a session cookie.
- The remote channel uses X25519, HKDF-SHA256 and ChaCha20-Poly1305.
- Repeated failed attempts from one address get that address `429` for a while.

[The fixed limits](docs/configuration.md#fixed-limits) give the exact times and counts.

### Persistence

- A single SQLite database with text (FTS5) and vectors (`sqlite-vec`).
- Before changing the schema, the service makes a full copy of the database and deletes it after a fixed period.

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
| 1. Goals | `src/claude-code/hook.ts:22-44`, `src/config.ts:11`, `src/mcp/server.ts:47-52`, `src/remoto/canal.ts:7-22`, `src/remoto/rele.ts:1-9` |
| 2. Context | `src/model-fetch.ts:14-17`, `src/service/app.ts:44-46`, `src/remoto/transporte.ts:2-3` |
| 3. Blocks | `src/cli.ts:102-126`, `src/mcp/server.ts:69-244`, `src/service/server.ts:33-70`, `src/db/schema.ts:15-223`, `web/src/App.tsx:1-12` |
| 3. Rules | `src/service/server.ts:11`, `src/client.ts:16-51`, `src/cli.ts:476-487`, `src/search/embedder.ts:67-79`, `src/mcp/server.ts:36-38` |
| 4. Runtime | `src/claude-code/hook.ts:22-44`, `src/config.ts:9`, `src/domain/cerco.ts:10-16`, `src/search/search.ts:52-56`, `src/remoto/remoto.ts:1076-1079` |
| 5. Deployment | `src/cli.ts:155-167`, `src/config.ts:7`, `src/config.ts:49-51`, `src/config.ts:56`, `src/search/models.ts:73-75` |
| 6. Privacy | `src/remoto/datos.ts:160-162`, `src/remoto/datos.ts:386-390`, `src/remoto/datos.ts:491-496`, `src/remoto/rele-estado.ts:1-6`, `src/remoto/canal.ts:7-22`. A search for telemetry and external URLs in `src/` found none |
| 7. Decisions | `src/db/driver.ts:4-8`, `src/search/models.ts:25-30`, `src/search/models.ts:44-48` |
