import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/store.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";

const ctx = { repo: "github.com/ejemplo/sintetico", proyecto: null };
const original = {
  tipo: "leccion",
  titulo: "Comprobar la rama antes de integrar",
  contenido: "antes de integrar en una fuente compartida correr git branch show current",
  contexto: ctx,
};

describe("memory_create avisa de entradas parecidas", () => {
  let s: ServicioDePrueba;
  let idOriginal: number;
  beforeEach(async () => {
    s = await servicioDePrueba();
    idOriginal = (await s.api("crear", original)).datos.entrada.id;
  });
  afterEach(() => s.cerrar());

  it("una casi copia trae a la original; un tema distinto no trae nada", async () => {
    const copia = await s.api("crear", { ...original, titulo: "Comprobar la rama antes de integrar siempre" });
    expect(copia.datos.parecidas).toEqual([
      expect.objectContaining({ id: idOriginal, titulo: original.titulo, similitud: expect.any(Number) }),
    ]);
    expect(copia.datos.parecidas[0].similitud).toBeGreaterThanOrEqual(0.85);

    const distinta = await s.api("crear", { ...original, titulo: "Recetas de cocina", contenido: "hervir agua con sal y fideos" });
    expect(distinta.datos.parecidas).toEqual([]);
  });

  it("el borrador ya avisa, antes de crear nada", async () => {
    const r = await s.api("crear", { ...original, borrador: true });
    expect(r.datos.huella).toBeDefined();
    expect(r.datos.parecidas.map((p: { id: number }) => p.id)).toEqual([idOriginal]);
    expect((await s.api("listar", { contexto: ctx })).datos.entradas).toHaveLength(1);
  });

  it("la entrada que se reemplaza no cuenta como parecida", async () => {
    const r = await s.api("crear", { ...original, reemplaza_a: idOriginal });
    expect(r.datos.parecidas).toEqual([]);
  });
});

describe("sin modelo de embeddings", () => {
  it("parecidas es null: no se comprobó, que no es lo mismo que no haber ninguna", async () => {
    const embedder = new EmbedderFalso();
    const store = MemoryStore.abrir(":memory:", { embedder });
    embedder.fallar = true;
    expect(await store.parecidas("Comprobar la rama", "antes de integrar", [])).toBeNull();
    store.close();
  });
});
