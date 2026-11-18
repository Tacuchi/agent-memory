---
status: accepted
date: 2026-11-17
---

# Use the `uint8` variant of the model

Recorded on 2026-11-17 from the comments in `src/search/models.ts`. The change itself was made on 2026-11-10.

## Context and Problem Statement

The pinned embedding model is published in several quantized variants. With the `q8` variant, the vectors came out broken on some x64 CPUs of the CI runners. The suspected cause, CPUs without VNNI, was not confirmed.

## Considered Options

- `q8`
- `uint8`

## Decision Outcome

Chosen option: `uint8`. It weighs the same as `q8`, about 98 MB, and it passed the measurement on Linux x64, Windows x64 and macOS arm64.

### Consequences

- The identifier stored with each vector includes the variant, because each variant produces different numbers.
- A database built with `q8` regenerates its vectors at startup.
- The service still checks the model at startup with three fixed phrases. If the vectors come out broken on that CPU, search falls back to text only.
