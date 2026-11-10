#!/usr/bin/env node
import { mensajeNodeViejo, nodeSuficiente } from "./node-minimo.js";

// Entrada del bin `agent-memory`: comprueba la versión de Node antes de cargar la CLI, porque los
// imports estáticos de cli.js se evalúan antes de su primera línea.
if (nodeSuficiente(process.versions.node)) {
  await import("./cli.js");
} else {
  process.stderr.write(`${mensajeNodeViejo(process.versions.node)}\n`);
  process.exitCode = 1;
}
