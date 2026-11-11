/**
 * Relé ciego (`agent-memory relay`): punto de encuentro de dos instalaciones que no aceptan conexiones entrantes.
 *
 * - Toda petición sin la clave del relé (`Authorization: Bearer <clave>`) recibe 401 sin detalle, en cualquier ruta.
 *   La clave se compara en tiempo constante y antes del upgrade a WebSocket.
 * - `/buzon/<id>` junta como máximo dos extremos y reenvía al otro los mensajes binarios tal cual: no los lee, no los
 *   guarda y no registra nada de su contenido. Lo que llega antes de que esté el otro se encola con tope.
 * - Tope de tamaño por mensaje y cierre por inactividad. Cuando un extremo se va, se cierra el otro: cada par es
 *   una sesión.
 * - `/pc` es el canal de control de cada PC 0.3.0 (informe de metadatos y órdenes del panel); `/dashboard` es el panel,
 *   que no usa la clave del relé sino un JWT de Cloudflare Access verificado aquí (plan 007). Sin Access configurado,
 *   `/dashboard` responde 404.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { version as versionPaquete } from "../version.js";
import { CABECERA_ACCESS, crearVerificador, type OpcionesAcceso } from "./acceso.js";
import { DURACIONES, EstadoRele } from "./rele-estado.js";

export const TOPE_MENSAJE_POR_DEFECTO = 1024 * 1024;
export const INACTIVIDAD_POR_DEFECTO_MS = 60_000;
const TOPE_COLA = 16;
/** Tope de conexiones abiertas del relé (para una persona con pocos dispositivos sobra). */
const TOPE_CONEXIONES = 256;
const BUZON = /^\/buzon\/([A-Za-z0-9_-]{16,64})$/;
/** Largo mínimo de la clave del relé. */
export const LARGO_MINIMO_CLAVE = 24;

export interface OpcionesRele {
  clave: string;
  puerto?: number;
  host?: string;
  topeMensaje?: number;
  inactividadMs?: number;
  /** Cloudflare Access para el panel; sin esto, `/dashboard` responde 404. */
  acceso?: OpcionesAcceso;
  /** Carpeta con los estáticos del panel; por defecto `dist/panel` del paquete. */
  dirPanel?: string | null;
}

const CABECERA_PC = "x-agent-memory-pc";
const HUELLA_PC = /^[A-Za-z0-9_-]{22}$/;
const TOPE_INFORME = 256 * 1024;
const TOPE_ACCION = 16 * 1024;
const PC = z.string().regex(/^([A-Za-z0-9_-]{22}|ip-[0-9a-fA-F.:]{2,45})$/);
const IP = z.string().regex(/^[0-9a-fA-F.:]{2,45}$/);
const ACCION = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("cerrar_pc"), pc: PC }).strict(),
  z.object({ accion: z.literal("cerrar_todo") }).strict(),
  z.object({ accion: z.literal("bloquear"), pc: PC.optional(), ip: IP.optional(), duracion: z.enum(Object.keys(DURACIONES) as ["1h", "24h", "indefinido"]) }).strict(),
  z.object({ accion: z.literal("desbloquear"), pc: PC.optional(), ip: IP.optional() }).strict(),
  z.object({ accion: z.literal("revocar"), pc: PC, objetivo: z.string().min(1).max(40) }).strict(),
  z.object({ accion: z.literal("quitar_enlace"), pc: PC, objetivo: z.string().min(1).max(40) }).strict(),
  z.object({ accion: z.literal("renovar"), pc: PC, objetivo: z.string().min(1).max(40) }).strict(),
  z
    .object({
      accion: z.literal("alcance"),
      pc: PC,
      objetivo: z.string().min(1).max(40),
      alcance: z.object({ ambitos: z.array(z.string().min(1).max(200)).max(50), pendientes: z.boolean() }).strict(),
    })
    .strict(),
  z.object({ accion: z.literal("codigo"), pc: PC }).strict(),
]);
const TIPOS_ESTATICOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface Rele {
  url: string;
  port: number;
  /** Extremos conectados ahora en un buzón (para pruebas y diagnóstico; no expone contenido). */
  extremos(buzon: string): number;
  /** Conexiones aceptadas desde que arrancó, en todos los buzones. */
  aceptadas(): number;
  /** Estado del panel (PCs, rechazos, bloqueos), solo en memoria. */
  estado: EstadoRele;
  cerrar(): Promise<void>;
}

interface Extremo {
  ws: WebSocket;
  cola: Buffer[];
  reloj: NodeJS.Timeout | null;
}

export async function crearRele(op: OpcionesRele): Promise<Rele> {
  if (op.clave.length < LARGO_MINIMO_CLAVE) throw new Error(`la clave del relé debe tener al menos ${LARGO_MINIMO_CLAVE} caracteres`);
  const huella = sha(op.clave);
  const topeMensaje = op.topeMensaje ?? TOPE_MENSAJE_POR_DEFECTO;
  const inactividadMs = op.inactividadMs ?? INACTIVIDAD_POR_DEFECTO_MS;
  const buzones = new Map<string, Extremo[]>();
  let aceptadas = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: topeMensaje, perMessageDeflate: false });
  const wssControl = new WebSocketServer({ noServer: true, maxPayload: TOPE_INFORME, perMessageDeflate: false });
  const estado = new EstadoRele();
  const verificador = op.acceso ? crearVerificador(op.acceso) : null;
  const dirPanel = op.dirPanel === undefined ? fileURLToPath(new URL("../panel/", import.meta.url)) : op.dirPanel;
  const version = versionPaquete();

  const autorizado = (req: IncomingMessage): boolean => {
    const cabecera = req.headers.authorization ?? "";
    const valor = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : "";
    return timingSafeEqual(sha(valor), huella);
  };

  const servidor: Server = createServer((req, res) => {
    const ruta = (req.url ?? "/").split("?")[0] ?? "/";
    if (ruta === "/dashboard" || ruta.startsWith("/dashboard/")) {
      void panel(req, res, ruta).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-length": "0" });
        res.end();
      });
      return;
    }
    // Sin upgrade no hay nada que servir; con la clave, 204 sirve para comprobar que el relé se alcanza.
    const ok = autorizado(req);
    if (!ok) estado.rechazo(ipDe(req));
    res.writeHead(ok ? 204 : 401, { "content-length": "0" }).end();
  });

  const panel = async (req: IncomingMessage, res: ServerResponse, ruta: string): Promise<void> => {
    if (!verificador) return void res.writeHead(404, { "content-length": "0" }).end();
    const sesion = await verificador.verificar(req.headers[CABECERA_ACCESS] as string | undefined);
    if (!sesion) return void res.writeHead(401, { "content-length": "0" }).end();
    if (ruta === "/dashboard/api/estado" && req.method === "GET") return json(res, 200, estado.vista(version, TOPE_CONEXIONES));
    if (ruta === "/dashboard/api/accion" && req.method === "POST") {
      const host = req.headers.host ?? "";
      const origen = req.headers.origin;
      if (!origen || (origen !== `https://${host}` && origen !== `http://${host}`)) return json(res, 403, { ok: false, error: "origen no permitido" });
      const cuerpo = await leerCuerpo(req, TOPE_ACCION);
      let datos: unknown;
      try {
        datos = JSON.parse(cuerpo ?? "");
      } catch {
        return json(res, 400, { ok: false, error: "el cuerpo no es JSON" });
      }
      const a = ACCION.safeParse(datos);
      if (!a.success) return json(res, 400, { ok: false, error: "acción inválida" });
      return json(res, 200, await accion(a.data));
    }
    if (req.method !== "GET") return void res.writeHead(405, { "content-length": "0" }).end();
    return estatico(res, dirPanel, ruta === "/dashboard" || ruta === "/dashboard/" ? "index.html" : ruta.slice("/dashboard/".length));
  };

  const accion = async (a: z.infer<typeof ACCION>): Promise<{ ok: boolean; estado?: string; mensaje?: string; error?: string }> => {
    switch (a.accion) {
      case "cerrar_pc":
        return { ok: true, estado: "hecho", mensaje: `${estado.cerrarPc(a.pc)} conexiones cerradas` };
      case "cerrar_todo":
        return { ok: true, estado: "hecho", mensaje: `${estado.cerrarTodo()} conexiones cerradas` };
      case "bloquear":
      case "desbloquear": {
        const objetivo = a.ip ? { ip: a.ip } : a.pc?.startsWith("ip-") ? { ip: a.pc.slice(3) } : a.pc ? { pc: a.pc } : null;
        if (!objetivo) return { ok: false, error: "falta la PC o la IP" };
        if (a.accion === "bloquear") estado.bloquear(objetivo, a.duracion);
        else estado.desbloquear(objetivo);
        return { ok: true, estado: "hecho" };
      }
      default: {
        const r = await estado.ordenar(a.pc, {
          accion: a.accion,
          objetivo: "objetivo" in a ? a.objetivo : null,
          datos: a.accion === "alcance" ? a.alcance : null,
        });
        return r.estado === "error" ? { ok: false, error: r.mensaje ?? "la PC no pudo cumplir la orden" } : { ok: true, estado: r.estado, ...(r.mensaje ? { mensaje: r.mensaje } : {}) };
      }
    }
  };

  servidor.on("upgrade", (req: IncomingMessage, socket: Duplex, cabeza: Buffer) => {
    const ip = ipDe(req);
    const cabeceraPc = req.headers[CABECERA_PC];
    const pc = typeof cabeceraPc === "string" && HUELLA_PC.test(cabeceraPc) ? cabeceraPc : null;
    if (!autorizado(req)) {
      estado.rechazo(ip);
      return rechazar(socket, 401, "Unauthorized");
    }
    if (estado.bloqueado(pc, ip)) return rechazar(socket, 403, "Forbidden");
    const ruta = (req.url ?? "/").split("?")[0] ?? "";
    if (ruta === "/pc") {
      if (!pc) return rechazar(socket, 400, "Bad Request");
      return wssControl.handleUpgrade(req, socket, cabeza, (ws) => {
        estado.abrirControl(pc, ip, ws);
        ws.on("message", (datos, binario) => {
          if (!binario) estado.mensajeControl(pc, String(datos));
        });
        ws.on("close", () => estado.cerrarControl(pc, ws));
        ws.on("error", () => ws.terminate());
      });
    }
    const id = BUZON.exec(ruta)?.[1];
    if (!id) return rechazar(socket, 404, "Not Found");
    const lista = buzones.get(id) ?? [];
    if (lista.length >= 2) return rechazar(socket, 409, "Conflict");
    wss.handleUpgrade(req, socket, cabeza, (ws) => {
      aceptadas++;
      const yo: Extremo = { ws, cola: [], reloj: null };
      lista.push(yo);
      buzones.set(id, lista);
      estado.abrirConexion(ws, { pc, ip, buzon: id, par: () => lista.length === 2 && lista.includes(yo) });
      const otro = (): Extremo | undefined => lista.find((e) => e !== yo);
      const reiniciarReloj = (): void => {
        if (yo.reloj) clearTimeout(yo.reloj);
        yo.reloj = setTimeout(() => ws.close(1000, "inactivo"), inactividadMs);
      };
      reiniciarReloj();
      // Al llegar el segundo, recibe lo que el primero mandó mientras estaba solo.
      const primero = otro();
      if (primero) for (const datos of primero.cola.splice(0)) ws.send(datos);
      ws.on("message", (datos, binario) => {
        if (!lista.includes(yo)) return;
        if (!binario) return ws.close(1003, "solo binario");
        reiniciarReloj();
        const marco = Buffer.isBuffer(datos) ? datos : Array.isArray(datos) ? Buffer.concat(datos) : Buffer.from(datos);
        estado.trafico(ws, marco.length);
        const destino = otro();
        // Contrapresión: un receptor que no lee no hace crecer la memoria del relé.
        if (destino && destino.ws.bufferedAmount > 4 * topeMensaje) return ws.close(1008, "receptor lento");
        if (destino) destino.ws.send(marco);
        else if (yo.cola.length < TOPE_COLA) yo.cola.push(marco);
        else ws.close(1008, "cola llena");
      });
      ws.on("close", () => {
        estado.cerrarConexion(ws);
        if (yo.reloj) clearTimeout(yo.reloj);
        // El par termina entero y en el acto: el otro sale del buzón ya, para que un recién llegado no se empareje
        // con un extremo que se está cerrando.
        const companero = otro();
        for (const e of [yo, companero]) {
          const i = e ? lista.indexOf(e) : -1;
          if (i >= 0) lista.splice(i, 1);
        }
        if (lista.length === 0 && buzones.get(id) === lista) buzones.delete(id);
        if (companero) {
          if (companero.reloj) clearTimeout(companero.reloj);
          companero.ws.close(1000, "el otro extremo se fue");
        }
      });
      ws.on("error", () => ws.terminate());
    });
  });

  await new Promise<void>((ok, mal) => {
    servidor.once("error", mal);
    servidor.maxConnections = TOPE_CONEXIONES;
    servidor.listen(op.puerto ?? 0, op.host ?? "127.0.0.1", () => ok());
  });
  const { port, address } = servidor.address() as AddressInfo;
  return {
    url: `ws://${address.includes(":") ? `[${address}]` : address}:${port}`,
    port,
    extremos: (buzon) => buzones.get(buzon)?.length ?? 0,
    aceptadas: () => aceptadas,
    estado,
    cerrar: () =>
      new Promise<void>((ok) => {
        for (const lista of buzones.values()) for (const e of lista) e.ws.terminate();
        for (const ws of wssControl.clients) ws.terminate();
        wss.close();
        wssControl.close();
        servidor.closeAllConnections();
        servidor.close(() => ok());
      }),
  };
}

/**
 * IP del cliente: la de `CF-Connecting-IP` si viene (el relé publicado solo acepta tráfico de Cloudflare, que la
 * fija), si no la del socket.
 */
function ipDe(req: IncomingMessage): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && /^[0-9a-fA-F.:]{2,45}$/.test(cf)) return cf;
  return req.socket.remoteAddress ?? null;
}

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(texto) });
  res.end(texto);
}

function leerCuerpo(req: IncomingMessage, tope: number): Promise<string | null> {
  return new Promise((ok) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on("data", (p: Buffer) => {
      total += p.length;
      if (total > tope) {
        req.destroy();
        ok(null);
      } else partes.push(p);
    });
    req.on("end", () => ok(Buffer.concat(partes).toString("utf8")));
    req.on("error", () => ok(null));
  });
}

function estatico(res: ServerResponse, dir: string | null, relativa: string): void {
  if (!dir) return void res.writeHead(404, { "content-length": "0" }).end();
  const base = normalize(dir.endsWith(sep) ? dir : dir + sep);
  const archivo = normalize(join(base, decodeURIComponent(relativa)));
  if (!archivo.startsWith(base) || !existsSync(archivo) || !statSync(archivo).isFile()) {
    return void res.writeHead(404, { "content-length": "0" }).end();
  }
  const cuerpo = readFileSync(archivo);
  res.writeHead(200, {
    "content-type": TIPOS_ESTATICOS[extname(archivo)] ?? "application/octet-stream",
    "content-length": cuerpo.length,
    "cache-control": relativa === "index.html" ? "no-store" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(cuerpo);
}

function rechazar(socket: Duplex, estado: number, texto: string): void {
  socket.end(`HTTP/1.1 ${estado} ${texto}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sha(texto: string): Buffer {
  return createHash("sha256").update(texto, "utf8").digest();
}

/**
 * Clave del relé: de `AGENT_MEMORY_RELAY_KEY` o de un archivo que solo lee su dueño (0600). Nunca por argumento, para
 * que no quede en el historial de la terminal ni en la lista de procesos.
 */
export function leerClaveRele(env: NodeJS.ProcessEnv, archivo?: string): string {
  if (archivo) {
    if (process.platform !== "win32" && (statSync(archivo).mode & 0o077) !== 0) {
      throw new Error(`${archivo} debe ser legible solo por su dueño (chmod 600)`);
    }
    return validarClave(readFileSync(archivo, "utf8").trim());
  }
  const valor = env.AGENT_MEMORY_RELAY_KEY?.trim();
  if (!valor) throw new Error("falta la clave del relé: AGENT_MEMORY_RELAY_KEY o --clave-archivo <ruta> (0600)");
  return validarClave(valor);
}

function validarClave(clave: string): string {
  if (clave.length < LARGO_MINIMO_CLAVE) {
    throw new Error(`la clave del relé debe tener al menos ${LARGO_MINIMO_CLAVE} caracteres; generá una al azar, por ejemplo con «openssl rand -base64 32»`);
  }
  return clave;
}
