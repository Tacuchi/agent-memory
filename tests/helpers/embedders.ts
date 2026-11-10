import { createHash } from "node:crypto";
import { DIMENSIONES } from "../../src/db/schema.js";
import { TransformersEmbedder } from "../../src/search/embedder.js";
import { cacheModelos, modeloFijado } from "../../src/search/models.js";
import { terminos } from "../../src/search/stopwords.js";

/** Embedder determinista de bolsa de palabras: prueba la mecánica sin depender del modelo. */
export class EmbedderFalso {
  readonly dims = DIMENSIONES;
  llamadas = 0;
  fallar = false;
  constructor(readonly modelId = "falso/bolsa-de-palabras") {}

  async embedPassage(texto: string): Promise<Float32Array> {
    return this.vector(texto);
  }

  async embedQuery(texto: string): Promise<Float32Array> {
    return this.vector(texto);
  }

  private vector(texto: string): Float32Array {
    this.llamadas++;
    if (this.fallar) throw new Error("modelo no disponible (simulado)");
    const v = new Float32Array(DIMENSIONES);
    for (const t of terminos(texto)) {
      const i = createHash("sha256").update(t).digest().readUInt16BE(0) % DIMENSIONES;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norma = Math.hypot(...v) || 1;
    return v.map((x) => x / norma);
  }
}

/** El modelo fijado, desde la caché local y sin red. Sin caché, la prueba falla con el comando. */
export function modeloReal(): TransformersEmbedder {
  const modelo = modeloFijado();
  if (!TransformersEmbedder.enCache(modelo)) {
    throw new Error(`falta el modelo ${modelo.id} en ${cacheModelos()}: corré una vez «npm run model:fetch»`);
  }
  return new TransformersEmbedder(modelo);
}
