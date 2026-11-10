import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Puerto por defecto del servicio local (plan 001, Implementation decisions). */
export const PUERTO_POR_DEFECTO = 47821;
/** Tope del índice de inicio en tokens (plan 002): un tercio de lo que gasta la memoria nativa. */
export const TOPE_INDICE_POR_DEFECTO = 1500;
/** Espera máxima del hook de inicio por el servicio (plan 002): nunca bloquea la sesión. */
export const ESPERA_HOOK_POR_DEFECTO_MS = 2000;
/** Umbrales de la vista de revisión (plan 003): propuestas a revisar por la persona. */
export const DIAS_SIN_USO_POR_DEFECTO = 90;
export const DIAS_SIN_VERIFICAR_POR_DEFECTO = 180;

/** Repos excluidos (AC-20): el paquete trae la lista vacía; los patrones son de la persona. */
export interface Exclusion {
  patrones: string[];
  excepciones: string[];
}

export interface Config {
  /** Directorio de datos: `~/.agent-memory/` o `AGENT_MEMORY_HOME`. */
  home: string;
  configPath: string;
  dbPath: string;
  tokenPath: string;
  pidPath: string;
  logPath: string;
  /** Registro de purgas: solo id y fecha (AC-27). */
  purgasPath: string;
  /** Carpeta por defecto de las exportaciones pedidas desde la web (AC-22). */
  exportacionesPath: string;
  port: number;
  /** Carpetas declaradas como proyecto (AC-19). */
  proyectos: string[];
  exclusion: Exclusion;
  topeIndice: number;
  esperaHookMs: number;
  revision: { diasSinUso: number; diasSinVerificar: number };
}

/** Forma de `config.json`. Las claves que la CLI no conoce se conservan al reescribirlo. */
export interface ArchivoConfig {
  port?: number;
  proyectos?: string[];
  exclusion?: Partial<Exclusion>;
  indice?: { tope_tokens?: number };
  hook?: { espera_ms?: number };
  revision?: { dias_sin_uso?: number; dias_sin_verificar?: number };
  [otra: string]: unknown;
}

export function homeDatos(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MEMORY_HOME?.trim() || join(homedir(), ".agent-memory");
}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homeDatos(env);
  const configPath = join(home, "config.json");
  const archivo = leerArchivoConfig(configPath);
  const port = puerto(env.AGENT_MEMORY_PORT) ?? archivo.port ?? PUERTO_POR_DEFECTO;
  return {
    home,
    configPath,
    dbPath: join(home, "memoria.db"),
    tokenPath: join(home, "token"),
    pidPath: join(home, "servicio.pid"),
    logPath: join(home, "servicio.log"),
    purgasPath: join(home, "purgas.log"),
    exportacionesPath: join(home, "exportaciones"),
    port,
    proyectos: archivo.proyectos ?? [],
    exclusion: {
      patrones: textos(archivo.exclusion?.patrones, "exclusion.patrones"),
      excepciones: textos(archivo.exclusion?.excepciones, "exclusion.excepciones"),
    },
    topeIndice: entero(archivo.indice?.tope_tokens, "indice.tope_tokens", 200) ?? TOPE_INDICE_POR_DEFECTO,
    esperaHookMs: entero(archivo.hook?.espera_ms, "hook.espera_ms", 0) ?? ESPERA_HOOK_POR_DEFECTO_MS,
    revision: {
      diasSinUso: entero(archivo.revision?.dias_sin_uso, "revision.dias_sin_uso", 1) ?? DIAS_SIN_USO_POR_DEFECTO,
      diasSinVerificar: entero(archivo.revision?.dias_sin_verificar, "revision.dias_sin_verificar", 1) ?? DIAS_SIN_VERIFICAR_POR_DEFECTO,
    },
  };
}

export function leerArchivoConfig(ruta: string): ArchivoConfig {
  if (!existsSync(ruta)) return {};
  try {
    return JSON.parse(readFileSync(ruta, "utf8")) as ArchivoConfig;
  } catch (error) {
    throw new Error(`config.json ilegible en ${ruta}: ${(error as Error).message}`);
  }
}

export function escribirArchivoConfig(ruta: string, archivo: ArchivoConfig): void {
  mkdirSync(dirname(ruta), { recursive: true, mode: 0o700 });
  writeFileSync(ruta, `${JSON.stringify(archivo, null, 2)}\n`, { mode: 0o600 });
}

function puerto(valor: string | undefined): number | undefined {
  if (!valor) return undefined;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`AGENT_MEMORY_PORT inválido: ${valor}`);
  return n;
}

function textos(valor: unknown, clave: string): string[] {
  if (valor === undefined) return [];
  if (!Array.isArray(valor) || valor.some((v) => typeof v !== "string")) throw new Error(`config.json: ${clave} debe ser una lista de textos`);
  return (valor as string[]).map((v) => v.trim()).filter(Boolean);
}

function entero(valor: unknown, clave: string, minimo: number): number | undefined {
  if (valor === undefined) return undefined;
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < minimo) throw new Error(`config.json: ${clave} debe ser un entero ≥ ${minimo}`);
  return valor;
}
