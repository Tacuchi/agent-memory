import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { homeDatos } from "../config.js";
import { argumentosNode, rutaCli } from "../service/daemon.js";

// Conexión con Claude Code, aislada en este módulo: MCP con `claude mcp add`, hook
// `SessionStart` en settings.json y la skill. Idempotente; la desinstalación quita exactamente eso.

export const NOMBRE_MCP = "agent-memory";
/** Marca que identifica el hook propio entre los de la persona. */
export const MARCA_HOOK = "AGENT_MEMORY_HOOK=claude-code";

export interface Entorno {
  env: NodeJS.ProcessEnv;
}

export function dirClaude(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
}

export function rutasClaude(env: NodeJS.ProcessEnv = process.env) {
  const dir = dirClaude(env);
  return {
    settings: join(dir, "settings.json"),
    skill: join(dir, "skills", "agent-memory"),
    /** Copia de settings.json previa a la primera instalación, para dejarlo byte a byte igual. */
    estado: join(homeDatos(env), "claude-code.json"),
  };
}

export function origenSkill(): string {
  return fileURLToPath(new URL("../../skills/agent-memory/", import.meta.url));
}

/** Comillas simples de shell: ninguna ruta se expande ni se parte. */
export function citar(texto: string): string {
  return `'${texto.replaceAll("'", `'\\''`)}'`;
}

export function comandoHook(): string {
  return `${MARCA_HOOK} ${citar(process.execPath)} ${citar(rutaCli())} hook session-start`;
}

export function argumentosMcp(): string[] {
  return ["mcp", "add", "--scope", "user", NOMBRE_MCP, "--", process.execPath, ...argumentosNode("mcp")];
}

/** Corre `claude`; null si no está en el PATH. Otro fallo se propaga con su salida. */
export function claude(args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("claude", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function claudeDisponible(env: NodeJS.ProcessEnv): boolean {
  try {
    return claude(["--version"], env) !== null;
  } catch {
    return false;
  }
}

export function mcpRegistrado(env: NodeJS.ProcessEnv): boolean {
  try {
    return claude(["mcp", "get", NOMBRE_MCP], env) !== null;
  } catch {
    return false;
  }
}

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };
interface GrupoHook {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function leerSettings(ruta: string): { texto: string | null; datos: Settings } {
  if (!existsSync(ruta)) return { texto: null, datos: {} };
  const texto = readFileSync(ruta, "utf8");
  try {
    const datos = JSON.parse(texto) as unknown;
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw new Error("no es un objeto JSON");
    return { texto, datos: datos as Settings };
  } catch (error) {
    throw new Error(`${ruta} ilegible (${(error as Error).message}); no se tocó nada`);
  }
}

function esPropio(grupo: GrupoHook): boolean {
  return (grupo.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARCA_HOOK));
}

/** Quita los grupos propios de SessionStart y las claves que quedan vacías. */
export function sinHookPropio(settings: Settings): Settings {
  const copia = structuredClone(settings);
  const hooks = copia.hooks;
  if (!hooks || typeof hooks !== "object") return copia;
  const grupos = hooks.SessionStart;
  if (!Array.isArray(grupos)) return copia;
  const restantes = (grupos as GrupoHook[]).filter((g) => !esPropio(g));
  if (restantes.length === grupos.length) return copia;
  if (restantes.length) hooks.SessionStart = restantes;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete copia.hooks;
  return copia;
}

export function conHookPropio(settings: Settings): Settings {
  const copia = sinHookPropio(settings);
  const hooks = (copia.hooks ??= {});
  const grupos = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as GrupoHook[]) : [];
  hooks.SessionStart = [...grupos, { hooks: [{ type: "command", command: comandoHook(), timeout: 15 }] }];
  return copia;
}

export function hookInstalado(env: NodeJS.ProcessEnv): boolean {
  try {
    const grupos = leerSettings(rutasClaude(env).settings).datos.hooks?.SessionStart;
    return Array.isArray(grupos) && (grupos as GrupoHook[]).some(esPropio);
  } catch {
    return false;
  }
}

export function skillInstalada(env: NodeJS.ProcessEnv): boolean {
  return existsSync(join(rutasClaude(env).skill, "SKILL.md"));
}

function escribirSettings(ruta: string, datos: Settings): void {
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`);
}

/**
 * true si la ruta está en una ubicación que se borra sola: el caché de `npx` (segmento `_npx`) o
 * la carpeta temporal de `bunx` (`bunx-<uid>-<paquete>@<versión>`). Se mira por segmentos de ruta,
 * no por variables de entorno de npm, que cambian entre versiones.
 */
export function rutaEfimera(ruta: string): boolean {
  return ruta.split(/[\\/]+/).some((segmento) => segmento === "_npx" || segmento.startsWith("bunx-"));
}

/** Las rutas que el hook propio registró (node y cli.js), o null si no hay hook propio legible. */
export function rutasHook(env: NodeJS.ProcessEnv): string[] | null {
  let grupos: unknown;
  try {
    grupos = leerSettings(rutasClaude(env).settings).datos.hooks?.SessionStart;
  } catch {
    return null;
  }
  if (!Array.isArray(grupos)) return null;
  const comando = (grupos as GrupoHook[])
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .find((c): c is string => typeof c === "string" && c.includes(MARCA_HOOK));
  if (!comando) return null;
  // Cada ruta va entre comillas simples (ver `citar`): '…' con '\'' por cada comilla interna.
  return [...comando.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => (m[1] as string).replaceAll(`'\\''`, "'"));
}

/** Nunca pregunta nada ni lee la entrada estándar: corre igual en una terminal que desde un script. */
export function instalarClaudeCode(env: NodeJS.ProcessEnv): string[] {
  const informe: string[] = [];
  const efimera = [rutaCli(), process.execPath].find(rutaEfimera);
  if (efimera) {
    throw new Error(
      `esta copia corre desde una ubicación temporal (${efimera}) que npx o bunx pueden borrar, y Claude Code quedaría apuntando a una ruta rota. ` +
        "Instalalo de forma permanente con «npm install -g @tacuchi/agent-memory» y repetí «agent-memory install claude-code»; no se tocó nada",
    );
  }
  if (!claudeDisponible(env)) {
    throw new Error("«claude» no está en el PATH: instalá Claude Code y repetí «agent-memory install claude-code»; no se tocó nada");
  }
  const rutas = rutasClaude(env);
  const { texto, datos } = leerSettings(rutas.settings);

  // 1. MCP: quitar y volver a agregar deja una sola entrada con la ruta actual.
  try {
    claude(["mcp", "remove", NOMBRE_MCP, "--scope", "user"], env);
  } catch {
    // No estaba registrado.
  }
  claude(argumentosMcp(), env);
  informe.push(`MCP «${NOMBRE_MCP}» registrado con «claude mcp add --scope user»`);

  // 2. Hook SessionStart, sin tocar los demás.
  if (!existsSync(rutas.estado)) {
    mkdirSync(dirname(rutas.estado), { recursive: true, mode: 0o700 });
    writeFileSync(rutas.estado, `${JSON.stringify({ settings_previo: texto }, null, 2)}\n`, { mode: 0o600 });
  }
  escribirSettings(rutas.settings, conHookPropio(datos));
  informe.push(`hook SessionStart en ${rutas.settings}`);

  // 3. Skill.
  rmSync(rutas.skill, { recursive: true, force: true });
  mkdirSync(dirname(rutas.skill), { recursive: true });
  cpSync(origenSkill(), rutas.skill, { recursive: true });
  informe.push(`skill agent-memory en ${rutas.skill}`);
  return informe;
}

export function desinstalarClaudeCode(env: NodeJS.ProcessEnv): string[] {
  const informe: string[] = [];
  const rutas = rutasClaude(env);

  try {
    if (claude(["mcp", "remove", NOMBRE_MCP, "--scope", "user"], env) === null) {
      informe.push("«claude» no está en el PATH: el MCP no se pudo quitar; quitálo con «claude mcp remove agent-memory --scope user»");
    } else informe.push(`MCP «${NOMBRE_MCP}» quitado`);
  } catch {
    informe.push(`MCP «${NOMBRE_MCP}» no estaba registrado`);
  }

  if (existsSync(rutas.settings)) {
    const { datos } = leerSettings(rutas.settings);
    const limpio = sinHookPropio(datos);
    const previo = leerEstado(rutas.estado);
    if (previo !== undefined && previo === null && Object.keys(limpio).length === 0) rmSync(rutas.settings);
    else if (typeof previo === "string" && isDeepStrictEqual(JSON.parse(previo), limpio)) writeFileSync(rutas.settings, previo);
    else if (!isDeepStrictEqual(limpio, datos)) escribirSettings(rutas.settings, limpio);
    informe.push(`hook SessionStart quitado de ${rutas.settings}`);
  }
  rmSync(rutas.estado, { force: true });

  if (skillInstalada(env) && readFileSync(join(rutas.skill, "SKILL.md"), "utf8").includes("name: agent-memory")) {
    rmSync(rutas.skill, { recursive: true, force: true });
    informe.push(`skill quitada de ${rutas.skill}`);
  }
  return informe;
}

/** settings.json previo a la primera instalación: texto, null (no existía) o undefined (sin registro). */
function leerEstado(ruta: string): string | null | undefined {
  if (!existsSync(ruta)) return undefined;
  try {
    const datos = JSON.parse(readFileSync(ruta, "utf8")) as { settings_previo?: string | null };
    return datos.settings_previo;
  } catch {
    return undefined;
  }
}
