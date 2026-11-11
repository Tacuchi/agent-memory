/**
 * El enlace remoto de una instalación, en sus dos papeles a la vez (AC-17):
 *
 * - **Dueña**: con el interruptor encendido y un relé configurado, escucha por el relé el buzón de cada dispositivo
 *   enlazado y el de cada código reciente; con el interruptor apagado no se conecta al relé. Por un enlace vigente
 *   responde solo `buscar`, `leer`, `listar` y `revisiones`, dentro del alcance del dispositivo, sin registrar uso; todo
 *   lo demás se rechaza. Cada lectura y cada rechazo quedan en el registro.
 * - **Lectora**: canjea un código por una credencial (buzón propio y clave fijada de la dueña) y pide lecturas bajo
 *   demanda. Cada pedido es una sesión nueva (handshake, un pedido, una respuesta en un solo mensaje): revocar o
 *   vencer corta en el pedido siguiente, y una respuesta que no llega es `sin_respuesta`, nunca un vacío. Lo leído
 *   no se guarda en ningún lado (P9).
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ESPERA_REMOTA_POR_DEFECTO_MS } from "../config.js";
import { transaction } from "../db/driver.js";
import { ReglaError, TIPOS, VALIDACIONES, AMBITOS } from "../domain/types.js";
import type { Buscador } from "../search/search.js";
import { clausulaFiltros, type Alcance } from "../store/filters.js";
import type { MemoryStore } from "../store/store.js";
import { desdeFila, type FilaEntrada } from "../store/rows.js";
import { vistaEntrada, vistaRelacion, vistaResultado, vistaRevision } from "../service/views.js";
import { abrirComoIniciador, abrirComoRespondedor, cargarIdentidad, ErrorCanal, type Identidad, type MotivoRechazo, type Transporte } from "./canal.js";
import { generarCodigo, leerCodigo } from "./codigo.js";
import { DatosRemotos, huellaDe, INTENTOS_CODIGO, type Dispositivo, type Enlace, type Pendiente } from "./datos.js";
import { conectarControl, conectarRele, ErrorRele, type CanalControl } from "./transporte.js";
import { version } from "../version.js";

const ESCUCHA_SIN_PLAZO_MS = 24 * 3600_000;
const REVISAR_ESCUCHAS_MS = 60_000;
/** Cada cuánto la PC repite su informe al relé (además de al conectar y ante un cambio). */
export const INFORME_CADA_MS = 30_000;
const ORDEN = z.object({ tipo: z.literal("orden"), id: z.string().min(1).max(40), accion: z.string().max(40), objetivo: z.string().max(200).nullable().optional(), datos: z.unknown().optional() }).passthrough();
const ALCANCE_PANEL = z.object({ ambitos: z.array(z.string().min(1).max(200)).max(50), pendientes: z.boolean() }).strict();
export const LECTURAS_REMOTAS = ["buscar", "leer", "listar", "revisiones"] as const;
export type LecturaRemota = (typeof LECTURAS_REMOTAS)[number];
export type EstadoEnlace = "ok" | "sin_respuesta" | "rechazado" | "version_incompatible";

/** Error de un pedido a un enlace: el estado que la lectora muestra en `enlaces`. */
export class ErrorEnlace extends ReglaError {
  constructor(
    readonly estado: Exclude<EstadoEnlace, "ok">,
    readonly origen: string,
    readonly motivo: string | null,
  ) {
    super(estado, mensajeEstado(estado, origen, motivo));
    this.name = "ErrorEnlace";
  }
}

function mensajeEstado(estado: string, origen: string, motivo: string | null): string {
  if (estado === "sin_respuesta") return `el enlace «${origen}» no respondió${motivo ? ` (${motivo})` : ""}`;
  if (estado === "version_incompatible") return `el enlace «${origen}» corre una versión incompatible`;
  return `el enlace «${origen}» rechazó el pedido${motivo ? ` (${motivo})` : ""}`;
}

export interface OpcionesRemoto {
  esperaMs?: number;
  env?: NodeJS.ProcessEnv;
}

const filtrosRemotos = z
  .object({
    ambito: z.enum(AMBITOS).optional(),
    tipos: z.array(z.enum(TIPOS)).optional(),
    validacion: z.array(z.enum(VALIDACIONES)).optional(),
    incluir_reemplazadas: z.boolean().optional(),
    incluir_vencidas: z.boolean().optional(),
    todos_los_ambitos: z.boolean().optional(),
  })
  .strict()
  .optional();
const limite = z.number().int().min(1).max(100).optional();
const id = z.number().int().positive();
/** Lo único que la dueña atiende. Los filtros se aceptan pero solo `tipos` cuenta: manda el alcance. */
const PEDIDO = z.discriminatedUnion("op", [
  z.object({ op: z.literal("buscar"), datos: z.object({ consulta: z.string().min(1).max(2000), filtros: filtrosRemotos, limite }).strict() }).strict(),
  z.object({ op: z.literal("leer"), datos: z.object({ id }).strict() }).strict(),
  z.object({ op: z.literal("listar"), datos: z.object({ filtros: filtrosRemotos, limite }).strict() }).strict(),
  z.object({ op: z.literal("revisiones"), datos: z.object({ id }).strict() }).strict(),
]);
const PEDIDO_ENLACE = z.object({ op: z.literal("enlazar"), dispositivo: z.string().trim().min(1).max(80) }).strict();
const NOMBRE_ORIGEN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

interface Escucha {
  activa: boolean;
  transporte: Transporte | null;
}

export class Remoto {
  readonly datos: DatosRemotos;
  private readonly identidad: Identidad;
  private readonly esperaMs: number;
  private readonly env: NodeJS.ProcessEnv;
  /** Secreto de cada código vivo, solo en memoria: la base guarda la huella. */
  private readonly secretos = new Map<string, Buffer>();
  private readonly escuchas = new Map<string, Escucha>();
  private readonly enCurso = new Map<string, Promise<unknown>>();
  private readonly revision: NodeJS.Timeout;
  private cerrado = false;
  /** Huella pública de esta PC ante el relé. */
  readonly huella: string;
  private control: { activa: boolean; canal: CanalControl | null } | null = null;
  private informeProgramado: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: MemoryStore,
    private readonly buscador: Buscador,
    opciones: OpcionesRemoto = {},
  ) {
    this.datos = new DatosRemotos(store.db, () => store.ahora());
    this.identidad = cargarIdentidad(this.datos.identidad());
    this.huella = huellaDe(this.identidad.publica);
    this.esperaMs = opciones.esperaMs ?? ESPERA_REMOTA_POR_DEFECTO_MS;
    this.env = opciones.env ?? process.env;
    this.revision = setInterval(() => this.reconciliar(), REVISAR_ESCUCHAS_MS);
    this.revision.unref();
  }

  cerrar(): void {
    this.cerrado = true;
    clearInterval(this.revision);
    for (const buzon of [...this.escuchas.keys()]) this.dejarDeEscuchar(buzon);
    this.dejarControl();
    if (this.informeProgramado) clearTimeout(this.informeProgramado);
  }

  /** Buzones que la dueña escucha ahora (para diagnóstico y pruebas). */
  escuchando(): string[] {
    return [...this.escuchas.keys()];
  }

  // ── Gobierno (la persona, desde la web) ──────────────────────────────────────

  estado() {
    const rele = this.datos.rele();
    const vigente = this.datos.codigoVigente();
    return {
      interruptor: this.datos.interruptor(),
      nombre_pc: this.datos.nombrePc(),
      panel: this.control?.canal ? "conectado" : this.control ? "conectando" : "inactivo",
      pendientes: this.datos.pendientes().map((p) => this.vistaPendiente(p)),
      rele: rele ? { url: rele.url } : null,
      codigo: vigente ? { vence_en: vigente.venceEn, intentos_restantes: INTENTOS_CODIGO - vigente.intentos } : null,
      dispositivos: this.datos.dispositivos().map((d) => this.vistaDispositivo(d)),
      enlaces: this.datos.enlaces().map((e) => ({ origen: e.origen, enlazado_en: e.creadoEn, vence_en: e.venceEn })),
    };
  }

  vistaPendiente(p: Pendiente) {
    const lectora = p.objetivo ? this.datos.dispositivos().find((d) => huellaDe(d.clavePublica) === p.objetivo) : undefined;
    return { id: p.id, accion: p.accion, dispositivo: lectora ? { id: lectora.id, nombre: lectora.nombre } : null, datos: p.datos, creado_en: p.creadoEn, estado: p.estado };
  }

  fijarNombrePc(nombre: string): string {
    const r = this.datos.fijarNombrePc(nombre);
    this.informar();
    return r;
  }

  /**
   * La persona acepta o rechaza un pedido del panel (D01). Aceptar aplica el cambio aquí, en la PC dueña; un código
   * aceptado se devuelve solo a la web local, nunca al relé (D04).
   */
  resolverPendiente(id: number, aceptar: boolean): { pendiente: ReturnType<Remoto["vistaPendiente"]>; codigo?: { codigo: string; vence_en: string } } {
    const p = this.datos.pendiente(id);
    if (p.estado !== "pendiente") throw new ReglaError("ya_resuelto", "ese pedido ya se resolvió");
    let codigo: { codigo: string; vence_en: string } | undefined;
    if (aceptar) {
      if (p.accion === "codigo") {
        if (!this.datos.interruptor()) throw new ReglaError("acceso_apagado", "encendé el acceso remoto antes de generar un código");
        codigo = this.nuevoCodigo();
      } else {
        const d = this.datos.dispositivos().find((x) => huellaDe(x.clavePublica) === p.objetivo);
        if (!d) throw new ReglaError("no_encontrado", "esa PC ya no está enlazada");
        if (p.accion === "renovar") this.datos.renovar(d.id);
        else this.datos.fijarAlcance(d.id, alcanceDesdePanel(p.datos));
      }
    }
    const resuelto = this.datos.resolverPendiente(id, aceptar ? "aceptado" : "rechazado");
    this.informar();
    return { pendiente: this.vistaPendiente(resuelto), ...(codigo ? { codigo } : {}) };
  }

  vistaDispositivo(d: Dispositivo) {
    return {
      id: d.id,
      nombre: d.nombre,
      enlazado_en: d.enlazadoEn,
      usado_en: d.usadoEn,
      vence_en: d.venceEn,
      revocado_en: d.revocadoEn,
      estado: this.datos.estadoDispositivo(d) ?? "vigente",
      alcance: { ambitos: d.alcance.ambitos, no_validadas: d.alcance.noValidadas },
    };
  }

  fijarInterruptor(encendido: boolean): void {
    this.datos.fijarInterruptor(encendido);
    this.reconciliar();
    this.informar();
  }

  /** Código nuevo de 10 minutos y 5 intentos. El texto solo se devuelve aquí, una vez. */
  nuevoCodigo(): { codigo: string; vence_en: string } {
    const c = generarCodigo();
    const fila = this.datos.crearCodigo(c.buzon, c.huella);
    this.secretos.set(c.buzon, c.secreto);
    this.reconciliar();
    return { codigo: c.texto, vence_en: fila.venceEn };
  }

  configurarRele(url: string, clave: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ReglaError("rele_invalido", "la URL del relé no es válida");
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "wss:" && !(u.protocol === "ws:" && loopback)) throw new ReglaError("rele_invalido", "el relé va por wss:// (ws:// solo en loopback)");
    if (clave.trim().length < 24) throw new ReglaError("rele_invalido", "la clave del relé tiene al menos 24 caracteres");
    this.datos.fijarRele({ url: `${u.protocol}//${u.host}`, clave: clave.trim() });
    for (const buzon of [...this.escuchas.keys()]) this.dejarDeEscuchar(buzon);
    this.reconciliar();
  }

  // ── Dueña: escuchar el relé ──────────────────────────────────────────────────

  /** Alinea las escuchas con el estado: nada con el interruptor apagado o sin relé. */
  reconciliar(): void {
    if (this.cerrado) return;
    const deseados = new Map<string, "codigo" | "dispositivo">();
    if (this.datos.interruptor() && this.datos.rele()) {
      for (const d of this.datos.dispositivos()) deseados.set(d.buzon, "dispositivo");
      for (const c of this.datos.codigosEscuchados()) deseados.set(c.buzon, "codigo");
    }
    for (const buzon of [...this.escuchas.keys()]) if (!deseados.has(buzon)) this.dejarDeEscuchar(buzon);
    for (const [buzon, tipo] of deseados) if (!this.escuchas.has(buzon)) this.escuchar(buzon, tipo);
    // El canal de control con el panel: con relé y algo que informar (acceso encendido o enlaces).
    const quiereControl = Boolean(this.datos.rele()) && (this.datos.interruptor() || this.datos.enlaces().length > 0);
    if (quiereControl && !this.control) this.abrirControl();
    if (!quiereControl && this.control) this.dejarControl();
    this.informar();
  }

  // ── Panel del relé: informe y órdenes (plan 007) ─────────────────────────────

  /** Metadatos para el panel: nunca contenido de la memoria ni el texto de un código (D04). */
  informe() {
    const vigente = this.datos.codigoVigente();
    return {
      tipo: "informe" as const,
      nombre: this.datos.nombrePc(),
      version: version(),
      acceso: this.datos.interruptor(),
      leen: this.datos.dispositivos().map((d) => ({
        huella: huellaDe(d.clavePublica),
        nombre: d.nombre,
        alcance: { ambitos: d.alcance.ambitos.map(textoAmbito), pendientes: d.alcance.noValidadas },
        vence: d.venceEn,
        usado: d.usadoEn,
        revocado: Boolean(d.revocadoEn),
      })),
      lee: this.datos.enlaces().map((e) => ({ origen: e.origen, duena: huellaDe(e.claveDuena), vence: e.venceEn, usado: e.usadoEn })),
      codigo: vigente ? { vence: vigente.venceEn } : null,
      uso: this.datos.uso(7),
      pendientes: this.datos.pendientes().map((p) => ({ id: p.id, accion: p.accion, objetivo: p.objetivo, creado: p.creadoEn })),
    };
  }

  /** Manda el informe ahora si el canal está abierto; si no, sale al conectar. */
  informar(): void {
    this.control?.canal?.enviar(this.informe());
  }

  /** Tras un cambio de uso: un solo informe en el próximo segundo, aunque haya muchas lecturas seguidas. */
  private informarPronto(): void {
    if (this.informeProgramado || !this.control?.canal) return;
    this.informeProgramado = setTimeout(() => {
      this.informeProgramado = null;
      this.informar();
    }, 1000);
    this.informeProgramado.unref();
  }

  private abrirControl(): void {
    const control: { activa: boolean; canal: CanalControl | null } = { activa: true, canal: null };
    this.control = control;
    void (async () => {
      let pausa = 250;
      while (control.activa && !this.cerrado) {
        const rele = this.datos.rele();
        if (!rele) break;
        let reloj: NodeJS.Timeout | undefined;
        try {
          const canal = await conectarControl({ url: rele.url, clave: rele.clave, pc: this.huella, env: this.env });
          if (!control.activa) {
            canal.cerrar();
            break;
          }
          control.canal = canal;
          pausa = 250;
          const cerrado = new Promise<void>((ok) => canal.alCerrar(ok));
          canal.alMensaje((m) => void this.atenderOrden(canal, m));
          canal.enviar(this.informe());
          reloj = setInterval(() => canal.enviar(this.informe()), INFORME_CADA_MS);
          reloj.unref();
          await cerrado;
        } catch {
          // relé caído, bloqueado o sin red: se reintenta con espera creciente
        } finally {
          clearInterval(reloj);
          control.canal = null;
        }
        if (!control.activa || this.cerrado) break;
        await new Promise((ok) => setTimeout(ok, pausa));
        pausa = Math.min(pausa * 2, 30_000);
      }
    })();
  }

  private dejarControl(): void {
    if (!this.control) return;
    this.control.activa = false;
    this.control.canal?.cerrar();
    this.control = null;
  }

  /**
   * Una orden del panel (D01): revocar y quitar enlace se cumplen aquí y quedan en el registro; renovar, alcance y
   * código quedan pendientes de la persona en la web local. El resultado vuelve al relé con el mismo id.
   */
  async atenderOrden(canal: CanalControl, mensaje: unknown): Promise<void> {
    const o = ORDEN.safeParse(mensaje);
    if (!o.success) return;
    const { id, accion, objetivo, datos } = o.data;
    const responder = (estado: "hecho" | "pendiente" | "error", texto?: string) => {
      canal.enviar({ tipo: "resultado", id, estado, ...(texto ? { mensaje: texto } : {}) });
      this.informar();
    };
    const lectora = typeof objetivo === "string" ? this.datos.dispositivos().find((d) => huellaDe(d.clavePublica) === objetivo) : undefined;
    try {
      switch (accion) {
        case "revocar": {
          if (!lectora) return responder("error", "esa PC no lee la memoria de esta");
          this.datos.revocar(lectora.id);
          this.datos.registrar({ dispositivoId: lectora.id, dispositivo: lectora.nombre, herramienta: "panel", pedido: null, ids: [], resultado: "rechazo", motivo: "revocado_desde_panel" });
          return responder("hecho", `${lectora.nombre} ya no puede leer esta memoria`);
        }
        case "quitar_enlace": {
          if (typeof objetivo !== "string" || !this.datos.quitarEnlace(objetivo)) return responder("error", "no hay un enlace con ese nombre");
          // Primero la respuesta: sin enlaces ni acceso, reconciliar cierra este mismo canal.
          responder("hecho", `enlace «${objetivo}» quitado`);
          this.reconciliar();
          return;
        }
        case "renovar":
          if (!lectora) return responder("error", "esa PC no lee la memoria de esta");
          this.datos.crearPendiente("renovar", objetivo as string);
          return responder("pendiente", `renovar ${lectora.nombre}: falta aceptarlo en la web de esta PC`);
        case "alcance": {
          if (!lectora) return responder("error", "esa PC no lee la memoria de esta");
          const alcance = ALCANCE_PANEL.safeParse(datos);
          if (!alcance.success) return responder("error", "alcance inválido");
          alcanceDesdePanel(alcance.data);
          this.datos.crearPendiente("alcance", objetivo as string, alcance.data);
          return responder("pendiente", `cambiar el alcance de ${lectora.nombre}: falta aceptarlo en la web de esta PC`);
        }
        case "codigo":
          this.datos.crearPendiente("codigo", null);
          return responder("pendiente", "código nuevo: falta aceptarlo en la web de esta PC, donde se verá");
        default:
          return responder("error", "orden desconocida");
      }
    } catch (error) {
      return responder("error", error instanceof ReglaError ? error.message : "no se pudo cumplir la orden");
    }
  }

  private dejarDeEscuchar(buzon: string): void {
    const e = this.escuchas.get(buzon);
    if (!e) return;
    e.activa = false;
    e.transporte?.cerrar();
    this.escuchas.delete(buzon);
  }

  private escuchar(buzon: string, tipo: "codigo" | "dispositivo"): void {
    const escucha: Escucha = { activa: true, transporte: null };
    this.escuchas.set(buzon, escucha);
    void (async () => {
      let pausa = 250;
      while (escucha.activa && !this.cerrado) {
        const rele = this.datos.rele();
        if (!rele) break;
        try {
          const t = await conectarRele({ url: rele.url, clave: rele.clave, buzon, env: this.env, pc: this.huella });
          if (!escucha.activa) {
            t.cerrar();
            break;
          }
          escucha.transporte = t;
          pausa = 250;
          await (tipo === "codigo" ? this.atenderCanje(t, buzon) : this.atenderEnlace(t, buzon));
        } catch {
          await new Promise((ok) => setTimeout(ok, pausa));
          pausa = Math.min(pausa * 2, 30_000);
        } finally {
          escucha.transporte?.cerrar();
          escucha.transporte = null;
        }
      }
    })();
  }

  private async atenderCanje(t: Transporte, buzon: string): Promise<void> {
    let codigoId: number | null = null;
    let sesion;
    try {
      sesion = await abrirComoRespondedor(t, {
        yo: this.identidad,
        modo: "emparejar",
        esperaPrimerMensajeMs: ESCUCHA_SIN_PLAZO_MS,
        esperaMs: this.esperaMs * 5,
        alLlegar: () => {
          const c = this.datos.codigoPorBuzon(buzon);
          const ahora = this.store.ahora().toISOString();
          const motivo: MotivoRechazo | null = !c
            ? "desconocido"
            : c.usadoEn
              ? "codigo_usado"
              : c.venceEn <= ahora
                ? "codigo_vencido"
                : c.intentos >= INTENTOS_CODIGO
                  ? "intentos_agotados"
                  : null;
          if (motivo || !c) {
            this.rechazo(null, "enlazar", null, motivo ?? "desconocido");
            return { rechazo: motivo ?? "desconocido" };
          }
          this.datos.sumarIntento(c.id);
          codigoId = c.id;
          const secreto = this.secretos.get(buzon);
          if (!secreto) {
            this.rechazo(null, "enlazar", null, "codigo_vencido");
            return { rechazo: "codigo_vencido" };
          }
          return { secreto };
        },
      });
    } catch (error) {
      // Con otro secreto, la lectora es la primera en ver la prueba inválida y corta: la dueña ve el corte. Todo
      // handshake de canje que no termina después de haber dado el secreto cuenta como secreto malo.
      const rechazadoAntes = error instanceof ErrorCanal && error.codigo === "rechazado";
      if (codigoId !== null && !rechazadoAntes) this.rechazo(null, "enlazar", null, "secreto_malo");
      return;
    }
    try {
      const pedido = PEDIDO_ENLACE.safeParse(await sesion.recibir(this.esperaMs * 5));
      if (!pedido.success || codigoId === null) {
        this.rechazo(null, "enlazar", null, "operacion_no_permitida");
        return sesion.enviar({ ok: false, error: { codigo: "operacion_no_permitida" } });
      }
      const nombre = pedido.data.dispositivo;
      const id = codigoId;
      const resultado = transaction(this.store.db, () => {
        if (!this.datos.usarCodigo(id)) return null;
        return this.datos.crearDispositivo(nombre, sesion.otro, randomBytes(16).toString("base64url"));
      });
      if (!resultado) {
        this.rechazo(null, "enlazar", null, "codigo_usado");
        return sesion.enviar({ ok: false, error: { codigo: "codigo_usado" } });
      }
      this.secretos.delete(buzon);
      this.datos.registrar({ dispositivoId: resultado.id, dispositivo: resultado.nombre, herramienta: "enlazar", pedido: null, ids: [], resultado: "lectura", motivo: null });
      sesion.enviar({ ok: true, enlace_id: resultado.id, buzon: resultado.buzon, vence_en: resultado.venceEn });
      this.reconciliar();
    } catch (error) {
      if (error instanceof ReglaError) sesion.enviar({ ok: false, error: { codigo: error.codigo } });
    } finally {
      sesion.cerrar();
    }
  }

  private async atenderEnlace(t: Transporte, buzon: string): Promise<void> {
    let dispositivo: Dispositivo | null = null;
    let sesion;
    try {
      sesion = await abrirComoRespondedor(t, {
        yo: this.identidad,
        modo: "enlace",
        esperaPrimerMensajeMs: ESCUCHA_SIN_PLAZO_MS,
        esperaMs: this.esperaMs * 5,
        aceptar: (estatica) => {
          dispositivo = this.datos.dispositivoPorBuzon(buzon);
          if (!dispositivo || estatica !== dispositivo.clavePublica) {
            this.rechazo(dispositivo, "conexion", null, "desconocido");
            return "desconocido";
          }
          const motivo = this.datos.estadoDispositivo(dispositivo);
          if (motivo) {
            this.rechazo(dispositivo, "conexion", null, motivo);
            return motivo;
          }
          return true;
        },
      });
    } catch {
      return;
    }
    try {
      const pedido = await sesion.recibir(this.esperaMs * 5);
      const respuesta = await this.atenderPedido(dispositivo as unknown as Dispositivo, pedido);
      sesion.enviar(respuesta);
      const ok = (respuesta as { ok?: unknown }).ok === true;
      this.datos.sumarUso(ok ? { recibidas: 1, bytes: Buffer.byteLength(JSON.stringify(respuesta)) } : { rechazos: 1 });
      this.informarPronto();
    } catch {
      // la lectora se fue o el canal se cortó: nada que responder
    } finally {
      sesion.cerrar();
    }
  }

  /**
   * Responde un pedido de un dispositivo: solo las cuatro lecturas, dentro de su alcance, sin registrar uso. Se
   * exporta para probar la dueña sin relé.
   */
  async atenderPedido(dispositivo: Dispositivo, pedido: unknown): Promise<unknown> {
    const actual = this.datos.dispositivo(dispositivo.id);
    const motivo = this.datos.estadoDispositivo(actual);
    if (motivo) {
      this.rechazo(actual, herramientaDe(pedido), null, motivo);
      return { ok: false, error: { codigo: motivo } };
    }
    const p = PEDIDO.safeParse(pedido);
    if (!p.success) {
      this.rechazo(actual, herramientaDe(pedido), resumirPedido(pedido), "operacion_no_permitida");
      return { ok: false, error: { codigo: "operacion_no_permitida" } };
    }
    this.datos.marcarUso(actual.id);
    const alcance = actual.alcance;
    const { op, datos } = p.data;
    const tipos = "filtros" in datos ? datos.filtros?.tipos : undefined;
    const registrar = (ids: number[], textoPedido: string) =>
      this.datos.registrar({ dispositivoId: actual.id, dispositivo: actual.nombre, herramienta: op, pedido: textoPedido, ids, resultado: "lectura", motivo: null });
    switch (op) {
      case "buscar": {
        const r = await this.buscador.buscar(datos.consulta, { filtros: { alcance, ...(tipos ? { tipos } : {}) }, limite: datos.limite ?? 10 });
        registrar(
          r.resultados.map((x) => x.entrada.id),
          JSON.stringify({ consulta: datos.consulta, ...(tipos ? { tipos } : {}) }),
        );
        return { ok: true, datos: { modo: r.modo, aviso: r.aviso, resultados: r.resultados.map(vistaResultado) } };
      }
      case "listar": {
        const entradas = this.store.listar({ alcance, ...(tipos ? { tipos } : {}) }, datos.limite ?? 50);
        registrar(
          entradas.map((e) => e.id),
          JSON.stringify(tipos ? { tipos } : {}),
        );
        return { ok: true, datos: { entradas: entradas.map((e) => vistaEntrada(e, false)) } };
      }
      case "leer":
      case "revisiones": {
        const visibles = this.enAlcance([datos.id], alcance);
        if (!visibles.has(datos.id)) {
          registrar([], JSON.stringify({ id: datos.id }));
          return { ok: false, error: { codigo: "no_encontrada" } };
        }
        registrar([datos.id], JSON.stringify({ id: datos.id }));
        if (op === "revisiones") return { ok: true, datos: { id: datos.id, revisiones: this.store.revisiones(datos.id).map(vistaRevision) } };
        const { entrada, relaciones } = this.store.leer(datos.id);
        const conAlcance = this.enAlcance(
          relaciones.map((r) => r.id),
          alcance,
        );
        return { ok: true, datos: { entrada: vistaEntrada(entrada), relaciones: relaciones.filter((r) => conAlcance.has(r.id)).map(vistaRelacion) } };
      }
    }
  }

  private enAlcance(ids: number[], alcance: Alcance): Set<number> {
    if (!ids.length) return new Set();
    const { sql, params } = clausulaFiltros({ alcance }, this.store.ahora());
    const filas = this.store.db
      .prepare(`SELECT e.* FROM entradas e WHERE ${sql} AND e.id IN (${ids.map(() => "?").join(",")})`)
      .all(...params, ...ids) as unknown as FilaEntrada[];
    return new Set(filas.map((f) => desdeFila(f).id));
  }

  private rechazo(d: Dispositivo | null, herramienta: string, pedido: string | null, motivo: string): void {
    this.datos.registrar({ dispositivoId: d?.id ?? null, dispositivo: d?.nombre ?? null, herramienta, pedido, ids: [], resultado: "rechazo", motivo });
  }

  // ── Lectora ──────────────────────────────────────────────────────────────────

  /** Canjea un código por una credencial de solo lectura y la guarda con el nombre de origen elegido. */
  async enlazar(codigoTexto: string, origen: string, dispositivo = hostname()): Promise<{ origen: string; vence_en: string }> {
    if (!NOMBRE_ORIGEN.test(origen)) throw new ReglaError("origen_invalido", "el nombre del enlace va en minúsculas, números, - y _ (hasta 40)");
    if (this.datos.enlace(origen)) throw new ReglaError("origen_repetido", `ya hay un enlace llamado «${origen}»`);
    let codigo;
    try {
      codigo = leerCodigo(codigoTexto);
    } catch (error) {
      throw new ReglaError("codigo_invalido", (error as Error).message);
    }
    const rele = this.datos.rele();
    if (!rele) throw new ReglaError("sin_rele", "falta configurar el relé: agent-memory remote relay <url>");
    let t: Transporte | null = null;
    try {
      t = await this.conectarLectora(rele, codigo.buzon, Date.now() + this.esperaMs * 5);
      const sesion = await abrirComoIniciador(t, { yo: this.identidad, secreto: codigo.secreto, esperaMs: this.esperaMs * 5 });
      sesion.enviar({ op: "enlazar", dispositivo: dispositivo.slice(0, 80) || "dispositivo" });
      const r = (await sesion.recibir(this.esperaMs * 5)) as { ok?: boolean; enlace_id?: number; buzon?: string; vence_en?: string; error?: { codigo?: string } };
      sesion.cerrar();
      if (!r.ok || typeof r.buzon !== "string" || typeof r.vence_en !== "string" || typeof r.enlace_id !== "number") {
        const motivo = typeof r.error?.codigo === "string" && /^[a-z_]{1,40}$/.test(r.error.codigo) ? r.error.codigo : "rechazado";
        throw new ReglaError(motivo, `la dueña rechazó el código (${motivo})`);
      }
      const enlace = this.datos.guardarEnlace({ origen, buzon: r.buzon, claveDuena: sesion.otro, enlaceId: r.enlace_id, venceEn: r.vence_en });
      this.reconciliar();
      return { origen: enlace.origen, vence_en: enlace.venceEn };
    } catch (error) {
      if (error instanceof ReglaError) throw error;
      if (error instanceof ErrorCanal && error.codigo === "rechazado") throw new ReglaError(error.motivo ?? "rechazado", `la dueña rechazó el código (${error.motivo ?? "rechazado"})`);
      if (error instanceof ErrorCanal && error.codigo === "prueba_invalida") throw new ReglaError("codigo_invalido", "el código no coincide");
      if (error instanceof ErrorCanal && error.codigo === "version_incompatible") throw new ReglaError("version_incompatible", "la otra instalación corre una versión incompatible");
      if (error instanceof ErrorRele) throw new ReglaError("sin_respuesta", error.message);
      throw new ReglaError("sin_respuesta", "la dueña no respondió: ¿tiene el acceso remoto encendido y el código vigente?");
    } finally {
      t?.cerrar();
    }
  }

  /**
   * Conecta al buzón como lectora. Un `buzon_ocupado` justo después de otro pedido es el relé que todavía no procesó
   * el cierre anterior: se reintenta dentro del plazo.
   */
  private async conectarLectora(rele: { url: string; clave: string }, buzon: string, limite: number): Promise<Transporte> {
    for (;;) {
      try {
        return await conectarRele({ url: rele.url, clave: rele.clave, buzon, env: this.env, esperaMs: Math.max(100, limite - Date.now()), pc: this.huella });
      } catch (error) {
        if (!(error instanceof ErrorRele && error.codigo === "buzon_ocupado") || Date.now() + 50 >= limite) throw error;
        await new Promise((ok) => setTimeout(ok, 50));
      }
    }
  }

  tieneEnlaces(): boolean {
    return this.datos.enlaces().length > 0;
  }

  /** Un pedido de lectura a un origen; el resultado llega marcado como dato externo. */
  async pedir(origen: string, op: LecturaRemota, datos: Record<string, unknown>): Promise<Record<string, unknown>> {
    const enlace = this.datos.enlace(origen);
    if (!enlace) throw new ReglaError("origen_desconocido", `no hay un enlace llamado «${origen}»`);
    const anterior = this.enCurso.get(origen) ?? Promise.resolve();
    const actual = anterior.catch(() => undefined).then(() => this.pedirAhora(enlace, op, datos));
    this.enCurso.set(origen, actual);
    try {
      return await actual;
    } finally {
      if (this.enCurso.get(origen) === actual) this.enCurso.delete(origen);
    }
  }

  /** Búsqueda en todos los enlaces en paralelo, con la espera corta; nunca falla: cada enlace dice su estado. */
  async buscarEnEnlaces(consulta: string, filtros: Record<string, unknown> | undefined, limite: number | undefined) {
    const enlaces = this.datos.enlaces();
    const respuestas = await Promise.all(
      enlaces.map(async (e) => {
        try {
          const r = await this.pedir(e.origen, "buscar", limpiar({ consulta, filtros, limite }));
          return { origen: e.origen, estado: "ok" as EstadoEnlace, motivo: null, resultados: (r.resultados as unknown[] | undefined) ?? [] };
        } catch (error) {
          const fallo = error instanceof ErrorEnlace ? error : new ErrorEnlace("sin_respuesta", e.origen, null);
          return { origen: e.origen, estado: fallo.estado as EstadoEnlace, motivo: fallo.motivo, resultados: [] };
        }
      }),
    );
    return {
      resultados: respuestas.flatMap((r) => r.resultados),
      enlaces: respuestas.map(({ origen, estado, motivo }) => ({ origen, estado, motivo })),
    };
  }

  private async pedirAhora(enlace: Enlace, op: LecturaRemota, datos: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rele = this.datos.rele();
    if (!rele) throw new ErrorEnlace("sin_respuesta", enlace.origen, "sin relé configurado");
    let t: Transporte | null = null;
    let reloj: NodeJS.Timeout | undefined;
    const vencido = new Promise<never>((_, mal) => {
      reloj = setTimeout(() => mal(new ErrorEnlace("sin_respuesta", enlace.origen, null)), this.esperaMs);
    });
    const trabajo = (async () => {
      t = await this.conectarLectora(rele, enlace.buzon, Date.now() + this.esperaMs);
      const sesion = await abrirComoIniciador(t, { yo: this.identidad, otro: enlace.claveDuena, esperaMs: this.esperaMs });
      sesion.enviar({ op, datos });
      const respuesta = await sesion.recibir(this.esperaMs);
      sesion.cerrar();
      return respuesta;
    })();
    try {
      const r = (await Promise.race([trabajo, vencido])) as { ok?: unknown; datos?: unknown; error?: { codigo?: unknown } } | null;
      if (r && r.ok === true && typeof r.datos === "object" && r.datos !== null) {
        this.datos.sumarUso({ hechas: 1, bytes: Buffer.byteLength(JSON.stringify(r.datos)) });
        this.datos.marcarUsoEnlace(enlace.origen);
        this.informarPronto();
        return marcarExterno(r.datos as Record<string, unknown>, enlace.origen);
      }
      const codigo = typeof r?.error?.codigo === "string" ? r.error.codigo : "error_remoto";
      if (codigo === "revocado" || codigo === "credencial_vencida") throw new ErrorEnlace("rechazado", enlace.origen, codigo);
      if (codigo === "no_encontrada") throw new ReglaError("no_encontrada", `no existe esa entrada en «${enlace.origen}» o no está compartida`);
      if (codigo === "operacion_no_permitida") throw new ReglaError("operacion_no_permitida", "el enlace es de solo lectura");
      throw new ErrorEnlace("rechazado", enlace.origen, "error_remoto");
    } catch (error) {
      if (error instanceof ReglaError) throw error;
      if (error instanceof ErrorCanal && error.codigo === "rechazado") throw new ErrorEnlace("rechazado", enlace.origen, error.motivo ?? null);
      if (error instanceof ErrorCanal && error.codigo === "version_incompatible") throw new ErrorEnlace("version_incompatible", enlace.origen, null);
      if (error instanceof ErrorRele && error.codigo === "clave_rele") throw new ErrorEnlace("sin_respuesta", enlace.origen, "el relé rechazó la clave");
      throw new ErrorEnlace("sin_respuesta", enlace.origen, null);
    } finally {
      clearTimeout(reloj);
      trabajo.catch(() => undefined);
      (t as Transporte | null)?.cerrar();
    }
  }
}

/**
 * Un ámbito del alcance como texto del panel: «global», la referencia del proyecto tal cual («proyecto:x») o
 * «repo:<ref>».
 */
function textoAmbito(a: Alcance["ambitos"][number]): string {
  if (a.ambito === "global") return "global";
  if (a.ambito === "proyecto") return a.ref ?? "proyecto";
  return `repo:${a.ref ?? ""}`;
}

/** Alcance en la forma del panel al de la base; lanza si un ámbito no es válido. */
function alcanceDesdePanel(datos: unknown): Alcance {
  const a = ALCANCE_PANEL.parse(datos);
  return {
    ambitos: a.ambitos.map((texto) => {
      if (texto === "global") return { ambito: "global" as const, ref: null };
      if (texto.startsWith("proyecto:") && texto.length > 9) return { ambito: "proyecto" as const, ref: texto };
      if (texto.startsWith("repo:") && texto.length > 5) return { ambito: "repo" as const, ref: texto.slice(5) };
      throw new ReglaError("ambito_invalido", `ámbito desconocido: ${texto}`);
    }),
    noValidadas: a.pendientes,
  };
}

/** Todo lo que viene de otra instalación lleva su origen y la marca de dato externo, en cada entrada. */
function marcarExterno(datos: Record<string, unknown>, origen: string): Record<string, unknown> {
  const marcar = (x: unknown) => (typeof x === "object" && x !== null && !Array.isArray(x) ? { ...(x as object), origen, dato_externo: true } : x);
  const r: Record<string, unknown> = { ...datos, origen, dato_externo: true };
  for (const clave of ["resultados", "entradas", "revisiones", "relaciones"]) {
    if (Array.isArray(datos[clave])) r[clave] = (datos[clave] as unknown[]).map(marcar);
  }
  if (datos.entrada !== undefined) r.entrada = marcar(datos.entrada);
  return r;
}

function herramientaDe(pedido: unknown): string {
  const op = typeof pedido === "object" && pedido !== null ? (pedido as { op?: unknown }).op : undefined;
  return typeof op === "string" ? op.replace(/[^a-z_]/g, "").slice(0, 40) || "desconocida" : "desconocida";
}

function resumirPedido(pedido: unknown): string | null {
  try {
    const texto = JSON.stringify((pedido as { datos?: unknown })?.datos ?? null);
    return texto.length > 500 ? `${texto.slice(0, 500)}…` : texto;
  } catch {
    return null;
  }
}

function limpiar<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
