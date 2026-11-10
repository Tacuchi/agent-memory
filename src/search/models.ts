import { homedir } from "node:os";
import { join } from "node:path";

/** Cómo se calcula el embedding de un candidato: pooling y prefijos de consulta y pasaje. */
export interface ModeloEmbeddings {
  id: string;
  dims: number;
  dtype: "q8" | "fp32";
  pooling: "mean" | "cls";
  prefijoConsulta: string;
  prefijoPasaje: string;
}

/** Candidatos medidos con `src/medir-modelos.ts` sobre `tests/fixtures/consultas-es.json`. */
export const CANDIDATOS: readonly ModeloEmbeddings[] = [
  {
    id: "Xenova/multilingual-e5-small",
    dims: 384,
    dtype: "q8",
    pooling: "mean",
    prefijoConsulta: "query: ",
    prefijoPasaje: "passage: ",
  },
  {
    id: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    dims: 384,
    dtype: "q8",
    pooling: "cls",
    prefijoConsulta: "",
    prefijoPasaje: "",
  },
  {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dims: 384,
    dtype: "q8",
    pooling: "mean",
    prefijoConsulta: "",
    prefijoPasaje: "",
  },
];

/**
 * Modelo fijado por la medición de candidatos: el único candidato que pone cada paráfrasis entre los
 * tres primeros y cada nombre exacto primero, y además el más liviano (~121 MB en q8).
 */
export const MODELO_ID_FIJADO = "onnx-community/granite-embedding-97m-multilingual-r2-ONNX";

export function modeloFijado(): ModeloEmbeddings {
  const modelo = CANDIDATOS.find((m) => m.id === MODELO_ID_FIJADO);
  if (!modelo) throw new Error(`modelo fijado desconocido: ${MODELO_ID_FIJADO}`);
  return modelo;
}

/** Caché local de modelos: fuera del directorio de datos, para que las pruebas lo compartan sin red. */
export function cacheModelos(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MEMORY_MODEL_CACHE?.trim() || join(homedir(), ".cache", "agent-memory", "models");
}
