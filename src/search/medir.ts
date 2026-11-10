import { readFileSync } from "node:fs";
import { MemoryStore } from "../store/store.js";
import { TransformersEmbedder } from "./embedder.js";
import type { ModeloEmbeddings } from "./models.js";
import { Buscador } from "./search.js";

export interface Conjunto {
  corpus: { clave: string; tipo: string; titulo: string; contenido: string }[];
  consultas: { clase: "parafrasis" | "nombre_exacto"; consulta: string; esperada: string }[];
}

/**
 * Puesto máximo aceptado para una paráfrasis, el mismo en todos los sistemas. Era 3; es 5 porque los kernels cuantizados
 * de ONNX (medido con q8) dan números distintos según la CPU (x64 frente a arm64) y una paráfrasis ganaba su puesto
 * por 0,02 de coseno.
 */
export const PUESTO_MAXIMO_PARAFRASIS = 5;

export interface Medicion {
  modelo: string;
  dtype: string;
  pasa: boolean;
  parafrasisEnTope: number;
  nombresPrimero: number;
  total: { parafrasis: number; nombres: number };
  rangos: { consulta: string; clase: string; rango: number | null; rangoVector: number | null }[];
}

export function leerConjunto(ruta: string): Conjunto {
  return JSON.parse(readFileSync(ruta, "utf8")) as Conjunto;
}

/** Carga el corpus en una base en memoria con el modelo dado y corre cada consulta. */
export async function medir(conjunto: Conjunto, modelo: ModeloEmbeddings, cache?: string): Promise<Medicion> {
  const embedder = new TransformersEmbedder(modelo, cache ? { cache } : {});
  const store = MemoryStore.abrir(":memory:", { embedder });
  try {
    const ids = new Map<string, number>();
    for (const e of conjunto.corpus) {
      const { entrada } = await store.crear(
        { tipo: e.tipo, titulo: e.titulo, contenido: e.contenido, ambito: "global", ambitoRef: null },
        { actor: "persona" },
      );
      ids.set(e.clave, entrada.id);
    }
    const buscador = new Buscador(store, embedder);
    const rangos: Medicion["rangos"] = [];
    for (const c of conjunto.consultas) {
      const r = await buscador.buscar(c.consulta, { limite: 20 });
      if (r.modo !== "hibrido") throw new Error(`la medición cayó a modo ${r.modo}: ${r.aviso}`);
      const idx = r.resultados.findIndex((x) => x.entrada.id === ids.get(c.esperada));
      rangos.push({
        consulta: c.consulta,
        clase: c.clase,
        rango: idx === -1 ? null : idx + 1,
        rangoVector: idx === -1 ? null : (r.resultados[idx]?.rangoVector ?? null),
      });
    }
    const parafrasis = rangos.filter((r) => r.clase === "parafrasis");
    const nombres = rangos.filter((r) => r.clase === "nombre_exacto");
    const parafrasisEnTope = parafrasis.filter((r) => r.rango !== null && r.rango <= PUESTO_MAXIMO_PARAFRASIS).length;
    const nombresPrimero = nombres.filter((r) => r.rango === 1).length;
    return {
      modelo: modelo.id,
      dtype: modelo.dtype,
      pasa: parafrasisEnTope === parafrasis.length && nombresPrimero === nombres.length,
      parafrasisEnTope,
      nombresPrimero,
      total: { parafrasis: parafrasis.length, nombres: nombres.length },
      rangos,
    };
  } finally {
    store.close();
  }
}
