import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { ReglaError } from "../domain/types.js";

// Zip mínimo para el intercambio, sobre node:zlib. El escritor produce lo único que el lector acepta: archivos
// stored o deflate, sin cifrado, sin zip64 y en un solo disco. El lector parte del directorio central, rechaza todo
// lo demás antes de inflar, compara cada cabecera local con su entrada central e infla con un tope de salida real:
// un tamaño declarado que miente no pasa el tope, y uno que no coincide con lo inflado se rechaza.

export interface ArchivoZip {
  nombre: string;
  datos: Buffer;
}

export interface TopesZip {
  /** Bytes del zip. */
  zip: number;
  /** Archivos, sin contar las carpetas. */
  archivos: number;
  /** Bytes inflados de un archivo. */
  porArchivo: number;
  /** Bytes inflados en total. */
  total: number;
  /** Tope propio de un archivo por su nombre (p. ej. el manifest). */
  porNombre?: Readonly<Record<string, number>>;
}

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_FIN = 0x06054b50;
const LARGO_LOCAL = 30;
const LARGO_CENTRAL = 46;
const LARGO_FIN = 22;
const UTF8 = 0x0800;
const CIFRADO = 0x0001 | 0x0040;
const STORED = 0;
const DEFLATE = 8;
const UNIX = 3;
const TIPO_ARCHIVO = 0o170000;
const ENLACE = 0o120000;
const ARCHIVO_0600 = 0o100600;

/** Escribe un zip con cada archivo comprimido con deflate y nombres en UTF-8. */
export function escribirZip(archivos: readonly ArchivoZip[], fecha: Date): Buffer {
  const { hora, dia } = fechaDos(fecha);
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;
  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre, "utf8");
    const comprimido = deflateRawSync(a.datos);
    const crc = crc32(a.datos);

    const local = Buffer.alloc(LARGO_LOCAL);
    local.writeUInt32LE(FIRMA_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(dia, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(a.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    locales.push(local, nombre, comprimido);

    const central = Buffer.alloc(LARGO_CENTRAL);
    central.writeUInt32LE(FIRMA_CENTRAL, 0);
    central.writeUInt16LE((UNIX << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(a.datos.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE((ARCHIVO_0600 << 16) >>> 0, 38);
    central.writeUInt32LE(desplazamiento, 42);
    centrales.push(central, nombre);

    desplazamiento += LARGO_LOCAL + nombre.length + comprimido.length;
  }
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(LARGO_FIN);
  fin.writeUInt32LE(FIRMA_FIN, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, directorio, fin]);
}

/** Lee un zip dentro de los topes; devuelve sus archivos (sin carpetas) o un ReglaError que nombra la causa. */
export function leerZip(zip: Buffer, topes: TopesZip): ArchivoZip[] {
  if (zip.length > topes.zip) {
    throw new ReglaError("zip_grande", `el zip pesa ${zip.length} bytes; el máximo es ${topes.zip}`);
  }
  const fin = buscarFin(zip);
  const disco = zip.readUInt16LE(fin + 4);
  const discoDirectorio = zip.readUInt16LE(fin + 6);
  const enDisco = zip.readUInt16LE(fin + 8);
  const total = zip.readUInt16LE(fin + 10);
  const largoDirectorio = zip.readUInt32LE(fin + 12);
  const inicioDirectorio = zip.readUInt32LE(fin + 16);
  if (disco !== 0 || discoDirectorio !== 0 || enDisco !== total) {
    throw noSoportado("está partido en varios discos");
  }
  if (total === 0xffff || largoDirectorio === 0xffffffff || inicioDirectorio === 0xffffffff) throw noSoportado("usa zip64");
  if (inicioDirectorio + largoDirectorio > fin) throw danado("el directorio central se sale del archivo");
  if (total > topes.archivos * 2 + 16) throw demasiados(total, topes.archivos);

  const vistos = new Set<string>();
  const archivos: ArchivoZip[] = [];
  let p = inicioDirectorio;
  let inflados = 0;
  for (let i = 0; i < total; i++) {
    if (p + LARGO_CENTRAL > inicioDirectorio + largoDirectorio || zip.readUInt32LE(p) !== FIRMA_CENTRAL) {
      throw danado("el directorio central está incompleto");
    }
    const hecho = zip.readUInt16LE(p + 4);
    const flags = zip.readUInt16LE(p + 8);
    const metodo = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const comprimido = zip.readUInt32LE(p + 20);
    const declarado = zip.readUInt32LE(p + 24);
    const largoNombre = zip.readUInt16LE(p + 28);
    const largoExtra = zip.readUInt16LE(p + 30);
    const largoComentario = zip.readUInt16LE(p + 32);
    const atributos = zip.readUInt32LE(p + 38);
    const local = zip.readUInt32LE(p + 42);
    const bytesNombre = zip.subarray(p + LARGO_CENTRAL, p + LARGO_CENTRAL + largoNombre);
    p += LARGO_CENTRAL + largoNombre + largoExtra + largoComentario;
    if (p > inicioDirectorio + largoDirectorio) throw danado("el directorio central está incompleto");

    const nombre = leerNombre(bytesNombre);
    if (flags & CIFRADO) throw noSoportado(`«${nombre}» está cifrado`);
    if (metodo !== STORED && metodo !== DEFLATE) throw noSoportado(`«${nombre}» usa el método de compresión ${metodo}`);
    if (comprimido === 0xffffffff || declarado === 0xffffffff || local === 0xffffffff) throw noSoportado("usa zip64");
    if (hecho >> 8 === UNIX && ((atributos >>> 16) & TIPO_ARCHIVO) === ENLACE) {
      throw new ReglaError("zip_enlace", `«${nombre}» es un enlace simbólico; se esperan solo archivos comunes`);
    }
    exigirRutaSegura(nombre);
    if (vistos.has(nombre)) {
      throw new ReglaError("zip_nombre_repetido", `el zip trae dos veces «${nombre}»; se espera un nombre por archivo`);
    }
    vistos.add(nombre);
    if (nombre.endsWith("/")) continue;
    if (archivos.length === topes.archivos) throw demasiados(archivos.length + 1, topes.archivos);

    const datos = leerDatos(zip, local, bytesNombre, metodo, comprimido, inicioDirectorio, nombre);
    const propio = topes.porNombre?.[nombre] ?? topes.porArchivo;
    const restante = topes.total - inflados;
    const porTotal = restante < propio;
    const tope = Math.min(propio, restante);
    if (declarado > tope) throw excedido(nombre, porTotal, tope, declarado, topes.total);
    const contenido = inflar(datos, metodo, tope, nombre, porTotal, topes.total);
    if (contenido.length !== declarado || crc32(contenido) !== crc) {
      throw danado(`«${nombre}» no coincide con su tamaño o su CRC declarados (declara ${declarado} bytes, trae ${contenido.length})`);
    }
    inflados += contenido.length;
    archivos.push({ nombre, datos: contenido });
  }
  return archivos;
}

function buscarFin(zip: Buffer): number {
  const desde = Math.max(0, zip.length - LARGO_FIN - 0xffff);
  for (let i = zip.length - LARGO_FIN; i >= desde; i--) {
    if (zip.readUInt32LE(i) === FIRMA_FIN && i + LARGO_FIN + zip.readUInt16LE(i + 20) === zip.length) return i;
  }
  throw danado("no se encuentra el final del zip: no es un zip o está truncado");
}

function leerNombre(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReglaError("zip_ruta_insegura", "el zip trae un nombre de archivo que no es UTF-8 válido");
  }
}

/** Rutas relativas dentro del paquete: sin raíz, sin unidad, sin «\», sin NUL y sin segmentos vacíos, «.» ni «..». */
function exigirRutaSegura(nombre: string): void {
  const sinBarraFinal = nombre.endsWith("/") ? nombre.slice(0, -1) : nombre;
  const segmentos = sinBarraFinal.split("/");
  const insegura =
    !sinBarraFinal ||
    nombre.startsWith("/") ||
    /^[A-Za-z]:/.test(nombre) ||
    nombre.includes("\\") ||
    nombre.includes("\0") ||
    segmentos.some((s) => s === "" || s === "." || s === "..");
  if (insegura) {
    throw new ReglaError(
      "zip_ruta_insegura",
      `el zip trae la ruta «${nombre}»; se esperan rutas relativas dentro del paquete, sin «..», sin «/» inicial y sin «\\»`,
    );
  }
}

function leerDatos(zip: Buffer, local: number, bytesNombre: Buffer, metodo: number, comprimido: number, limite: number, nombre: string): Buffer {
  if (local + LARGO_LOCAL > limite || zip.readUInt32LE(local) !== FIRMA_LOCAL) throw danado(`falta la cabecera local de «${nombre}»`);
  const largoNombre = zip.readUInt16LE(local + 26);
  const largoExtra = zip.readUInt16LE(local + 28);
  const nombreLocal = zip.subarray(local + LARGO_LOCAL, local + LARGO_LOCAL + largoNombre);
  if (!nombreLocal.equals(bytesNombre) || zip.readUInt16LE(local + 8) !== metodo) {
    throw danado(`la cabecera local de «${nombre}» no coincide con su entrada en el directorio central`);
  }
  const inicio = local + LARGO_LOCAL + largoNombre + largoExtra;
  if (inicio + comprimido > limite) throw danado(`los datos de «${nombre}» se salen del archivo: está truncado`);
  return zip.subarray(inicio, inicio + comprimido);
}

function inflar(datos: Buffer, metodo: number, tope: number, nombre: string, porTotal: boolean, total: number): Buffer {
  if (metodo === STORED) {
    if (datos.length > tope) throw excedido(nombre, porTotal, tope, datos.length, total);
    return Buffer.from(datos);
  }
  try {
    return inflateRawSync(datos, { maxOutputLength: Math.max(1, tope) });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw excedido(nombre, porTotal, tope, null, total);
    throw danado(`«${nombre}» no se puede descomprimir (${(error as Error).message})`);
  }
}

function excedido(nombre: string, porTotal: boolean, tope: number, bytes: number | null, total: number): ReglaError {
  const trae = bytes === null ? "más" : String(bytes);
  if (porTotal) {
    return new ReglaError("zip_inflado_grande", `el contenido descomprimido del zip pasa de ${total} bytes (al llegar a «${nombre}»)`);
  }
  return new ReglaError("zip_entrada_grande", `«${nombre}» descomprimido trae ${trae} bytes; el máximo por archivo es ${tope}`);
}

function demasiados(cantidad: number, tope: number): ReglaError {
  return new ReglaError("zip_demasiadas_entradas", `el zip trae ${cantidad} archivos o más; el máximo es ${tope}`);
}

function noSoportado(detalle: string): ReglaError {
  return new ReglaError("zip_no_soportado", `el zip ${detalle}; se espera un zip común (stored o deflate, sin cifrar), como el que genera «agent-memory export --zip»`);
}

function danado(detalle: string): ReglaError {
  return new ReglaError("zip_danado", `${detalle}; se espera un zip completo y sin daños`);
}

/** Fecha y hora en el formato de MS-DOS que guarda el zip (resolución de 2 s, desde 1980). */
function fechaDos(fecha: Date): { hora: number; dia: number } {
  const anio = Math.min(Math.max(fecha.getFullYear(), 1980), 2107);
  return {
    hora: (fecha.getHours() << 11) | (fecha.getMinutes() << 5) | Math.floor(fecha.getSeconds() / 2),
    dia: ((anio - 1980) << 9) | ((fecha.getMonth() + 1) << 5) | fecha.getDate(),
  };
}
