import { z } from "zod";
import { ambitoPorDefecto } from "../context.js";
import { join, isAbsolute } from "node:path";
import { exportar } from "../export/export.js";
import { armarIndice } from "../indice/indice.js";
import { huella } from "../domain/draft.js";
import { validarTexto, validarTipo } from "../domain/rules.js";
import { AMBITOS, ReglaError, TIPOS, VALIDACIONES, type Actor, type Ambito, type Contexto } from "../domain/types.js";
import type { Buscador } from "../search/search.js";
import type { Filtros } from "../store/filters.js";
import type { MemoryStore, Umbrales } from "../store/store.js";
import { validarOrigen, type Remoto } from "../remoto/remoto.js";
import { vistaEntrada, vistaRelacion, vistaResultado, vistaRevision } from "./views.js";

// Operaciones de la memoria expuestas por el servicio. Las reglas viven una sola vez: aquí
// y en el almacén. MCP, CLI y web solo traducen a estas operaciones.

const id = z.number().int().positive();
const contextoObligatorio = z.object({ repo: z.string().min(1).nullable(), proyecto: z.string().min(1).nullable() }).strict();
const contexto = contextoObligatorio.optional();
const filtros = z
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
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "huella sha256 en hexadecimal");
/** Nombre de un enlace de lectura; `local` (o ausente) es esta instalación. */
const origen = z.string().min(1).max(40).optional();
const ambitoAlcance = z.object({ ambito: z.enum(AMBITOS), ref: z.string().min(1).nullable() }).strict();

const ESQUEMAS = {
  salud: z.object({}).strict(),
  buscar: z.object({ consulta: z.string(), contexto, filtros, limite }).strict(),
  leer: z.object({ id, origen }).strict(),
  listar: z.object({ contexto, filtros, limite, origen }).strict(),
  crear: z
    .object({
      tipo: z.string(),
      titulo: z.string(),
      contenido: z.string(),
      ambito: z.enum(AMBITOS).optional(),
      contexto,
      reemplaza_a: id.optional(),
      relacionadas: z.array(id).optional(),
      borrador: z.boolean().optional(),
      huella: sha256.optional(),
    })
    .strict(),
  editar: z
    .object({ id, titulo: z.string().optional(), contenido: z.string().optional(), borrador: z.boolean().optional(), huella: sha256.optional() })
    .strict(),
  revisiones: z.object({ id, origen }).strict(),
  restaurar: z.object({ id, numero: z.number().int().positive() }).strict(),
  caducar: z
    .object({ id, fecha: z.string().optional(), cerrar_trabajo: z.boolean().optional() })
    .strict(),
  revertir_caducidad: z.object({ id }).strict(),
  pendientes: z.object({ contexto, todos_los_ambitos: z.boolean().optional() }).strict(),
  aprobar: z.object({ id }).strict(),
  rechazar: z.object({ id, motivo: z.string().optional() }).strict(),
  cambiar_ambito: z.object({ id, ambito: z.enum(AMBITOS), ambito_ref: z.string().nullable().optional() }).strict(),
  relacionar: z.object({ origen: id, destino: id }).strict(),
  fusionar: z
    .object({
      ids: z.array(id).min(2).max(50),
      titulo: z.string(),
      contenido: z.string(),
      tipo: z.enum(TIPOS).optional(),
      ambito: z.enum(AMBITOS).optional(),
      ambito_ref: z.string().nullable().optional(),
    })
    .strict(),
  exportar: z.object({ completa: z.boolean().optional(), destino: z.string().min(1).optional() }).strict(),
  revision: z.object({}).strict(),
  confirmar_vigencia: z.object({ id }).strict(),
  indice: z.object({ contexto: contextoObligatorio, tope: z.number().int().min(200).max(100_000).optional() }).strict(),
  // Enlace remoto, gobierno de la dueña: solo la persona (SOLO_PERSONA).
  remoto_estado: z.object({}).strict(),
  remoto_interruptor: z.object({ encendido: z.boolean() }).strict(),
  remoto_codigo: z.object({ ambitos: z.array(ambitoAlcance).max(50).optional(), no_validadas: z.boolean().optional() }).strict(),
  remoto_revocar: z.object({ id }).strict(),
  remoto_renovar: z.object({ id }).strict(),
  remoto_alcance: z.object({ id, ambitos: z.array(ambitoAlcance).max(50), no_validadas: z.boolean() }).strict(),
  remoto_registro: z.object({ dispositivo_id: id.optional(), solo_rechazos: z.boolean().optional(), limite: z.number().int().min(1).max(1000).optional() }).strict(),
  // Panel del relé (plan 007): nombre de esta PC y pedidos del panel que amplían el acceso (D01).
  remoto_nombre: z.object({ nombre: z.string().min(1).max(200) }).strict(),
  remoto_pendiente: z.object({ id, aceptar: z.boolean() }).strict(),
  // Acceso remoto desde la web (plan 008): lo mismo que la CLI, sin escribir nombres, solo la persona.
  remoto_canjear: z.object({ codigo: z.string().min(1).max(100) }).strict(),
  remoto_enlace_quitar: z.object({ origen: z.string().min(1).max(40) }).strict(),
  remoto_enlace_renombrar: z.object({ origen: z.string().min(1).max(40), nuevo: z.string().min(1).max(40) }).strict(),
  remoto_rele: z.object({ url: z.string().min(1).max(500), clave: z.string().min(1).max(500) }).strict(),
  remoto_rele_probar: z.object({}).strict(),
  remoto_ambitos: z.object({}).strict(),
  // Enlace remoto desde la CLI (token): configurar el relé, canjear un código como lectora y ver el estado sin secretos.
  enlace_estado: z.object({}).strict(),
  enlace_rele: z.object({ url: z.string().min(1), clave: z.string().min(1) }).strict(),
  enlace_canjear: z.object({ codigo: z.string().min(1).max(100), origen: z.string().min(1).max(40).optional(), dispositivo: z.string().min(1).max(80).optional() }).strict(),
  // Quitar un enlace propio solo restringe (deja de leer ese origen): lo puede pedir la CLI.
  enlace_quitar: z.object({ origen: z.string().min(1).max(40) }).strict(),
} as const;

export type Operacion = keyof typeof ESQUEMAS;
export const OPERACIONES = Object.keys(ESQUEMAS) as Operacion[];

/** Operaciones que la persona hace desde la web (sesión del navegador), nunca el agente. */
const SOLO_PERSONA: ReadonlySet<Operacion> = new Set([
  "revertir_caducidad",
  "cambiar_ambito",
  "fusionar",
  "confirmar_vigencia",
  // Abrir la memoria a otra máquina es de la persona: ningún agente con el token puede hacerlo.
  "remoto_estado",
  "remoto_interruptor",
  "remoto_codigo",
  "remoto_revocar",
  "remoto_renovar",
  "remoto_alcance",
  "remoto_registro",
  "remoto_nombre",
  "remoto_pendiente",
  "remoto_canjear",
  "remoto_enlace_quitar",
  "remoto_enlace_renombrar",
  "remoto_rele",
  "remoto_rele_probar",
  "remoto_ambitos",
]);

export interface OpcionesApi {
  /** Tope del índice de inicio cuando el cliente no manda uno. */
  topeIndice?: number;
  /** Umbrales en días de la vista de revisión. */
  umbralesRevision?: Umbrales;
  /** Carpeta donde caen las exportaciones pedidas desde la web; por defecto, ninguna (hay que dar destino). */
  dirExportaciones?: string;
  /** Enlace remoto; sin él, `origen` y las operaciones remotas responden que no está disponible. */
  remoto?: Remoto;
}

export class Api {
  private readonly topeIndice: number;
  private readonly umbrales: Umbrales;
  private readonly dirExportaciones: string | null;
  private readonly remoto: Remoto | null;

  constructor(
    private readonly store: MemoryStore,
    private readonly buscador: Buscador,
    private readonly version: string,
    opciones: OpcionesApi = {},
  ) {
    this.topeIndice = opciones.topeIndice ?? 1500;
    this.umbrales = opciones.umbralesRevision ?? { diasSinUso: 90, diasSinVerificar: 180 };
    this.dirExportaciones = opciones.dirExportaciones ?? null;
    this.remoto = opciones.remoto ?? null;
  }

  private enlace(): Remoto {
    if (!this.remoto) throw new ReglaError("sin_enlace_remoto", "esta instalación no tiene el enlace remoto");
    return this.remoto;
  }

  esOperacion(nombre: string): nombre is Operacion {
    return Object.hasOwn(ESQUEMAS, nombre);
  }

  async ejecutar(op: Operacion, cuerpo: unknown, actor: Actor): Promise<unknown> {
    if (SOLO_PERSONA.has(op) && actor !== "persona") {
      throw new ReglaError("solo_persona", `«${op}» lo hace la persona desde la web, no el agente`);
    }
    const datos = ESQUEMAS[op].parse(cuerpo ?? {}) as never;
    return this[op](datos, actor);
  }

  private indice(d: z.infer<typeof ESQUEMAS.indice>) {
    const entradas = this.store.listar(aFiltros(undefined, d.contexto), 100_000);
    return armarIndice(entradas, d.tope ?? this.topeIndice);
  }

  private salud() {
    return {
      ok: true,
      version: this.version,
      modelo: this.store.modeloVectorial,
      vectores_pendientes: this.store.vectoresPendientes().length,
    };
  }

  /** Lo local primero; después, lo de cada enlace con su origen (los puntajes de bases distintas no se mezclan). */
  private async buscar(d: z.infer<typeof ESQUEMAS.buscar>, actor: Actor) {
    const remotos = this.remoto?.tieneEnlaces() ? this.remoto.buscarEnEnlaces(d.consulta, d.filtros, d.limite) : null;
    const r = await this.buscador.buscar(d.consulta, { filtros: aFiltros(d.filtros, d.contexto), limite: d.limite ?? 10 });
    if (actor === "agente") this.store.registrarUso(r.resultados.map((x) => x.entrada.id));
    const local = { modo: r.modo, aviso: r.aviso, resultados: r.resultados.map(vistaResultado) as unknown[] };
    if (!remotos) return local;
    const enlazados = await remotos;
    return { ...local, resultados: [...local.resultados, ...enlazados.resultados], enlaces: enlazados.enlaces };
  }

  private leer(d: z.infer<typeof ESQUEMAS.leer>, actor: Actor) {
    if (esRemoto(d.origen)) return this.enlace().pedir(d.origen, "leer", { id: d.id });
    const { entrada, relaciones } = this.store.leer(d.id);
    if (actor === "agente") this.store.registrarUso([d.id]);
    return { entrada: vistaEntrada(entrada), relaciones: relaciones.map(vistaRelacion) };
  }

  private listar(d: z.infer<typeof ESQUEMAS.listar>) {
    if (esRemoto(d.origen)) return this.enlace().pedir(d.origen, "listar", limpiarIndefinidos({ filtros: d.filtros, limite: d.limite }));
    return { entradas: this.store.listar(aFiltros(d.filtros, d.contexto), d.limite ?? 50).map((e) => vistaEntrada(e, false)) };
  }

  private async crear(d: z.infer<typeof ESQUEMAS.crear>, actor: Actor) {
    const tipo = validarTipo(d.tipo);
    const { ambito, ambitoRef } = resolverAmbito(d.ambito, d.contexto ?? { repo: null, proyecto: null }, tipo);
    const titulo = this.store.redactarTexto(validarTexto("titulo", d.titulo));
    const contenido = this.store.redactarTexto(validarTexto("contenido", d.contenido));
    const redactados = [...new Set([...titulo.redactados, ...contenido.redactados])];
    const canonico = {
      operacion: "crear",
      tipo,
      ambito,
      ambito_ref: ambitoRef,
      titulo: titulo.texto,
      contenido: contenido.texto,
      reemplaza_a: d.reemplaza_a ?? null,
    };
    if (d.borrador) return { borrador: canonico, huella: huella(canonico), redactados };
    const confirmado = this.verificarHuella(d.huella, canonico);
    const r = await this.store.crear(
      {
        tipo,
        titulo: titulo.texto,
        contenido: contenido.texto,
        ambito,
        ambitoRef,
        reemplazaA: d.reemplaza_a ?? null,
        relacionadas: d.relacionadas ?? [],
      },
      { actor, confirmado },
    );
    return { entrada: vistaEntrada(r.entrada), redactados };
  }

  private async editar(d: z.infer<typeof ESQUEMAS.editar>, actor: Actor) {
    const actual = this.store.obtener(d.id);
    const titulo = this.store.redactarTexto(d.titulo ?? actual.titulo);
    const contenido = this.store.redactarTexto(d.contenido ?? actual.contenido);
    const redactados = [...new Set([...titulo.redactados, ...contenido.redactados])];
    const canonico = { operacion: "editar", id: d.id, titulo: titulo.texto, contenido: contenido.texto };
    if (d.borrador) return { borrador: canonico, huella: huella(canonico), redactados };
    const confirmado = this.verificarHuella(d.huella, canonico);
    const r = await this.store.editar(d.id, { titulo: titulo.texto, contenido: contenido.texto }, { actor, confirmado });
    return { entrada: vistaEntrada(r.entrada), redactados };
  }

  private revisiones(d: z.infer<typeof ESQUEMAS.revisiones>) {
    if (esRemoto(d.origen)) return this.enlace().pedir(d.origen, "revisiones", { id: d.id });
    return { id: d.id, revisiones: this.store.revisiones(d.id).map(vistaRevision) };
  }

  private async restaurar(d: z.infer<typeof ESQUEMAS.restaurar>, actor: Actor) {
    const r = await this.store.restaurar(d.id, d.numero, { actor });
    return { entrada: vistaEntrada(r.entrada) };
  }

  private caducar(d: z.infer<typeof ESQUEMAS.caducar>, actor: Actor) {
    const opciones = { actor, ...(d.fecha ? { fecha: d.fecha } : {}), cerrarTrabajo: Boolean(d.cerrar_trabajo) };
    return { entrada: vistaEntrada(this.store.caducar(d.id, opciones)) };
  }

  private revertir_caducidad(d: z.infer<typeof ESQUEMAS.revertir_caducidad>) {
    return { entrada: vistaEntrada(this.store.revertirCaducidad(d.id)) };
  }

  private pendientes(d: z.infer<typeof ESQUEMAS.pendientes>) {
    const filtrosBandeja = d.contexto ? { contexto: d.contexto, todosLosAmbitos: Boolean(d.todos_los_ambitos) } : {};
    return {
      entradas: this.store.pendientes(filtrosBandeja).map((e) => ({
        ...vistaEntrada(e),
        reemplazaria: e.reemplazaA === null ? null : { id: e.reemplazaA, titulo: this.store.obtener(e.reemplazaA).titulo },
      })),
    };
  }

  private aprobar(d: z.infer<typeof ESQUEMAS.aprobar>, actor: Actor) {
    return { entrada: vistaEntrada(this.store.aprobar(d.id, actor === "persona" ? "web" : "mcp")) };
  }

  private rechazar(d: z.infer<typeof ESQUEMAS.rechazar>) {
    return { entrada: vistaEntrada(this.store.rechazar(d.id, d.motivo)) };
  }

  private cambiar_ambito(d: z.infer<typeof ESQUEMAS.cambiar_ambito>) {
    return { entrada: vistaEntrada(this.store.cambiarAmbito(d.id, d.ambito, d.ambito_ref ?? null)) };
  }

  private relacionar(d: z.infer<typeof ESQUEMAS.relacionar>) {
    return { relaciones: this.store.relacionar(d.origen, d.destino).map(vistaRelacion) };
  }

  private async fusionar(d: z.infer<typeof ESQUEMAS.fusionar>) {
    const r = await this.store.fusionar(d.ids, {
      titulo: d.titulo,
      contenido: d.contenido,
      ...(d.tipo ? { tipo: d.tipo } : {}),
      ...(d.ambito ? { ambito: d.ambito, ambitoRef: d.ambito_ref ?? null } : {}),
    });
    return { entrada: vistaEntrada(r.entrada), reemplazadas: d.ids, redactados: r.redactados };
  }

  /**
   * Exportación a markdown. La CLI elige la carpeta destino (absoluta, nueva o vacía); la
   * web no elige rutas: cae en una carpeta nueva con fecha bajo la de exportaciones.
   */
  private exportar(d: z.infer<typeof ESQUEMAS.exportar>, actor: Actor) {
    let destino: string;
    if (actor === "persona" || d.destino === undefined) {
      if (actor === "persona" && d.destino !== undefined) throw new ReglaError("destino_no_permitido", "la web no elige la carpeta: usá «agent-memory export --destino»");
      if (!this.dirExportaciones) throw new ReglaError("sin_destino", "falta la carpeta destino de la exportación");
      const sello = this.store.ahora().toISOString().replace(/[:.]/g, "-");
      destino = join(this.dirExportaciones, `${sello}${d.completa ? "-completa" : ""}`);
    } else {
      if (!isAbsolute(d.destino)) throw new ReglaError("destino_relativo", "el destino de la exportación tiene que ser una ruta absoluta");
      destino = d.destino;
    }
    return exportar(this.store, destino, { completa: Boolean(d.completa) });
  }

  private revision() {
    return {
      umbrales: { dias_sin_uso: this.umbrales.diasSinUso, dias_sin_verificar: this.umbrales.diasSinVerificar },
      entradas: this.store.paraRevisar(this.umbrales).map(({ entrada, motivos }) => ({
        ...vistaEntrada(entrada, false),
        motivos,
        usada_en: entrada.usadaEn,
        verificada_en: entrada.verificadaEn,
        validada_en: entrada.validadaEn,
      })),
    };
  }

  private confirmar_vigencia(d: z.infer<typeof ESQUEMAS.confirmar_vigencia>) {
    const e = this.store.confirmarVigencia(d.id);
    return { entrada: { ...vistaEntrada(e), verificada_en: e.verificadaEn } };
  }

  // ── Enlace remoto ────────────────────────────────────────────────────────────

  private remoto_estado() {
    return this.enlace().estado();
  }

  private remoto_interruptor(d: z.infer<typeof ESQUEMAS.remoto_interruptor>) {
    this.enlace().fijarInterruptor(d.encendido);
    return this.enlace().estado();
  }

  private remoto_codigo(d: z.infer<typeof ESQUEMAS.remoto_codigo>) {
    const r = this.enlace();
    if (!r.datos.interruptor()) throw new ReglaError("acceso_apagado", "encendé el acceso remoto antes de generar un código");
    const conAlcance = d.ambitos !== undefined || d.no_validadas !== undefined;
    return r.nuevoCodigo(conAlcance ? { ambitos: d.ambitos ?? [], noValidadas: Boolean(d.no_validadas) } : null);
  }

  private remoto_revocar(d: z.infer<typeof ESQUEMAS.remoto_revocar>) {
    const r = this.enlace();
    const dispositivo = r.vistaDispositivo(r.datos.revocar(d.id));
    r.informar();
    return { dispositivo };
  }

  private remoto_renovar(d: z.infer<typeof ESQUEMAS.remoto_renovar>) {
    const r = this.enlace();
    const dispositivo = r.vistaDispositivo(r.datos.renovar(d.id));
    r.informar();
    return { dispositivo };
  }

  private remoto_alcance(d: z.infer<typeof ESQUEMAS.remoto_alcance>) {
    const r = this.enlace();
    const dispositivo = r.vistaDispositivo(r.datos.fijarAlcance(d.id, { ambitos: d.ambitos, noValidadas: d.no_validadas }));
    r.informar();
    return { dispositivo };
  }

  private remoto_nombre(d: z.infer<typeof ESQUEMAS.remoto_nombre>) {
    this.enlace().fijarNombrePc(d.nombre);
    return this.enlace().estado();
  }

  private remoto_pendiente(d: z.infer<typeof ESQUEMAS.remoto_pendiente>) {
    return this.enlace().resolverPendiente(d.id, d.aceptar);
  }

  private remoto_canjear(d: z.infer<typeof ESQUEMAS.remoto_canjear>) {
    return this.enlace().enlazar(d.codigo);
  }

  private remoto_enlace_quitar(d: z.infer<typeof ESQUEMAS.remoto_enlace_quitar>) {
    return this.enlace_quitar(d);
  }

  private remoto_enlace_renombrar(d: z.infer<typeof ESQUEMAS.remoto_enlace_renombrar>) {
    const r = this.enlace();
    validarOrigen(d.nuevo);
    const enlace = r.datos.renombrarEnlace(d.origen, d.nuevo);
    r.informar();
    return { origen: enlace.origen };
  }

  private remoto_rele(d: z.infer<typeof ESQUEMAS.remoto_rele>) {
    return this.enlace_rele(d);
  }

  private remoto_rele_probar() {
    return this.enlace().probarRele();
  }

  /** Global, proyectos y repos de esta memoria con cuántas entradas compartibles tiene cada uno (D04). */
  private remoto_ambitos() {
    const filas = this.store.db
      .prepare(
        `SELECT ambito, ambito_ref AS ref, COUNT(*) AS entradas FROM entradas
         WHERE vida = 'activa' AND (validacion IS NULL OR validacion <> 'rechazada') GROUP BY ambito, ambito_ref`,
      )
      .all() as { ambito: "global" | "proyecto" | "repo"; ref: string | null; entradas: number }[];
    const orden = { global: 0, proyecto: 1, repo: 2 } as const;
    filas.sort((a, b) => orden[a.ambito] - orden[b.ambito] || (a.ref ?? "").localeCompare(b.ref ?? ""));
    return { ambitos: filas.map((f) => ({ ambito: f.ambito, ref: f.ambito === "global" ? null : f.ref, entradas: Number(f.entradas) })) };
  }

  private remoto_registro(d: z.infer<typeof ESQUEMAS.remoto_registro>) {
    const registro = this.enlace().datos.registro({
      ...(d.dispositivo_id !== undefined ? { dispositivoId: d.dispositivo_id } : {}),
      soloRechazos: Boolean(d.solo_rechazos),
      ...(d.limite !== undefined ? { limite: d.limite } : {}),
    });
    return {
      registro: registro.map((x) => ({
        id: x.id,
        fecha: x.fecha,
        dispositivo_id: x.dispositivoId,
        dispositivo: x.dispositivo,
        herramienta: x.herramienta,
        pedido: x.pedido,
        ids: x.ids,
        resultado: x.resultado,
        motivo: x.motivo,
      })),
    };
  }

  /** Estado sin secretos ni códigos: para `agent-memory remote status`. */
  private enlace_estado() {
    const e = this.enlace().estado();
    return {
      interruptor: e.interruptor,
      rele: e.rele,
      escuchando: this.enlace().escuchando().length,
      codigo_vigente: e.codigo !== null,
      dispositivos: e.dispositivos.map((d) => ({ nombre: d.nombre, estado: d.estado, vence_en: d.vence_en })),
      enlaces: e.enlaces,
    };
  }

  private enlace_rele(d: z.infer<typeof ESQUEMAS.enlace_rele>) {
    this.enlace().configurarRele(d.url, d.clave);
    return { rele: this.enlace().estado().rele };
  }

  private enlace_canjear(d: z.infer<typeof ESQUEMAS.enlace_canjear>) {
    return this.enlace().enlazar(d.codigo, d.origen, d.dispositivo);
  }

  private enlace_quitar(d: z.infer<typeof ESQUEMAS.enlace_quitar>) {
    const r = this.enlace();
    if (!r.datos.quitarEnlace(d.origen)) throw new ReglaError("origen_desconocido", `no hay un enlace llamado «${d.origen}»`);
    r.reconciliar();
    r.informar();
    return { quitado: d.origen };
  }

  /** Sin huella, la entrada no cuenta como confirmada; una huella distinta se rechaza. */
  private verificarHuella(recibida: string | undefined, canonico: Record<string, string | number | null>): boolean {
    if (recibida === undefined) return false;
    if (recibida !== huella(canonico)) {
      throw new ReglaError(
        "huella_distinta",
        "el borrador cambió desde que la persona lo confirmó: mostrá el borrador nuevo y pedí otra confirmación, o guardalo sin huella como pendiente",
      );
    }
    return true;
  }
}

function resolverAmbito(ambito: Ambito | undefined, ctx: Contexto, tipo: string): { ambito: Ambito; ambitoRef: string | null } {
  if (!ambito) return ambitoPorDefecto(ctx, tipo);
  if (ambito === "global") return { ambito, ambitoRef: null };
  const ref = ambito === "repo" ? ctx.repo : ctx.proyecto;
  if (!ref) throw new ReglaError("ambito_sin_contexto", `no hay un ${ambito} en el directorio de trabajo para el ámbito «${ambito}»`);
  return { ambito, ambitoRef: ref };
}

function aFiltros(f: z.infer<typeof filtros>, ctx: Contexto | undefined): Filtros {
  return {
    ...(ctx ? { contexto: ctx } : {}),
    ...(f?.ambito ? { ambito: f.ambito } : {}),
    ...(f?.tipos ? { tipos: f.tipos } : {}),
    ...(f?.validacion ? { validacion: f.validacion } : {}),
    incluirReemplazadas: Boolean(f?.incluir_reemplazadas),
    incluirVencidas: Boolean(f?.incluir_vencidas),
    todosLosAmbitos: Boolean(f?.todos_los_ambitos),
  };
}

function esRemoto(origen: string | undefined): origen is string {
  return origen !== undefined && origen !== "local";
}

function limpiarIndefinidos(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
