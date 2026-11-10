import { cpus } from "node:os";

// Autochequeo de los embeddings al arrancar. Los kernels cuantizados de ONNX pueden dar vectores rotos en
// algunas CPU (se vio en runners x64 de CI): la búsqueda devolvería cualquier cosa sin dar error. Antes de
// usar el modelo se vectorizan tres frases fijas: la paráfrasis tiene que parecerse a la consulta bastante
// más que la frase ajena. Con vectores sanos el margen ronda 0,20 en todas las variantes y CPU medidas; con
// los rotos quedó por debajo de 0,02.

export const UMBRAL_AUTOCHEQUEO = 0.08;

const CONSULTA = "reintentar con espera exponencial ante un error 503";
const PARAFRASIS = "volver a intentar duplicando la pausa cuando el servidor no responde";
const AJENA = "la receta del pan lleva harina, agua y sal";

export interface EmbedderAutochequeo {
  readonly modelId: string;
  readonly dims: number;
  embedQuery(texto: string): Promise<Float32Array>;
  embedPassage(texto: string): Promise<Float32Array>;
}

export interface ResultadoAutochequeo {
  ok: boolean;
  /** cos(consulta, paráfrasis) − cos(consulta, ajena). */
  margen: number;
}

function coseno(a: Float32Array, b: Float32Array): number {
  let punto = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    punto += x * y;
    na += x * x;
    nb += y * y;
  }
  return punto / Math.sqrt(na * nb);
}

/** Tres embeddings fijos. Un error del modelo (p. ej. falta en la caché) se propaga: eso no es un vector roto. */
export async function autochequear(embedder: Pick<EmbedderAutochequeo, "embedQuery" | "embedPassage">): Promise<ResultadoAutochequeo> {
  const consulta = await embedder.embedQuery(CONSULTA);
  const parafrasis = await embedder.embedPassage(PARAFRASIS);
  const ajena = await embedder.embedPassage(AJENA);
  const margen = coseno(consulta, parafrasis) - coseno(consulta, ajena);
  // NaN (un vector nulo o con NaN) también es roto.
  return { ok: margen >= UMBRAL_AUTOCHEQUEO, margen };
}

/** Qué pasa y qué hacer, para el aviso de la búsqueda y para `agent-memory doctor`. */
export function explicarFallo(margen: number): string {
  const valor = Number.isFinite(margen) ? margen.toFixed(3) : String(margen);
  return (
    `los embeddings salen defectuosos en esta máquina (autochequeo: margen ${valor}, mínimo ${UMBRAL_AUTOCHEQUEO}; CPU ${cpus()[0]?.model ?? "desconocida"}): ` +
    "se busca solo por texto y las entradas se guardan sin vector. Qué hacer: actualizá agent-memory y reiniciá el servicio " +
    "(«agent-memory stop» y «agent-memory start»); si sigue, reportalo con la salida de «agent-memory doctor»"
  );
}

export class EmbeddingsDefectuosos extends Error {
  constructor(readonly margen: number) {
    super(explicarFallo(margen));
    this.name = "EmbeddingsDefectuosos";
  }
}

/**
 * Envuelve al embedder: antes del primer uso corre el autochequeo una vez. Si falla, cada embedding lanza
 * `EmbeddingsDefectuosos` y así ningún vector roto llega a la base ni a una búsqueda. Si el modelo no
 * carga, el error pasa tal cual y el chequeo se reintenta en el próximo uso (después de «model fetch»).
 */
export class EmbedderVerificado implements EmbedderAutochequeo {
  readonly modelId: string;
  readonly dims: number;
  private chequeo: Promise<ResultadoAutochequeo> | null = null;

  constructor(private readonly base: EmbedderAutochequeo) {
    this.modelId = base.modelId;
    this.dims = base.dims;
  }

  /** Resultado del autochequeo (lo corre si todavía no corrió). */
  verificar(): Promise<ResultadoAutochequeo> {
    this.chequeo ??= autochequear(this.base).catch((error: unknown) => {
      this.chequeo = null;
      throw error;
    });
    return this.chequeo;
  }

  async embedQuery(texto: string): Promise<Float32Array> {
    await this.exigirSano();
    return this.base.embedQuery(texto);
  }

  async embedPassage(texto: string): Promise<Float32Array> {
    await this.exigirSano();
    return this.base.embedPassage(texto);
  }

  private async exigirSano(): Promise<void> {
    const r = await this.verificar();
    if (!r.ok) throw new EmbeddingsDefectuosos(r.margen);
  }
}
