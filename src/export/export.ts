import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entrada, Revision, Validacion } from "../domain/types.js";
import { ReglaError } from "../domain/types.js";
import type { MemoryStore } from "../store/store.js";

// Exportación a markdown: un archivo por entrada, legible sin el servicio, con el
// contenido y sus estados en la cabecera YAML. Por defecto, las activas; completa, todas con su
// historia. Restaurar desde una exportación queda fuera del producto.

export interface OpcionesExportacion {
  /** Todas las entradas (reemplazadas, vencidas y rechazadas incluidas) con sus revisiones. */
  completa?: boolean;
}

export interface Exportacion {
  destino: string;
  archivos: number;
  completa: boolean;
}

/**
 * Activas = las que el agente recibe por defecto: vida activa, vigentes y no rechazadas.
 * La completa no filtra nada.
 */
export function entradasAExportar(store: MemoryStore, opciones: OpcionesExportacion): Entrada[] {
  const filtros = opciones.completa
    ? { incluirReemplazadas: true, incluirVencidas: true, validacion: ["pendiente", "validada", "rechazada"] as Validacion[] }
    : {};
  return store.listar(filtros, 1_000_000).sort((a, b) => a.id - b.id);
}

/** Escribe la exportación en `destino`, que debe no existir o estar vacío: nunca pisa archivos. */
export function exportar(store: MemoryStore, destino: string, opciones: OpcionesExportacion = {}): Exportacion {
  if (existsSync(destino) && !statSync(destino).isDirectory()) {
    throw new ReglaError("destino_ocupado", `${destino} ya existe y no es una carpeta: elegí una nueva`);
  }
  if (existsSync(destino) && readdirSync(destino).length > 0) {
    throw new ReglaError("destino_ocupado", `la carpeta ${destino} no está vacía: elegí una nueva`);
  }
  mkdirSync(destino, { recursive: true, mode: 0o700 });
  const entradas = entradasAExportar(store, opciones);
  for (const e of entradas) {
    const revisiones = opciones.completa ? store.revisiones(e.id) : [];
    writeFileSync(join(destino, nombreArchivo(e)), markdown(e, revisiones), { mode: 0o600, flag: "wx" });
  }
  return { destino, archivos: entradas.length, completa: Boolean(opciones.completa) };
}

export function nombreArchivo(e: Pick<Entrada, "id" | "titulo">): string {
  const slug = e.titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${String(e.id).padStart(5, "0")}${slug ? `-${slug}` : ""}.md`;
}

export function markdown(e: Entrada, revisiones: Revision[]): string {
  const cabecera: [string, unknown][] = [
    ["id", e.id],
    ["titulo", e.titulo],
    ["tipo", e.tipo],
    ["ambito", e.ambito],
    ["ambito_ref", e.ambitoRef],
    ["vida", e.vida],
    ["vigencia_hasta", e.vigenciaHasta],
    ["validacion", e.validacion],
    ["validacion_via", e.validacionVia],
    ["motivo_rechazo", e.motivoRechazo],
    ["reemplaza_a", e.reemplazaA],
    ["reemplazada_por", e.reemplazadaPor],
    ["caducidad_por", e.caducidad?.actor ?? null],
    ["caducidad_fecha", e.caducidad?.fecha ?? null],
    ["creada_en", e.creadaEn],
    ["actualizada_en", e.actualizadaEn],
    ["validada_en", e.validadaEn],
    ["verificada_en", e.verificadaEn],
    ["usada_en", e.usadaEn],
    ["usos", e.usos],
    ["mostrada_en", e.mostradaEn],
    ["mostrada_veces", e.mostradaVeces],
    ["leida_en", e.leidaEn],
    ["leida_veces", e.leidaVeces],
  ];
  const partes = ["---", ...cabecera.map(([k, v]) => `${k}: ${yaml(v)}`), "---", "", `# ${e.titulo}`, "", e.contenido, ""];
  if (revisiones.length) {
    partes.push("## Revisiones", "");
    for (const r of revisiones) {
      partes.push(
        `### Revisión ${r.numero} · ${r.accion} · ${r.actor} · ${r.creadaEn}`,
        "",
        `- validacion: ${r.instantanea.validacion ?? "—"}`,
        `- vida: ${r.instantanea.vida}`,
        `- vigencia_hasta: ${r.instantanea.vigenciaHasta ?? "—"}`,
        `- titulo: ${r.instantanea.titulo}`,
        "",
        `${cerco(r.instantanea.contenido)}text`,
        r.instantanea.contenido,
        cerco(r.instantanea.contenido),
        "",
      );
    }
  }
  return partes.join("\n");
}

/** Cerco de bloque más largo que cualquier tira de comillas invertidas del texto: el contenido va tal cual. */
function cerco(texto: string): string {
  const mayor = Math.max(0, ...(texto.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(Math.max(3, mayor + 1));
}

/** Escalar YAML: null, números y textos siempre entre comillas dobles con escapes JSON (válidos en YAML). */
function yaml(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}
