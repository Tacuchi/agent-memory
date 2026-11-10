import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Puerto por defecto del servicio local (plan 001, Implementation decisions). */
export const PUERTO_POR_DEFECTO = 47821;

export interface Config {
  /** Directorio de datos: `~/.agent-memory/` o `AGENT_MEMORY_HOME`. */
  home: string;
  dbPath: string;
  tokenPath: string;
  port: number;
  /** Carpetas declaradas como proyecto (AC-19). */
  proyectos: string[];
}

interface ArchivoConfig {
  port?: number;
  proyectos?: string[];
}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.AGENT_MEMORY_HOME?.trim() || join(homedir(), ".agent-memory");
  const archivo = leerArchivo(join(home, "config.json"));
  const port = puerto(env.AGENT_MEMORY_PORT) ?? archivo.port ?? PUERTO_POR_DEFECTO;
  return {
    home,
    dbPath: join(home, "memoria.db"),
    tokenPath: join(home, "token"),
    port,
    proyectos: archivo.proyectos ?? [],
  };
}

function puerto(valor: string | undefined): number | undefined {
  if (!valor) return undefined;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`AGENT_MEMORY_PORT inválido: ${valor}`);
  return n;
}

function leerArchivo(ruta: string): ArchivoConfig {
  if (!existsSync(ruta)) return {};
  try {
    return JSON.parse(readFileSync(ruta, "utf8")) as ArchivoConfig;
  } catch (error) {
    throw new Error(`config.json ilegible en ${ruta}: ${(error as Error).message}`);
  }
}
