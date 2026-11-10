import type { Config } from "../config.js";
import { Buscador } from "../search/search.js";
import { TransformersEmbedder } from "../search/embedder.js";
import { modeloFijado } from "../search/models.js";
import { MemoryStore, type Embedder } from "../store/store.js";
import { version } from "../version.js";
import { Api } from "./api.js";
import { iniciarServicio, type Servicio } from "./server.js";
import { asegurarToken } from "./token.js";

export interface App extends Servicio {
  store: MemoryStore;
  /** Termina cuando se regeneraron los vectores faltantes o de otro modelo (T2.3). */
  regeneracion: Promise<number>;
}

type EmbedderCompleto = Embedder & { embedQuery(texto: string): Promise<Float32Array> };

/** Raíz de composición del servicio: almacén, búsqueda, token y HTTP sobre el directorio de datos. */
export async function arrancarServicio(config: Config, opciones: { embedder?: EmbedderCompleto | null } = {}): Promise<App> {
  const embedder = opciones.embedder === undefined ? new TransformersEmbedder(modeloFijado()) : opciones.embedder;
  const token = asegurarToken(config.tokenPath);
  const store = MemoryStore.abrir(config.dbPath, { embedder });
  const api = new Api(store, new Buscador(store, embedder), version());
  const servicio = await iniciarServicio({ api, token, port: config.port });
  const regeneracion = store.regenerarVectores().catch(() => 0);
  return {
    ...servicio,
    store,
    regeneracion,
    cerrar: async () => {
      await servicio.cerrar();
      await regeneracion;
      store.close();
    },
  };
}
