import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, transaction, vectorBlob, type Database } from "../../src/db/driver.js";

// Guarda de regresión de la decisión de T1.1: el driver elegido (node:sqlite) tiene que
// seguir cargando sqlite-vec 0.1.9, traer FTS5 y revertir juntas la fila y su vector.
describe("driver SQLite elegido (node:sqlite)", () => {
  let dir: string;
  let db: Database;

  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function open(): Database {
    dir = mkdtempSync(join(tmpdir(), "agent-memory-spike-"));
    db = openDatabase(join(dir, "spike.db"));
    return db;
  }

  it("carga sqlite-vec en la versión fijada", () => {
    const row = open().prepare("select vec_version() as v").get() as { v: string };
    expect(row.v).toBe("v0.1.9");
  });

  it("trae FTS5", () => {
    const d = open();
    d.exec("create virtual table t using fts5(texto)");
    d.prepare("insert into t(texto) values (?)").run("búsqueda por texto completo");
    const hit = d.prepare("select count(*) as n from t where t match ?").get("texto") as { n: number };
    expect(hit.n).toBe(1);
  });

  it("revierte juntas la fila y su vector cuando la transacción falla", () => {
    const d = open();
    d.exec("create table e(id integer primary key, titulo text not null)");
    d.exec("create virtual table v using vec0(embedding float[3])");
    const vector = vectorBlob(new Float32Array([0.1, 0.2, 0.3]));

    expect(() =>
      transaction(d, () => {
        d.prepare("insert into e(id, titulo) values (1, 'a')").run();
        d.prepare("insert into v(rowid, embedding) values (1, ?)").run(vector);
        throw new Error("fallo a mitad de la transacción");
      }),
    ).toThrow("fallo a mitad");

    expect((d.prepare("select count(*) as n from e").get() as { n: number }).n).toBe(0);
    expect((d.prepare("select count(*) as n from v").get() as { n: number }).n).toBe(0);

    transaction(d, () => {
      d.prepare("insert into e(id, titulo) values (2, 'b')").run();
      d.prepare("insert into v(rowid, embedding) values (2, ?)").run(vector);
    });
    const near = d
      .prepare("select rowid as id from v where embedding match ? and k = 1")
      .get(vector) as { id: number };
    expect(near.id).toBe(2);
  });
});
