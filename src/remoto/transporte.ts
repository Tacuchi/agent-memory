/**
 * Cliente del relé: abre un buzón por WebSocket (sobre TLS con `wss://`) y lo presenta como {@link Transporte}.
 * Si hay proxy (`HTTPS_PROXY`), abre antes un túnel `CONNECT` con `node:http` y monta el TLS dentro: el proxy solo
 * ve el host y el puerto del relé. Los destinos de loopback y los de `NO_PROXY` van directo.
 */
import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { connect as conectarTls } from "node:tls";
import { WebSocket } from "ws";
import type { Transporte } from "./canal.js";
import { TOPE_MENSAJE_POR_DEFECTO } from "./rele.js";

const ESPERA_CONEXION_MS = 10_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ErrorRele extends Error {
  constructor(
    readonly codigo: "clave_rele" | "buzon_ocupado" | "sin_conexion" | "proxy" | "bloqueado",
    detalle: string,
  ) {
    super(detalle);
    this.name = "ErrorRele";
  }
}

export interface OpcionesConexion {
  /** URL base del relé: `wss://host` (o `ws://` en pruebas locales). */
  url: string;
  clave: string;
  buzon: string;
  /** Proxy explícito; si falta, se toma de `HTTPS_PROXY`/`https_proxy`. `null` lo desactiva. */
  proxy?: string | null;
  env?: NodeJS.ProcessEnv;
  esperaMs?: number;
  /** Huella de esta PC: el relé 0.3.0 atribuye la conexión a la PC para su panel. */
  pc?: string;
}

/** Cabecera con la que una PC se presenta ante el relé (huella pública, nunca un secreto). */
export const CABECERA_PC = "x-agent-memory-pc";
export const HUELLA_PC = /^[A-Za-z0-9_-]{22}$/;

/** Canal de control PC ↔ relé: mensajes JSON de texto (informe, órdenes, resultados). */
export interface CanalControl {
  enviar(mensaje: object): void;
  alMensaje(fn: (mensaje: unknown) => void): void;
  alCerrar(fn: () => void): void;
  cerrar(): void;
}

export function proxyPara(destino: URL, env: NodeJS.ProcessEnv = process.env): string | null {
  if (LOOPBACK.has(destino.hostname)) return null;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (!proxy) return null;
  const excepciones = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((h) => h.trim().replace(/^\*?\./, ""))
    .filter(Boolean);
  const host = destino.hostname;
  if (excepciones.some((h) => h === "*" || host === h || host.endsWith(`.${h}`))) return null;
  return proxy;
}

export async function conectarRele(op: OpcionesConexion): Promise<Transporte> {
  const base = new URL(op.url);
  // La clave del relé viaja en una cabecera: sin TLS solo se admite loopback (pruebas y relé local).
  if (base.protocol !== "wss:" && !(base.protocol === "ws:" && LOOPBACK.has(base.hostname))) {
    throw new ErrorRele("sin_conexion", `la URL del relé debe empezar con wss:// (es ${base.protocol}//${base.hostname})`);
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(op.buzon)) throw new ErrorRele("sin_conexion", "id de buzón inválido");
  const ws = await abrirWs(base, `/buzon/${op.buzon}`, op);
  // Se escucha desde antes del `open`: el relé puede entregar lo encolado en el mismo paquete que el upgrade.
  const transporte = transporteDe(ws);
  await esperarApertura(ws);
  return transporte;
}

/**
 * Lectora en el modo directo: abre `ws://<host>:<puerto>/buzon/<id>` en la dueña, sin clave de relé y sin proxy (es la
 * red local o la tailnet). Va sin TLS a propósito: lo que viaja ya está cifrado de punta a punta por el canal.
 */
export async function conectarDirecto(op: { host: string; puerto: number; buzon: string; esperaMs?: number }): Promise<Transporte> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(op.buzon)) throw new ErrorRele("sin_conexion", "id de buzón inválido");
  const host = op.host.includes(":") ? `[${op.host}]` : op.host;
  const destino = `${host}:${op.puerto}`;
  const ws = new WebSocket(`ws://${destino}/buzon/${op.buzon}`, {
    maxPayload: TOPE_MENSAJE_POR_DEFECTO,
    handshakeTimeout: op.esperaMs ?? ESPERA_CONEXION_MS,
    perMessageDeflate: false,
  });
  const transporte = transporteDe(ws);
  await new Promise<void>((ok, mal) => {
    ws.once("open", () => ok());
    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      const estado = res.statusCode ?? 0;
      ws.terminate();
      if (estado === 429) mal(new ErrorRele("bloqueado", `la otra PC limitó a esta por intentos fallidos (429); probá de nuevo en unos minutos`));
      else if (estado === 404) mal(new ErrorRele("sin_conexion", `la otra PC no atiende este enlace en ${destino} (404): ¿tiene el acceso remoto encendido?`));
      else mal(new ErrorRele("sin_conexion", `la otra PC respondió ${estado} en ${destino}`));
    });
    ws.once("error", (error) => mal(new ErrorRele("sin_conexion", `no se pudo conectar a la otra PC en ${destino}: ${error.message}`)));
  });
  return transporte;
}

/** Abre el canal de control de esta PC con el relé (`/pc`). */
export async function conectarControl(op: Omit<OpcionesConexion, "buzon"> & { pc: string }): Promise<CanalControl> {
  const base = new URL(op.url);
  if (base.protocol !== "wss:" && !(base.protocol === "ws:" && LOOPBACK.has(base.hostname))) {
    throw new ErrorRele("sin_conexion", `la URL del relé debe empezar con wss:// (es ${base.protocol}//${base.hostname})`);
  }
  const ws = await abrirWs(base, "/pc", op);
  const previos: unknown[] = [];
  let receptor: ((m: unknown) => void) | null = null;
  let cerrado = false;
  const alCerrar: (() => void)[] = [];
  ws.on("message", (datos, binario) => {
    if (binario) return;
    let mensaje: unknown;
    try {
      mensaje = JSON.parse(String(datos));
    } catch {
      return;
    }
    if (receptor) receptor(mensaje);
    else if (previos.length < 16) previos.push(mensaje);
  });
  ws.on("close", () => {
    cerrado = true;
    for (const fn of alCerrar.splice(0)) fn();
  });
  ws.on("error", () => ws.terminate());
  await esperarApertura(ws);
  return {
    enviar: (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    alMensaje: (fn) => {
      receptor = fn;
      for (const m of previos.splice(0)) fn(m);
    },
    alCerrar: (fn) => {
      if (cerrado) fn();
      else alCerrar.push(fn);
    },
    cerrar: () => ws.close(1000),
  };
}

async function abrirWs(base: URL, ruta: string, op: Omit<OpcionesConexion, "buzon" | "url">): Promise<WebSocket> {
  const destino = new URL(ruta, base);
  const proxy = op.proxy === undefined ? proxyPara(destino, op.env) : op.proxy;
  const espera = op.esperaMs ?? ESPERA_CONEXION_MS;
  const socket = proxy ? await tunel(proxy, destino, espera) : null;
  const headers: Record<string, string> = { authorization: `Bearer ${op.clave}` };
  if (op.pc && HUELLA_PC.test(op.pc)) headers[CABECERA_PC] = op.pc;
  return new WebSocket(destino.toString(), {
    headers,
    maxPayload: TOPE_MENSAJE_POR_DEFECTO,
    handshakeTimeout: espera,
    perMessageDeflate: false,
    ...(socket ? { createConnection: () => socket } : {}),
  });
}

function esperarApertura(ws: WebSocket): Promise<void> {
  return new Promise<void>((ok, mal) => {
    ws.once("open", () => ok());
    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      const estado = res.statusCode ?? 0;
      ws.terminate();
      if (estado === 401) mal(new ErrorRele("clave_rele", "el relé rechazó la clave (401)"));
      else if (estado === 409) mal(new ErrorRele("buzon_ocupado", "el buzón ya tiene dos extremos"));
      else if (estado === 403) mal(new ErrorRele("bloqueado", "el relé bloqueó esta PC o esta IP (403)"));
      else if (estado === 429) mal(new ErrorRele("bloqueado", "el relé limitó esta IP por intentos con una clave equivocada (429); probá de nuevo en 15 minutos"));
      else mal(new ErrorRele("sin_conexion", `el relé respondió ${estado}`));
    });
    ws.once("error", (error) => mal(new ErrorRele("sin_conexion", `no se pudo conectar al relé: ${error.message}`)));
  });
}

/** Presenta un WebSocket abierto como {@link Transporte} (lo usan el cliente del relé y el servidor directo). */
export function transporteDe(ws: WebSocket): Transporte {
  const previos: Buffer[] = [];
  const TOPE_PREVIOS = 64;
  let receptor: ((datos: Buffer) => void) | null = null;
  let cerrado = false;
  const alCerrar: (() => void)[] = [];
  ws.on("message", (datos) => {
    const marco = Buffer.isBuffer(datos) ? datos : Array.isArray(datos) ? Buffer.concat(datos) : Buffer.from(datos);
    if (receptor) receptor(marco);
    else if (previos.length < TOPE_PREVIOS) previos.push(marco);
    else ws.terminate();
  });
  ws.on("close", () => {
    cerrado = true;
    for (const fn of alCerrar.splice(0)) fn();
  });
  return {
    enviar: (datos) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(datos);
    },
    alRecibir: (fn) => {
      receptor = fn;
      for (const marco of previos.splice(0)) fn(marco);
    },
    alCerrar: (fn) => {
      if (cerrado) fn();
      else alCerrar.push(fn);
    },
    cerrar: () => ws.close(1000),
  };
}

/** Túnel `CONNECT host:puerto` por el proxy; con `wss://`, el TLS va adentro del túnel, punta a punta con el relé. */
function tunel(proxy: string, destino: URL, esperaMs: number): Promise<Socket> {
  const p = new URL(proxy);
  if (p.protocol !== "http:") return Promise.reject(new ErrorRele("proxy", `solo se admite un proxy http:// (es ${p.protocol})`));
  const puerto = destino.port || (destino.protocol === "wss:" ? "443" : "80");
  const autoridad = `${destino.hostname}:${puerto}`;
  const cabeceras: Record<string, string> = { host: autoridad };
  if (p.username) cabeceras["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}`;
  return new Promise((ok, mal) => {
    const req = request({ host: p.hostname, port: Number(p.port || 80), method: "CONNECT", path: autoridad, headers: cabeceras, timeout: esperaMs });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return mal(new ErrorRele("proxy", `el proxy rechazó el túnel (${res.statusCode})`));
      }
      if (destino.protocol !== "wss:") return ok(socket);
      const tls = conectarTls({ socket, servername: destino.hostname });
      tls.setTimeout(esperaMs, () => tls.destroy(new Error("tiempo agotado en el TLS")));
      tls.once("secureConnect", () => {
        tls.setTimeout(0);
        ok(tls);
      });
      tls.once("error", (error) => mal(new ErrorRele("proxy", `TLS dentro del túnel: ${error.message}`)));
    });
    req.once("timeout", () => req.destroy(new Error("tiempo agotado")));
    req.once("error", (error) => mal(new ErrorRele("proxy", `no se pudo abrir el túnel: ${error.message}`)));
    req.end();
  });
}
