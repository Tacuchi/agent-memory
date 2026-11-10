import { homedir } from "node:os";
import { join } from "node:path";

/** Cómo se calcula el embedding de un candidato: pooling y prefijos de consulta y pasaje. */
export interface ModeloEmbeddings {
  id: string;
  dims: number;
  dtype: "q8" | "uint8" | "fp32";
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
    // uint8 y no q8: con q8 los vectores salían rotos en algunas CPU x64 de los runners de CI (sin VNNI, sospecha
    // no confirmada); uint8 pesa lo mismo (~98 MB) y pasó la medición en Linux x64, Windows x64 y macOS arm64.
    dtype: "uint8",
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
 * tres primeros y cada nombre exacto primero, y además el más liviano (~98 MB cuantizado).
 */
export const MODELO_ID_FIJADO = "onnx-community/granite-embedding-97m-multilingual-r2-ONNX";

export function modeloFijado(): ModeloEmbeddings {
  const modelo = CANDIDATOS.find((m) => m.id === MODELO_ID_FIJADO);
  if (!modelo) throw new Error(`modelo fijado desconocido: ${MODELO_ID_FIJADO}`);
  return modelo;
}

/** Sufijo del archivo ONNX de cada dtype, como lo nombra transformers.js en la carpeta `onnx/` del modelo. */
const SUFIJO_ONNX: Record<ModeloEmbeddings["dtype"], string> = { fp32: "", q8: "_quantized", uint8: "_uint8" };

/** Ruta del archivo ONNX del modelo dentro de su carpeta: `onnx/model_uint8.onnx`, p. ej. */
export function archivoOnnx(modelo: ModeloEmbeddings): string[] {
  return ["onnx", `model${SUFIJO_ONNX[modelo.dtype]}.onnx`];
}

/**
 * Id del modelo que se guarda con cada vector: incluye el dtype porque cada variante da otros números. Un vector
 * guardado con otro id (otro modelo, u otra variante del mismo) se regenera al arrancar.
 */
export function idVectorial(modelo: ModeloEmbeddings): string {
  return `${modelo.id}@${modelo.dtype}`;
}

/** Caché local de modelos: fuera del directorio de datos, para que las pruebas lo compartan sin red. */
export function cacheModelos(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MEMORY_MODEL_CACHE?.trim() || join(homedir(), ".cache", "agent-memory", "models");
}
