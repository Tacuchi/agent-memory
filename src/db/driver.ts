import type { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

/**
 * Driver elegido por la prueba comparativa de drivers (tests/spike/driver.test.ts): `node:sqlite`.
 * Carga sqlite-vec 0.1.9, trae FTS5 y revierte juntas la fila y su vector; gana sobre
 * better-sqlite3 porque no agrega ninguna dependencia nativa propia.
 */
export type Database = DatabaseSync;

const sqlite = cargarSqlite();

/**
 * Carga `node:sqlite` sin su aviso de módulo experimental, se arranque el proceso como se arranque.
 * Node emite ese aviso en el instante en que carga el módulo, y a los módulos integrados de un
 * `import` estático los carga al enlazar el grafo, antes de ejecutar una sola línea propia: ningún
 * filtro puesto desde el código llegaría a tiempo. Por eso el módulo se pide aquí, en ejecución, y el
 * filtro vive solo mientras dura esa carga: descarta ese aviso y deja pasar cualquier otro.
 */
function cargarSqlite(): typeof import("node:sqlite") {
  const emitir = process.emitWarning;
  process.emitWarning = ((aviso: string | Error, ...resto: unknown[]) => {
    if (esAvisoDeSqlite(aviso, resto[0])) return;
    Reflect.apply(emitir, process, [aviso, ...resto]);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emitir;
  }
}

/** El tipo del aviso llega suelto o dentro de las opciones, según cómo se llame a `emitWarning`. */
function esAvisoDeSqlite(aviso: string | Error, tipoUOpciones: unknown): boolean {
  if (typeof aviso !== "string") return false;
  const tipo = typeof tipoUOpciones === "string" ? tipoUOpciones : (tipoUOpciones as { type?: unknown } | undefined)?.type;
  return tipo === "ExperimentalWarning" && aviso.startsWith("SQLite ");
}

export function openDatabase(path: string): Database {
  const db = new sqlite.DatabaseSync(path, { allowExtension: true });
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
