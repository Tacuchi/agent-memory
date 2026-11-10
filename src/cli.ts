#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Punto de entrada del bin `agent-memory`. Los subcomandos llegan por fase: `mcp` y `serve` en
// el plan 001 (F3); el resto de la CLI en el plan 002.
const AYUDA = `uso: agent-memory <comando>

comandos:
  --version   muestra la versión`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<number> {
  const [comando] = argv;
  if (comando === "--version" || comando === "-v") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  process.stderr.write(`${AYUDA}\n`);
  return comando === undefined || comando === "--help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    process.stderr.write(`agent-memory: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
