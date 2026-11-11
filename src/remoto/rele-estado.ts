/**
 * Estado del relé para su panel (plan 007), solo en memoria: un redeploy lo borra y las PCs lo reconstruyen con su
 * siguiente informe.
 *
 * - PCs: cada instalación 0.3.0 se presenta con su huella (cabecera `x-agent-memory-pc`) y por el canal `/pc` manda un
 *   informe de metadatos (nombre, enlaces, alcance, vencimientos, uso). Nunca contenido de la memoria ni códigos.
 * - Conexiones de buzón atribuidas a su PC; las de una PC 0.2.0 (sin cabecera) se agrupan por IP como «sin informe».
 * - IPs que fallan la clave del relé (ventana de 1 h) y bloqueos de PC o de IP con vencimiento.
 * - Órdenes del panel hacia una PC por su canal de control, con respuesta o tiempo agotado.
 */
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { z } from "zod";

const VENTANA_RECHAZOS_MS = 3600_000;
const ESPERA_ORDEN_MS = 5_000;
const TOPE_IPS = 1000;

const corto = z.string().max(200);
const fecha = z.string().max(40).nullable();
export const INFORME = z
  .object({
    tipo: z.literal("informe"),
    nombre: z.string().trim().min(1).max(60),
    version: z.string().max(40),
    acceso: z.boolean(),
    leen: z
      .array(
        z.object({
          huella: z.string().max(40),
          nombre: corto,
          alcance: z.object({ ambitos: z.array(corto).max(50), pendientes: z.boolean() }),
          vence: fecha,
          usado: fecha,
          revocado: z.boolean(),
        }),
      )
      .max(100),
    lee: z.array(z.object({ origen: corto, duena: z.string().max(40), vence: fecha, usado: fecha })).max(100),
    codigo: z.object({ vence: z.string().max(40) }).nullable(),
    uso: z
      .array(
        z.object({
          dia: z.string().max(10),
          recibidas: z.number().int().min(0),
          hechas: z.number().int().min(0),
          bytes: z.number().int().min(0),
          rechazos: z.number().int().min(0),
        }),
      )
      .max(31),
    pendientes: z.array(z.object({ id: z.number().int(), accion: corto, objetivo: z.string().max(200).nullable(), creado: z.string().max(40) })).max(100),
  })
  .strip();
export type Informe = z.infer<typeof INFORME>;

export const DURACIONES = { "1h": 3600_000, "24h": 24 * 3600_000, indefinido: null } as const;
export type Duracion = keyof typeof DURACIONES;

interface Pc {
  huella: string;
  informe: Informe | null;
  visto: number;
  ip: string | null;
  control: WebSocket | null;
}

interface Conexion {
  pc: string | null;
  ip: string | null;
  buzon: string;
  bytes: number;
  ultimo: number;
  par: () => boolean;
}

interface Rechazos {
  marcas: number[];
}

export interface ResultadoOrden {
  estado: "hecho" | "pendiente" | "error";
  mensaje?: string;
}

export class EstadoRele {
  private readonly encendido = Date.now();
  private readonly pcs = new Map<string, Pc>();
  private readonly conexiones = new Map<WebSocket, Conexion>();
  private readonly rechazos = new Map<string, Rechazos>();
  private readonly bloqueos = new Map<string, number | null>();
  private readonly ordenes = new Map<string, (r: ResultadoOrden) => void>();

  constructor(private readonly ahora: () => number = Date.now) {}

  // ── Conexiones ───────────────────────────────────────────────────────────────

  /** La PC abre su canal de control; reemplaza uno anterior de la misma huella. */
  abrirControl(huella: string, ip: string | null, ws: WebSocket): void {
    const pc = this.pc(huella);
    if (pc.control && pc.control !== ws) pc.control.close(1000, "reemplazado");
    pc.control = ws;
    pc.ip = ip;
    pc.visto = this.ahora();
  }

  cerrarControl(huella: string, ws: WebSocket): void {
    const pc = this.pcs.get(huella);
    if (pc?.control === ws) {
      pc.control = null;
      pc.visto = this.ahora();
    }
  }

  /** Mensaje de texto por el canal de control: informe o resultado de una orden. Lo demás se ignora. */
  mensajeControl(huella: string, texto: string): void {
    let mensaje: unknown;
    try {
      mensaje = JSON.parse(texto);
    } catch {
      return;
    }
    const pc = this.pc(huella);
    pc.visto = this.ahora();
    const tipo = (mensaje as { tipo?: unknown })?.tipo;
    if (tipo === "informe") {
      const r = INFORME.safeParse(mensaje);
      if (r.success) pc.informe = r.data;
    } else if (tipo === "resultado") {
      const { id, estado, mensaje: texto2 } = mensaje as { id?: unknown; estado?: unknown; mensaje?: unknown };
      const fin = typeof id === "string" ? this.ordenes.get(id) : undefined;
      if (fin && (estado === "hecho" || estado === "pendiente" || estado === "error")) {
        this.ordenes.delete(id as string);
        fin({ estado, ...(typeof texto2 === "string" ? { mensaje: texto2.slice(0, 300) } : {}) });
      }
    }
  }

  abrirConexion(ws: WebSocket, c: Omit<Conexion, "bytes" | "ultimo">): void {
    this.conexiones.set(ws, { ...c, bytes: 0, ultimo: this.ahora() });
    if (c.pc) {
      const pc = this.pc(c.pc);
      pc.visto = this.ahora();
      pc.ip = c.ip ?? pc.ip;
    }
  }

  trafico(ws: WebSocket, bytes: number): void {
    const c = this.conexiones.get(ws);
    if (!c) return;
    c.bytes += bytes;
    c.ultimo = this.ahora();
  }

  cerrarConexion(ws: WebSocket): void {
    const c = this.conexiones.get(ws);
    this.conexiones.delete(ws);
    if (c?.pc) {
      const pc = this.pcs.get(c.pc);
      if (pc) pc.visto = this.ahora();
    }
  }

  // ── Rechazos y bloqueos ──────────────────────────────────────────────────────

  rechazo(ip: string | null): void {
    if (!ip) return;
    const ahora = this.ahora();
    const r = this.rechazos.get(ip) ?? { marcas: [] };
    r.marcas = r.marcas.filter((m) => ahora - m < VENTANA_RECHAZOS_MS);
    r.marcas.push(ahora);
    this.rechazos.delete(ip);
    this.rechazos.set(ip, r);
    while (this.rechazos.size > TOPE_IPS) this.rechazos.delete(this.rechazos.keys().next().value as string);
  }

  bloqueado(pc: string | null, ip: string | null): boolean {
    return (pc !== null && this.vigente(`pc:${pc}`)) || (ip !== null && this.vigente(`ip:${ip}`));
  }

  private vigente(clave: string): boolean {
    if (!this.bloqueos.has(clave)) return false;
    const hasta = this.bloqueos.get(clave) ?? null;
    if (hasta !== null && hasta <= this.ahora()) {
      this.bloqueos.delete(clave);
      return false;
    }
    return true;
  }

  bloquear(objetivo: { pc: string } | { ip: string }, duracion: Duracion): void {
    const ms = DURACIONES[duracion];
    const clave = "pc" in objetivo ? `pc:${objetivo.pc}` : `ip:${objetivo.ip}`;
    this.bloqueos.set(clave, ms === null ? null : this.ahora() + ms);
    if ("pc" in objetivo) this.cerrarPc(objetivo.pc);
    else this.cerrarPor((c) => c.ip === objetivo.ip, (pc) => pc.ip === objetivo.ip);
  }

  desbloquear(objetivo: { pc: string } | { ip: string }): boolean {
    return this.bloqueos.delete("pc" in objetivo ? `pc:${objetivo.pc}` : `ip:${objetivo.ip}`);
  }

  // ── Acciones ─────────────────────────────────────────────────────────────────

  /** Cierra las conexiones de una PC (buzones y control): la PC vuelve a conectarse sola. */
  cerrarPc(huella: string): number {
    if (huella.startsWith("ip-")) {
      const ip = huella.slice(3);
      return this.cerrarPor((c) => c.pc === null && c.ip === ip, () => false);
    }
    return this.cerrarPor((c) => c.pc === huella, (pc) => pc.huella === huella);
  }

  cerrarTodo(): number {
    return this.cerrarPor(() => true, () => true);
  }

  private cerrarPor(conexion: (c: Conexion) => boolean, control: (pc: Pc) => boolean): number {
    let n = 0;
    for (const [ws, c] of [...this.conexiones]) {
      if (conexion(c)) {
        ws.close(1000, "cerrado desde el panel");
        n++;
      }
    }
    for (const pc of this.pcs.values()) {
      if (pc.control && control(pc)) {
        pc.control.close(1000, "cerrado desde el panel");
        pc.control = null;
        pc.visto = this.ahora();
        n++;
      }
    }
    return n;
  }

  /** Manda una orden a una PC por su canal de control y espera su resultado. */
  ordenar(huella: string, orden: { accion: string; objetivo?: string | null; datos?: unknown }): Promise<ResultadoOrden> {
    const pc = this.pcs.get(huella);
    if (!pc?.control) return Promise.resolve({ estado: "error", mensaje: "esa PC no está conectada al relé ahora" });
    const id = randomBytes(9).toString("base64url");
    const control = pc.control;
    return new Promise((ok) => {
      const reloj = setTimeout(() => {
        this.ordenes.delete(id);
        ok({ estado: "error", mensaje: "la PC no respondió a tiempo" });
      }, ESPERA_ORDEN_MS);
      this.ordenes.set(id, (r) => {
        clearTimeout(reloj);
        ok(r);
      });
      control.send(JSON.stringify({ tipo: "orden", id, accion: orden.accion, objetivo: orden.objetivo ?? null, datos: orden.datos ?? null }));
    });
  }

  conectada(huella: string): boolean {
    return Boolean(this.pcs.get(huella)?.control);
  }

  // ── Vista para el panel ──────────────────────────────────────────────────────

  vista(version: string, tope: number) {
    const ahora = this.ahora();
    const iso = (t: number) => new Date(t).toISOString();
    const conexionesDe = (filtro: (c: Conexion) => boolean) =>
      [...this.conexiones.values()].filter(filtro).map((c) => ({
        buzon: `${c.buzon.slice(0, 4)}…${c.buzon.slice(-4)}`,
        estado: c.par() ? "emparejado" : "esperando",
        bytes: c.bytes,
        inactivo_s: Math.round((ahora - c.ultimo) / 1000),
      }));
    const pcs = [...this.pcs.values()].map((pc) => {
      const i = pc.informe;
      return {
        huella: pc.huella,
        nombre: i?.nombre ?? `PC ${pc.huella.slice(0, 6)}`,
        version: i?.version ?? null,
        en_linea: pc.control !== null,
        visto: iso(pc.visto),
        ip: pc.ip,
        informe: i !== null,
        acceso: i?.acceso ?? false,
        leen: i?.leen ?? [],
        lee: i?.lee ?? [],
        codigo: i?.codigo ?? null,
        conexiones: conexionesDe((c) => c.pc === pc.huella),
        uso: i?.uso ?? [],
        pendientes: i?.pendientes ?? [],
      };
    });
    // PCs 0.2.0: sin cabecera ni informe, agrupadas por IP.
    const sinInforme = new Map<string, number>();
    for (const c of this.conexiones.values()) if (c.pc === null && c.ip) sinInforme.set(c.ip, (sinInforme.get(c.ip) ?? 0) + 1);
    for (const ip of sinInforme.keys()) {
      pcs.push({
        huella: `ip-${ip}`,
        nombre: `PC sin informe (${ip})`,
        version: null,
        en_linea: true,
        visto: iso(ahora),
        ip,
        informe: false,
        acceso: false,
        leen: [],
        lee: [],
        codigo: null,
        conexiones: conexionesDe((c) => c.pc === null && c.ip === ip),
        uso: [],
        pendientes: [],
      });
    }
    const desconocidas = [...this.rechazos]
      .map(([ip, r]) => ({ ip, marcas: r.marcas.filter((m) => ahora - m < VENTANA_RECHAZOS_MS) }))
      .filter((r) => r.marcas.length > 0)
      .map((r) => ({ ip: r.ip, rechazos: r.marcas.length, primera: iso(r.marcas[0] as number), ultima: iso(r.marcas.at(-1) as number) }))
      .sort((a, b) => b.rechazos - a.rechazos);
    const bloqueos = [...this.bloqueos.keys()]
      .filter((k) => this.vigente(k))
      .map((k) => {
        const hasta = this.bloqueos.get(k) ?? null;
        return { tipo: k.startsWith("pc:") ? ("pc" as const) : ("ip" as const), valor: k.slice(3), hasta: hasta === null ? null : iso(hasta) };
      });
    return {
      rele: { version, encendido_desde: iso(this.encendido), conexiones: this.conexiones.size, tope },
      pcs: pcs.sort((a, b) => Number(b.en_linea) - Number(a.en_linea) || a.nombre.localeCompare(b.nombre)),
      desconocidas,
      bloqueos,
    };
  }

  private pc(huella: string): Pc {
    let pc = this.pcs.get(huella);
    if (!pc) {
      pc = { huella, informe: null, visto: this.ahora(), ip: null, control: null };
      this.pcs.set(huella, pc);
    }
    return pc;
  }
}
