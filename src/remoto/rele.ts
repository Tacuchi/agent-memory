/**
 * Relé ciego (`agent-memory relay`): punto de encuentro de dos instalaciones que no aceptan conexiones entrantes.
 *
 * - Toda petición sin la clave del relé (`Authorization: Bearer <clave>`) recibe 401 sin detalle, en cualquier ruta.
 *   La clave se compara en tiempo constante y antes del upgrade a WebSocket.
 * - `/buzon/<id>` junta como máximo dos extremos y reenvía al otro los mensajes binarios tal cual: no los lee, no los
 *   guarda y no registra nada de su contenido. Lo que llega antes de que esté el otro se encola con tope.
 * - Tope de tamaño por mensaje y cierre por inactividad. Cuando un extremo se va, se cierra el otro: cada par es
 *   una sesión.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

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
}

export interface Rele {
  url: string;
  port: number;
  /** Extremos conectados ahora en un buzón (para pruebas y diagnóstico; no expone contenido). */
  extremos(buzon: string): number;
  /** Conexiones aceptadas desde que arrancó, en todos los buzones. */
  aceptadas(): number;
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

  const autorizado = (req: IncomingMessage): boolean => {
    const cabecera = req.headers.authorization ?? "";
    const valor = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : "";
    return timingSafeEqual(sha(valor), huella);
  };

  const servidor: Server = createServer((req, res) => {
    // Sin upgrade no hay nada que servir; con la clave, 204 sirve para comprobar que el relé se alcanza.
    res.writeHead(autorizado(req) ? 204 : 401, { "content-length": "0" }).end();
  });

  servidor.on("upgrade", (req: IncomingMessage, socket: Duplex, cabeza: Buffer) => {
    if (!autorizado(req)) return rechazar(socket, 401, "Unauthorized");
    const id = BUZON.exec((req.url ?? "/").split("?")[0] ?? "")?.[1];
    if (!id) return rechazar(socket, 404, "Not Found");
    const lista = buzones.get(id) ?? [];
    if (lista.length >= 2) return rechazar(socket, 409, "Conflict");
    wss.handleUpgrade(req, socket, cabeza, (ws) => {
      aceptadas++;
      const yo: Extremo = { ws, cola: [], reloj: null };
      lista.push(yo);
      buzones.set(id, lista);
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
        const destino = otro();
        // Contrapresión: un receptor que no lee no hace crecer la memoria del relé.
        if (destino && destino.ws.bufferedAmount > 4 * topeMensaje) return ws.close(1008, "receptor lento");
        if (destino) destino.ws.send(marco);
        else if (yo.cola.length < TOPE_COLA) yo.cola.push(marco);
        else ws.close(1008, "cola llena");
      });
      ws.on("close", () => {
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
    cerrar: () =>
      new Promise<void>((ok) => {
        for (const lista of buzones.values()) for (const e of lista) e.ws.terminate();
        wss.close();
        servidor.closeAllConnections();
        servidor.close(() => ok());
      }),
  };
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
