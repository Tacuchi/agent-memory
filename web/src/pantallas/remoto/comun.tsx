import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { mensajeError } from "../../api";

/**
 * Una acción con su propio aviso: el error o la confirmación aparecen junto al control que la disparó, no en un
 * rincón común de la pantalla. Devuelve si salió bien, para que el formulario decida si se cierra.
 */
export function useAccion(recargar: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const ejecutar = useCallback(
    async <T,>(trabajo: () => Promise<T>, mensaje: string | ((r: T) => string) | null): Promise<boolean> => {
      setError(null);
      setHecho(null);
      setOcupado(true);
      try {
        const r = await trabajo();
        setHecho(typeof mensaje === "function" ? mensaje(r) : mensaje);
        await recargar();
        return true;
      } catch (e) {
        setError(mensajeError(e));
        return false;
      } finally {
        setOcupado(false);
      }
    },
    [recargar],
  );

  const limpiar = useCallback(() => {
    setError(null);
    setHecho(null);
  }, []);

  return { error, hecho, ocupado, ejecutar, limpiar };
}

/** Confirmación en línea para lo que no se deshace: el foco arranca en Cancelar y Escape también cancela. */
export function Confirmar({
  children,
  accion,
  confirmar,
  cancelar,
  ocupado = false,
}: {
  children: ReactNode;
  accion: string;
  confirmar: () => void;
  cancelar: () => void;
  ocupado?: boolean;
}) {
  const cancelarRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelarRef.current?.focus(), []);
  return (
    <div className="confirmar" role="group" aria-label={accion} onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <p>{children}</p>
      <div className="barra-accion">
        <button type="button" className="peligro" disabled={ocupado} onClick={confirmar}>
          {accion}
        </button>
        <button type="button" ref={cancelarRef} onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Rótulo de estado: punto + palabra, nunca solo color. */
export function Senal({ tono, children }: { tono: "validada" | "rechazada" | "pendiente" | "tenue"; children: ReactNode }) {
  return (
    <span className={`senal ${tono}`}>
      <span className={`punto ${tono === "tenue" ? "" : tono}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function fechaHora(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

/** Escape cierra el formulario en línea que lo envuelve. */
export function alEscape(cerrar: () => void) {
  return (e: { key: string }) => {
    if (e.key === "Escape") cerrar();
  };
}
