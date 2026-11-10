#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { desinstalarClaudeCode, instalarClaudeCode } from "./claude-code/install.js";
import { hookSessionStart, leerEntradaHook } from "./claude-code/hook.js";
import { ClienteServicio, ErrorServicio } from "./client.js";
import { cargarConfig } from "./config.js";
import { resolverContexto } from "./context.js";
import { diagnosticar, formatearHallazgos } from "./doctor.js";
import { invocacion } from "./ejecutable.js";
import { traerModelo } from "./model-fetch.js";
import { servirMcp } from "./mcp/server.js";
import { arrancarServicio } from "./service/app.js";
import { arrancarSeparado, borrarPid, detener, escribirPid, leerPid, salud } from "./service/daemon.js";
import { purgar } from "./purge/purge.js";
import { crearRele, leerClaveRele } from "./remoto/rele.js";
import { MemoryStore } from "./store/store.js";
import { version } from "./version.js";

// La CLI `agent-memory`, sobre `node:util` `parseArgs`. El bin entra por bin.js, que antes comprueba Node.
const AYUDA = `uso: agent-memory <comando> [opciones]

servicio:
  start                     arranca el servicio en segundo plano y espera a que responda
  stop                      apaga el servicio
  status                    estado: puerto, pid y versión (sale con 3 si está detenido)
  serve                     corre el servicio en primer plano
  doctor                    revisa Node, token, servicio, sqlite-vec, modelo y Claude Code
  model fetch               descarga el modelo de embeddings a su caché (el único paso con red)

memoria:
  open                      abre la web local con un enlace de un solo uso
       [--imprimir]         solo muestra el enlace, sin abrir el navegador
  search <consulta>         busca en el contexto del directorio actual
         [--limite N] [--todos]
  export                    exporta a markdown, un archivo por entrada (las activas)
         [--completa]       todas las entradas, con su historia
         [--destino <dir>]  carpeta nueva o vacía (por defecto, ~/.agent-memory/exportaciones/)
  purge <id>                borra para siempre una entrada y toda su historia; pide escribir el id

agentes:
  mcp                       servidor MCP por stdio con las herramientas memory_*
  install claude-code       conecta Claude Code: MCP, hook de inicio y skill
  uninstall claude-code     quita exactamente lo que agregó install
  hook session-start        hook SessionStart de Claude Code (lo llama Claude Code)

enlace remoto (solo lectura entre dos instalaciones, por un relé):
  remote code               abre la web en «Acceso remoto» para generar un código (lo hace la persona)
              [--imprimir]  solo muestra el enlace de un solo uso
  remote link <código> --nombre <origen> [--dispositivo <nombre>]
                            canjea un código de la otra instalación y la enlaza para leer
  remote relay <url>        configura el relé (wss://…); la clave se lee por stdin
  remote status             estado del acceso remoto, dispositivos y enlaces, sin secretos
  relay                     corre el relé del enlace remoto (va detrás de HTTPS)
        [--puerto N] [--host <dir>] [--clave-archivo <ruta>]
                            la clave sale de AGENT_MEMORY_RELAY_KEY o de un archivo 0600, nunca de un argumento

  --version                 muestra la versión

proyectos:
  Un proyecto agrupa carpetas (notas, repos de código) bajo un nombre. Se declara de dos formas;
  gana la carpeta declarada más cercana al directorio de trabajo:
    - un archivo .agent-memory.json en la carpeta: {"proyecto": "<nombre>"}
    - en ~/.agent-memory/config.json: "proyectos": {"<nombre>": ["<carpeta>", "~/<carpeta>"]}
  Sin declaración no hay proyecto: una entrada nueva nace en el repo actual (o en global fuera de
  un repo). Una preferencia nace en global salvo que se pida otro ámbito.`;

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
    case "model":
      return model(resto);
    case "open":
      return abrir(resto);
    case "search":
      return search(resto);
    case "export":
      return exportarCli(resto);
    case "purge":
      return purge(resto);
    case "install":
      return install(resto);
    case "uninstall":
      return uninstall(resto);
    case "hook":
      return hook(resto);
    case "relay":
      return relay(resto);
    case "remote":
      return remote(resto);
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
  await servirMcp(new ClienteServicio(config), resolverContexto(process.cwd(), { proyectos: config.proyectos }));
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

/** El relé en primer plano, hasta SIGINT/SIGTERM. No registra nada del tráfico. */
async function relay(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { puerto: { type: "string" }, host: { type: "string" }, "clave-archivo": { type: "string" } },
  });
  const desconocidas = Object.keys(values).filter((k) => !["puerto", "host", "clave-archivo"].includes(k));
  if (desconocidas.includes("clave")) return uso("la clave del relé no se pasa por argumento: usá AGENT_MEMORY_RELAY_KEY o --clave-archivo");
  if (desconocidas.length) return uso(`opción desconocida: --${desconocidas[0]}`);
  if (positionals.length) return uso(`argumentos de más: ${positionals.join(" ")}`);
  const puerto = values.puerto === undefined ? 8787 : Number(values.puerto);
  if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) return uso(`puerto inválido: ${String(values.puerto)}`);
  let clave: string;
  try {
    clave = leerClaveRele(process.env, values["clave-archivo"] as string | undefined);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const host = (values.host as string | undefined) ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    process.stderr.write(`aviso: el relé sirve HTTP sin TLS en ${host}; publicalo detrás de HTTPS, nunca directo a internet\n`);
  }
  const rele = await crearRele({ clave, puerto, host });
  process.stderr.write(`agent-memory relay ${version()} escuchando en ${rele.url.replace(/^ws/, "http")}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await rele.cerrar();
  return 0;
}

async function model(args: string[]): Promise<number> {
  if (args.join(" ") !== "fetch") return uso("uso: agent-memory model fetch");
  await traerModelo(process.env, (linea) => process.stdout.write(`${linea}\n`));
  return 0;
}

/**
 * Abre la web: arranca el servicio si hace falta, pide con el token un enlace de un solo uso
 * y lo abre en el navegador. El enlace vence en 60 s y no sirve una segunda vez.
 */
async function abrir(args: string[], ir?: "remoto"): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { imprimir: { type: "boolean" } } });
  if (positionals.length) return uso(`argumentos de más: ${positionals.join(" ")}`);
  const config = cargarConfig();
  const r = await arrancarSeparado(config, ESPERA_START_MS);
  if (!r.salud) {
    process.stderr.write(`agent-memory no respondió en ${ESPERA_START_MS / 1000} s; mirá ${config.logPath} o corré «agent-memory doctor»\n`);
    return 1;
  }
  const { url: base } = await new ClienteServicio(config).llamar<{ url: string }>("enlace-web");
  const url = ir ? `${base}?ir=${ir}` : base;
  if (values.imprimir) return salida(url);
  const [programa, ...previos] = navegador() as [string, ...string[]];
  // Si no está en el PATH se intenta igual: el error del lanzamiento lleva al enlace para abrirlo a mano.
  const lanzar = invocacion(programa, [...previos, url], process.env) ?? { archivo: programa, args: [...previos, url], windowsVerbatimArguments: false };
  const hijo = spawn(lanzar.archivo, lanzar.args, { detached: true, stdio: "ignore", windowsVerbatimArguments: lanzar.windowsVerbatimArguments });
  const lanzado = await new Promise<boolean>((resolve) => {
    hijo.once("error", () => resolve(false));
    hijo.once("spawn", () => resolve(true));
  });
  if (!lanzado) {
    process.stderr.write(`no se pudo abrir el navegador con «${programa}»; abrí este enlace a mano (sirve una vez, por 60 s):\n${url}\n`);
    return 1;
  }
  hijo.unref();
  return salida("web abierta en el navegador (el enlace sirve una sola vez y vence en 60 s)");
}

/**
 * `agent-memory remote …`. Generar el código, el alcance, revocar y renovar son de la persona en la web: `remote code`
 * solo abre esa pantalla. Lo demás va por el servicio con el token.
 */
async function remote(args: string[]): Promise<number> {
  const [sub, ...resto] = args;
  if (sub === "code") return abrir(resto, "remoto");
  if (sub !== "status" && sub !== "relay" && sub !== "link") return uso("uso: agent-memory remote code | link <código> --nombre <origen> | relay <url> | status");
  const { values, positionals } = parseArgs({ args: resto, allowPositionals: true, options: { nombre: { type: "string" }, dispositivo: { type: "string" } } });
  const config = cargarConfig();
  const arranque = await arrancarSeparado(config, ESPERA_START_MS);
  if (!arranque.salud) {
    process.stderr.write(`agent-memory no respondió en ${ESPERA_START_MS / 1000} s; mirá ${config.logPath} o corré «agent-memory doctor»\n`);
    return 1;
  }
  const cliente = new ClienteServicio(config);
  try {
    if (sub === "status") {
      if (positionals.length) return uso(`argumentos de más: ${positionals.join(" ")}`);
      const e = await cliente.llamar<EstadoEnlaceCli>("enlace_estado");
      return salida(formatearEstadoRemoto(e));
    }
    if (sub === "relay") {
      if (positionals.length !== 1) return uso("uso: agent-memory remote relay <url>   (la clave del relé, por stdin)");
      const clave = (await leerStdin()).trim();
      if (!clave) return uso("falta la clave del relé por stdin, por ejemplo: agent-memory remote relay wss://… < archivo-de-clave");
      const r = await cliente.llamar<{ rele: { url: string } }>("enlace_rele", { url: positionals[0], clave });
      return salida(`relé configurado: ${r.rele.url}`);
    }
    if (positionals.length !== 1 || !values.nombre) return uso("uso: agent-memory remote link <código> --nombre <origen> [--dispositivo <nombre>]");
    const r = await cliente.llamar<{ origen: string; vence_en: string }>("enlace_canjear", {
      codigo: positionals[0],
      origen: values.nombre,
      ...(values.dispositivo ? { dispositivo: values.dispositivo } : {}),
    });
    return salida(`enlace «${r.origen}» listo, de solo lectura; vence el ${r.vence_en.slice(0, 10)} (la dueña puede renovarlo)`);
  } catch (error) {
    if (error instanceof ErrorServicio) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

interface EstadoEnlaceCli {
  interruptor: boolean;
  rele: { url: string } | null;
  escuchando: number;
  codigo_vigente: boolean;
  dispositivos: { nombre: string; estado: string; vence_en: string }[];
  enlaces: { origen: string; vence_en: string }[];
}

function formatearEstadoRemoto(e: EstadoEnlaceCli): string {
  const lineas = [
    `acceso remoto: ${e.interruptor ? "encendido" : "apagado"}${e.interruptor ? ` (escuchando ${e.escuchando} buzón/es)` : ""}`,
    `relé: ${e.rele ? e.rele.url : "sin configurar («agent-memory remote relay <url>»)"}`,
    `código vigente: ${e.codigo_vigente ? "sí" : "no"}`,
    `dispositivos que leen esta memoria: ${e.dispositivos.length || "ninguno"}`,
    ...e.dispositivos.map((d) => `  - ${d.nombre}: ${d.estado}, vence ${d.vence_en.slice(0, 10)}`),
    `enlaces para leer otras memorias: ${e.enlaces.length || "ninguno"}`,
    ...e.enlaces.map((x) => `  - ${x.origen}: vence ${x.vence_en.slice(0, 10)}`),
  ];
  return lineas.join("\n");
}

async function leerStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("pegá la clave del relé y apretá Ctrl-D:\n");
  let texto = "";
  for await (const parte of process.stdin) texto += String(parte);
  return texto;
}

/** Exportación: la hace el servicio, que se arranca si hace falta. */
async function exportarCli(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { completa: { type: "boolean" }, destino: { type: "string" } },
  });
  if (positionals.length) return uso(`argumentos de más: ${positionals.join(" ")}`);
  const config = cargarConfig();
  const r = await arrancarSeparado(config, ESPERA_START_MS);
  if (!r.salud) {
    process.stderr.write(`agent-memory no respondió en ${ESPERA_START_MS / 1000} s; mirá ${config.logPath} o corré «agent-memory doctor»\n`);
    return 1;
  }
  const hecho = await new ClienteServicio(config).llamar<{ destino: string; archivos: number }>("exportar", {
    ...(values.completa ? { completa: true } : {}),
    ...(values.destino ? { destino: resolve(process.cwd(), values.destino) } : {}),
  });
  return salida(`${hecho.archivos} entradas exportadas${values.completa ? " con su historia" : " (activas)"} en ${hecho.destino}`);
}

/**
 * Purga física: abre la base directamente, sin la API, y pide escribir el id. Es
 * irreversible: la confirmación es la única barrera.
 */
async function purge(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { confirmar: { type: "string" } } });
  const id = Number(positionals[0]);
  if (positionals.length !== 1 || !Number.isInteger(id) || id < 1) return uso("uso: agent-memory purge <id>");
  const config = cargarConfig();
  if (!existsSync(config.dbPath)) {
    process.stderr.write(`no hay memoria en ${config.dbPath}\n`);
    return 1;
  }
  const store = MemoryStore.abrir(config.dbPath, { embedder: null });
  try {
    const e = store.obtener(id);
    process.stdout.write(
      `Vas a purgar #${e.id} · ${e.titulo} · ${e.tipo}, con sus ${store.revisiones(id).length} revisiones, relaciones y vectores.\n` +
        "No se puede deshacer. Para retirarla conservando la historia, caducala o reemplazala desde la web.\n",
    );
    const respuesta = values.confirmar ?? (await leerLinea(`Escribí el id (${id}) para confirmar: `));
    if (respuesta.trim() !== String(id)) {
      process.stderr.write("purga cancelada: el id no coincide; no se borró nada\n");
      return 1;
    }
    purgar(store, id, config.purgasPath);
    return salida(`#${id} purgada; quedó anotada en ${config.purgasPath} con el id y la fecha, sin contenido`);
  } finally {
    store.close();
  }
}

/** Comando que abre una URL: `AGENT_MEMORY_NAVEGADOR` si está, si no el del sistema. */
function navegador(): string[] {
  const propio = process.env.AGENT_MEMORY_NAVEGADOR?.trim();
  if (propio) return [propio];
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
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
    contexto: resolverContexto(process.cwd(), { proyectos: config.proyectos }),
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
  if (args.join(" ") !== "claude-code") return uso("uso: agent-memory install claude-code");
  return salida(instalarClaudeCode(process.env).map((l) => `· ${l}`).join("\n"));
}

/** Una línea de stdin; si stdin se cierra sin respuesta, devuelve vacío (nunca queda colgada). */
function leerLinea(pregunta: string): Promise<string> {
  process.stdout.write(pregunta);
  const rl = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve) => {
    let respondida = false;
    rl.once("line", (linea) => {
      respondida = true;
      rl.close();
      resolve(linea);
    });
    rl.once("close", () => {
      if (!respondida) resolve("");
    });
  });
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
