import { z } from "zod";
import type { Exclusion } from "../config.js";
import { ambitoPorDefecto } from "../context.js";
import { contextoExcluido, errorExcluido } from "../exclusion.js";
import { armarIndice } from "../indice/indice.js";
import { huella } from "../domain/draft.js";
import { validarTexto, validarTipo } from "../domain/rules.js";
import { AMBITOS, ReglaError, TIPOS, VALIDACIONES, type Actor, type Ambito, type Contexto } from "../domain/types.js";
import type { Buscador } from "../search/search.js";
import type { Filtros } from "../store/filters.js";
import type { MemoryStore } from "../store/store.js";
import { vistaEntrada, vistaRelacion, vistaResultado, vistaRevision } from "./views.js";

// Operaciones de la memoria expuestas por el servicio (T3.2). Las reglas viven una sola vez: aquí
// y en el almacén. MCP, CLI y web solo traducen a estas operaciones.

const id = z.number().int().positive();
const contextoObligatorio = z
  .object({ repo: z.string().min(1).nullable(), proyecto: z.string().min(1).nullable(), ruta: z.string().min(1).nullable().optional() })
  .strict();
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

const ESQUEMAS = {
  salud: z.object({}).strict(),
  buscar: z.object({ consulta: z.string(), contexto, filtros, limite }).strict(),
  leer: z.object({ id }).strict(),
  listar: z.object({ contexto, filtros, limite }).strict(),
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
  revisiones: z.object({ id }).strict(),
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
  indice: z.object({ contexto: contextoObligatorio, tope: z.number().int().min(200).max(100_000).optional() }).strict(),
} as const;

export type Operacion = keyof typeof ESQUEMAS;
export const OPERACIONES = Object.keys(ESQUEMAS) as Operacion[];

/** Operaciones que la persona hace desde la web (sesión del navegador), nunca el agente. */
const SOLO_PERSONA: ReadonlySet<Operacion> = new Set(["revertir_caducidad", "cambiar_ambito"]);

export interface OpcionesApi {
  /** Patrones de repos excluidos (AC-20), o cómo leerlos en cada petición; por defecto, ninguno. */
  exclusion?: Exclusion | (() => Exclusion);
  /** Tope del índice de inicio cuando el cliente no manda uno. */
  topeIndice?: number;
}

export class Api {
  private readonly exclusion: () => Exclusion;
  private readonly topeIndice: number;

  constructor(
    private readonly store: MemoryStore,
    private readonly buscador: Buscador,
    private readonly version: string,
    opciones: OpcionesApi = {},
  ) {
    const exclusion = opciones.exclusion ?? { patrones: [], excepciones: [] };
    this.exclusion = typeof exclusion === "function" ? exclusion : () => exclusion;
    this.topeIndice = opciones.topeIndice ?? 1500;
  }

  esOperacion(nombre: string): nombre is Operacion {
    return Object.hasOwn(ESQUEMAS, nombre);
  }

  async ejecutar(op: Operacion, cuerpo: unknown, actor: Actor): Promise<unknown> {
    if (SOLO_PERSONA.has(op) && actor !== "persona") {
      throw new ReglaError("solo_persona", `«${op}» lo hace la persona desde la web, no el agente`);
    }
    const datos = ESQUEMAS[op].parse(this.sinContextoAjeno(op, cuerpo, actor)) as never;
    return this[op](datos, actor);
  }

  /**
   * Toda operación del agente acepta el contexto del cliente: si es un repo excluido (AC-20), no se
   * guarda ni se devuelve nada. Las operaciones que no lo usan lo reciben solo para este control.
   */
  private sinContextoAjeno(op: Operacion, cuerpo: unknown, actor: Actor): unknown {
    const datos = (cuerpo ?? {}) as Record<string, unknown>;
    if (typeof datos !== "object" || Array.isArray(datos) || !("contexto" in datos)) return datos;
    const ctx = contextoObligatorio.parse(datos.contexto);
    if (actor === "agente" && contextoExcluido(ctx, this.exclusion())) throw errorExcluido();
    if ("contexto" in ESQUEMAS[op].shape) return datos;
    const { contexto: _usado, ...resto } = datos;
    return resto;
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

  private async buscar(d: z.infer<typeof ESQUEMAS.buscar>, actor: Actor) {
    const r = await this.buscador.buscar(d.consulta, { filtros: aFiltros(d.filtros, d.contexto), limite: d.limite ?? 10 });
    if (actor === "agente") this.store.registrarUso(r.resultados.map((x) => x.entrada.id));
    return { modo: r.modo, aviso: r.aviso, resultados: r.resultados.map(vistaResultado) };
  }

  private leer(d: z.infer<typeof ESQUEMAS.leer>, actor: Actor) {
    const { entrada, relaciones } = this.store.leer(d.id);
    if (actor === "agente") this.store.registrarUso([d.id]);
    return { entrada: vistaEntrada(entrada), relaciones: relaciones.map(vistaRelacion) };
  }

  private listar(d: z.infer<typeof ESQUEMAS.listar>) {
    return { entradas: this.store.listar(aFiltros(d.filtros, d.contexto), d.limite ?? 50).map((e) => vistaEntrada(e, false)) };
  }

  private async crear(d: z.infer<typeof ESQUEMAS.crear>, actor: Actor) {
    const tipo = validarTipo(d.tipo);
    const { ambito, ambitoRef } = resolverAmbito(d.ambito, d.contexto ?? { repo: null, proyecto: null });
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

  /** Sin huella, la entrada no cuenta como confirmada; una huella distinta se rechaza (AC-16). */
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

function resolverAmbito(ambito: Ambito | undefined, ctx: Contexto): { ambito: Ambito; ambitoRef: string | null } {
  if (!ambito) return ambitoPorDefecto(ctx);
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
