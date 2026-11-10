import { afterEach, describe, expect, it } from "vitest";
import { Buscador } from "../../src/search/search.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { REPO, storeTemporal } from "../helpers/temp.js";

const enRepo = { ambito: "repo" as const, ambitoRef: REPO };
const persona = { actor: "persona" as const };

describe("modo de búsqueda y degradación (T2.4)", () => {
  let t: ReturnType<typeof storeTemporal>;
  afterEach(() => t.cerrar());

  it("una base sin vectores responde en modo texto y lo avisa", async () => {
    t = storeTemporal();
    await t.store.crear({ tipo: "leccion", titulo: "Bloqueos en SQLite", contenido: "usar busy_timeout", ...enRepo }, persona);
    const r = await new Buscador(t.store, new EmbedderFalso()).buscar("busy_timeout");
    expect(r.modo).toBe("texto");
    expect(r.aviso).toMatch(/solo por texto/);
    expect(r.resultados.map((x) => x.entrada.titulo)).toEqual(["Bloqueos en SQLite"]);
  });

  it("sin modelo configurado o con el modelo caído, cae a texto con aviso y encuentra por coincidencia parcial", async () => {
    const embedder = new EmbedderFalso();
    t = storeTemporal({ embedder });
    await t.store.crear({ tipo: "leccion", titulo: "Reintentos con espera", contenido: "pausas que se duplican", ...enRepo }, persona);

    const sinModelo = await new Buscador(t.store, null).buscar("reintentos lentos");
    expect(sinModelo).toMatchObject({ modo: "texto", aviso: expect.stringMatching(/no hay modelo/) });
    expect(sinModelo.resultados).toHaveLength(1);

    embedder.fallar = true;
    const caido = await new Buscador(t.store, embedder).buscar("reintentos lentos");
    expect(caido).toMatchObject({ modo: "texto", aviso: expect.stringMatching(/no está disponible/) });
    expect(caido.resultados[0]?.rangoTexto).toBe(1);
  });

  it("con vectores responde en modo híbrido", async () => {
    const embedder = new EmbedderFalso();
    t = storeTemporal({ embedder });
    await t.store.crear({ tipo: "leccion", titulo: "Pausas que se duplican", contenido: "espera exponencial", ...enRepo }, persona);
    const r = await new Buscador(t.store, embedder).buscar("espera exponencial");
    expect(r).toMatchObject({ modo: "hibrido", aviso: null });
    expect(r.resultados[0]).toMatchObject({ rangoTexto: 1, rangoVector: 1 });
  });

  it("si falla el texto completo devuelve error, nunca un vacío", async () => {
    t = storeTemporal();
    await t.store.crear({ tipo: "leccion", titulo: "t", contenido: "c", ...enRepo }, persona);
    t.store.db.exec("DROP TABLE entradas_fts");
    await expect(new Buscador(t.store, null).buscar("bloqueo")).rejects.toMatchObject({ codigo: "busqueda_texto_fallida" });
  });

  it("una consulta de solo palabras vacías se busca con esas palabras", async () => {
    t = storeTemporal();
    await t.store.crear({ tipo: "leccion", titulo: "Para qué sirve", contenido: "c", ...enRepo }, persona);
    const r = await new Buscador(t.store, null).buscar("para que");
    expect(r.resultados).toHaveLength(1);
  });

  it("una consulta vacía es un error", async () => {
    t = storeTemporal();
    await expect(new Buscador(t.store, null).buscar("   ")).rejects.toMatchObject({ codigo: "consulta_vacia" });
  });

  it("la sintaxis de FTS5 en la consulta se busca como texto, sin romper", async () => {
    t = storeTemporal();
    await t.store.crear({ tipo: "referencia", titulo: "Comando", contenido: 'usar "aw flow submit" AND NOT x*', ...enRepo }, persona);
    const r = await new Buscador(t.store, null).buscar('"aw flow submit" AND NOT x* (');
    expect(r.resultados).toHaveLength(1);
  });
});

describe("modelo ausente de la caché (sin red)", () => {
  it("falla con el comando para traerlo, sin intentar descargarlo", async () => {
    const { TransformersEmbedder } = await import("../../src/search/embedder.js");
    const { modeloFijado } = await import("../../src/search/models.js");
    const { dirTemporal } = await import("../helpers/temp.js");
    const vacio = dirTemporal();
    try {
      const embedder = new TransformersEmbedder(modeloFijado(), { cache: vacio.dir });
      await expect(embedder.embedQuery("hola")).rejects.toThrow(/npm run model:fetch/);
    } finally {
      vacio.limpiar();
    }
  });
});
