#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { desinstalarClaudeCode, instalarClaudeCode } from "./claude-code/install.js";
import { hookSessionStart, leerEntradaHook } from "./claude-code/hook.js";
import { ClienteServicio, ErrorServicio } from "./client.js";
import { cargarConfig } from "./config.js";
import { contextoCliente } from "./context.js";
import { diagnosticar, formatearHallazgos } from "./doctor.js";
import { servirMcp } from "./mcp/server.js";
import { arrancarServicio } from "./service/app.js";
import { arrancarSeparado, borrarPid, detener, escribirPid, leerPid, salud } from "./service/daemon.js";
import { version } from "./version.js";

// Punto de entrada del bin `agent-memory`, sobre `node:util` `parseArgs` (plan 002, T1.1).
const AYUDA = `uso: agent-memory <comando> [opciones]

servicio:
  start                     arranca el servicio en segundo plano y espera a que responda
  stop                      apaga el servicio
  status                    estado: puerto, pid y versión (sale con 3 si está detenido)
  serve                     corre el servicio en primer plano
  doctor                    revisa Node, token, servicio, sqlite-vec, modelo y Claude Code

memoria:
  search <consulta>         busca en el contexto del directorio actual
         [--limite N] [--todos]

agentes:
  mcp                       servidor MCP por stdio con las herramientas memory_*
  install claude-code       conecta Claude Code: MCP, hook de inicio y skill
          [--excluir <patrón>]...   repos excluidos (remoto, organización o ruta)
  uninstall claude-code     quita exactamente lo que agregó install
  hook session-start        hook SessionStart de Claude Code (lo llama Claude Code)

  --version                 muestra la versión`;

const ESPERA_START_MS = 20_000;

export async function main(argv: string[]): Promise<number> {
  const [comando, ...resto] = argv;
  switch (comando) {
    case "--version":
    case "-v":
      return salida(version());
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return salida(AYUDA);
    case "serve":
      return sinArgs(resto, serve);
    case "mcp":
      return sinArgs(resto, mcp);
    case "start":
      return sinArgs(resto, start);
    case "stop":
      return sinArgs(resto, stop);
    case "status":
      return sinArgs(resto, status);
    case "doctor":
      return sinArgs(resto, doctor);
    case "search":
      return search(resto);
    case "install":
      return install(resto);
    case "uninstall":
      return uninstall(resto);
    case "hook":
      return hook(resto);
    default:
      return uso(`comando desconocido: ${comando}`);
  }
}

function salida(texto: string): number {
  process.stdout.write(`${texto}\n`);
  return 0;
}

function uso(mensaje: string): number {
  process.stderr.write(`${mensaje}\n\n${AYUDA}\n`);
  return 2;
}

function sinArgs(args: string[], comando: () => Promise<number>): Promise<number> | number {
  return args.length ? uso(`argumentos de más: ${args.join(" ")}`) : comando();
}

async function serve(): Promise<number> {
  const config = cargarConfig();
  const app = await arrancarServicio(config);
  escribirPid(config, { pid: process.pid, port: app.port });
  process.stderr.write(`agent-memory ${version()} escuchando en ${app.url}\n`);
  await new Promise<void>((resolve) => {
    const parar = () => resolve();
    process.once("SIGINT", parar);
    process.once("SIGTERM", parar);
  });
  await app.cerrar();
  borrarPid(config, process.pid);
  return 0;
}

async function mcp(): Promise<number> {
  const config = cargarConfig();
  await servirMcp(new ClienteServicio(config), contextoCliente(process.cwd(), { proyectos: config.proyectos }));
  return 0;
}

async function start(): Promise<number> {
  const config = cargarConfig();
  const r = await arrancarSeparado(config, ESPERA_START_MS);
  if (r.yaCorria) return salida(`agent-memory ya corre en http://127.0.0.1:${config.port} (pid ${r.pid ?? "?"})`);
  if (!r.salud) {
    process.stderr.write(`agent-memory no respondió en ${ESPERA_START_MS / 1000} s; mirá ${config.logPath} o corré «agent-memory doctor»\n`);
    return 1;
  }
  return salida(`agent-memory ${r.salud.version} arrancó en http://127.0.0.1:${config.port} (pid ${r.pid})`);
}

async function stop(): Promise<number> {
  const config = cargarConfig();
  const r = await detener(config);
  if (r.detenido) return salida(`agent-memory detenido (pid ${r.pid})`);
  if (await salud(config, 500)) {
    process.stderr.write(`hay un servicio respondiendo en 127.0.0.1:${config.port} sin archivo de pid en ${config.pidPath}; detenelo desde su terminal\n`);
    return 1;
  }
  return salida("agent-memory no estaba corriendo");
}

async function status(): Promise<number> {
  const config = cargarConfig();
  const s = await salud(config, 1500);
  if (!s) {
    process.stdout.write(`agent-memory detenido (puerto ${config.port}); arrancalo con «agent-memory start»\n`);
    return 3;
  }
  return salida(`agent-memory ${s.version} corriendo · puerto ${config.port} · pid ${leerPid(config)?.pid ?? "?"} · datos ${config.home}`);
}

async function doctor(): Promise<number> {
  const config = cargarConfig();
  const hallazgos = await diagnosticar(config, process.env);
  process.stdout.write(`${formatearHallazgos(hallazgos)}\n`);
  return hallazgos.some((h) => h.nivel === "falla") ? 1 : 0;
}

interface Resultado {
  id: number;
  titulo: string;
  tipo: string;
  ambito: string;
  validacion: string | null;
  actualizada_en: string;
}

async function search(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { limite: { type: "string" }, todos: { type: "boolean" } },
  });
  const consulta = positionals.join(" ").trim();
  if (!consulta) return uso("search necesita una consulta");
  const limite = values.limite === undefined ? undefined : Number(values.limite);
  if (limite !== undefined && (!Number.isInteger(limite) || limite < 1 || limite > 100)) return uso("--limite va de 1 a 100");
  const config = cargarConfig();
  const r = await new ClienteServicio(config).llamar<{ modo: string; aviso: string | null; resultados: Resultado[] }>("buscar", {
    consulta,
    contexto: contextoCliente(process.cwd(), { proyectos: config.proyectos }),
    ...(limite ? { limite } : {}),
    ...(values.todos ? { filtros: { todos_los_ambitos: true } } : {}),
  });
  if (r.aviso) process.stderr.write(`aviso: ${r.aviso}\n`);
  if (r.resultados.length === 0) return salida("sin resultados (un vacío no prueba que no exista: probá otra consulta)");
  return salida(
    r.resultados
      .map((e) => `#${e.id} · ${e.titulo} · ${e.tipo} · ${e.ambito} · ${e.validacion ?? "trabajo"} · ${e.actualizada_en.slice(0, 10)}`)
      .join("\n"),
  );
}

async function install(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { excluir: { type: "string", multiple: true } } });
  if (positionals.join(" ") !== "claude-code") return uso("uso: agent-memory install claude-code [--excluir <patrón>]...");
  const interactivo = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const informe = await instalarClaudeCode({
    env: process.env,
    excluir: values.excluir ?? [],
    ...(interactivo ? { preguntar } : {}),
  });
  return salida(informe.map((l) => `· ${l}`).join("\n"));
}

async function preguntar(pregunta: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(pregunta);
  } finally {
    rl.close();
  }
}

async function uninstall(args: string[]): Promise<number> {
  if (args.join(" ") !== "claude-code") return uso("uso: agent-memory uninstall claude-code");
  return salida(desinstalarClaudeCode(process.env).map((l) => `· ${l}`).join("\n"));
}

async function hook(args: string[]): Promise<number> {
  if (args.join(" ") !== "session-start") return uso("uso: agent-memory hook session-start");
  const texto = await hookSessionStart(await leerEntradaHook());
  process.stdout.write(`${texto}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
    // El hook nunca deja la sesión esperando por un socket abierto.
    if (process.argv[2] === "hook") process.stdout.write("", () => process.exit(codigo));
  },
  (error: unknown) => {
    const codigo = error instanceof ErrorServicio ? `error ${error.codigo}: ` : "agent-memory: ";
    process.stderr.write(`${codigo}${(error as Error).message}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  },
);
