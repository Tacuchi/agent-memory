import { TransformersEmbedder } from "./search/embedder.js";
import { cacheModelos, modeloFijado } from "./search/models.js";

/**
 * `agent-memory model fetch`: el único paso con red. Descarga el modelo fijado a la caché local
 * (si falta) y después lo verifica cargándolo sin red.
 */
export async function traerModelo(env: NodeJS.ProcessEnv, escribir: (linea: string) => void): Promise<void> {
  const modelo = modeloFijado();
  const cache = cacheModelos(env);
  if (TransformersEmbedder.enCache(modelo, cache)) {
    escribir(`modelo ${modelo.id} ya está en ${cache}`);
  } else {
    escribir(`descargando ${modelo.id} (${modelo.dtype}) a ${cache}…`);
    await new TransformersEmbedder(modelo, { cache, permitirRed: true }).cargar();
    escribir("listo");
  }
  const vector = await new TransformersEmbedder(modelo, { cache }).embedQuery("prueba sin red");
  escribir(`verificado sin red: ${vector.length} dimensiones`);
}
