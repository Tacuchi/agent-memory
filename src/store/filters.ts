import { hoy } from "../domain/rules.js";
import type { Ambito, Contexto, Tipo, Validacion } from "../domain/types.js";

/**
 * Filtros de listado y búsqueda. Sin filtros explícitos aplica los que recibe el agente por defecto: activas, vigentes,
 * validadas o pendientes, y las de proyecto; las rechazadas, reemplazadas y vencidas solo salen
 * cuando se piden.
 */
export interface Filtros {
  tipos?: Tipo[];
  /** Solo entradas de este tipo de ámbito. */
  ambito?: Ambito;
  /** Restringe a global más el repo y el proyecto del contexto (salvo `todosLosAmbitos`). */
  contexto?: Contexto;
  todosLosAmbitos?: boolean;
  /** Estados de validación explícitos; incluir `rechazada` las trae. */
  validacion?: Validacion[];
  incluirReemplazadas?: boolean;
  incluirVencidas?: boolean;
}

export interface ClausulaSql {
  sql: string;
  params: (string | number | null)[];
}

/** Arma el WHERE sobre la tabla `entradas` con alias `e`. */
export function clausulaFiltros(filtros: Filtros, ahora: Date): ClausulaSql {
  const partes: string[] = [];
  const params: (string | number | null)[] = [];

  if (!filtros.incluirReemplazadas) partes.push("e.vida = 'activa'");
  if (!filtros.incluirVencidas) {
    partes.push("(e.vigencia_hasta IS NULL OR e.vigencia_hasta > ?)");
    params.push(hoy(ahora));
  }

  const validacion = filtros.validacion?.length ? filtros.validacion : ["validada", "pendiente"];
  partes.push(`(e.validacion IS NULL OR e.validacion IN (${validacion.map(() => "?").join(",")}))`);
  params.push(...validacion);

  if (filtros.tipos?.length) {
    partes.push(`e.tipo IN (${filtros.tipos.map(() => "?").join(",")})`);
    params.push(...filtros.tipos);
  }

  if (filtros.ambito) {
    partes.push("e.ambito = ?");
    params.push(filtros.ambito);
  }

  if (filtros.contexto && !filtros.todosLosAmbitos) {
    const { repo, proyecto } = filtros.contexto;
    partes.push("(e.ambito = 'global' OR (e.ambito = 'repo' AND e.ambito_ref = ?) OR (e.ambito = 'proyecto' AND e.ambito_ref = ?))");
    params.push(repo, proyecto);
  }

  return { sql: partes.length ? partes.join(" AND ") : "1", params };
}
