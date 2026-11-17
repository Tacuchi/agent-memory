import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { transaction, type Database } from "./driver.js";

/** Dimensiones de la proyección vectorial (modelo multilingüe local). */
export const DIMENSIONES = 384;

/** Marca de la migración que reconstruye `entradas` (no cabe en una transacción común: ver `reconstruirEntradas`). */
const RECONSTRUIR_ENTRADAS = Symbol("reconstruir-entradas");

// Esquema versionado con `PRAGMA user_version`. Cada migración corre una sola vez, en orden y
// en su propia transacción.
const MIGRACIONES: readonly (string | typeof RECONSTRUIR_ENTRADAS)[] = [
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
  // Acceso remoto desde la web (plan 008): el nombre de la PC dueña de cada enlace y el alcance que lleva un código.
  `
  ALTER TABLE remoto_enlaces ADD COLUMN nombre TEXT;
  ALTER TABLE remoto_codigos ADD COLUMN alcance TEXT;
  `,
  // Actividad por conexión (0.4.1): lo que esta PC leyó de cada otra, por la huella de la dueña (sobrevive a renombrar
  // y a volver a enlazar). Queda solo en esta PC.
  `
  CREATE TABLE remoto_consultas (
    id          INTEGER PRIMARY KEY,
    fecha       TEXT NOT NULL,
    huella      TEXT NOT NULL,
    origen      TEXT NOT NULL,
    herramienta TEXT NOT NULL,
    pedido      TEXT,
    ids         TEXT,
    resultado   TEXT NOT NULL CHECK (resultado IN ('lectura','rechazo')),
    motivo      TEXT
  );
  CREATE INDEX remoto_consultas_huella ON remoto_consultas(huella, id);
  `,
  // Memoria más presente (plan 009): `tipo` deja de estar cerrado en la base (la lista vive en el código) y la regla
  // proyecto/validación también (`esConocimiento`); se suman los contadores de «mostrada» y «leída».
  RECONSTRUIR_ENTRADAS,
  // Modo directo: la dirección de la dueña de cada enlace canjeado sin relé (null = por relé).
  `ALTER TABLE remoto_enlaces ADD COLUMN direccion TEXT;`,
];

export const VERSION_ESQUEMA = MIGRACIONES.length;

/** Días que vive la copia previa a una reconstrucción después de una actualización correcta. */
export const DIAS_COPIA_PREVIA = 7;
const PREFIJO_COPIA = "copia-previa-esquema-";

export interface OpcionesMigrar {
  /** Última versión a aplicar (pruebas: armar una base de una versión anterior). */
  hasta?: number;
  /** Se llama en cada paso de la reconstrucción; si lanza, la reconstrucción se revierte (pruebas de falla a mitad). */
  observar?: (paso: "copiada" | "reconstruida" | "verificada") => void;
}

export function migrar(db: Database, opciones: OpcionesMigrar = {}): number {
  const actual = versionDe(db);
  const destino = opciones.hasta ?? VERSION_ESQUEMA;
  if (actual > VERSION_ESQUEMA) {
    throw new Error(`la base tiene el esquema ${actual}, más nuevo que el ${VERSION_ESQUEMA} de esta versión`);
  }
  for (let v = actual; v < destino; v++) {
    const migracion = MIGRACIONES[v];
    if (migracion === RECONSTRUIR_ENTRADAS) {
      reconstruirEntradas(db, v + 1, actual > 0, opciones.observar);
      continue;
    }
    transaction(db, () => {
      db.exec(migracion as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return destino;
}

function versionDe(db: Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Ruta del archivo de la base, o null si vive en memoria. */
export function rutaBase(db: Database): string | null {
  const filas = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
  const archivo = filas.find((f) => f.name === "main")?.file ?? "";
  return archivo ? archivo : null;
}

/** Copias previas a una reconstrucción que siguen junto a la base. */
export function copiasPrevias(db: Database): string[] {
  const base = rutaBase(db);
  if (!base) return [];
  const dir = dirname(base);
  let nombres: string[];
  try {
    nombres = readdirSync(dir);
  } catch {
    return [];
  }
  return nombres.filter((n) => n.startsWith(PREFIJO_COPIA) && n.endsWith(".db")).map((n) => join(dir, n));
}

/** Borra las copias previas con más de `DIAS_COPIA_PREVIA` días; devuelve las borradas. */
export function vencerCopiasPrevias(db: Database, ahora: Date): string[] {
  const limite = ahora.getTime() - DIAS_COPIA_PREVIA * 86_400_000;
  const borradas: string[] = [];
  for (const ruta of copiasPrevias(db)) {
    try {
      if (statSync(ruta).mtimeMs <= limite) {
        rmSync(ruta, { force: true });
        borradas.push(ruta);
      }
    } catch {
      // Otro proceso la borró o no se puede leer: se reintenta la próxima vez.
    }
  }
  return borradas;
}

/**
 * Copia completa y consistente de la base antes de reconstruir, legible solo por la cuenta de la persona. Si ya hay
 * una copia de esta versión (un intento anterior falló y la base quedó igual), se conserva la primera.
 */
function copiarAntes(db: Database, version: number): string | null {
  const base = rutaBase(db);
  if (!base) return null;
  const destino = join(dirname(base), `${PREFIJO_COPIA}${version}.db`);
  if (existsSync(destino)) return destino;
  const temporal = join(dirname(base), `.${basename(destino)}.${process.pid}.tmp`);
  rmSync(temporal, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(temporal);
    chmodSync(temporal, 0o600);
    if (existsSync(destino)) return destino;
    renameSync(temporal, destino);
  } finally {
    rmSync(temporal, { force: true });
  }
  return destino;
}

const TABLA_ENTRADAS = `
  CREATE TABLE entradas_nueva (
    id              INTEGER PRIMARY KEY,
    tipo            TEXT NOT NULL CHECK (length(trim(tipo)) > 0),
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
    verificada_en   TEXT,
    usada_en        TEXT,
    usos            INTEGER NOT NULL DEFAULT 0,
    mostrada_en     TEXT,
    mostrada_veces  INTEGER NOT NULL DEFAULT 0,
    leida_en        TEXT,
    leida_veces     INTEGER NOT NULL DEFAULT 0,
    CHECK ((ambito = 'global') = (ambito_ref IS NULL)),
    CHECK (validacion <> 'rechazada' OR length(trim(motivo_rechazo)) > 0)
  );`;

/** Índices y triggers de `entradas`: `DROP TABLE` se los lleva y hay que recrearlos. */
const COLGANTES_ENTRADAS = `
  CREATE INDEX entradas_ambito ON entradas(ambito, ambito_ref);
  CREATE INDEX entradas_validacion ON entradas(validacion);
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
  CREATE TRIGGER vectores_ad AFTER DELETE ON entradas BEGIN
    DELETE FROM entradas_vec WHERE rowid = old.id;
  END;`;

const TABLAS_CONTADAS = ["entradas", "revisiones", "relaciones", "vectores", "entradas_vec"] as const;

function conteos(db: Database): Record<string, number> {
  return Object.fromEntries(TABLAS_CONTADAS.map((t) => [t, Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number | bigint }).n)]));
}

function violacionesClaves(db: Database): number {
  return db.prepare("PRAGMA foreign_key_check").all().length;
}

/**
 * Reconstruye `entradas` según la receta de SQLite para cambiar una tabla: las claves foráneas se apagan FUERA de la
 * transacción (dentro, SQLite ignora el pragma y el `DROP` borraría en cascada revisiones, relaciones y vectores),
 * las columnas se copian por nombre y, antes de confirmar, se comparan los conteos y la integridad. Cualquier falla
 * revierte todo: la base queda en la versión anterior y el error nombra la copia previa.
 */
function reconstruirEntradas(db: Database, versionNueva: number, conDatos: boolean, observar: OpcionesMigrar["observar"]): void {
  let copia: string | null = null;
  try {
    copia = conDatos ? copiarAntes(db, versionNueva - 1) : null;
  } catch (error) {
    throw new Error(`no se pudo hacer la copia previa para actualizar la base al esquema ${versionNueva}; la base no se tocó: ${(error as Error).message}`, { cause: error });
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    transaction(db, () => {
      // Otro proceso pudo migrar mientras se esperaba el candado.
      if (versionDe(db) >= versionNueva) return;
      observar?.("copiada");
      const antes = conteos(db);
      const violacionesAntes = violacionesClaves(db);
      const columnas = (db.prepare("PRAGMA table_info(entradas)").all() as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
      db.exec(TABLA_ENTRADAS);
      db.exec(`INSERT INTO entradas_nueva (${columnas}) SELECT ${columnas} FROM entradas`);
      db.exec("DROP TABLE entradas");
      db.exec("ALTER TABLE entradas_nueva RENAME TO entradas");
      db.exec(COLGANTES_ENTRADAS);
      observar?.("reconstruida");
      const despues = conteos(db);
      for (const t of TABLAS_CONTADAS) {
        if (despues[t] !== antes[t]) throw new Error(`la tabla ${t} pasó de ${antes[t]} a ${despues[t]} filas`);
      }
      const integridad = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((f) => f.integrity_check);
      if (integridad.join() !== "ok") throw new Error(`la verificación de integridad dio: ${integridad.slice(0, 3).join("; ")}`);
      if (violacionesClaves(db) > violacionesAntes) throw new Error("aparecieron referencias rotas entre tablas");
      db.exec("INSERT INTO entradas_fts(entradas_fts) VALUES ('integrity-check')");
      observar?.("verificada");
      db.exec(`PRAGMA user_version = ${versionNueva}`);
    });
  } catch (error) {
    const donde = copia ? `; la copia previa está en ${copia}` : "";
    throw new Error(`no se pudo actualizar la base al esquema ${versionNueva} y quedó como estaba${donde}: ${(error as Error).message}`, { cause: error });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
