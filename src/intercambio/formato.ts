import { z } from "zod";
import { markdown, nombreArchivo } from "../export/export.js";
import { AMBITOS, ReglaError, type Ambito, type Entrada } from "../domain/types.js";
import type { ArchivoZip, TopesZip } from "./zip.js";

// Formato de intercambio: un `manifest.json` y un markdown por entrada, el mismo de la exportación a carpeta. El
// lector es el inverso estricto de ese markdown; del zip solo se usan el id (para las relaciones), el tipo, el
// título, el contenido y la vigencia. Estados, ámbito, contadores y fechas del zip no viajan a la memoria.

export const FORMATO = 1;
export const MANIFEST = "manifest.json";
export const CARPETA = "entradas/";

/** Topes de un zip que se importa. */
export const TOPES_IMPORTACION: TopesZip = {
  zip: 20 * 1024 * 1024,
  archivos: 2_001,
  porArchivo: 256 * 1024,
  total: 50 * 1024 * 1024,
  porNombre: { [MANIFEST]: 2 * 1024 * 1024 },
};
export const MAX_ENTRADAS = TOPES_IMPORTACION.archivos - 1;

export interface AmbitoElegido {
  ambito: Ambito;
  ref: string | null;
}

const FORMAS_AMBITO = "«global», «proyecto:<nombre>» o «repo:<id>»";

/** `global`, `proyecto:<nombre>` o `repo:<id>`. */
export function leerAmbito(texto: string): AmbitoElegido {
  const limpio = texto.trim();
  if (limpio === "global") return { ambito: "global", ref: null };
  const i = limpio.indexOf(":");
  const ambito = limpio.slice(0, i);
  const ref = limpio.slice(i + 1).trim();
  if (i > 0 && (ambito === "proyecto" || ambito === "repo") && ref) return { ambito, ref };
  throw new ReglaError("ambito_invalido", `ámbito «${texto}» no válido; se espera ${FORMAS_AMBITO}`);
}

export function textoAmbito(a: AmbitoElegido): string {
  return a.ref === null ? a.ambito : `${a.ambito}:${a.ref}`;
}

export const ambitoElegido = z
  .object({ ambito: z.enum(AMBITOS), ref: z.string().trim().min(1).max(300).nullable() })
  .strict()
  .refine((a) => (a.ambito === "global") === (a.ref === null), { message: `se espera ${FORMAS_AMBITO}` });

const idZip = z.number().int().positive();
const manifest = z.object({
  formato: z.literal(FORMATO),
  agent_memory: z.string().min(1).max(50),
  esquema: z.number().int().nonnegative(),
  exportado_en: z.string().min(1).max(40),
  cantidades: z.object({ total: z.number().int().nonnegative(), por_tipo: z.record(z.string().max(40), z.number().int().nonnegative()) }),
  filtros: z.object({ ambitos: z.array(z.string().max(400)).max(100) }),
  entradas: z.array(z.string().min(1).max(200)).max(MAX_ENTRADAS),
  relaciones: z.array(z.tuple([idZip, idZip])).max(100_000),
});
export type Manifest = z.infer<typeof manifest>;

export interface EntradaPaquete {
  /** Id en la memoria de origen; solo sirve para las relaciones del zip. */
  id: number;
  tipo: string;
  titulo: string;
  contenido: string;
  vigenciaHasta: string | null;
}

export interface Paquete {
  manifest: Manifest;
  entradas: EntradaPaquete[];
}

export interface DatosPaquete {
  entradas: readonly Entrada[];
  relaciones: readonly (readonly [number, number])[];
  agentMemory: string;
  esquema: number;
  exportadoEn: string;
  ambitos: readonly AmbitoElegido[];
}

/** Los archivos del zip: el manifest primero y una entrada por archivo bajo `entradas/`. */
export function armarPaquete(d: DatosPaquete): ArchivoZip[] {
  const porTipo: Record<string, number> = {};
  for (const e of d.entradas) porTipo[e.tipo] = (porTipo[e.tipo] ?? 0) + 1;
  const rutas = d.entradas.map((e) => `${CARPETA}${nombreArchivo(e)}`);
  const m: Manifest = {
    formato: FORMATO,
    agent_memory: d.agentMemory,
    esquema: d.esquema,
    exportado_en: d.exportadoEn,
    cantidades: { total: d.entradas.length, por_tipo: porTipo },
    filtros: { ambitos: d.ambitos.map(textoAmbito) },
    entradas: rutas,
    relaciones: d.relaciones.map(([a, b]) => [a, b]),
  };
  return [
    { nombre: MANIFEST, datos: Buffer.from(`${JSON.stringify(m, null, 2)}\n`, "utf8") },
    ...d.entradas.map((e, i) => ({ nombre: rutas[i] as string, datos: Buffer.from(markdown(e, []), "utf8") })),
  ];
}

/** Valida los archivos de un zip contra el formato y devuelve sus entradas; todo o nada. */
export function leerPaquete(archivos: readonly ArchivoZip[]): Paquete {
  const porNombre = new Map(archivos.map((a) => [a.nombre, a.datos]));
  const crudo = porNombre.get(MANIFEST);
  if (!crudo) throw new ReglaError("manifest_invalido", `el zip no trae ${MANIFEST}; se espera en la raíz del zip`);
  const m = leerManifest(crudo);

  for (const a of archivos) {
    if (a.nombre === MANIFEST) continue;
    const resto = a.nombre.slice(CARPETA.length);
    if (!a.nombre.startsWith(CARPETA) || !resto.endsWith(".md") || resto.includes("/")) {
      throw new ReglaError("zip_archivo_ajeno", `el zip trae «${a.nombre}»; se esperan solo ${MANIFEST} y archivos ${CARPETA}<nombre>.md`);
    }
  }
  const declarados = new Set(m.entradas);
  const presentes = archivos.filter((a) => a.nombre !== MANIFEST).map((a) => a.nombre);
  const sobra = presentes.find((n) => !declarados.has(n));
  const falta = m.entradas.find((n) => !porNombre.has(n));
  if (sobra || falta || declarados.size !== m.entradas.length) {
    const detalle = sobra ? `trae «${sobra}», que el manifest no lista` : falta ? `el manifest lista «${falta}», que no está` : "el manifest repite una entrada";
    throw new ReglaError("manifest_no_coincide", `el zip no coincide con su manifest: ${detalle}`);
  }
  if (m.cantidades.total !== m.entradas.length) {
    throw new ReglaError("manifest_no_coincide", `el manifest declara ${m.cantidades.total} entradas y lista ${m.entradas.length}`);
  }

  const entradas = m.entradas.map((nombre) => leerEntrada(nombre, (porNombre.get(nombre) as Buffer).toString("utf8")));
  const ids = new Set<number>();
  for (const e of entradas) {
    if (ids.has(e.id)) throw new ReglaError("entrada_invalida", `dos entradas del zip tienen el id ${e.id}; se espera uno por entrada`);
    ids.add(e.id);
  }
  const ajena = m.relaciones.find(([a, b]) => !ids.has(a) || !ids.has(b));
  if (ajena) {
    throw new ReglaError("manifest_no_coincide", `el manifest relaciona ${ajena[0]} con ${ajena[1]}, y alguno no es una entrada del zip`);
  }
  return { manifest: m, entradas };
}

function leerManifest(crudo: Buffer): Manifest {
  let datos: unknown;
  try {
    datos = JSON.parse(crudo.toString("utf8"));
  } catch {
    throw new ReglaError("manifest_invalido", `${MANIFEST} no es JSON válido`);
  }
  const formato = (datos as { formato?: unknown } | null)?.formato;
  if (typeof formato === "number" && Number.isInteger(formato) && formato > FORMATO) {
    throw new ReglaError("formato_futuro", `el zip usa el formato ${formato}; esta versión entiende hasta el ${FORMATO}: actualizá agent-memory`);
  }
  const r = manifest.safeParse(datos);
  if (!r.success) {
    const problema = r.error.issues[0];
    const campo = problema?.path.join(".") || "(raíz)";
    throw new ReglaError("manifest_invalido", `${MANIFEST} no cumple el formato ${FORMATO}: ${campo}: ${problema?.message ?? "inválido"}`);
  }
  return r.data;
}

/** Inverso estricto de `markdown(e, [])`: cabecera de escalares JSON y cuerpo «# título», línea vacía y contenido. */
function leerEntrada(nombre: string, texto: string): EntradaPaquete {
  const invalida = (detalle: string) =>
    new ReglaError("entrada_invalida", `«${nombre}» ${detalle}; se espera el markdown que genera «agent-memory export --zip»`);
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texto);
  if (!m) throw invalida("no tiene cabecera");
  const cabecera: Record<string, unknown> = {};
  for (const linea of (m[1] as string).split("\n")) {
    const i = linea.indexOf(": ");
    if (i <= 0) throw invalida(`tiene una línea de cabecera sin «clave: valor»`);
    try {
      cabecera[linea.slice(0, i)] = JSON.parse(linea.slice(i + 2));
    } catch {
      throw invalida(`tiene un valor ilegible en «${linea.slice(0, i)}»`);
    }
  }
  const { id, titulo, tipo, vigencia_hasta: vigencia } = cabecera;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) throw invalida("no tiene un id entero positivo");
  if (typeof titulo !== "string" || !titulo.trim()) throw invalida("no tiene título");
  if (typeof tipo !== "string" || !tipo) throw invalida("no tiene tipo");
  if (vigencia !== undefined && vigencia !== null && (typeof vigencia !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(vigencia))) {
    throw invalida("tiene una vigencia que no es YYYY-MM-DD");
  }
  const cuerpo = m[2] as string;
  const inicio = `\n# ${titulo}\n\n`;
  if (!cuerpo.startsWith(inicio) || !cuerpo.endsWith("\n")) throw invalida("no tiene el cuerpo «# título» y el contenido");
  return { id, tipo, titulo, contenido: cuerpo.slice(inicio.length, -1), vigenciaHasta: (vigencia as string | null | undefined) ?? null };
}
