import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, transaction, vectorBlob, type Database } from "../db/driver.js";
import { DIMENSIONES, migrar } from "../db/schema.js";
import { redactar, PATRONES_POR_DEFECTO, type PatronSecreto } from "../domain/redact.js";
import * as reglas from "../domain/rules.js";
import {
  ReglaError,
  type Actor,
  type Ambito,
  type Entrada,
  type Relacion,
  type Revision,
  type Via,
} from "../domain/types.js";
import { clausulaFiltros, type Filtros } from "./filters.js";
import { COLUMNAS_VERSIONADAS, aParametros, desdeFila, instantanea, type FilaEntrada } from "./rows.js";

/** Calcula el embedding de un texto. Lo implementa la búsqueda (F2); sin él, el vector queda faltante. */
export interface Embedder {
  readonly modelId: string;
  readonly dims: number;
  embedPassage(texto: string): Promise<Float32Array>;
}

export interface OpcionesStore {
  embedder?: Embedder | null;
  patronesSecretos?: readonly PatronSecreto[];
  reloj?: () => Date;
}

export interface NuevaEntrada {
  tipo: string;
  titulo: string;
  contenido: string;
  ambito: Ambito;
  ambitoRef: string | null;
  /** Entrada que esta reemplaza (AC-08); con el agente y lo validado, solo al aprobarse (AC-23). */
  reemplazaA?: number | null;
  relacionadas?: number[];
}

/** Lo que la persona elige para la entrada resultante de una fusión; tipo y ámbito, por defecto, los de la primera. */
export interface Fusion {
  titulo: string;
  contenido: string;
  tipo?: string;
  ambito?: Ambito;
  ambitoRef?: string | null;
}

export interface Origen {
  actor: Actor;
  confirmado?: boolean;
}

export interface ResultadoEscritura {
  entrada: Entrada;
  /** Tipos de secreto redactados antes de guardar, sin el valor (AC-26). */
  redactados: string[];
}

export interface Lectura {
  entrada: Entrada;
  relaciones: Relacion[];
}

/**
 * Almacén de la memoria sobre un único archivo SQLite (AC-01): entradas, revisiones, relaciones,
 * FTS5 por triggers y la proyección vectorial en la misma transacción que la entrada.
 */
export class MemoryStore {
  readonly db: Database;
  private readonly embedder: Embedder | null;
  private readonly patrones: readonly PatronSecreto[];
  private readonly reloj: () => Date;

  constructor(db: Database, opciones: OpcionesStore = {}) {
    this.db = db;
    this.embedder = opciones.embedder ?? null;
    this.patrones = opciones.patronesSecretos ?? PATRONES_POR_DEFECTO;
    this.reloj = opciones.reloj ?? (() => new Date());
    migrar(db);
  }

  static abrir(dbPath: string, opciones: OpcionesStore = {}): MemoryStore {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    return new MemoryStore(openDatabase(dbPath), opciones);
  }

  get modeloVectorial(): { modelId: string; dims: number } | null {
    return this.embedder ? { modelId: this.embedder.modelId, dims: this.embedder.dims } : null;
  }

  ahora(): Date {
    return this.reloj();
  }

  /** La misma redacción que se aplica al guardar: para armar un borrador con su huella. */
  redactarTexto(texto: string): { texto: string; redactados: string[] } {
    return this.redactarCampo(texto);
  }

  close(): void {
    this.db.close();
  }

  // ── Escritura ────────────────────────────────────────────────────────────────

  async crear(nueva: NuevaEntrada, origen: Origen): Promise<ResultadoEscritura> {
    const tipo = reglas.validarTipo(nueva.tipo);
    const titulo = this.redactarCampo(reglas.validarTexto("titulo", nueva.titulo));
    const contenido = this.redactarCampo(reglas.validarTexto("contenido", nueva.contenido));
    const ambito = reglas.validarAmbito(nueva.ambito);
    const ambitoRef = ambito === "global" ? null : nueva.ambitoRef;
    if (ambito !== "global" && !ambitoRef) {
      throw new ReglaError("ambito_sin_ref", `el ámbito ${ambito} necesita la referencia del ${ambito}`);
    }
    const reemplazaA = nueva.reemplazaA ?? null;
    if (reemplazaA !== null) this.exigirActiva(reemplazaA, "reemplazar");
    for (const id of nueva.relacionadas ?? []) this.obtener(id);

    const vector = await this.vectorizar(titulo.texto, contenido.texto);
    const ahora = this.reloj();
    const marca = ahora.toISOString();
    const base: Omit<Entrada, "id"> = {
      tipo,
      titulo: titulo.texto,
      contenido: contenido.texto,
      ambito,
      ambitoRef,
      vida: "activa",
      vigenciaHasta: null,
      reemplazadaPor: null,
      reemplazaA,
      ...reglas.validacionInicial(tipo, origen),
      motivoRechazo: null,
      caducidad: null,
      creadaEn: marca,
      actualizadaEn: marca,
      validadaEn: null,
      usadaEn: null,
      usos: 0,
      verificadaEn: null,
    };
    if (base.validacion === "validada") base.validadaEn = marca;

    const entrada = transaction(this.db, () => {
      const id = this.insertar(base);
      const creada = this.obtener(id);
      this.registrarRevision(creada, "crear", origen.actor);
      this.escribirVector(id, vector);
      for (const destino of nueva.relacionadas ?? []) this.insertarRelacion(id, destino);
      this.aplicarReemplazo(creada, ahora, origen.actor);
      return this.obtener(id);
    });
    return { entrada, redactados: unir(titulo.redactados, contenido.redactados) };
  }

  async editar(id: number, cambios: reglas.CambiosContenido, origen: Origen): Promise<ResultadoEscritura> {
    const actual = this.obtener(id);
    const titulo = cambios.titulo === undefined ? undefined : this.redactarCampo(cambios.titulo);
    const contenido = cambios.contenido === undefined ? undefined : this.redactarCampo(cambios.contenido);
    const ahora = this.reloj();
    const editada = reglas.aplicarEdicion(
      actual,
      { titulo: titulo?.texto, contenido: contenido?.texto },
      origen,
      ahora,
    );
    const vector = await this.vectorizar(editada.titulo, editada.contenido);
    const entrada = transaction(this.db, () => {
      this.exigirSinCambiosConcurrentes(actual);
      this.guardar(editada, "editar", origen.actor);
      this.escribirVector(id, vector);
      this.aplicarReemplazo(editada, ahora, origen.actor);
      return this.obtener(id);
    });
    return { entrada, redactados: unir(titulo?.redactados ?? [], contenido?.redactados ?? []) };
  }

  /** Restaurar crea una revisión nueva con el contenido de la elegida; no borra ninguna (AC-05, S-05). */
  async restaurar(id: number, numero: number, origen: Origen): Promise<ResultadoEscritura> {
    const revision = this.revisiones(id).find((r) => r.numero === numero);
    if (!revision) throw new ReglaError("revision_no_encontrada", `la entrada ${id} no tiene la revisión ${numero}`);
    const actual = this.obtener(id);
    const ahora = this.reloj();
    const restaurada = reglas.aplicarEdicion(
      actual,
      { titulo: revision.instantanea.titulo, contenido: revision.instantanea.contenido },
      origen,
      ahora,
    );
    const vector = await this.vectorizar(restaurada.titulo, restaurada.contenido);
    const entrada = transaction(this.db, () => {
      this.exigirSinCambiosConcurrentes(actual);
      this.guardar(restaurada, `restaurar:${numero}`, origen.actor);
      this.escribirVector(id, vector);
      return this.obtener(id);
    });
    return { entrada, redactados: [] };
  }

  /**
   * Fusión hecha por la persona (AC-12): la resultante nace validada por la web (o sin validación si
   * es de proyecto) y cada original queda reemplazada por ella, relacionada y con su historia intacta.
   */
  async fusionar(ids: readonly number[], fusion: Fusion): Promise<ResultadoEscritura> {
    const unicos = [...new Set(ids)];
    if (unicos.length < 2) throw new ReglaError("fusion_invalida", "una fusión necesita al menos dos entradas distintas");
    const originales = unicos.map((id) => this.obtener(id));
    for (const o of originales) this.exigirActiva(o.id, "fusionar");
    const primera = originales[0] as Entrada;
    const tipo = reglas.validarTipo(fusion.tipo ?? primera.tipo);
    const ambito = reglas.validarAmbito(fusion.ambito ?? primera.ambito);
    const ambitoRef = ambito === "global" ? null : (fusion.ambito === undefined ? primera.ambitoRef : (fusion.ambitoRef ?? "").trim() || null);
    if (ambito !== "global" && !ambitoRef) {
      throw new ReglaError("ambito_sin_ref", `el ámbito ${ambito} necesita la referencia del ${ambito}`);
    }
    const titulo = this.redactarCampo(reglas.validarTexto("titulo", fusion.titulo));
    const contenido = this.redactarCampo(reglas.validarTexto("contenido", fusion.contenido));
    const vector = await this.vectorizar(titulo.texto, contenido.texto);
    const ahora = this.reloj();
    const marca = ahora.toISOString();
    const base: Omit<Entrada, "id"> = {
      tipo,
      titulo: titulo.texto,
      contenido: contenido.texto,
      ambito,
      ambitoRef,
      vida: "activa",
      vigenciaHasta: null,
      reemplazadaPor: null,
      reemplazaA: null,
      ...reglas.validacionInicial(tipo, { actor: "persona" }),
      motivoRechazo: null,
      caducidad: null,
      creadaEn: marca,
      actualizadaEn: marca,
      validadaEn: reglas.validacionInicial(tipo, { actor: "persona" }).validacion === "validada" ? marca : null,
      usadaEn: null,
      usos: 0,
      verificadaEn: null,
    };
    const entrada = transaction(this.db, () => {
      for (const o of originales) this.exigirSinCambiosConcurrentes(o);
      const id = this.insertar(base);
      this.registrarRevision(this.obtener(id), `fusionar:${unicos.join(",")}`, "persona");
      this.escribirVector(id, vector);
      for (const o of originales) {
        this.guardar(reglas.marcarReemplazada(this.obtener(o.id), id, ahora), `fusionada_en:${id}`, "persona");
        this.insertarRelacion(id, o.id);
      }
      return this.obtener(id);
    });
    return { entrada, redactados: unir(titulo.redactados, contenido.redactados) };
  }

  aprobar(id: number, via: Via): Entrada {
    return transaction(this.db, () => {
      const ahora = this.reloj();
      const aprobada = reglas.aprobar(this.obtener(id), via, ahora);
      this.guardar(aprobada, `aprobar:${via}`, via === "web" ? "persona" : "agente");
      this.aplicarReemplazo(aprobada, ahora, "persona");
      return this.obtener(id);
    });
  }

  rechazar(id: number, motivo: string | undefined): Entrada {
    return transaction(this.db, () => {
      const rechazada = reglas.rechazar(this.obtener(id), motivo, this.reloj());
      this.guardar(rechazada, "rechazar", "persona");
      return this.obtener(id);
    });
  }

  caducar(id: number, opciones: reglas.OpcionesCaducar): Entrada {
    return transaction(this.db, () => {
      const caducada = reglas.caducar(this.obtener(id), opciones, this.reloj());
      this.guardar(caducada, opciones.cerrarTrabajo ? "cerrar_trabajo" : "caducar", opciones.actor);
      return this.obtener(id);
    });
  }

  revertirCaducidad(id: number): Entrada {
    return transaction(this.db, () => {
      const revertida = reglas.revertirCaducidad(this.obtener(id), this.reloj());
      this.guardar(revertida, "revertir_caducidad", "persona");
      return this.obtener(id);
    });
  }

  cambiarAmbito(id: number, ambito: string, ambitoRef: string | null): Entrada {
    return transaction(this.db, () => {
      const movida = reglas.cambiarAmbito(this.obtener(id), ambito, ambitoRef, this.reloj());
      this.guardar(movida, "cambiar_ambito", "persona");
      return this.obtener(id);
    });
  }

  relacionar(origenId: number, destinoId: number): Relacion[] {
    return transaction(this.db, () => {
      this.obtener(origenId);
      this.obtener(destinoId);
      this.insertarRelacion(origenId, destinoId);
      return this.relaciones(origenId);
    });
  }

  /**
   * La persona confirma en la vista de revisión que la entrada sigue vigente (AC-25, S-11): queda la
   * fecha en la entrada y una revisión, sin cambiar contenido ni estados.
   */
  confirmarVigencia(id: number): Entrada {
    return transaction(this.db, () => {
      const actual = this.obtener(id);
      if (actual.vida !== "activa" || reglas.estaVencida(actual, this.reloj())) {
        throw new ReglaError("no_activa", `la entrada ${id} no está activa y vigente: no hay vigencia que confirmar`);
      }
      const marca = this.reloj().toISOString();
      this.db.prepare("UPDATE entradas SET verificada_en = ? WHERE id = ?").run(marca, id);
      this.registrarRevision({ ...actual, actualizadaEn: marca }, "confirmar_vigencia", "persona");
      return this.obtener(id);
    });
  }

  /**
   * Vista de revisión (AC-25): activas y vigentes sin uso hace `diasSinUso` o sin verificar hace
   * `diasSinVerificar`. Solo lista: nada vence por antigüedad.
   */
  paraRevisar(umbrales: Umbrales): { entrada: Entrada; motivos: MotivoRevision[] }[] {
    const ahora = this.reloj();
    const antes = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000).toISOString();
    const limiteUso = antes(umbrales.diasSinUso);
    const limiteVerificacion = antes(umbrales.diasSinVerificar);
    const r: { entrada: Entrada; motivos: MotivoRevision[] }[] = [];
    for (const e of this.listar({ validacion: ["pendiente", "validada"] }, 100_000)) {
      const motivos: MotivoRevision[] = [];
      const ultimoUso = maximo(e.usadaEn, e.verificadaEn, e.creadaEn);
      if (ultimoUso < limiteUso) motivos.push("sin_uso");
      if (e.validacion !== null && maximo(e.verificadaEn, e.validadaEn, e.creadaEn) < limiteVerificacion) motivos.push("sin_verificar");
      if (motivos.length) r.push({ entrada: e, motivos });
    }
    return r.sort((a, b) => a.entrada.id - b.entrada.id);
  }

  /** Uso = el agente la lee en detalle o la recibe en una búsqueda (S-11). */
  registrarUso(ids: readonly number[]): void {
    if (!ids.length) return;
    const marca = this.reloj().toISOString();
    const stmt = this.db.prepare("UPDATE entradas SET usos = usos + 1, usada_en = ? WHERE id = ?");
    transaction(this.db, () => {
      for (const id of new Set(ids)) stmt.run(marca, id);
    });
  }

  // ── Lectura ──────────────────────────────────────────────────────────────────

  obtener(id: number): Entrada {
    const fila = this.db.prepare("SELECT * FROM entradas WHERE id = ?").get(id) as FilaEntrada | undefined;
    if (!fila) throw new ReglaError("no_encontrada", `no existe la entrada ${id}`);
    return desdeFila(fila);
  }

  leer(id: number): Lectura {
    return { entrada: this.obtener(id), relaciones: this.relaciones(id) };
  }

  listar(filtros: Filtros = {}, limite = 50): Entrada[] {
    const { sql, params } = clausulaFiltros(filtros, this.reloj());
    const filas = this.db
      .prepare(`SELECT e.* FROM entradas e WHERE ${sql} ORDER BY e.actualizada_en DESC, e.id DESC LIMIT ?`)
      .all(...params, limite) as unknown as FilaEntrada[];
    return filas.map(desdeFila);
  }

  /** Bandeja: el conocimiento pendiente y activo, con el reemplazo que propone (AC-07, AC-23). */
  pendientes(filtros: Pick<Filtros, "contexto" | "todosLosAmbitos"> = {}): Entrada[] {
    return this.listar({ ...filtros, validacion: ["pendiente"], incluirVencidas: true }, 500).filter(
      (e) => e.validacion === "pendiente",
    );
  }

  revisiones(id: number): Revision[] {
    this.obtener(id);
    const filas = this.db
      .prepare("SELECT * FROM revisiones WHERE entrada_id = ? ORDER BY numero")
      .all(id) as { entrada_id: number; numero: number; accion: string; actor: string; instantanea: string; creada_en: string }[];
    return filas.map((f) => ({
      entradaId: f.entrada_id,
      numero: f.numero,
      accion: f.accion,
      actor: f.actor as Actor,
      instantanea: JSON.parse(f.instantanea) as Revision["instantanea"],
      creadaEn: f.creada_en,
    }));
  }

  /** Relaciones en ambos sentidos con el estado de cada entrada relacionada (AC-31). */
  relaciones(id: number): Relacion[] {
    const filas = this.db
      .prepare(
        `SELECT e.*, 'saliente' AS sentido FROM relaciones r JOIN entradas e ON e.id = r.destino_id WHERE r.origen_id = ?
         UNION ALL
         SELECT e.*, 'entrante' AS sentido FROM relaciones r JOIN entradas e ON e.id = r.origen_id WHERE r.destino_id = ?
         ORDER BY id`,
      )
      .all(id, id) as unknown as (FilaEntrada & { sentido: Relacion["sentido"] })[];
    return filas.map((f) => ({
      id: f.id,
      titulo: f.titulo,
      tipo: f.tipo as Relacion["tipo"],
      vida: f.vida as Relacion["vida"],
      vigenciaHasta: f.vigencia_hasta,
      validacion: f.validacion as Relacion["validacion"],
      sentido: f.sentido,
    }));
  }

  // ── Proyección vectorial ─────────────────────────────────────────────────────

  /** Ids cuyo vector falta o es de otro modelo: los que hay que regenerar al arrancar (T2.3). */
  vectoresPendientes(): number[] {
    const modelo = this.embedder?.modelId ?? null;
    const filas = this.db
      .prepare(
        `SELECT e.id FROM entradas e LEFT JOIN vectores v ON v.entrada_id = e.id
         WHERE v.entrada_id IS NULL OR v.estado <> 'ok' OR v.model_id IS NOT ? ORDER BY e.id`,
      )
      .all(modelo) as { id: number }[];
    return filas.map((f) => f.id);
  }

  /** Regenera los vectores faltantes o de otro modelo; devuelve cuántos escribió. */
  async regenerarVectores(): Promise<number> {
    if (!this.embedder) return 0;
    let escritos = 0;
    for (const id of this.vectoresPendientes()) {
      const e = this.obtener(id);
      const vector = await this.vectorizar(e.titulo, e.contenido);
      if (!vector) break;
      transaction(this.db, () => {
        const vigente = this.obtener(id);
        if (vigente.titulo === e.titulo && vigente.contenido === e.contenido) this.escribirVector(id, vector);
      });
      escritos++;
    }
    return escritos;
  }

  // ── Internos ─────────────────────────────────────────────────────────────────

  private async vectorizar(titulo: string, contenido: string): Promise<Float32Array | null> {
    if (!this.embedder) return null;
    try {
      const vector = await this.embedder.embedPassage(`${titulo}\n${contenido}`);
      if (vector.length !== DIMENSIONES) {
        throw new Error(`el modelo devolvió ${vector.length} dimensiones; se esperan ${DIMENSIONES}`);
      }
      return vector;
    } catch {
      // Sin modelo la entrada se guarda igual con su vector marcado como faltante (T2.3).
      return null;
    }
  }

  private escribirVector(id: number, vector: Float32Array | null): void {
    const marca = this.reloj().toISOString();
    this.db.prepare("DELETE FROM entradas_vec WHERE rowid = ?").run(BigInt(id));
    if (vector && this.embedder) {
      this.db.prepare("INSERT INTO entradas_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), vectorBlob(vector));
      this.db
        .prepare(
          `INSERT INTO vectores (entrada_id, estado, model_id, dims, actualizado_en) VALUES (?, 'ok', ?, ?, ?)
           ON CONFLICT(entrada_id) DO UPDATE SET estado = 'ok', model_id = excluded.model_id, dims = excluded.dims, actualizado_en = excluded.actualizado_en`,
        )
        .run(id, this.embedder.modelId, vector.length, marca);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO vectores (entrada_id, estado, model_id, dims, actualizado_en) VALUES (?, 'faltante', NULL, NULL, ?)
         ON CONFLICT(entrada_id) DO UPDATE SET estado = 'faltante', model_id = NULL, dims = NULL, actualizado_en = excluded.actualizado_en`,
      )
      .run(id, marca);
  }

  private insertar(base: Omit<Entrada, "id">): number {
    const cols = COLUMNAS_VERSIONADAS;
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO entradas (${cols.join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})`)
      .run(aParametros(base));
    return Number(lastInsertRowid);
  }

  private guardar(entrada: Entrada, accion: string, actor: Actor): void {
    const params = aParametros(entrada);
    const asignaciones = COLUMNAS_VERSIONADAS.map((c) => `${c} = :${c}`).join(", ");
    this.db.prepare(`UPDATE entradas SET ${asignaciones} WHERE id = :id`).run({ ...params, id: entrada.id });
    this.registrarRevision(entrada, accion, actor);
  }

  private registrarRevision(entrada: Entrada, accion: string, actor: Actor): void {
    const { n } = this.db
      .prepare("SELECT coalesce(max(numero), 0) + 1 AS n FROM revisiones WHERE entrada_id = ?")
      .get(entrada.id) as { n: number };
    this.db
      .prepare("INSERT INTO revisiones (entrada_id, numero, accion, actor, instantanea, creada_en) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entrada.id, n, accion, actor, JSON.stringify(instantanea(entrada)), entrada.actualizadaEn);
  }

  /** Si la entrada ya cuenta, la que reemplaza queda reemplazada (AC-08). */
  private aplicarReemplazo(entrada: Entrada, ahora: Date, actor: Actor): void {
    if (!reglas.reemplazoSurteEfecto(entrada) || entrada.reemplazaA === null) return;
    const original = this.obtener(entrada.reemplazaA);
    if (original.vida !== "activa") return;
    this.guardar(reglas.marcarReemplazada(original, entrada.id, ahora), `reemplazada_por:${entrada.id}`, actor);
  }

  private insertarRelacion(origenId: number, destinoId: number): void {
    if (origenId === destinoId) throw new ReglaError("relacion_invalida", "una entrada no se relaciona consigo misma");
    this.db
      .prepare("INSERT OR IGNORE INTO relaciones (origen_id, destino_id, creada_en) VALUES (?, ?, ?)")
      .run(origenId, destinoId, this.reloj().toISOString());
  }

  private exigirActiva(id: number, accion: string): void {
    const e = this.obtener(id);
    if (e.vida !== "activa") throw new ReglaError("no_activa", `no se puede ${accion} la entrada ${id}: está ${e.vida}`);
  }

  /** El embedding se calcula fuera de la transacción: si la fila cambió entretanto, se rechaza. */
  private exigirSinCambiosConcurrentes(leida: Entrada): void {
    const vigente = this.obtener(leida.id);
    if (vigente.actualizadaEn !== leida.actualizadaEn) {
      throw new ReglaError("conflicto", `la entrada ${leida.id} cambió mientras se editaba; volvé a intentarlo`);
    }
  }

  private redactarCampo(texto: string): { texto: string; redactados: string[] } {
    return redactar(texto, this.patrones);
  }
}

export interface Umbrales {
  diasSinUso: number;
  diasSinVerificar: number;
}

export type MotivoRevision = "sin_uso" | "sin_verificar";

function maximo(...fechas: (string | null)[]): string {
  return fechas.filter((f): f is string => f !== null).sort().at(-1) ?? "";
}

function unir(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
