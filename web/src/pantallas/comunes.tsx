import type { Entrada } from "../api";

/** Estado de validación como clase: sin validación es una entrada de trabajo. */
export function claseValidacion(entrada: Pick<Entrada, "validacion">): string {
  return entrada.validacion ?? "trabajo";
}

/**
 * Estados de una entrada en una línea: validación, y solo si aplica, reemplazo y vencimiento.
 * Cada estado lleva su palabra además del color.
 */
export function Estados({ entrada }: { entrada: Entrada }) {
  const validacion = claseValidacion(entrada);
  return (
    <span className="estados">
      <span className={`estado ${validacion}`}>
        <span className={`punto ${validacion}`} aria-hidden="true" />
        {validacion}
      </span>
      {entrada.vida !== "activa" && (
        <span className="estado reemplazada">
          <span className="punto reemplazada" aria-hidden="true" />
          {entrada.vida}
        </span>
      )}
      {entrada.vigencia_hasta && <span className="estado vencimiento">vence {entrada.vigencia_hasta}</span>}
    </span>
  );
}

export function Aviso({ texto, tipo = "error" }: { texto: string | null; tipo?: "error" | "ok" }) {
  if (!texto) return null;
  return (
    <p role={tipo === "error" ? "alert" : "status"} className={`aviso ${tipo}`}>
      {texto}
    </p>
  );
}

export function fecha(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** Tipo y ámbito en una línea, con la referencia del proyecto o repo si la hay. */
export function lugar(e: Pick<Entrada, "tipo" | "ambito" | "ambito_ref">): string {
  return `${e.tipo} · ${e.ambito}${e.ambito_ref ? ` (${e.ambito_ref})` : ""}`;
}

/** De qué importación salió una entrada: número, archivo y día. */
export function textoImportacion(o: { id: number; archivo: string; importada_en: string }): string {
  return `Importación ${o.id} · ${o.archivo} · ${fecha(o.importada_en)}`;
}

/** Primera línea con texto del contenido, para leer de qué trata sin abrirla. */
export function extracto(contenido: string | undefined): string {
  return (contenido ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
