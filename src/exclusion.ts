import type { Exclusion } from "./config.js";
import { normalizarRemoto } from "./context.js";
import { ReglaError, type Contexto } from "./domain/types.js";

// Exclusión de repos. Un patrón es:
//   - una ruta absoluta (`/…` o `~/…`): prefijo de la carpeta de trabajo o del repo;
//   - un remoto u organización con host (`example.org/acme`, `git@example.org:acme/x.git`):
//     el repo cuyo remoto normalizado es ese o cuelga de él;
//   - un nombre suelto sin `/` (`acme`): la organización, segundo tramo del remoto normalizado.
// Una excepción usa la misma forma y gana sobre los patrones.

export interface ContextoCompleto extends Contexto {
  /** Carpeta de trabajo canónica (raíz del repo, si hay uno). Solo se compara como texto. */
  ruta?: string | null;
}

export function contextoExcluido(contexto: ContextoCompleto, exclusion: Exclusion, home = process.env.HOME ?? ""): boolean {
  const coincide = (patron: string) => coincidePatron(patron, contexto, home);
  return exclusion.patrones.some(coincide) && !exclusion.excepciones.some(coincide);
}

export function errorExcluido(): ReglaError {
  return new ReglaError(
    "repo_excluido",
    "repo excluido: la memoria no guarda ni devuelve entradas en este repo; la persona puede habilitar una excepción en exclusion.excepciones de ~/.agent-memory/config.json",
  );
}

export function coincidePatron(patronCrudo: string, contexto: ContextoCompleto, home: string): boolean {
  const patron = patronCrudo.trim();
  if (!patron) return false;
  if (patron.startsWith("/") || patron.startsWith("~/")) {
    const prefijo = (patron.startsWith("~/") ? home + patron.slice(1) : patron).replace(/\/+$/, "");
    const rutas = [contexto.ruta, quitar(contexto.repo, "ruta:")];
    return rutas.some((r) => r != null && (r === prefijo || r.startsWith(`${prefijo}/`)));
  }
  const repo = contexto.repo && !contexto.repo.startsWith("ruta:") ? contexto.repo : null;
  if (!repo) return false;
  if (!patron.includes("/") && !patron.includes(":")) return repo.split("/")[1] === patron.toLowerCase();
  const normal = normalizarRemoto(patron);
  return repo === normal || repo.startsWith(`${normal}/`);
}

function quitar(valor: string | null, prefijo: string): string | null {
  return valor?.startsWith(prefijo) ? valor.slice(prefijo.length) : null;
}
