import { afterEach, describe, expect, it } from "vitest";
import { cargarConfig } from "../../src/config.js";
import { diagnosticar } from "../../src/doctor.js";
import { autochequear, EmbedderVerificado, UMBRAL_AUTOCHEQUEO } from "../../src/search/autochequeo.js";
import { Buscador } from "../../src/search/search.js";
import { DIMENSIONES } from "../../src/db/schema.js";
import { modeloReal } from "../helpers/embedders.js";
import { puertoLibre } from "../helpers/servicio.js";
import { REPO, dirTemporal, storeTemporal } from "../helpers/temp.js";

// Autochequeo al arrancar: tres embeddings fijos. Si la paráfrasis no se parece a la consulta bastante más que
// la frase ajena, los vectores de esta máquina están rotos: la búsqueda queda en modo texto y lo dice.

const enRepo = { ambito: "repo" as const, ambitoRef: REPO };
const persona = { actor: "persona" as const };

/** Vector unitario sobre un eje, para armar parecidos a mano. */
function eje(...indices: number[]): Float32Array {
  const v = new Float32Array(DIMENSIONES);
  for (const i of indices) v[i] = 1 / Math.sqrt(indices.length);
  return v;
}

/** Como los vectores rotos que se vieron en CI: todos casi iguales, sin importar el texto. */
class EmbedderRoto {
  readonly modelId = "falso/roto";
  readonly dims = DIMENSIONES;
  llamadas = 0;
  async embedQuery(texto: string): Promise<Float32Array> {
    return this.vector(texto);
  }
  async embedPassage(texto: string): Promise<Float32Array> {
    return this.vector(texto);
  }
  private vector(texto: string): Float32Array {
    this.llamadas++;
    const v = eje(0);
    v[1] = (texto.length % 7) * 1e-3;
    return v;
  }
}

/** Sano: la paráfrasis comparte un eje con la consulta; la frase ajena, ninguno. */
class EmbedderSano {
  readonly modelId = "falso/sano";
  readonly dims = DIMENSIONES;
  async embedQuery(): Promise<Float32Array> {
    return eje(0, 1);
  }
  async embedPassage(texto: string): Promise<Float32Array> {
    return texto.includes("pan") ? eje(5) : eje(1, 2);
  }
}

describe("autochequeo de los embeddings", () => {
  let t: ReturnType<typeof storeTemporal> | null = null;
  afterEach(() => {
    t?.cerrar();
    t = null;
  });

  it("separa vectores sanos de rotos con el umbral de 0,08", async () => {
    expect(UMBRAL_AUTOCHEQUEO).toBe(0.08);
    expect(await autochequear(new EmbedderSano())).toMatchObject({ ok: true });
    const roto = await autochequear(new EmbedderRoto());
    expect(roto.ok).toBe(false);
    expect(roto.margen).toBeLessThan(UMBRAL_AUTOCHEQUEO);
  });

  it("con vectores rotos la búsqueda queda en modo texto, dice la causa y qué hacer, y no guarda vectores rotos", async () => {
    const embedder = new EmbedderVerificado(new EmbedderRoto());
    t = storeTemporal({ embedder });
    const { entrada } = await t.store.crear({ tipo: "leccion", titulo: "Bloqueos en SQLite", contenido: "usar busy_timeout", ...enRepo }, persona);
    expect(t.store.db.prepare("SELECT estado FROM vectores WHERE entrada_id = ?").get(entrada.id)).toEqual({ estado: "faltante" });
    expect(t.store.db.prepare("SELECT count(*) AS n FROM entradas_vec").get()).toEqual({ n: 0 });

    const r = await new Buscador(t.store, embedder).buscar("busy_timeout");
    expect(r.modo).toBe("texto");
    expect(r.aviso).toMatch(/solo por texto/);
    expect(r.aviso).toMatch(/defectuosos.*margen/);
    expect(r.aviso).toContain("agent-memory doctor");
    expect(r.resultados.map((x) => x.entrada.titulo)).toEqual(["Bloqueos en SQLite"]);
    expect(await t.store.regenerarVectores()).toBe(0);
  });

  it("corre una sola vez y, con vectores sanos, deja pasar cada embedding", async () => {
    const base = new EmbedderRoto();
    const verificado = new EmbedderVerificado(base);
    await expect(verificado.embedQuery("a")).rejects.toThrow(/defectuosos/);
    await expect(verificado.embedPassage("b")).rejects.toThrow(/defectuosos/);
    expect(base.llamadas).toBe(3);

    const sano = new EmbedderVerificado(new EmbedderSano());
    expect(await sano.embedQuery("x")).toEqual(eje(0, 1));
    expect(sano.modelId).toBe("falso/sano");
  });

  it("si el modelo no carga, el error pasa tal cual y el chequeo se reintenta en el próximo uso", async () => {
    let falta = true;
    const base = new EmbedderSano();
    const intermitente = {
      modelId: base.modelId,
      dims: base.dims,
      embedQuery: async () => {
        if (falta) throw new Error("falta el modelo; traelo con agent-memory model fetch");
        return base.embedQuery();
      },
      embedPassage: (texto: string) => base.embedPassage(texto),
    };
    const verificado = new EmbedderVerificado(intermitente);
    await expect(verificado.embedQuery("x")).rejects.toThrow(/model fetch/);
    falta = false;
    expect((await verificado.verificar()).ok).toBe(true);
  });

  it("agent-memory doctor marca la falla con la causa y qué hacer", async () => {
    const { dir, limpiar } = dirTemporal("agent-memory-doctor-");
    try {
      const config = cargarConfig({ AGENT_MEMORY_HOME: dir, AGENT_MEMORY_PORT: String(await puertoLibre()) });
      const hallazgos = await diagnosticar(config, { PATH: "" }, { embedder: new EmbedderRoto() });
      const modelo = hallazgos.find((h) => h.nombre === "modelo");
      expect(modelo).toMatchObject({ nivel: "falla", detalle: expect.stringMatching(/defectuosos.*margen.*solo por texto/), arreglo: expect.stringContaining("agent-memory") });

      const sanos = await diagnosticar(config, { PATH: "" }, { embedder: new EmbedderSano() });
      expect(sanos.find((h) => h.nombre === "modelo")).toMatchObject({ nivel: "ok", detalle: expect.stringContaining("autochequeo de embeddings ok") });
    } finally {
      limpiar();
    }
  });

  it("el modelo fijado pasa el autochequeo en esta máquina, sin red", async () => {
    const r = await autochequear(modeloReal());
    expect(r.margen, `margen ${r.margen}`).toBeGreaterThanOrEqual(UMBRAL_AUTOCHEQUEO);
  });
});
