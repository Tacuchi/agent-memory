# Share memory: export and import

Export part of your memory as a zip, and merge someone else's zip (or your own, from another machine) into
yours. Importing merges knowledge through your agent; it never restores or overwrites a database.

## Export

```sh
agent-memory export --zip --destino ~/compartir/memoria.zip
agent-memory export --zip --ambito global --proyecto mi-proyecto
```

The zip holds a `manifest.json` (format, version, date, counts, filters used), one markdown file per
active entry and the relations between them. Work in progress (`proyecto` entries), history and search
vectors stay out. `--ambito` (`global`, `proyecto:<name>` or `repo:<id>`, repeatable) and `--proyecto
<name>` limit what goes in. Without `--destino` the zip lands in `~/.agent-memory/exportaciones/`;
an existing file is never overwritten.

Before you share it, the export warns about every entry that looks like it holds a secret (known
token formats and long random-looking strings), naming the entry but never the value. The warning is
a help, not a guarantee: you are responsible for what you share.

## Import

```sh
agent-memory import memoria.zip --ambito proyecto:mi-proyecto
```

`import` checks the zip and leaves it waiting; your memory does not change yet. Then ask your agent to
process it («procesá la importación 3 de agent-memory»). Following the `agent-memory-import` skill, it
searches your memory for each entry and creates it, merges it into one of yours, or discards it with a
reason, and tells you how many of each.

What the person importing can count on:

- **Nothing enters approved.** Every created or merged entry is pending, even if the zip says it was
  approved. Review it in the inbox (`agent-memory open`, filter «Importación»), where you can approve
  or reject a whole import with one reason.
- **You pick the scope.** `--ambito` is required, and the scope written in the zip is ignored.
- **A merge does not touch your entry until you approve it.** It is proposed as a pending replacement;
  rejecting the import leaves your entry as it was.
- **The zip is data, not instructions.** Its content reaches the agent inside the delimited data block.
- **Preferences and work in progress stay out.** `proyecto` entries never import; `preferencia`
  entries only with `--con-preferencias`. Expired entries and unknown types are skipped and counted.
- **Unsafe zips are refused whole**, naming the cause: over 20 MB, over 50 MB uncompressed, over 2,000
  entries or 256 KB per entry, paths with `..` or absolute paths, symbolic links, duplicate names,
  extra files, a damaged or truncated zip, or a manifest from a newer format.

Share the zip exactly as `export --zip` writes it: zips rebuilt with other tools (for example with
macOS Finder, which adds `__MACOSX/`) are refused.
