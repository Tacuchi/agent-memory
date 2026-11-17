import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VERSION_ESQUEMA } from "../db/schema.js";
import { tieneCadenaAleatoria } from "../domain/redact.js";
import { ReglaError, type Entrada } from "../domain/types.js";
import { entradasAExportar } from "../export/export.js";
import type { MemoryStore } from "../store/store.js";
import { version } from "../version.js";
import { armarPaquete, type AmbitoElegido } from "./formato.js";
import { escribirZip } from "./zip.js";

// Exportación para compartir: las activas sin el estado de trabajo (`proyecto`), filtradas por ámbito, con las
// relaciones entre ellas y un aviso por cada entrada que parece traer un secreto. Nunca pisa un archivo.

export interface AvisoSecreto {
  id: number;
  titulo: string;
  /** Tipo de patrón de secreto o `cadena_aleatoria`; nunca el valor. */
  clases: string[];
}

export interface ExportacionZip {
  destino: string;
  archivos: number;
  relaciones: number;
  avisos: AvisoSecreto[];
}

export function exportarZip(store: MemoryStore, destino: string, ambitos: readonly AmbitoElegido[] = []): ExportacionZip {
  if (existsSync(destino)) throw new ReglaError("destino_ocupado", `${destino} ya existe: elegí un archivo nuevo`);
  const entradas = entradasAExportar(store, {}).filter((e) => e.tipo !== "proyecto" && dentroDe(e, ambitos));
  if (entradas.length === 0) {
    throw new ReglaError("nada_que_exportar", ambitos.length ? "ninguna entrada activa cae en esos ámbitos: no se escribió el zip" : "no hay entradas activas para exportar: no se escribió el zip");
  }
  const ids = new Set(entradas.map((e) => e.id));
  const relaciones = relacionesEntre(store, ids);
  const ahora = store.ahora();
  const archivos = armarPaquete({
    entradas,
    relaciones,
    agentMemory: version(),
    esquema: VERSION_ESQUEMA,
    exportadoEn: ahora.toISOString(),
    ambitos,
  });
  mkdirSync(dirname(destino), { recursive: true, mode: 0o700 });
  writeFileSync(destino, escribirZip(archivos, ahora), { mode: 0o600, flag: "wx" });
  return { destino, archivos: entradas.length, relaciones: relaciones.length, avisos: avisosDeSecretos(store, entradas) };
}

function dentroDe(e: Entrada, ambitos: readonly AmbitoElegido[]): boolean {
  return ambitos.length === 0 || ambitos.some((a) => a.ambito === e.ambito && a.ref === e.ambitoRef);
}

/** Cada relación una vez, entre entradas que viajan en el zip. */
function relacionesEntre(store: MemoryStore, ids: ReadonlySet<number>): [number, number][] {
  const filas = store.db.prepare("SELECT origen_id AS a, destino_id AS b FROM relaciones ORDER BY origen_id, destino_id").all() as { a: number; b: number }[];
  return filas.filter((f) => ids.has(f.a) && ids.has(f.b)).map((f) => [f.a, f.b]);
}

/** Los mismos patrones que redactan al guardar (atrapan lo guardado antes de un patrón) y las cadenas aleatorias. */
function avisosDeSecretos(store: MemoryStore, entradas: readonly Entrada[]): AvisoSecreto[] {
  const avisos: AvisoSecreto[] = [];
  for (const e of entradas) {
    const texto = `${e.titulo}\n${e.contenido}`;
    const clases = [...store.redactarTexto(texto).redactados, ...(tieneCadenaAleatoria(texto) ? ["cadena_aleatoria"] : [])];
    if (clases.length) avisos.push({ id: e.id, titulo: store.redactarTexto(e.titulo).texto, clases });
  }
  return avisos;
}
