import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../store/store.js";
import { cacheModelos, type ModeloEmbeddings } from "./models.js";

type Extractor = (texto: string, opciones: { pooling: "mean" | "cls"; normalize: boolean }) => Promise<{ data: Float32Array }>;

export class ModeloNoDisponible extends Error {
  constructor(modelo: string, cache: string) {
    super(`el modelo ${modelo} no está en la caché local (${cache}); traelo una vez con: agent-memory model fetch`);
    this.name = "ModeloNoDisponible";
  }
}

export interface OpcionesEmbedder {
  cache?: string;
  /** Solo `agent-memory model fetch` habilita la red; el resto corre sin red. */
  permitirRed?: boolean;
}

/** Embeddings locales por transformers.js/ONNX. Sin red salvo en `agent-memory model fetch`. */
export class TransformersEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims: number;
  private extractor: Promise<Extractor> | null = null;

  constructor(
    private readonly modelo: ModeloEmbeddings,
    private readonly opciones: OpcionesEmbedder = {},
  ) {
    this.modelId = modelo.id;
    this.dims = modelo.dims;
  }

  static enCache(modelo: ModeloEmbeddings, cache = cacheModelos()): boolean {
    return existsSync(join(cache, ...modelo.id.split("/"), "onnx"));
  }

  async embedPassage(texto: string): Promise<Float32Array> {
    return this.embed(this.modelo.prefijoPasaje + texto);
  }

  async embedQuery(texto: string): Promise<Float32Array> {
    return this.embed(this.modelo.prefijoConsulta + texto);
  }

  /** Carga el modelo (y lo descarga si la red está permitida). */
  async cargar(): Promise<void> {
    await this.obtenerExtractor();
  }

  private async embed(texto: string): Promise<Float32Array> {
    const extractor = await this.obtenerExtractor();
    const salida = await extractor(texto, { pooling: this.modelo.pooling, normalize: true });
    return Float32Array.from(salida.data);
  }

  private obtenerExtractor(): Promise<Extractor> {
    this.extractor ??= this.crearExtractor().catch((error: unknown) => {
      this.extractor = null;
      throw error;
    });
    return this.extractor;
  }

  private async crearExtractor(): Promise<Extractor> {
    const cache = this.opciones.cache ?? cacheModelos();
    const red = Boolean(this.opciones.permitirRed);
    if (!red && !TransformersEmbedder.enCache(this.modelo, cache)) throw new ModeloNoDisponible(this.modelo.id, cache);
    const { env, pipeline } = await import("@huggingface/transformers");
    // Sin red, la caché local se lee como carpeta de modelos locales: mismo layout `<org>/<modelo>/`.
    env.cacheDir = cache;
    env.localModelPath = cache;
    env.allowLocalModels = true;
    env.allowRemoteModels = red;
    const extractor = await pipeline("feature-extraction", this.modelo.id, { dtype: this.modelo.dtype });
    return extractor as unknown as Extractor;
  }
}
