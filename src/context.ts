import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Ambito, Contexto } from "./domain/types.js";

// Resolución del contexto (AC-19): la hace el proceso del cliente (MCP o CLI) desde su propio
// directorio y manda solo ids; el servicio nunca lee rutas que le pase un cliente.

export interface OpcionesContexto {
  /** Carpetas declaradas como proyecto en la configuración. */
  proyectos?: readonly string[];
}

export function resolverContexto(cwd: string, opciones: OpcionesContexto = {}): Contexto {
  const dir = canonica(cwd);
  return { repo: resolverRepo(dir), proyecto: resolverProyecto(dir, opciones.proyectos ?? []) };
}

/** Ámbito por defecto de una entrada nueva: proyecto, si no repo, si no global (AC-19, S-12). */
export function ambitoPorDefecto(contexto: Contexto): { ambito: Ambito; ambitoRef: string | null } {
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

/** Proyecto: la carpeta declarada más cercana o el hub de Workline más cercano que contiene a `dir`. */
export function resolverProyecto(dir: string, declarados: readonly string[]): string | null {
  const candidatos = declarados.map(canonica).filter((p) => dir === p || dir.startsWith(p + sep));
  let hub: string | null = null;
  for (let actual = dir; ; actual = dirname(actual)) {
    if (existsSync(join(actual, ".workflow", "workline.json"))) {
      hub = actual;
      break;
    }
    if (dirname(actual) === actual) break;
  }
  if (hub) candidatos.push(hub);
  const masCercano = candidatos.sort((a, b) => b.length - a.length)[0];
  return masCercano ? `proyecto:${masCercano}` : null;
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
