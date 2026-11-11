import { transaction, type Database } from "./driver.js";

/** Dimensiones de la proyección vectorial (modelo multilingüe local). */
export const DIMENSIONES = 384;

// Esquema versionado con `PRAGMA user_version`. Cada migración corre una sola vez, en orden y
// en su propia transacción.
const MIGRACIONES: readonly string[] = [
  `
  CREATE TABLE entradas (
    id              INTEGER PRIMARY KEY,
    tipo            TEXT NOT NULL CHECK (tipo IN ('leccion','decision','convencion','referencia','preferencia','proyecto')),
    titulo          TEXT NOT NULL,
    contenido       TEXT NOT NULL,
    ambito          TEXT NOT NULL CHECK (ambito IN ('global','proyecto','repo')),
    ambito_ref      TEXT,
    vida            TEXT NOT NULL DEFAULT 'activa' CHECK (vida IN ('activa','reemplazada')),
    vigencia_hasta  TEXT,
    reemplazada_por INTEGER REFERENCES entradas(id),
    reemplaza_a     INTEGER REFERENCES entradas(id),
    validacion      TEXT CHECK (validacion IN ('pendiente','validada','rechazada')),
    validacion_via  TEXT CHECK (validacion_via IN ('web','mcp','conversacion')),
    motivo_rechazo  TEXT,
    caducidad       TEXT,
    creada_en       TEXT NOT NULL,
    actualizada_en  TEXT NOT NULL,
    validada_en     TEXT,
    usada_en        TEXT,
    usos            INTEGER NOT NULL DEFAULT 0,
    CHECK ((tipo = 'proyecto') = (validacion IS NULL)),
    CHECK ((ambito = 'global') = (ambito_ref IS NULL)),
    CHECK (validacion <> 'rechazada' OR length(trim(motivo_rechazo)) > 0)
  );
  CREATE INDEX entradas_ambito ON entradas(ambito, ambito_ref);
  CREATE INDEX entradas_validacion ON entradas(validacion);

  CREATE TABLE revisiones (
    entrada_id  INTEGER NOT NULL REFERENCES entradas(id) ON DELETE CASCADE,
    numero      INTEGER NOT NULL,
    accion      TEXT NOT NULL,
    actor       TEXT NOT NULL CHECK (actor IN ('agente','persona')),
    instantanea TEXT NOT NULL,
    creada_en   TEXT NOT NULL,
    PRIMARY KEY (entrada_id, numero)
  );

  CREATE TABLE relaciones (
    origen_id  INTEGER NOT NULL REFERENCES entradas(id) ON DELETE CASCADE,
    destino_id INTEGER NOT NULL REFERENCES entradas(id) ON DELETE CASCADE,
    creada_en  TEXT NOT NULL,
    PRIMARY KEY (origen_id, destino_id),
    CHECK (origen_id <> destino_id)
  );
  CREATE INDEX relaciones_destino ON relaciones(destino_id);

  CREATE VIRTUAL TABLE entradas_fts USING fts5(
    titulo, contenido,
    content = 'entradas', content_rowid = 'id',
    tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
  );
  CREATE TRIGGER entradas_fts_ai AFTER INSERT ON entradas BEGIN
    INSERT INTO entradas_fts(rowid, titulo, contenido) VALUES (new.id, new.titulo, new.contenido);
  END;
  CREATE TRIGGER entradas_fts_ad AFTER DELETE ON entradas BEGIN
    INSERT INTO entradas_fts(entradas_fts, rowid, titulo, contenido) VALUES ('delete', old.id, old.titulo, old.contenido);
  END;
  CREATE TRIGGER entradas_fts_au AFTER UPDATE OF titulo, contenido ON entradas BEGIN
    INSERT INTO entradas_fts(entradas_fts, rowid, titulo, contenido) VALUES ('delete', old.id, old.titulo, old.contenido);
    INSERT INTO entradas_fts(rowid, titulo, contenido) VALUES (new.id, new.titulo, new.contenido);
  END;

  CREATE VIRTUAL TABLE entradas_vec USING vec0(embedding float[${DIMENSIONES}]);
  CREATE TABLE vectores (
    entrada_id     INTEGER PRIMARY KEY REFERENCES entradas(id) ON DELETE CASCADE,
    estado         TEXT NOT NULL CHECK (estado IN ('ok','faltante')),
    model_id       TEXT,
    dims           INTEGER,
    actualizado_en TEXT NOT NULL
  );
  CREATE TRIGGER vectores_ad AFTER DELETE ON entradas BEGIN
    DELETE FROM entradas_vec WHERE rowid = old.id;
  END;
  `,
  // Fecha en que la persona confirmó que la entrada sigue vigente (vista de revisión).
  `ALTER TABLE entradas ADD COLUMN verificada_en TEXT;`,
  // Enlace remoto de solo lectura (plan 005): ajustes, dispositivos de la dueña, enlaces de la lectora, códigos y registro.
  `
  CREATE TABLE remoto_ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE remoto_dispositivos (
    id            INTEGER PRIMARY KEY,
    nombre        TEXT NOT NULL,
    clave_publica TEXT NOT NULL UNIQUE,
    buzon         TEXT NOT NULL UNIQUE,
    enlazado_en   TEXT NOT NULL,
    usado_en      TEXT,
    vence_en      TEXT NOT NULL,
    revocado_en   TEXT,
    alcance       TEXT NOT NULL DEFAULT '{"ambitos":[],"no_validadas":false}'
  );

  CREATE TABLE remoto_enlaces (
    id          INTEGER PRIMARY KEY,
    origen      TEXT NOT NULL UNIQUE,
    buzon       TEXT NOT NULL,
    clave_duena TEXT NOT NULL,
    enlace_id   INTEGER NOT NULL,
    vence_en    TEXT NOT NULL,
    creado_en   TEXT NOT NULL
  );

  CREATE TABLE remoto_codigos (
    id        INTEGER PRIMARY KEY,
    buzon     TEXT NOT NULL UNIQUE,
    huella    TEXT NOT NULL,
    vence_en  TEXT NOT NULL,
    intentos  INTEGER NOT NULL DEFAULT 0,
    usado_en  TEXT,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE remoto_registro (
    id             INTEGER PRIMARY KEY,
    fecha          TEXT NOT NULL,
    dispositivo_id INTEGER,
    dispositivo    TEXT,
    herramienta    TEXT NOT NULL,
    pedido         TEXT,
    ids            TEXT,
    resultado      TEXT NOT NULL CHECK (resultado IN ('lectura','rechazo')),
    motivo         TEXT
  );
  CREATE INDEX remoto_registro_dispositivo ON remoto_registro(dispositivo_id, id);
  `,
  // Panel del relé (plan 007): uso por día sin contenido, pedidos del panel que la persona acepta o rechaza, y el
  // último uso de cada enlace de la lectora.
  `
  CREATE TABLE remoto_uso (
    dia       TEXT PRIMARY KEY,
    recibidas INTEGER NOT NULL DEFAULT 0,
    hechas    INTEGER NOT NULL DEFAULT 0,
    bytes     INTEGER NOT NULL DEFAULT 0,
    rechazos  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE remoto_pendientes (
    id          INTEGER PRIMARY KEY,
    accion      TEXT NOT NULL CHECK (accion IN ('renovar','alcance','codigo')),
    objetivo    TEXT,
    datos       TEXT,
    creado_en   TEXT NOT NULL,
    estado      TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aceptado','rechazado')),
    resuelto_en TEXT
  );

  ALTER TABLE remoto_enlaces ADD COLUMN usado_en TEXT;
  `,
];

export const VERSION_ESQUEMA = MIGRACIONES.length;

export function migrar(db: Database): number {
  const actual = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (actual > VERSION_ESQUEMA) {
    throw new Error(`la base tiene el esquema ${actual}, más nuevo que el ${VERSION_ESQUEMA} de esta versión`);
  }
  for (let v = actual; v < VERSION_ESQUEMA; v++) {
    transaction(db, () => {
      db.exec(MIGRACIONES[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return VERSION_ESQUEMA;
}
