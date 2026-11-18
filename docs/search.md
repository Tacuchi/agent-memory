# How a search works

The path of a search from an agent, from the tool call to the results. [The architecture overview](../ARCHITECTURE.md#4-runtime-view) names it in one sentence.

1. The agent calls `memory_search` on the MCP server.
2. The MCP server sends the operation to the local API with the token.
3. Search queries the text with FTS5 and, when the model is available, the nearest neighbours in `sqlite-vec`.
4. It fuses both lists by reciprocal rank.
5. With remote links, it then adds the results of each origin, marked as external data.
6. It returns excerpts. `memory_get` returns the whole entry.

Search does not depend on the model. Without the model, or if its vectors come out broken on that CPU, search continues by text and says so.
