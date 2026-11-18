---
status: accepted
date: 2026-11-17
---

# Use `node:sqlite` as the SQLite driver

Recorded on 2026-11-17 from the comment in `src/db/driver.ts`. The decision itself dates from the first version of the store.

## Context and Problem Statement

The store keeps entries, their full-text index and their vectors in one SQLite database. The driver has to load `sqlite-vec`, provide FTS5 and roll back a row and its vector together.

## Considered Options

- `node:sqlite`, the driver built into Node.js
- `better-sqlite3`

## Decision Outcome

Chosen option: `node:sqlite`. A comparative test of both drivers (`tests/spike/driver.test.ts`) showed that it loads `sqlite-vec` 0.1.9, brings FTS5 and rolls back the row and its vector together. It wins over `better-sqlite3` because it adds no native dependency of its own.

### Consequences

- The package ships no native SQLite build of its own.
