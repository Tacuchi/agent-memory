import { TransformersEmbedder } from "./search/embedder.js";
import { cacheModelos, modeloFijado } from "./search/models.js";

// `npm run model:fetch`: el único paso con red. Descarga el modelo fijado a la caché local.
const modelo = modeloFijado();
const cache = cacheModelos();
if (TransformersEmbedder.enCache(modelo, cache)) {
  process.stdout.write(`modelo ${modelo.id} ya está en ${cache}\n`);
} else {
  process.stdout.write(`descargando ${modelo.id} (${modelo.dtype}) a ${cache}…\n`);
  await new TransformersEmbedder(modelo, { cache, permitirRed: true }).cargar();
  process.stdout.write("listo\n");
}
const vector = await new TransformersEmbedder(modelo, { cache }).embedQuery("prueba sin red");
process.stdout.write(`verificado sin red: ${vector.length} dimensiones\n`);
