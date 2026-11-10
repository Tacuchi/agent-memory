import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cargarConfig } from "../../src/config.js";
import { OPERACIONES } from "../../src/service/api.js";
import { MemoryStore } from "../../src/store/store.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { asegurarBuild, servicioDePrueba } from "../helpers/servicio.js";

// La purga física solo existe en la CLI, pide escribir el id, borra la entrada con toda su
// historia en una transacción y deja un registro con id y fecha, sin el contenido.

const CONTENIDO = "contenido-sintetico-a-purgar-7f3a";
let e: EntornoCli;
let ids: { objetivo: number; otra: number; reemplazo: number };

beforeAll(() => asegurarBuild());
beforeEach(async () => {
  e = await entornoCli();
  const config = cargarConfig(e.env);
  const store = MemoryStore.abrir(config.dbPath, { embedder: new EmbedderFalso() });
  const persona = { actor: "persona" as const };
  const otra = (await store.crear({ tipo: "leccion", titulo: "Otra", contenido: "se queda", ambito: "global", ambitoRef: null }, persona)).entrada;
  const objetivo = (
    await store.crear({ tipo: "leccion", titulo: "Título a purgar", contenido: CONTENIDO, ambito: "global", ambitoRef: null, relacionadas: [otra.id] }, persona)
  ).entrada;
  await store.editar(objetivo.id, { contenido: `${CONTENIDO} v2` }, persona);
  store.relacionar(otra.id, objetivo.id);
  const reemplazo = (await store.crear({ tipo: "leccion", titulo: "Reemplazo", contenido: "nuevo", ambito: "global", ambitoRef: null, reemplazaA: otra.id }, persona)).entrada;
  ids = { objetivo: objetivo.id, otra: otra.id, reemplazo: reemplazo.id };
  store.close();
});
afterEach(async () => e.limpiar());

function rastro(id: number): Record<string, number> {
  const store = MemoryStore.abrir(cargarConfig(e.env).dbPath, { embedder: null });
  try {
    const n = (sql: string, ...p: (number | bigint | string)[]) => (store.db.prepare(sql).get(...p) as { n: number }).n;
    return {
      entradas: n("SELECT count(*) AS n FROM entradas WHERE id = ?", id),
      revisiones: n("SELECT count(*) AS n FROM revisiones WHERE entrada_id = ?", id),
      relaciones: n("SELECT count(*) AS n FROM relaciones WHERE origen_id = ? OR destino_id = ?", id, id),
      vectores: n("SELECT count(*) AS n FROM vectores WHERE entrada_id = ?", id),
      vec: n("SELECT count(*) AS n FROM entradas_vec WHERE rowid = ?", BigInt(id)),
      texto: n("SELECT count(*) AS n FROM entradas_fts WHERE entradas_fts MATCH ?", '"contenido-sintetico-a-purgar-7f3a"'),
      referencias: n("SELECT count(*) AS n FROM entradas WHERE reemplaza_a = ? OR reemplazada_por = ?", id, id),
    };
  } finally {
    store.close();
  }
}

describe("agent-memory purge", () => {
  it("escribiendo el id borra la entrada de todas las tablas y registra solo id y fecha", async () => {
    expect(rastro(ids.objetivo)).toMatchObject({ entradas: 1, revisiones: 2, relaciones: 2, vectores: 1, vec: 1, texto: 1 });
    const r = await correr(e, ["purge", String(ids.objetivo)], { input: `${ids.objetivo}\n` });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("No se puede deshacer");
    expect(rastro(ids.objetivo)).toEqual({ entradas: 0, revisiones: 0, relaciones: 0, vectores: 0, vec: 0, texto: 0, referencias: 0 });

    const log = readFileSync(cargarConfig(e.env).purgasPath, "utf8");
    expect(log).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\tpurga\\t${ids.objetivo}\\n$`));
    expect(log).not.toContain(CONTENIDO);
    expect(log).not.toContain("Título a purgar");
    // Lo demás queda intacto.
    expect(rastro(ids.otra).entradas).toBe(1);
  });

  it("purgar una entrada que reemplazó a otra limpia la referencia sin tocar el resto", async () => {
    const r = await correr(e, ["purge", String(ids.reemplazo), "--confirmar", String(ids.reemplazo)]);
    expect(r.code, r.stderr).toBe(0);
    expect(rastro(ids.reemplazo)).toMatchObject({ entradas: 0, referencias: 0 });
    expect(rastro(ids.otra).entradas).toBe(1);
  });

  it("sin confirmación o con otro id no borra nada y sale con 1", async () => {
    for (const input of ["", "\n", `${ids.otra}\n`, "si\n"]) {
      const r = await correr(e, ["purge", String(ids.objetivo)], { input });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("purga cancelada");
    }
    expect(rastro(ids.objetivo)).toMatchObject({ entradas: 1, revisiones: 2 });
    expect(existsSync(cargarConfig(e.env).purgasPath)).toBe(false);
  });

  it("si el registro no se puede escribir, no se purga nada", async () => {
    const config = cargarConfig(e.env);
    mkdirSync(config.purgasPath);
    const r = await correr(e, ["purge", String(ids.objetivo), "--confirmar", String(ids.objetivo)]);
    expect(r.code).toBe(1);
    expect(rastro(ids.objetivo)).toMatchObject({ entradas: 1, revisiones: 2, relaciones: 2, vectores: 1, vec: 1, texto: 1 });
  });

  it("un id inexistente o mal escrito no purga", async () => {
    expect((await correr(e, ["purge", "999"], { input: "999\n" })).code).toBe(1);
    expect((await correr(e, ["purge", "abc"])).code).toBe(2);
    expect((await correr(e, ["purge"])).code).toBe(2);
  });
});

describe("la API no purga", () => {
  it("ninguna operación borra y las rutas de purga no existen", async () => {
    expect(OPERACIONES.filter((op) => /purg|borr|elimin|delete|remove/i.test(op))).toEqual([]);
    const s = await servicioDePrueba();
    try {
      for (const op of ["purgar", "purge", "borrar", "eliminar"]) {
        const r = await s.api(op, { id: 1 });
        expect(r.status).toBe(404);
      }
    } finally {
      await s.cerrar();
    }
  });
});
