import { useId } from "react";
import type { Alcance, AmbitoAlcance, AmbitoExistente } from "./tipos";

// Alcance de una PC lectora: casillas de lo que existe en esta memoria (D04), sin escribir referencias a mano.

export const clave = (a: AmbitoAlcance) => `${a.ambito}:${a.ref ?? ""}`;

/** Ámbito para leer: global como «Global», un proyecto por su nombre y un repo con su prefijo. */
export function nombreAmbito(a: AmbitoAlcance): string {
  if (a.ambito === "global") return "Global";
  return a.ambito === "repo" ? `repo ${a.ref}` : (a.ref ?? "");
}

/**
 * Lo que la PC ya ve y no figura entre los ámbitos existentes (un proyecto sin entradas activas) se conserva con 0:
 * desmarcarlo es decisión de la persona, no un efecto de que la lista no lo traiga.
 */
export function unirAmbitos(existentes: AmbitoExistente[], actuales: AmbitoAlcance[]): AmbitoExistente[] {
  const vistos = new Set(existentes.map(clave));
  return [...existentes, ...actuales.filter((a) => !vistos.has(clave(a))).map((a) => ({ ...a, entradas: 0 }))];
}

export function SelectorAlcance({
  leyenda,
  ambitos,
  marcados,
  noValidadas,
  cambiar,
  cambiarNoValidadas,
}: {
  leyenda: string;
  ambitos: AmbitoExistente[] | null;
  marcados: Set<string>;
  noValidadas: boolean;
  cambiar: (marcados: Set<string>) => void;
  cambiarNoValidadas: (v: boolean) => void;
}) {
  const nota = useId();
  function alternar(k: string, si: boolean) {
    const nuevo = new Set(marcados);
    if (si) nuevo.add(k);
    else nuevo.delete(k);
    cambiar(nuevo);
  }
  return (
    <fieldset className="selector-alcance" aria-describedby={nota}>
      <legend>{leyenda}</legend>
      {ambitos === null ? (
        <p className="meta">Cargando los ámbitos de esta memoria…</p>
      ) : (
        <ul className="casillas">
          {ambitos.map((a) => (
            <li key={clave(a)}>
              <label className="casilla">
                <input type="checkbox" checked={marcados.has(clave(a))} onChange={(e) => alternar(clave(a), e.target.checked)} />
                <span className="casilla-nombre">{nombreAmbito(a)}</span>
                <span className="num cuenta-ambito" aria-label={`${a.entradas} entradas`}>
                  {a.entradas}
                </span>
              </label>
            </li>
          ))}
          <li className="separada">
            <label className="casilla">
              <input type="checkbox" checked={noValidadas} onChange={(e) => cambiarNoValidadas(e.target.checked)} />
              <span className="casilla-nombre">Incluir no validadas</span>
            </label>
          </li>
        </ul>
      )}
      <p id={nota} className="meta">
        Nunca se comparten las rechazadas, las vencidas ni las reemplazadas.
      </p>
    </fieldset>
  );
}

export function marcadosDe(ambitos: AmbitoAlcance[]): Set<string> {
  return new Set(ambitos.map(clave));
}

export function elegidos(ambitos: AmbitoExistente[] | null, marcados: Set<string>): AmbitoAlcance[] {
  return (ambitos ?? []).filter((a) => marcados.has(clave(a))).map(({ ambito, ref }) => ({ ambito, ref }));
}

export function ChipsAlcance({ alcance }: { alcance: Alcance }) {
  return (
    <span className="chips">
      {alcance.ambitos.map((a) => (
        <span key={clave(a)} className="chip">
          {nombreAmbito(a)}
        </span>
      ))}
      {alcance.no_validadas && <span className="chip">+ no validadas</span>}
    </span>
  );
}
