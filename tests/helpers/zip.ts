import { crc32, deflateRawSync } from "node:zlib";

// Zips armados byte a byte para probar el lector con lo que el escritor nunca produce: rutas que escapan, enlaces,
// nombres repetidos, tamaños que mienten, cabeceras locales que no coinciden y archivos truncados.

export interface ArchivoCrudo {
  nombre: string;
  datos: Buffer;
  /** 0 = stored, 8 = deflate (por defecto). */
  metodo?: number;
  /** Tamaño descomprimido declarado; por defecto, el real. */
  declarado?: number;
  /** Nombre en la cabecera local; por defecto, el mismo del directorio central. */
  nombreLocal?: string;
  /** Modo Unix en los atributos externos (p. ej. 0o120777 para un enlace simbólico). */
  modo?: number;
}

export function zipCrudo(archivos: readonly ArchivoCrudo[]): Buffer {
  const partes: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;
  for (const a of archivos) {
    const metodo = a.metodo ?? 8;
    const datos = metodo === 8 ? deflateRawSync(a.datos) : a.datos;
    const nombre = Buffer.from(a.nombre, "utf8");
    const nombreLocal = Buffer.from(a.nombreLocal ?? a.nombre, "utf8");
    const declarado = a.declarado ?? a.datos.length;
    const crc = crc32(a.datos);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nombreLocal.length, 26);
    partes.push(local, nombreLocal, datos);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(((a.modo ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(desplazamiento, 42);
    centrales.push(central, nombre);
    desplazamiento += 30 + nombreLocal.length + datos.length;
  }
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...partes, directorio, fin]);
}

/** Un manifest válido para las entradas dadas (rutas bajo `entradas/`). */
export function manifestPara(rutas: readonly string[], extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      formato: 1,
      agent_memory: "0.0.0-prueba",
      esquema: 1,
      exportado_en: "2026-11-17T00:00:00.000Z",
      cantidades: { total: rutas.length, por_tipo: {} },
      filtros: { ambitos: [] },
      entradas: rutas,
      relaciones: [],
      ...extra,
    }),
  );
}

/** El markdown de una entrada como lo escribe la exportación. */
export function entradaMd(id: number, titulo: string, contenido: string, tipo = "leccion", extra: Record<string, unknown> = {}): Buffer {
  const cabecera = { id, titulo, tipo, ambito: "global", ambito_ref: null, validacion: "validada", vigencia_hasta: null, ...extra };
  const lineas = Object.entries(cabecera).map(([k, v]) => `${k}: ${v === null ? "null" : typeof v === "number" ? v : JSON.stringify(String(v))}`);
  return Buffer.from(["---", ...lineas, "---", "", `# ${titulo}`, "", contenido, ""].join("\n"));
}
