import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { ZodError } from "zod";
import { ReglaError, type Actor } from "../domain/types.js";
import type { Api } from "./api.js";
import { mismoSecreto } from "./token.js";

export const HOST = "127.0.0.1";
const COOKIE = "am_sesion";
const VIDA_ENLACE_MS = 60_000;
const MAX_CUERPO = 1_000_000;
const HOSTS_LOOPBACK = new Set(["127.0.0.1", "localhost"]);

export interface OpcionesServidor {
  api: Api;
  token: string;
  port: number;
  reloj?: () => number;
  /** Carpeta con la web compilada (`dist/web`); sin ella, el servicio solo expone la API. */
  dirWeb?: string | null;
}

export interface Servicio {
  server: Server;
  port: number;
  url: string;
  cerrar(): Promise<void>;
}

/**
 * Servicio local (T3.1, AC-21): solo 127.0.0.1, `Host` de loopback y token en toda petición.
 * La web entra con un enlace de un solo uso que deja una cookie de sesión HttpOnly + Strict.
 */
export async function iniciarServicio(opciones: OpcionesServidor): Promise<Servicio> {
  const reloj = opciones.reloj ?? Date.now;
  const enlaces = new Map<string, number>();
  const sesiones = new Set<string>();

  const server = createServer((req, res) => {
    atender(req, res).catch((error: unknown) => responderError(res, error));
  });

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostLoopback(req.headers.host)) return responder(res, 421, { error: { codigo: "host_ajeno", mensaje: "host no permitido" } });
    const url = new URL(req.url ?? "/", `http://${HOST}`);

    if (req.method === "GET" && url.pathname.startsWith("/sesion/")) return canjearEnlace(url.pathname.slice("/sesion/".length), res);

    const actor = autenticar(req);
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      // La web es de la persona: sin cookie de sesión no se sirve ni un archivo (AC-21).
      if (actor !== "persona") return responderSinSesion(res);
      return servirWeb(url.pathname, res);
    }
    if (!actor) return responder(res, 401, { error: { codigo: "sin_token", mensaje: "falta un token válido" } });
    if (actor === "persona" && !peticionPropia(req)) {
      return responder(res, 403, { error: { codigo: "origen_ajeno", mensaje: "la web solo acepta peticiones JSON de su propio origen" } });
    }

    if (req.method === "POST" && url.pathname === "/api/enlace-web") {
      if (actor !== "agente") return responder(res, 403, { error: { codigo: "solo_cliente_local", mensaje: "el enlace lo pide la CLI con el token" } });
      return responder(res, 200, { url: acuñarEnlace() });
    }

    const op = url.pathname.startsWith("/api/") ? url.pathname.slice("/api/".length) : "";
    if (req.method !== "POST" || !opciones.api.esOperacion(op)) {
      return responder(res, 404, { error: { codigo: "ruta_desconocida", mensaje: `${req.method} ${url.pathname} no existe` } });
    }
    const cuerpo = await leerJson(req);
    responder(res, 200, await opciones.api.ejecutar(op, cuerpo, actor));
  }

  /** Token de la CLI o del MCP = cliente local; cookie de sesión del navegador = la persona. */
  function autenticar(req: IncomingMessage): Actor | null {
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Bearer ") && mismoSecreto(auth.slice(7).trim(), opciones.token)) return "agente";
    const sesion = leerCookie(req.headers.cookie, COOKIE);
    if (sesion && sesiones.has(sesion)) return "persona";
    return null;
  }

  /** Contra CSRF, además de SameSite=Strict: JSON (exige preflight entre orígenes) y Origin propio. */
  function peticionPropia(req: IncomingMessage): boolean {
    const tipo = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (tipo !== "application/json") return false;
    const origen = req.headers.origin;
    if (origen === undefined) return true;
    try {
      const o = new URL(origen);
      return o.protocol === "http:" && HOSTS_LOOPBACK.has(o.hostname) && Number(o.port) === puerto();
    } catch {
      return false;
    }
  }

  async function servirWeb(ruta: string, res: ServerResponse): Promise<void> {
    const dir = opciones.dirWeb;
    if (!dir) return responder(res, 404, { error: { codigo: "sin_web", mensaje: "esta instalación no trae la web compilada; corré «npm run build»" } });
    const archivo = await archivoWeb(dir, ruta);
    if (!archivo) return responder(res, 404, { error: { codigo: "ruta_desconocida", mensaje: `GET ${ruta} no existe` } });
    const esIndice = archivo.endsWith(`${sep}index.html`);
    res.writeHead(200, {
      "content-type": TIPOS_MIME[extname(archivo)] ?? "application/octet-stream",
      "cache-control": esIndice ? "no-store" : "private, max-age=3600",
      ...CABECERAS_WEB,
    });
    res.end(await readFile(archivo));
  }

  function acuñarEnlace(): string {
    const ahora = reloj();
    for (const [n, vence] of enlaces) if (vence < ahora) enlaces.delete(n);
    const nonce = randomBytes(32).toString("hex");
    enlaces.set(nonce, ahora + VIDA_ENLACE_MS);
    return `http://${HOST}:${puerto()}/sesion/${nonce}`;
  }

  function canjearEnlace(nonce: string, res: ServerResponse): void {
    const vence = enlaces.get(nonce);
    enlaces.delete(nonce);
    if (vence === undefined || vence < reloj()) {
      return responder(res, 401, { error: { codigo: "enlace_invalido", mensaje: "el enlace ya se usó o venció" } });
    }
    const sesion = randomBytes(32).toString("hex");
    sesiones.add(sesion);
    res.writeHead(303, {
      location: "/",
      "set-cookie": `${COOKIE}=${sesion}; HttpOnly; SameSite=Strict; Path=/`,
      "cache-control": "no-store",
    });
    res.end();
  }

  function puerto(): number {
    return (server.address() as AddressInfo).port;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opciones.port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = puerto();
  return {
    server,
    port,
    url: `http://${HOST}:${port}`,
    cerrar: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const CABECERAS_WEB = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const TIPOS_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Archivo de la web para una ruta: los que existen dentro de la carpeta; el resto es la app (index.html). */
async function archivoWeb(dir: string, ruta: string): Promise<string | null> {
  let decodificada: string;
  try {
    decodificada = decodeURIComponent(ruta);
  } catch {
    return null;
  }
  const raiz = normalize(dir.endsWith(sep) ? dir : `${dir}${sep}`);
  const candidato = normalize(join(raiz, decodificada));
  if (!candidato.startsWith(raiz)) return null;
  if (candidato !== raiz && (await esArchivo(candidato))) return candidato;
  // Una ruta con extensión que no existe es un 404; una ruta de la app vuelve al índice.
  if (extname(decodificada)) return null;
  const indice = join(raiz, "index.html");
  return (await esArchivo(indice)) ? indice : null;
}

async function esArchivo(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).isFile();
  } catch {
    return false;
  }
}

function responderSinSesion(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CABECERAS_WEB });
  res.end("agent-memory: sin sesión. Abrí la web con «agent-memory open»; cada enlace sirve una sola vez.\n");
}

function hostLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const nombre = host.replace(/:\d+$/, "").toLowerCase();
  return HOSTS_LOOPBACK.has(nombre);
}

function leerCookie(cabecera: string | undefined, nombre: string): string | null {
  for (const parte of (cabecera ?? "").split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nombre) return v.join("=");
  }
  return null;
}

async function leerJson(req: IncomingMessage): Promise<unknown> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of req) {
    total += (trozo as Buffer).length;
    if (total > MAX_CUERPO) throw new ReglaError("cuerpo_grande", "el cuerpo supera 1 MB");
    trozos.push(trozo as Buffer);
  }
  const texto = Buffer.concat(trozos).toString("utf8").trim();
  if (!texto) return {};
  try {
    return JSON.parse(texto);
  } catch {
    throw new ReglaError("json_invalido", "el cuerpo no es JSON válido");
  }
}

function responder(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(cuerpo));
}

const STATUS: Record<string, number> = {
  no_encontrada: 404,
  revision_no_encontrada: 404,
  conflicto: 409,
  huella_distinta: 409,
  solo_persona: 403,
};

/** Todo fallo llega como error explícito con código, nunca como un resultado vacío. */
function responderError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return void res.end();
  if (error instanceof ReglaError) return responder(res, STATUS[error.codigo] ?? 400, { error: { codigo: error.codigo, mensaje: error.message } });
  if (error instanceof ZodError) {
    const mensaje = error.issues.map((i) => `${i.path.join(".") || "cuerpo"}: ${i.message}`).join("; ");
    return responder(res, 400, { error: { codigo: "peticion_invalida", mensaje } });
  }
  responder(res, 500, { error: { codigo: "error_interno", mensaje: (error as Error).message } });
}
