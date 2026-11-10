#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { ClienteServicio } from "./client.js";
import { cargarConfig } from "./config.js";
import { resolverContexto } from "./context.js";
import { servirMcp } from "./mcp/server.js";
import { arrancarServicio } from "./service/app.js";
import { version } from "./version.js";

// Punto de entrada del bin `agent-memory`. El plan 001 trae `serve` (servicio en primer plano) y
// `mcp` (servidor MCP por stdio); el resto de la CLI llega con el plan 002.
const AYUDA = `uso: agent-memory <comando>

comandos:
  serve       arranca el servicio local en 127.0.0.1 (primer plano)
  mcp         servidor MCP por stdio con las herramientas memory_*
  --version   muestra la versión`;

export async function main(argv: string[]): Promise<number> {
  const [comando] = argv;
  switch (comando) {
    case "--version":
    case "-v":
      process.stdout.write(`${version()}\n`);
      return 0;
    case "serve":
      return serve();
    case "mcp": {
      const config = cargarConfig();
      await servirMcp(new ClienteServicio(config), resolverContexto(process.cwd(), { proyectos: config.proyectos }));
      return 0;
    }
    case undefined:
    case "--help":
      process.stdout.write(`${AYUDA}\n`);
      return 0;
    default:
      process.stderr.write(`comando desconocido: ${comando}\n${AYUDA}\n`);
      return 2;
  }
}

async function serve(): Promise<number> {
  const app = await arrancarServicio(cargarConfig());
  process.stderr.write(`agent-memory ${version()} escuchando en ${app.url}\n`);
  await new Promise<void>((resolve) => {
    const parar = () => resolve();
    process.once("SIGINT", parar);
    process.once("SIGTERM", parar);
  });
  await app.cerrar();
  return 0;
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
