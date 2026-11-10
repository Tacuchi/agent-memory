import { vectorBlob } from "../db/driver.js";
import { ReglaError, type Entrada } from "../domain/types.js";
import { clausulaFiltros, type Filtros } from "../store/filters.js";
import type { MemoryStore } from "../store/store.js";
import { EmbeddingsDefectuosos } from "./autochequeo.js";
import { terminos } from "./stopwords.js";

/** Embedder capaz de vectorizar una consulta (con su propio prefijo, si el modelo lo usa). */
export interface EmbedderConsulta {
  readonly modelId: string;
  embedQuery(texto: string): Promise<Float32Array>;
}

export type Modo = "hibrido" | "texto";

/** Cómo se presenta una entrada al agente por defecto. */
export type Marca = "validada" | "pendiente" | "rechazada" | "estado de trabajo";

export interface Resultado {
  entrada: Entrada;
  marca: Marca;
  /** Puntaje de la fusión por rango recíproco. */
  puntaje: number;
  rangoTexto: number | null;
  rangoVector: number | null;
}

export interface RespuestaBusqueda {
  modo: Modo;
  /** Presente cuando la búsqueda cayó a texto: dice por qué. */
  aviso: string | null;
  resultados: Resultado[];
}

export interface OpcionesBusqueda {
  filtros?: Filtros;
  limite?: number;
}

/** Constante clásica de la fusión por rango recíproco. */
const K_RRF = 60;
const POOL = 50;
/** En modo texto, una coincidencia parcial va detrás de las completas y pesa la mitad. */
const PESO_PARCIAL = 0.5;

interface AciertoTexto {
  id: number;
  completo: boolean;
}
const POOL_VECTOR = 200;

/**
 * Búsqueda híbrida: FTS5 y KNN fusionados por rango recíproco, con los
 * filtros por defecto. Sin vector cae a texto y lo avisa; si falla el texto, error, nunca vacío.
 */
export class Buscador {
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: EmbedderConsulta | null,
  ) {}

  async buscar(consulta: string, opciones: OpcionesBusqueda = {}): Promise<RespuestaBusqueda> {
    const texto = consulta.trim();
    if (!texto) throw new ReglaError("consulta_vacia", "la consulta no puede estar vacía");
    const limite = Math.min(Math.max(opciones.limite ?? 10, 1), 100);
    const filtros = opciones.filtros ?? {};

    const vectorial = await this.rankVector(texto, filtros);
    const porTexto = this.rankTexto(texto, filtros, vectorial.modo === "texto");

    const fusion = new Map<number, { rangoTexto: number | null; rangoVector: number | null; puntaje: number }>();
    porTexto.forEach(({ id, completo }, i) =>
      fusion.set(id, { rangoTexto: i + 1, rangoVector: null, puntaje: (completo ? 1 : PESO_PARCIAL) / (K_RRF + i + 1) }),
    );
    vectorial.ids.forEach((id, i) => {
      const previo = fusion.get(id) ?? { rangoTexto: null, rangoVector: null, puntaje: 0 };
      fusion.set(id, { ...previo, rangoVector: i + 1, puntaje: previo.puntaje + 1 / (K_RRF + i + 1) });
    });

    const ordenados = [...fusion.entries()]
      .sort((a, b) => b[1].puntaje - a[1].puntaje || (a[1].rangoTexto ?? Infinity) - (b[1].rangoTexto ?? Infinity))
      .slice(0, limite);
    const resultados = ordenados.map(([id, r]) => {
      const entrada = this.store.obtener(id);
      return { entrada, marca: marcar(entrada), ...r };
    });
    return { modo: vectorial.modo, aviso: vectorial.aviso, resultados };
  }

  /**
   * FTS5 con bm25. En modo híbrido cuenta solo la entrada que reúne todos los términos (un nombre
   * exacto, una frase literal): la coincidencia parcial ya la cubre el vector y, sumada en la
   * fusión, tapa a la paráfrasis. En modo texto se agregan después las parciales, con menos peso.
   * Un fallo del índice de texto es un error, nunca un vacío.
   */
  private rankTexto(consulta: string, filtros: Filtros, incluirParciales: boolean): AciertoTexto[] {
    // Una consulta hecha solo de palabras vacías se busca igual, con todas sus palabras.
    const lista = terminos(consulta).length ? terminos(consulta) : terminos(consulta, { conVacias: true });
    if (!lista.length) return [];
    const completos = this.consultarFts(lista.map(citar).join(" AND "), filtros);
    const parciales =
      incluirParciales && lista.length > 1 ? this.consultarFts(lista.map(citar).join(" OR "), filtros) : [];
    const vistos = new Set(completos);
    return [
      ...completos.map((id) => ({ id, completo: true })),
      ...parciales.filter((id) => !vistos.has(id)).map((id) => ({ id, completo: false })),
    ].slice(0, POOL);
  }

  private consultarFts(match: string, filtros: Filtros): number[] {
    const { sql, params } = clausulaFiltros(filtros, this.store.ahora());
    try {
      const filas = this.store.db
        .prepare(
          `SELECT e.id FROM entradas_fts f JOIN entradas e ON e.id = f.rowid
           WHERE entradas_fts MATCH ? AND ${sql}
           ORDER BY bm25(entradas_fts, 3.0, 1.0) LIMIT ?`,
        )
        .all(match, ...params, POOL) as { id: number }[];
      return filas.map((f) => f.id);
    } catch (error) {
      throw new ReglaError("busqueda_texto_fallida", `falló la búsqueda por texto completo: ${(error as Error).message}`);
    }
  }

  private async rankVector(consulta: string, filtros: Filtros): Promise<{ modo: Modo; aviso: string | null; ids: number[] }> {
    if (!this.embedder) return texto("no hay modelo de embeddings configurado");
    // El modelo primero: sin él, la base tampoco tiene vectores y el aviso debe decir cómo traerlo.
    let vector: Float32Array;
    try {
      vector = await this.embedder.embedQuery(consulta);
    } catch (error) {
      if (error instanceof EmbeddingsDefectuosos) return texto(error.message);
      return texto(`el modelo de embeddings no está disponible (${(error as Error).message})`);
    }
    const conVector = this.store.db
      .prepare("SELECT count(*) AS n FROM vectores WHERE estado = 'ok' AND model_id = ?")
      .get(this.embedder.modelId) as { n: number };
    if (conVector.n === 0) return texto("la base no tiene vectores del modelo actual");

    const { sql, params } = clausulaFiltros(filtros, this.store.ahora());
    const filas = this.store.db
      .prepare(
        `WITH knn AS (SELECT rowid AS id, distance FROM entradas_vec WHERE embedding MATCH ? AND k = ?)
         SELECT e.id FROM knn JOIN entradas e ON e.id = knn.id
         JOIN vectores v ON v.entrada_id = e.id AND v.estado = 'ok' AND v.model_id = ?
         WHERE ${sql} ORDER BY knn.distance LIMIT ?`,
      )
      .all(vectorBlob(vector), POOL_VECTOR, this.embedder.modelId, ...params, POOL) as { id: number }[];
    const faltan = this.store.vectoresPendientes().length;
    const aviso = faltan ? `${faltan} entradas todavía no tienen vector y solo se encuentran por texto` : null;
    return { modo: "hibrido", aviso, ids: filas.map((f) => f.id) };
  }
}

function texto(motivo: string): { modo: Modo; aviso: string; ids: number[] } {
  return { modo: "texto", aviso: `búsqueda solo por texto: ${motivo}`, ids: [] };
}

export function marcar(e: Entrada): Marca {
  if (e.validacion === null) return "estado de trabajo";
  return e.validacion;
}

/** Un término entre comillas: FTS5 lo busca tal cual, sin interpretar su sintaxis. */
function citar(termino: string): string {
  return `"${termino.replaceAll('"', '""')}"`;
}
