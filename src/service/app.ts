import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { Buscador } from "../search/search.js";
import { TransformersEmbedder } from "../search/embedder.js";
import { modeloFijado } from "../search/models.js";
import { MemoryStore, type Embedder } from "../store/store.js";
import { Remoto } from "../remoto/remoto.js";
import { version } from "../version.js";
import { Api } from "./api.js";
import { iniciarServicio, type Servicio } from "./server.js";
import { asegurarToken } from "./token.js";

export interface App extends Servicio {
  store: MemoryStore;
  remoto: Remoto;
  /** Termina cuando se regeneraron los vectores faltantes o de otro modelo. */
  regeneracion: Promise<number>;
}

type EmbedderCompleto = Embedder & { embedQuery(texto: string): Promise<Float32Array> };

/**
 * La web compilada vive en `dist/web` del paquete. `src/service` y `dist/service` están a la misma
 * profundidad, así que la ruta vale tanto para el bin como para las pruebas sobre el código fuente.
 */
export function dirWebPorDefecto(): string | null {
  const dir = fileURLToPath(new URL("../../dist/web/", import.meta.url));
  return existsSync(`${dir}index.html`) ? dir : null;
}

/** Raíz de composición del servicio: almacén, búsqueda, token y HTTP sobre el directorio de datos. */
export async function arrancarServicio(
  config: Config,
  opciones: { embedder?: EmbedderCompleto | null; dirWeb?: string | null; reloj?: () => Date } = {},
): Promise<App> {
  const embedder = opciones.embedder === undefined ? new TransformersEmbedder(modeloFijado()) : opciones.embedder;
  const token = asegurarToken(config.tokenPath);
  const store = MemoryStore.abrir(config.dbPath, { embedder, ...(opciones.reloj ? { reloj: opciones.reloj } : {}) });
  const buscador = new Buscador(store, embedder);
  // El conector de la dueña sale hacia el relé solo con el interruptor encendido; ninguno abre un puerto.
  const remoto = new Remoto(store, buscador, { esperaMs: config.remoto.esperaMs });
  const api = new Api(store, buscador, version(), {
    remoto,
    topeIndice: config.topeIndice,
    umbralesRevision: config.revision,
    dirExportaciones: config.exportacionesPath,
  });
  const servicio = await iniciarServicio({ api, token, port: config.port, dirWeb: opciones.dirWeb === undefined ? dirWebPorDefecto() : opciones.dirWeb });
  const regeneracion = store.regenerarVectores().catch(() => 0);
  remoto.reconciliar();
  return {
    ...servicio,
    store,
    remoto,
    regeneracion,
    cerrar: async () => {
      remoto.cerrar();
      await servicio.cerrar();
      await regeneracion;
      store.close();
    },
  };
}
