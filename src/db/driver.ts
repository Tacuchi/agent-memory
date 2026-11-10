import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

/**
 * Driver elegido por la prueba de T1.1 (tests/spike/driver.test.ts): `node:sqlite`.
 * Carga sqlite-vec 0.1.9, trae FTS5 y revierte juntas la fila y su vector; gana sobre
 * better-sqlite3 porque no agrega ninguna dependencia nativa propia.
 */
export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path, { allowExtension: true });
  db.loadExtension(getLoadablePath());
  db.enableLoadExtension(false);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** Corre `work` en una transacción; cualquier excepción revierte todo lo escrito dentro. */
export function transaction<T>(db: Database, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** sqlite-vec recibe el vector como BLOB de float32. */
export function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
