import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargarConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/store/store.js";
import { REPO, dirTemporal, storeTemporal } from "../helpers/temp.js";

const enRepo = { ambito: "repo" as const, ambitoRef: REPO };

describe("revisiones y restauración", () => {
  let t: ReturnType<typeof storeTemporal>;
  afterEach(() => t.cerrar());

  it("cada edición deja una revisión y restaurar agrega otra sin borrar ninguna", async () => {
    t = storeTemporal();
    const { entrada } = await t.store.crear({ tipo: "leccion", titulo: "v1", contenido: "primera versión", ...enRepo }, { actor: "persona" });
    expect(t.store.revisiones(entrada.id)).toHaveLength(1);
    await t.store.editar(entrada.id, { titulo: "v2", contenido: "segunda versión" }, { actor: "persona" });
    await t.store.editar(entrada.id, { titulo: "v3", contenido: "tercera versión" }, { actor: "persona" });
    expect(t.store.revisiones(entrada.id)).toHaveLength(3);

    const { entrada: restaurada } = await t.store.restaurar(entrada.id, 1, { actor: "persona" });
    expect(restaurada).toMatchObject({ titulo: "v1", contenido: "primera versión", validacion: "validada" });
    const revs = t.store.revisiones(entrada.id);
    expect(revs.map((r) => r.numero)).toEqual([1, 2, 3, 4]);
    expect(revs.map((r) => r.instantanea.titulo)).toEqual(["v1", "v2", "v3", "v1"]);
    expect(revs[3]?.accion).toBe("restaurar:1");
  });

  it("restaurar una validada por el agente la devuelve a pendiente", async () => {
    t = storeTemporal();
    const { entrada } = await t.store.crear({ tipo: "leccion", titulo: "v1", contenido: "uno", ...enRepo }, { actor: "persona" });
    await t.store.editar(entrada.id, { contenido: "dos" }, { actor: "persona" });
    const { entrada: restaurada } = await t.store.restaurar(entrada.id, 1, { actor: "agente" });
    expect(restaurada).toMatchObject({ contenido: "uno", validacion: "pendiente" });
    await expect(t.store.restaurar(entrada.id, 9, { actor: "persona" })).rejects.toMatchObject({ codigo: "revision_no_encontrada" });
  });

  it("sin modelo, la entrada se guarda con el vector marcado como faltante", async () => {
    t = storeTemporal();
    const { entrada } = await t.store.crear({ tipo: "leccion", titulo: "t", contenido: "c", ...enRepo }, { actor: "agente" });
    const fila = t.store.db.prepare("SELECT estado, model_id FROM vectores WHERE entrada_id = ?").get(entrada.id);
    expect(fila).toEqual({ estado: "faltante", model_id: null });
    expect(t.store.vectoresPendientes()).toEqual([entrada.id]);
  });
});

describe("base local única", () => {
  it("el almacén vive en un único memoria.db del directorio de datos y dos aperturas ven lo mismo", async () => {
    const { dir, limpiar } = dirTemporal();
    try {
      const config = cargarConfig({ AGENT_MEMORY_HOME: dir });
      expect(config.dbPath).toBe(join(dir, "memoria.db"));
      const a = MemoryStore.abrir(config.dbPath);
      const { entrada } = await a.crear({ tipo: "preferencia", titulo: "Idioma", contenido: "Responder en español", ambito: "global", ambitoRef: null }, { actor: "persona" });
      const b = MemoryStore.abrir(config.dbPath);
      expect(b.obtener(entrada.id).titulo).toBe("Idioma");
      a.close();
      b.close();
      expect(existsSync(config.dbPath)).toBe(true);
      const bases = readdirSync(dir).filter((f) => f.endsWith(".db"));
      expect(bases).toEqual(["memoria.db"]);
    } finally {
      limpiar();
    }
  });
});
