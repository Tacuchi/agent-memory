/**
 * Modo directo: la dueña escucha el canal remoto en una dirección suya (Tailscale o la red local) y la lectora se
 * conecta sin relé. Cambia solo el transporte: el canal cifrado, el código y las reglas son los mismos que por el relé.
 *
 * La red se trata como no confiable: defienden el código y las claves fijadas. Aquí solo se acota lo que se expone:
 * una dirección elegida (nunca todas), solo `/buzon/<id>` de un buzón que la dueña atiende (todo lo demás es 404, la
 * API local no está), los topes del relé y un límite de intentos fallidos por IP.
 */
import { createServer, type IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { ReglaError } from "../domain/types.js";
import type { Transporte } from "./canal.js";
import type { LimiteIntentos } from "./limite.js";
import { INACTIVIDAD_POR_DEFECTO_MS, TOPE_MENSAJE_POR_DEFECTO } from "./rele.js";
import { transporteDe } from "./transporte.js";

export const PUERTO_DIRECTO_POR_DEFECTO = 47822;
const BUZON = /^\/buzon\/([A-Za-z0-9_-]{16,64})$/;
/** Tope de conexiones abiertas: una persona con pocas PCs no se acerca. */
const TOPE_CONEXIONES = 64;

export interface DireccionPc {
  direccion: string;
  interfaz: string;
  tailscale: boolean;
}

/** Direcciones de esta PC que sirven para invitar: Tailscale primero, luego IPv4 y al final IPv6. */
export function direccionesDeLaPc(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): DireccionPc[] {
  const lista: DireccionPc[] = [];
  for (const [interfaz, entradas] of Object.entries(interfaces)) {
    for (const e of entradas ?? []) {
      // Las de enlace local necesitan la zona de la interfaz: no sirven para que otra PC llegue con una invitación.
      if (e.internal || enlaceLocal(e.address) || lista.some((x) => x.direccion === e.address)) continue;
      lista.push({ direccion: e.address, interfaz, tailscale: esTailscale(e.address) });
    }
  }
  return lista.sort((a, b) => Number(b.tailscale) - Number(a.tailscale) || isIP(a.direccion) - isIP(b.direccion));
}

/** Rangos que Tailscale asigna: `100.64.0.0/10` y `fd7a:115c:a1e0::/48`. */
export function esTailscale(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 100 && b >= 64 && b <= 127;
  }
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function loopback(ip: string): boolean {
  return isIP(ip) === 4 ? ip.startsWith("127.") : ip === "::1";
}

function enlaceLocal(ip: string): boolean {
  return isIP(ip) === 4 ? ip.startsWith("169.254.") : /^fe[89ab][0-9a-f]:/i.test(ip);
}

/**
 * La dirección donde escuchará el modo directo: una IP concreta, nunca el comodín. Loopback y enlace local se rechazan
 * salvo que la PC la ofrezca como dirección suya (solo pasa en pruebas: el sistema nunca la ofrece).
 */
export function validarDireccion(direccion: string, ofrecidas: DireccionPc[]): string {
  const ip = direccion.trim().replace(/^\[(.*)\]$/, "$1");
  if (!isIP(ip)) throw new ReglaError("direccion_invalida", `la dirección es una IP de esta PC (por ejemplo 100.101.102.103); llegó «${direccion.slice(0, 60)}»`);
  if (ip === "0.0.0.0" || ip === "::") throw new ReglaError("direccion_invalida", "el modo directo escucha en una sola dirección elegida, nunca en todas");
  if ((loopback(ip) || enlaceLocal(ip)) && !ofrecidas.some((d) => d.direccion === ip)) {
    throw new ReglaError("direccion_invalida", `«${ip}» no sirve para que otra PC llegue: elegí la de Tailscale o la de la red local`);
  }
  return ip;
}

export function validarPuerto(puerto: number): number {
  if (!Number.isInteger(puerto) || puerto < 1024 || puerto > 65535) {
    throw new ReglaError("puerto_invalido", `el puerto va de 1024 a 65535; llegó ${String(puerto).slice(0, 20)}`);
  }
  return puerto;
}

/** `host:puerto`, con la IPv6 entre corchetes. */
export function hostPuerto(direccion: string, puerto: number): string {
  return isIP(direccion) === 6 ? `[${direccion}]:${puerto}` : `${direccion}:${puerto}`;
}

/** Lee `host:puerto` o `[ipv6]:puerto`; null si no tiene esa forma. */
export function leerDestino(texto: string): { host: string; puerto: number } | null {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(texto) ?? /^([0-9.]+):(\d{1,5})$/.exec(texto);
  if (!m) return null;
  const host = m[1] as string;
  const puerto = Number(m[2]);
  if (!isIP(host) || puerto < 1 || puerto > 65535) return null;
  return { host, puerto };
}

/** Invitación directa: `<código>@<dirección>:<puerto>`. El código va primero para que se reconozca. */
export function formarInvitacion(codigo: string, direccion: string, puerto: number): string {
  return `${codigo}@${hostPuerto(direccion, puerto)}`;
}

/**
 * Separa una invitación directa en código y destino. Devuelve null si el texto no tiene `@` (es un código del relé).
 * Nunca repite el código en un error: es el secreto.
 */
export function leerInvitacion(texto: string): { codigo: string; host: string; puerto: number } | null {
  const limpio = texto.trim();
  const arroba = limpio.lastIndexOf("@");
  if (arroba < 0) return null;
  const destinoTexto = limpio.slice(arroba + 1).trim();
  const destino = leerDestino(destinoTexto);
  if (!destino) {
    throw new ReglaError("invitacion_invalida", `la invitación termina en @<IP>:<puerto> (o @[IPv6]:<puerto>); después de la @ llegó «${destinoTexto.slice(0, 60)}»`);
  }
  return { codigo: limpio.slice(0, arroba), ...destino };
}

export interface OpcionesServidorDirecto {
  direccion: string;
  puerto: number;
  /** Qué atiende ahora ese buzón, o null si ninguno. */
  tipoDe(buzon: string): "codigo" | "dispositivo" | null;
  /** Atiende una conexión; true si la otra punta se identificó bien (el código o la clave fijada). */
  atender(tipo: "codigo" | "dispositivo", buzon: string, t: Transporte): Promise<boolean>;
  limite: LimiteIntentos;
  inactividadMs?: number;
}

export interface ServidorDirecto {
  puerto: number;
  cerrar(): Promise<void>;
}

/** Abre el servidor del modo directo; rechaza si no puede escuchar (la dirección no está o el puerto está ocupado). */
export async function abrirServidorDirecto(op: OpcionesServidorDirecto): Promise<ServidorDirecto> {
  const inactividadMs = op.inactividadMs ?? INACTIVIDAD_POR_DEFECTO_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: TOPE_MENSAJE_POR_DEFECTO, perMessageDeflate: false });
  const ipDe = (req: IncomingMessage) => req.socket.remoteAddress ?? null;
  // Sin upgrade no hay nada que servir: la API local no vive aquí. Cuenta como intento fallido.
  const servidor = createServer((req, res) => {
    const ip = ipDe(req);
    if (op.limite.limitada(ip)) return void res.writeHead(429, { "content-length": "0" }).end();
    op.limite.fallo(ip);
    res.writeHead(404, { "content-length": "0" }).end();
  });
  servidor.on("upgrade", (req: IncomingMessage, socket: Duplex, cabeza: Buffer) => {
    const ip = ipDe(req);
    if (op.limite.limitada(ip)) return rechazar(socket, 429, "Too Many Requests");
    const buzon = BUZON.exec((req.url ?? "").split("?")[0] ?? "")?.[1];
    const tipo = buzon ? op.tipoDe(buzon) : null;
    if (!buzon || !tipo) {
      op.limite.fallo(ip);
      return rechazar(socket, 404, "Not Found");
    }
    wss.handleUpgrade(req, socket, cabeza, (ws) => {
      let reloj = setTimeout(() => ws.close(1000, "inactivo"), inactividadMs);
      ws.on("message", (_datos, binario) => {
        if (!binario) return ws.close(1003, "solo binario");
        clearTimeout(reloj);
        reloj = setTimeout(() => ws.close(1000, "inactivo"), inactividadMs);
      });
      ws.on("close", () => clearTimeout(reloj));
      ws.on("error", () => ws.terminate());
      const t = transporteDe(ws);
      void op
        .atender(tipo, buzon, t)
        .then(
          (ok) => {
            if (!ok) op.limite.fallo(ip);
          },
          () => op.limite.fallo(ip),
        )
        .finally(() => t.cerrar());
    });
  });
  servidor.maxConnections = TOPE_CONEXIONES;
  await new Promise<void>((ok, mal) => {
    servidor.once("error", mal);
    servidor.listen(op.puerto, op.direccion, () => {
      servidor.off("error", mal);
      ok();
    });
  });
  return {
    puerto: (servidor.address() as AddressInfo).port,
    cerrar: () =>
      new Promise<void>((ok) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        servidor.closeAllConnections();
        servidor.close(() => ok());
      }),
  };
}

/** Motivo legible de un error al abrir el servidor. */
export function motivoDeEscucha(error: unknown, direccion: string, puerto: number): string {
  const codigo = (error as NodeJS.ErrnoException | null)?.code;
  if (codigo === "EADDRINUSE") return `el puerto ${puerto} está ocupado por otro programa`;
  if (codigo === "EADDRNOTAVAIL") return `esta PC no tiene ahora la dirección ${direccion}`;
  if (codigo === "EACCES") return `el sistema no deja escuchar en ${hostPuerto(direccion, puerto)}`;
  return `no se pudo escuchar en ${hostPuerto(direccion, puerto)}: ${(error as Error)?.message ?? String(error)}`;
}

function rechazar(socket: Duplex, estado: number, texto: string): void {
  socket.end(`HTTP/1.1 ${estado} ${texto}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
