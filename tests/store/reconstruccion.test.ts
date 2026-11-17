import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, vectorBlob, type Database } from "../../src/db/driver.js";
import { DIMENSIONES, VERSION_ESQUEMA, migrar } from "../../src/db/schema.js";
import { TIPOS } from "../../src/domain/types.js";
import { Buscador } from "../../src/search/search.js";
import { MemoryStore } from "../../src/store/store.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { dirTemporal } from "../helpers/temp.js";

// Spec 007, AC-16 a AC-19 y AC-21/22: la reconstrucción de `entradas` (esquema 7) no pierde filas, se revierte
// entera si falla a mitad y deja una copia previa de 7 días; después, el tipo ya no está cerrado en la base.

const DIA = 86_400_000;
/** El esquema previo a la reconstrucción (la 7); las migraciones posteriores no la mueven. */
const ANTERIOR = 6;
const embedder = new EmbedderFalso();

let dir: string;
let limpiar: () => void;
let ruta: string;

beforeEach(() => {
  ({ dir, limpiar } = dirTemporal());
  ruta = join(dir, "memoria.db");
});
afterEach(() => limpiar());

/** Base del esquema anterior con historia: revisiones, relaciones, vectores y una entrada que reemplaza a otra. */
async function baseAnterior(): Promise<void> {
  const db = openDatabase(ruta);
  migrar(db, { hasta: ANTERIOR });
  const filas = [
    [1, "decision", "Fusión por rango recíproco", "la fusión por rango recíproco ordena texto y vector", "global", null, "validada", null],
    [2, "leccion", "Copiar columnas por nombre", "al reconstruir una tabla se copian las columnas por nombre", "repo", "repo-x", "pendiente", 1],
    [3, "proyecto", "Estado del trabajo", "pendiente la reconstrucción segura de la tabla", "proyecto", "proyecto:x", null, null],
    [4, "referencia", "Tablero del equipo", "el tablero vive en una URL interna de ejemplo", "global", null, "rechazada", null],
  ] as const;
  const ins = db.prepare(
    "INSERT INTO entradas (id, tipo, titulo, contenido, ambito, ambito_ref, validacion, reemplaza_a, motivo_rechazo, creada_en, actualizada_en, usos, usada_en, verificada_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [id, tipo, titulo, contenido, ambito, ref, validacion, reemplaza] of filas) {
    ins.run(id, tipo, titulo, contenido, ambito, ref, validacion, reemplaza, validacion === "rechazada" ? "duplicada" : null, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", id, "2026-11-03T00:00:00.000Z", null);
    const v = await embedder.embedPassage(`${titulo}\n${contenido}`);
    db.prepare("INSERT INTO entradas_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), vectorBlob(v));
    db.prepare("INSERT INTO vectores VALUES (?, 'ok', ?, ?, '2026-11-02T00:00:00.000Z')").run(id, embedder.modelId, DIMENSIONES);
    db.prepare("INSERT INTO revisiones VALUES (?, 1, 'crear', 'agente', '{}', '2026-11-01T00:00:00.000Z')").run(id);
  }
  db.prepare("INSERT INTO revisiones VALUES (1, 2, 'editar', 'persona', '{}', '2026-11-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO relaciones VALUES (1, 2, '2026-11-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO relaciones VALUES (3, 1, '2026-11-02T00:00:00.000Z')").run();
  db.close();
}

const n = (db: Database, tabla: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get() as { n: number | bigint }).n);

/** Lo que una búsqueda puede encontrar: filas, texto (FTS5) y vecinos por vector, más las columnas que se conservan. */
async function foto(db: Database) {
  const consulta = await embedder.embedQuery("reconstruir tabla por nombre");
  return {
    filas: Object.fromEntries(["entradas", "revisiones", "relaciones", "vectores", "entradas_vec"].map((t) => [t, n(db, t)])),
    texto: (db.prepare("SELECT rowid FROM entradas_fts WHERE entradas_fts MATCH ? ORDER BY rank").all('"tabla" OR "rango"') as { rowid: number }[]).map((f) => f.rowid),
    vector: (db.prepare("SELECT rowid FROM entradas_vec WHERE embedding MATCH ? AND k = 4 ORDER BY distance").all(vectorBlob(consulta)) as { rowid: number }[]).map((f) => Number(f.rowid)),
    entradas: db.prepare("SELECT id, tipo, titulo, contenido, validacion, reemplaza_a, usos, usada_en, motivo_rechazo FROM entradas ORDER BY id").all(),
  };
}

const version = (db: Database) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const clavesForaneas = (db: Database) => (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
const copias = () => readdirSync(dir).filter((f) => f.startsWith("copia-previa-"));

describe("reconstrucción de entradas (esquema 7)", () => {
  it("una base con historia conserva todas sus filas y la búsqueda encuentra lo mismo", async () => {
    await baseAnterior();
    const db = openDatabase(ruta);
    const antes = await foto(db);
    expect(antes.filas).toEqual({ entradas: 4, revisiones: 5, relaciones: 2, vectores: 4, entradas_vec: 4 });
    expect(migrar(db)).toBe(VERSION_ESQUEMA);
    expect(version(db)).toBe(VERSION_ESQUEMA);
    expect(await foto(db)).toEqual(antes);
    expect(clavesForaneas(db)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Los contadores nuevos nacen en cero; los usos de antes quedan como estaban.
    expect(db.prepare("SELECT mostrada_veces, mostrada_en, leida_veces, leida_en FROM entradas WHERE id = 1").get()).toEqual({
      mostrada_veces: 0,
      mostrada_en: null,
      leida_veces: 0,
      leida_en: null,
    });
    // El borrado en cascada sigue funcionando sobre la tabla nueva.
    db.prepare("DELETE FROM relaciones WHERE origen_id = 3").run();
    db.prepare("DELETE FROM revisiones WHERE entrada_id = 3").run();
    db.prepare("DELETE FROM entradas WHERE id = 3").run();
    expect(n(db, "vectores")).toBe(3);
    expect(n(db, "entradas_vec")).toBe(3);
    db.close();

    // La búsqueda híbrida del almacén encuentra la misma entrada.
    const store = MemoryStore.abrir(ruta, { embedder });
    const r = await new Buscador(store, embedder).buscar("copiar columnas por nombre", { filtros: { todosLosAmbitos: true } });
    expect(r.resultados[0]?.entrada.id).toBe(2);
    store.close();
  });

  it("deja una copia previa completa, legible solo por la cuenta de la persona", async () => {
    await baseAnterior();
    MemoryStore.abrir(ruta, { embedder: null }).close();
    expect(copias()).toEqual([`copia-previa-esquema-${ANTERIOR}.db`]);
    const copia = join(dir, copias()[0] as string);
    if (process.platform !== "win32") expect(statSync(copia).mode & 0o777).toBe(0o600);
    const db = openDatabase(copia);
    expect(version(db)).toBe(ANTERIOR);
    expect(n(db, "entradas")).toBe(4);
    expect(n(db, "revisiones")).toBe(5);
    db.close();
  });

  it("si falla a mitad, la base queda en la versión anterior, sin pérdidas, y el error nombra la copia", async () => {
    await baseAnterior();
    const db = openDatabase(ruta);
    const antes = await foto(db);
    const fallar = (paso: string) => {
      if (paso === "reconstruida") throw new Error("corte simulado");
    };
    expect(() => migrar(db, { observar: fallar })).toThrow(new RegExp(`quedó como estaba; la copia previa está en .*copia-previa-esquema-${ANTERIOR}\\.db: corte simulado`));
    expect(version(db)).toBe(ANTERIOR);
    expect(await foto(db)).toEqual(antes);
    expect(clavesForaneas(db)).toBe(1);
    db.close();

    // Un intento posterior conserva la primera copia y completa la actualización.
    const copia = join(dir, `copia-previa-esquema-${ANTERIOR}.db`);
    const creada = statSync(copia).mtimeMs;
    const otra = openDatabase(ruta);
    migrar(otra);
    expect(version(otra)).toBe(VERSION_ESQUEMA);
    expect(statSync(copia).mtimeMs).toBe(creada);
    otra.close();
  });

  it("una base nueva no deja copia previa", () => {
    MemoryStore.abrir(ruta, { embedder: null }).close();
    expect(copias()).toEqual([]);
  });

  it("la copia se borra sola a los 7 días, al abrir la base", async () => {
    await baseAnterior();
    // La edad de la copia sale de la fecha del archivo: el reloj de la prueba es el real.
    const ahora = new Date();
    MemoryStore.abrir(ruta, { embedder: null, reloj: () => ahora }).close();
    const copia = join(dir, copias()[0] as string);
    const hace = (dias: number) => new Date(ahora.getTime() - dias * DIA);

    utimesSync(copia, hace(6), hace(6));
    MemoryStore.abrir(ruta, { embedder: null, reloj: () => ahora }).close();
    expect(existsSync(copia)).toBe(true);

    utimesSync(copia, hace(8), hace(8));
    const store = MemoryStore.abrir(ruta, { embedder: null, reloj: () => ahora });
    expect(existsSync(copia)).toBe(false);
    store.close();
  });

  it("después, un tipo nuevo no toca la tabla y escribir un tipo desconocido lista los admitidos", async () => {
    const store = MemoryStore.abrir(ruta, { embedder: null });
    store.db
      .prepare("INSERT INTO entradas (tipo, titulo, contenido, ambito, ambito_ref, validacion, creada_en, actualizada_en) VALUES ('hallazgo', 't', 'c', 'global', NULL, 'pendiente', 'x', 'x')")
      .run();
    store.db
      .prepare("INSERT INTO entradas (tipo, titulo, contenido, ambito, ambito_ref, validacion, creada_en, actualizada_en) VALUES ('bitacora', 't', 'c', 'global', NULL, NULL, 'x', 'x')")
      .run();
    expect(n(store.db, "entradas")).toBe(2);
    await expect(store.crear({ tipo: "hallazgo", titulo: "t", contenido: "c", ambito: "global", ambitoRef: null }, { actor: "persona" })).rejects.toThrow(
      `tipo «hallazgo» no admitido; los tipos son: ${TIPOS.join(", ")}`,
    );
    store.close();
  });
});
