import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { transaction } from "../db/driver.js";
import type { MemoryStore } from "../store/store.js";

// Purga física (AC-27): la única forma de borrar. Solo la CLI la ofrece y abre la base
// directamente; ninguna operación de la API purga. Borra la entrada con toda su historia en una
// transacción y anota en `purgas.log` solo el id y la fecha, nunca el contenido.

export interface Purga {
  id: number;
  fecha: string;
  /** Entradas que apuntaban a la purgada por reemplazo y quedaron sin esa referencia. */
  referenciasLimpiadas: number[];
}

export function purgar(store: MemoryStore, id: number, logPath: string): Purga {
  const db = store.db;
  store.obtener(id);
  const fecha = store.ahora().toISOString();
  const referenciasLimpiadas = transaction(db, () => {
    const afectadas = db
      .prepare("SELECT id FROM entradas WHERE (reemplaza_a = ? OR reemplazada_por = ?) AND id <> ? ORDER BY id")
      .all(id, id, id) as { id: number }[];
    db.prepare("UPDATE entradas SET reemplaza_a = NULL WHERE reemplaza_a = ?").run(id);
    db.prepare("UPDATE entradas SET reemplazada_por = NULL WHERE reemplazada_por = ?").run(id);
    db.prepare("DELETE FROM relaciones WHERE origen_id = ? OR destino_id = ?").run(id, id);
    db.prepare("DELETE FROM revisiones WHERE entrada_id = ?").run(id);
    db.prepare("DELETE FROM vectores WHERE entrada_id = ?").run(id);
    db.prepare("DELETE FROM entradas_vec WHERE rowid = ?").run(BigInt(id));
    // El trigger de borrado quita también las filas de texto (FTS5).
    db.prepare("DELETE FROM entradas WHERE id = ?").run(id);
    // El registro se escribe dentro de la transacción: si no se puede anotar, no se purga.
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${fecha}\tpurga\t${id}\n`, { mode: 0o600 });
    return afectadas.map((f) => f.id);
  });
  return { id, fecha, referenciasLimpiadas };
}
