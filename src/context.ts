import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Ambito, Contexto } from "./domain/types.js";

// Resolución del contexto: la hace el proceso del cliente (MCP o CLI) desde su propio
// directorio y manda solo ids; el servicio nunca lee rutas que le pase un cliente.

/**
 * Marcador de proyecto: un archivo `.agent-memory.json` con `{ "proyecto": "<nombre>" }` en una
 * carpeta. Todo lo que cuelga de ella pertenece a ese proyecto.
 */
export const MARCADOR_PROYECTO = ".agent-memory.json";

export interface OpcionesContexto {
  /** Proyectos declarados en la configuración: nombre → carpetas. */
  proyectos?: Readonly<Record<string, readonly string[]>>;
}

export function resolverContexto(cwd: string, opciones: OpcionesContexto = {}): Contexto {
  const dir = canonica(cwd);
  return { repo: resolverRepo(dir), proyecto: resolverProyecto(dir, opciones.proyectos ?? {}) };
}

/**
 * Ámbito por defecto de una entrada nueva: una preferencia va a global; lo demás, al
 * proyecto, si no al repo, si no a global.
 */
export function ambitoPorDefecto(contexto: Contexto, tipo?: string): { ambito: Ambito; ambitoRef: string | null } {
  if (tipo === "preferencia") return { ambito: "global", ambitoRef: null };
  if (contexto.proyecto) return { ambito: "proyecto", ambitoRef: contexto.proyecto };
  if (contexto.repo) return { ambito: "repo", ambitoRef: contexto.repo };
  return { ambito: "global", ambitoRef: null };
}

/** Repo: remoto git normalizado, o la ruta de su raíz si no tiene remoto. */
export function resolverRepo(dir: string): string | null {
  const raiz = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!raiz) return null;
  const remoto = git(dir, ["remote", "get-url", "origin"]) ?? primerRemoto(dir);
  return remoto ? normalizarRemoto(remoto) : `ruta:${canonica(raiz)}`;
}

function primerRemoto(dir: string): string | null {
  const nombre = git(dir, ["remote"])?.split("\n")[0]?.trim();
  return nombre ? git(dir, ["remote", "get-url", nombre]) : null;
}

/**
 * `git@github.com:Org/Repo.git`, `https://user@github.com/Org/Repo` y `ssh://git@github.com/Org/Repo.git`
 * dan el mismo id: `github.com/org/repo`.
 */
export function normalizarRemoto(url: string): string {
  let s = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  s = s.replace(/:\d+(?=\/)/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return s.toLowerCase();
}

/**
 * Proyecto: lo declara la persona con un marcador en una carpeta o con una entrada de la
 * configuración. Gana la carpeta declarada más cercana a `dir` (en empate, el marcador). El id es
 * el nombre declarado, así que varias carpetas pueden ser el mismo proyecto. Sin declaración, null.
 */
export function resolverProyecto(dir: string, declarados: Readonly<Record<string, readonly string[]>>): string | null {
  const candidatos: { carpeta: string; nombre: string }[] = [];
  const marcado = marcadorMasCercano(dir);
  if (marcado) candidatos.push(marcado);
  for (const [nombre, carpetas] of Object.entries(declarados)) {
    for (const carpeta of carpetas.map(expandir)) {
      if (dir === carpeta || dir.startsWith(carpeta + sep)) candidatos.push({ carpeta, nombre });
    }
  }
  const masCercano = candidatos.sort((a, b) => b.carpeta.length - a.carpeta.length)[0];
  return masCercano ? `proyecto:${masCercano.nombre}` : null;
}

function marcadorMasCercano(dir: string): { carpeta: string; nombre: string } | null {
  for (let actual = dir; ; actual = dirname(actual)) {
    const ruta = join(actual, MARCADOR_PROYECTO);
    if (existsSync(ruta)) return { carpeta: actual, nombre: leerMarcador(ruta) };
    if (dirname(actual) === actual) return null;
  }
}

function leerMarcador(ruta: string): string {
  let nombre: unknown;
  try {
    nombre = (JSON.parse(readFileSync(ruta, "utf8")) as { proyecto?: unknown } | null)?.proyecto;
  } catch (error) {
    throw new Error(`marcador de proyecto ilegible en ${ruta}: ${(error as Error).message}`);
  }
  if (typeof nombre !== "string" || !nombre.trim()) {
    throw new Error(`marcador de proyecto inválido en ${ruta}: se espera {"proyecto": "<nombre>"}`);
  }
  return nombre.trim();
}

function expandir(carpeta: string): string {
  return canonica(carpeta.startsWith("~/") ? join(homedir(), carpeta.slice(2)) : carpeta);
}

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function canonica(ruta: string): string {
  const absoluta = resolve(ruta);
  try {
    return realpathSync(absoluta);
  } catch {
    return absoluta;
  }
}
