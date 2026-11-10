import { statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

// Lanzar un programa externo (`claude`, el navegador configurado) igual en los tres sistemas.
// En Windows, CreateProcess solo prueba `.com` y `.exe` y no ejecuta un `.cmd`/`.bat` sin cmd.exe,
// pero npm instala sus comandos como `.cmd` (p. ej. `claude.cmd`): se resuelve el programa con PATH
// y PATHEXT y, si es un `.cmd`/`.bat`, se corre por cmd.exe con cada argumento escapado.
// En macOS y Linux el programa se pasa tal cual y lo resuelve el sistema.

export interface Invocacion {
  archivo: string;
  args: string[];
  /** Los argumentos ya van escapados para cmd.exe: Node no debe volver a citarlos. */
  windowsVerbatimArguments: boolean;
}

/** Variable de entorno sin distinguir mayúsculas, como la lee Windows (`Path`, `PATH`). */
function variable(env: NodeJS.ProcessEnv, nombre: string): string | undefined {
  const clave = Object.keys(env).find((k) => k.toUpperCase() === nombre.toUpperCase());
  return clave === undefined ? undefined : env[clave];
}

function esArchivo(ruta: string): boolean {
  try {
    return statSync(ruta).isFile();
  } catch {
    return false;
  }
}

/** Ruta del programa como lo buscaría cmd.exe con PATH y PATHEXT; null si no está. Solo Windows. */
export function buscarEnPathWindows(programa: string, env: NodeJS.ProcessEnv): string | null {
  const extensiones = extname(programa)
    ? [""]
    : (variable(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean);
  const conCarpeta = /[\\/]/.test(programa);
  const carpetas = conCarpeta ? [""] : (variable(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  for (const carpeta of carpetas) {
    for (const ext of extensiones) {
      const ruta = carpeta ? join(carpeta, programa + ext) : programa + ext;
      if (esArchivo(ruta)) return ruta;
    }
  }
  return null;
}

// Escapado para cmd.exe, el mismo algoritmo que cross-spawn (https://qntm.org/cmd).
const METACARACTERES = /([()\][%!^"`<>&|;, *?])/g;

function escaparComando(ruta: string): string {
  return ruta.replace(METACARACTERES, "^$1");
}

/** Doble escapado: un `.cmd` vuelve a interpretar sus argumentos al expandir `%*`. */
export function escaparArgumentoCmd(arg: string): string {
  let s = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, "$1$1");
  s = `"${s}"`;
  return s.replace(METACARACTERES, "^$1").replace(METACARACTERES, "^$1");
}

/**
 * Cómo lanzar `programa` con `args`. En Windows, null si el programa no está en el PATH (el mismo
 * caso que un ENOENT); en macOS y Linux siempre devuelve el programa tal cual.
 */
export function invocacion(programa: string, args: string[], env: NodeJS.ProcessEnv, plataforma = process.platform): Invocacion | null {
  if (plataforma !== "win32") return { archivo: programa, args, windowsVerbatimArguments: false };
  const ruta = buscarEnPathWindows(programa, env);
  if (!ruta) return null;
  if (!/\.(cmd|bat)$/i.test(ruta)) return { archivo: ruta, args, windowsVerbatimArguments: false };
  const linea = [escaparComando(ruta), ...args.map(escaparArgumentoCmd)].join(" ");
  return {
    archivo: variable(env, "ComSpec") ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${linea}"`],
    windowsVerbatimArguments: true,
  };
}
