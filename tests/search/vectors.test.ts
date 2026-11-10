import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/store.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { REPO, dirTemporal } from "../helpers/temp.js";

const enRepo = { ambito: "repo" as const, ambitoRef: REPO };

function estadoVector(store: MemoryStore, id: number) {
  const meta = store.db.prepare("SELECT estado, model_id, dims FROM vectores WHERE entrada_id = ?").get(id);
  const { n } = store.db.prepare("SELECT count(*) AS n FROM entradas_vec WHERE rowid = ?").get(BigInt(id)) as { n: number };
  return { meta, filasVec: n };
}

describe("proyección vectorial", () => {
  let limpiar = () => {};
  afterEach(() => limpiar());

  it("el vector se escribe con su modelo y dimensiones junto con la entrada, y se reemplaza al editar", async () => {
    const tmp = dirTemporal();
    limpiar = tmp.limpiar;
    const store = MemoryStore.abrir(join(tmp.dir, "memoria.db"), { embedder: new EmbedderFalso() });
    const { entrada } = await store.crear({ tipo: "leccion", titulo: "t", contenido: "uno", ...enRepo }, { actor: "persona" });
    expect(estadoVector(store, entrada.id)).toEqual({ meta: { estado: "ok", model_id: "falso/bolsa-de-palabras", dims: 384 }, filasVec: 1 });
    await store.editar(entrada.id, { contenido: "dos" }, { actor: "persona" });
    expect(estadoVector(store, entrada.id).filasVec).toBe(1);
    store.close();
  });

  it("si la transacción falla no queda ni la entrada ni su vector", async () => {
    const tmp = dirTemporal();
    limpiar = tmp.limpiar;
    const store = MemoryStore.abrir(join(tmp.dir, "memoria.db"), { embedder: new EmbedderFalso() });
    store.db.exec("CREATE TRIGGER falla AFTER INSERT ON vectores BEGIN SELECT RAISE(ABORT, 'falla simulada'); END");
    await expect(store.crear({ tipo: "leccion", titulo: "t", contenido: "c", ...enRepo }, { actor: "persona" })).rejects.toThrow(/falla simulada/);
    expect(store.db.prepare("SELECT count(*) AS n FROM entradas").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT count(*) AS n FROM entradas_vec").get()).toEqual({ n: 0 });
    store.close();
  });

  it("sin modelo guarda la entrada con el vector faltante y al arrancar con modelo lo regenera; también si cambia el modelo", async () => {
    const tmp = dirTemporal();
    limpiar = tmp.limpiar;
    const ruta = join(tmp.dir, "memoria.db");
    const caido = new EmbedderFalso();
    caido.fallar = true;
    const sinModelo = MemoryStore.abrir(ruta, { embedder: caido });
    const { entrada } = await sinModelo.crear({ tipo: "leccion", titulo: "t", contenido: "c", ...enRepo }, { actor: "persona" });
    expect(estadoVector(sinModelo, entrada.id)).toEqual({ meta: { estado: "faltante", model_id: null, dims: null }, filasVec: 0 });
    sinModelo.close();

    const conModelo = MemoryStore.abrir(ruta, { embedder: new EmbedderFalso() });
    expect(conModelo.vectoresPendientes()).toEqual([entrada.id]);
    expect(await conModelo.regenerarVectores()).toBe(1);
    expect(estadoVector(conModelo, entrada.id).meta).toMatchObject({ estado: "ok", model_id: "falso/bolsa-de-palabras" });
    conModelo.close();

    const otroModelo = MemoryStore.abrir(ruta, { embedder: new EmbedderFalso("falso/otro-modelo") });
    expect(otroModelo.vectoresPendientes()).toEqual([entrada.id]);
    await otroModelo.regenerarVectores();
    expect(estadoVector(otroModelo, entrada.id)).toMatchObject({ meta: { model_id: "falso/otro-modelo" }, filasVec: 1 });
    expect(otroModelo.vectoresPendientes()).toEqual([]);
    otroModelo.close();
  });
});
