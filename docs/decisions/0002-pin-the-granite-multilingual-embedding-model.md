---
status: accepted
date: 2026-11-17
---

# Pin the granite multilingual embedding model

Recorded on 2026-11-17 from the comments in `src/search/models.ts`.

## Context and Problem Statement

Search by meaning needs an embedding model that runs on the machine. The measurement uses queries in Spanish. The model has to rank a paraphrase near the top and an exact name first.

## Considered Options

The candidates measured with `src/medir-modelos.ts` over `tests/fixtures/consultas-es.json`:

- `Xenova/multilingual-e5-small`
- `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2`

## Decision Outcome

Chosen option: `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`. In the measurement it was the only candidate that put every paraphrase among the first three results and every exact name first. It was also the lightest, at about 98 MB quantized.

### Consequences

- One model is pinned for every installation.
- The model identifier is stored with each vector. A vector stored under another identifier is regenerated at startup.
