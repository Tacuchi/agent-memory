import type { Entrada } from "../api";

/** Estados de una entrada en una línea: vida, validación, vigencia y caducidad. */
export function Estados({ entrada }: { entrada: Entrada }) {
  return (
    <span className="estados">
      <span className={`chip vida-${entrada.vida}`}>{entrada.vida}</span>
      <span className={`chip validacion-${entrada.validacion ?? "trabajo"}`}>{entrada.validacion ?? "trabajo"}</span>
      {entrada.vigencia_hasta && <span className="chip vencimiento">vence {entrada.vigencia_hasta}</span>}
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
