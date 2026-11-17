import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, vectorBlob, type Database } from "../../src/db/driver.js";
import { DIMENSIONES, VERSION_ESQUEMA, migrar } from "../../src/db/schema.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { dirTemporal } from "../helpers/temp.js";

// La migración de importaciones va al final de la lista: suma sus tablas y la marca en `entradas` sin tocar una fila.
// Los números de versión salen de la lista, nunca escritos a mano.

const ANTERIOR = VERSION_ESQUEMA - 1;
const embedder = new EmbedderFalso();
let dir: string;
let limpiar: () => void;

beforeEach(() => ({ dir, limpiar } = dirTemporal()));
afterEach(() => limpiar());

const n = (db: Database, tabla: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get() as { n: number | bigint }).n);
const version = (db: Database) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const TABLAS = ["entradas", "revisiones", "relaciones", "vectores", "entradas_vec"];

/** Base en la versión anterior con el volumen de una memoria real: 200 entradas con historia, relaciones y vectores. */
async function baseAnterior(ruta: string): Promise<void> {
  const db = openDatabase(ruta);
  migrar(db, { hasta: ANTERIOR });
  const ins = db.prepare(
    "INSERT INTO entradas (id, tipo, titulo, contenido, ambito, ambito_ref, validacion, creada_en, actualizada_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let id = 1; id <= 200; id++) {
    const proyecto = id % 10 === 0;
    ins.run(id, proyecto ? "proyecto" : "leccion", `Entrada ${id}`, `contenido sintético ${id}`, "global", null, proyecto ? null : "validada", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
    db.prepare("INSERT INTO entradas_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), vectorBlob(await embedder.embedPassage(`Entrada ${id}`)));
    db.prepare("INSERT INTO vectores VALUES (?, 'ok', ?, ?, '2026-11-02T00:00:00.000Z')").run(id, embedder.modelId, DIMENSIONES);
    db.prepare("INSERT INTO revisiones VALUES (?, 1, 'crear', 'agente', '{}', '2026-11-01T00:00:00.000Z')").run(id);
    if (id > 1) db.prepare("INSERT INTO relaciones VALUES (?, ?, '2026-11-02T00:00:00.000Z')").run(id, id - 1);
  }
  db.close();
}

describe("migración de importaciones", () => {
  it("pasa a la versión siguiente con las mismas filas, sus tablas y la marca nula", async () => {
    const ruta = join(dir, "memoria.db");
    await baseAnterior(ruta);
    const db = openDatabase(ruta);
    expect(version(db)).toBe(ANTERIOR);
    const antes = Object.fromEntries(TABLAS.map((t) => [t, n(db, t)]));
    expect(antes).toEqual({ entradas: 200, revisiones: 200, relaciones: 199, vectores: 200, entradas_vec: 200 });

    expect(migrar(db)).toBe(VERSION_ESQUEMA);
    expect(version(db)).toBe(VERSION_ESQUEMA);
    expect(Object.fromEntries(TABLAS.map((t) => [t, n(db, t)]))).toEqual(antes);
    for (const t of ["importaciones", "importacion_entradas", "importacion_relaciones"]) expect(n(db, t)).toBe(0);
    expect(n(db, "entradas WHERE importacion_id IS NOT NULL")).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    db.close();
  });

  it("el texto en espera no puede quedar en una entrada resuelta", () => {
    const db = openDatabase(":memory:");
    migrar(db);
    db.prepare("INSERT INTO importaciones (id, archivo, huella, ambito, importada_en) VALUES (1, 'a.zip', 'h', 'global', 'x')").run();
    db.prepare("INSERT INTO importacion_entradas (importacion_id, entrada_zip, tipo, titulo, contenido) VALUES (1, 1, 'leccion', 't', 'c')").run();
    expect(() => db.prepare("UPDATE importacion_entradas SET resolucion = 'descartar' WHERE entrada_zip = 1").run()).toThrow(/CHECK/);
    db.close();
  });
});
