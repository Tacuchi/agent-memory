import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOPE_INDICE_MINIMO } from "./indice/indice.js";

/** Puerto por defecto del servicio local. */
export const PUERTO_POR_DEFECTO = 47821;
/** Tope del índice de inicio en tokens: un tercio de lo que gasta la memoria nativa. */
export const TOPE_INDICE_POR_DEFECTO = 1500;
/** Espera máxima del hook de inicio por el servicio: nunca bloquea la sesión. */
export const ESPERA_HOOK_POR_DEFECTO_MS = 2000;
/** Umbrales de la vista de revisión: propuestas a revisar por la persona. */
export const DIAS_SIN_USO_POR_DEFECTO = 90;
export const DIAS_SIN_VERIFICAR_POR_DEFECTO = 180;
/** Espera corta de cada enlace remoto: un enlace caído no demora la búsqueda local más que esto. */
export const ESPERA_REMOTA_POR_DEFECTO_MS = 2000;

export interface Config {
  /** Directorio de datos: `~/.agent-memory/` o `AGENT_MEMORY_HOME`. */
  home: string;
  dbPath: string;
  tokenPath: string;
  pidPath: string;
  logPath: string;
  /** Registro de purgas: solo id y fecha. */
  purgasPath: string;
  /** Carpeta por defecto de las exportaciones pedidas desde la web. */
  exportacionesPath: string;
  port: number;
  /** Proyectos declarados: nombre → carpetas que le pertenecen. */
  proyectos: Record<string, string[]>;
  topeIndice: number;
  esperaHookMs: number;
  revision: { diasSinUso: number; diasSinVerificar: number };
  /** Enlace remoto: espera de cada pedido a otra instalación. */
  remoto: { esperaMs: number };
}

/** Forma de `config.json`. Las claves que no figuran aquí se ignoran. */
interface ArchivoConfig {
  port?: number;
  proyectos?: Record<string, string[]>;
  indice?: { tope_tokens?: number };
  hook?: { espera_ms?: number };
  revision?: { dias_sin_uso?: number; dias_sin_verificar?: number };
  remoto?: { espera_ms?: number };
}

export function homeDatos(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MEMORY_HOME?.trim() || join(homedir(), ".agent-memory");
}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homeDatos(env);
  const archivo = leerArchivoConfig(join(home, "config.json"));
  const port = puerto(env.AGENT_MEMORY_PORT) ?? archivo.port ?? PUERTO_POR_DEFECTO;
  return {
    home,
    dbPath: join(home, "memoria.db"),
    tokenPath: join(home, "token"),
    pidPath: join(home, "servicio.pid"),
    logPath: join(home, "servicio.log"),
    purgasPath: join(home, "purgas.log"),
    exportacionesPath: join(home, "exportaciones"),
    port,
    proyectos: proyectos(archivo.proyectos),
    topeIndice: entero(archivo.indice?.tope_tokens, "indice.tope_tokens", TOPE_INDICE_MINIMO) ?? TOPE_INDICE_POR_DEFECTO,
    esperaHookMs: entero(archivo.hook?.espera_ms, "hook.espera_ms", 0) ?? ESPERA_HOOK_POR_DEFECTO_MS,
    revision: {
      diasSinUso: entero(archivo.revision?.dias_sin_uso, "revision.dias_sin_uso", 1) ?? DIAS_SIN_USO_POR_DEFECTO,
      diasSinVerificar: entero(archivo.revision?.dias_sin_verificar, "revision.dias_sin_verificar", 1) ?? DIAS_SIN_VERIFICAR_POR_DEFECTO,
    },
    remoto: { esperaMs: entero(archivo.remoto?.espera_ms, "remoto.espera_ms", 100) ?? ESPERA_REMOTA_POR_DEFECTO_MS },
  };
}

function leerArchivoConfig(ruta: string): ArchivoConfig {
  if (!existsSync(ruta)) return {};
  try {
    return JSON.parse(readFileSync(ruta, "utf8")) as ArchivoConfig;
  } catch (error) {
    throw new Error(`config.json ilegible en ${ruta}: ${(error as Error).message}`);
  }
}

function puerto(valor: string | undefined): number | undefined {
  if (!valor) return undefined;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`AGENT_MEMORY_PORT inválido: ${valor}`);
  return n;
}

function proyectos(valor: unknown): Record<string, string[]> {
  if (valor === undefined) return {};
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error('config.json: proyectos debe ser un objeto {"<nombre>": ["<carpeta>", …]}');
  }
  const resultado: Record<string, string[]> = {};
  for (const [nombre, carpetas] of Object.entries(valor)) {
    if (!nombre.trim()) throw new Error("config.json: proyectos no admite un nombre vacío");
    resultado[nombre.trim()] = textos(carpetas, `proyectos.${nombre}`);
  }
  return resultado;
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
