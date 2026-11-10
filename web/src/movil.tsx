import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Pendiente } from "./api";
import type { Navegar } from "./App";
import { Estados, fecha, lugar } from "./pantallas/comunes";

const CONSULTA_MOVIL = "(max-width: 760px)";

/** En el celular cambia la forma de operar (hoja inferior, pestañas abajo), no solo el ancho. */
export function useEsMovil(): boolean {
  const disponible = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [es, setEs] = useState(() => disponible && window.matchMedia(CONSULTA_MOVIL).matches);
  useEffect(() => {
    if (!disponible) return;
    const consulta = window.matchMedia(CONSULTA_MOVIL);
    const alCambiar = () => setEs(consulta.matches);
    consulta.addEventListener("change", alCambiar);
    return () => consulta.removeEventListener("change", alCambiar);
  }, [disponible]);
  return es;
}

/**
 * Hoja que sube desde abajo, sobre un `<dialog>` modal: el foco queda adentro, Escape y tocar
 * fuera la cierran.
 */
export function HojaInferior({ etiqueta, cerrar, children }: { etiqueta: string; cerrar: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialogo = ref.current;
    if (dialogo && !dialogo.open) {
      if (typeof dialogo.showModal === "function") dialogo.showModal();
      else dialogo.setAttribute("open", "");
    }
    return () => dialogo?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className="hoja-inferior"
      aria-label={etiqueta}
      onCancel={(e) => {
        e.preventDefault();
        cerrar();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <span className="asa" aria-hidden="true" />
      {children}
    </dialog>
  );
}

/** Atajos para escribir el motivo: llenan el texto y queda editable para agregar el detalle. */
const MOTIVOS_RAPIDOS = ["Ya está en la memoria", "No está verificado", "No aplica a este proyecto", "Lo registra el repo"];

export function FormRechazo({
  titulo,
  ocupado,
  rechazar,
  cancelar,
}: {
  titulo: string;
  ocupado: boolean;
  rechazar: (motivo: string) => void;
  cancelar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const campo = useRef<HTMLTextAreaElement>(null);
  const sinMotivo = motivo.trim() === "";
  return (
    <form
      className="hoja-cuerpo"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sinMotivo) rechazar(motivo);
      }}
    >
      <div>
        <h2>{titulo}</h2>
        <p className="meta">El motivo queda en la entrada y el agente lo ve. Es obligatorio.</p>
      </div>
      <div className="motivos" role="group" aria-label="Motivos rápidos">
        {MOTIVOS_RAPIDOS.map((m) => (
          <button
            key={m}
            type="button"
            className={motivo.startsWith(m) ? "motivo elegido" : "motivo"}
            aria-pressed={motivo.startsWith(m)}
            onClick={() => {
              setMotivo(`${m}: `);
              campo.current?.focus();
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <label>
        Motivo del rechazo
        <textarea ref={campo} rows={3} value={motivo} disabled={ocupado} onChange={(e) => setMotivo(e.target.value)} />
      </label>
      <div className="hoja-acciones">
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
        <button type="submit" className="peligro-lleno" disabled={ocupado || sinMotivo}>
          Rechazar
        </button>
      </div>
    </form>
  );
}

/** La pendiente tocada, completa, con sus acciones; «Rechazar…» cambia la misma hoja al motivo. */
export function HojaEntrada({
  entrada: e,
  ocupado,
  aprobar,
  rechazar,
  navegar,
  cerrar,
}: {
  entrada: Pendiente;
  ocupado: boolean;
  aprobar: () => void;
  rechazar: (motivo: string) => void;
  navegar: Navegar;
  cerrar: () => void;
}) {
  const [rechazando, setRechazando] = useState(false);
  return (
    <HojaInferior etiqueta={`Pendiente #${e.id}`} cerrar={cerrar}>
      {rechazando ? (
        <FormRechazo titulo={`Rechazar #${e.id}`} ocupado={ocupado} rechazar={rechazar} cancelar={() => setRechazando(false)} />
      ) : (
        <div className="hoja-cuerpo">
          <p className="meta">
            <Estados entrada={e} /> · {lugar(e)} · <span className="num">#{e.id} · {fecha(e.actualizada_en)}</span>
          </p>
          <h2>{e.titulo}</h2>
          <pre className="contenido">{e.contenido}</pre>
          {e.reemplazaria && (
            <p className="meta">
              Al aprobarla reemplaza a{" "}
              <button type="button" className="enlace azul" onClick={() => navegar({ tipo: "detalle", id: e.reemplazaria!.id })}>
                #{e.reemplazaria.id} · {e.reemplazaria.titulo}
              </button>
            </p>
          )}
          <div className="hoja-acciones tres">
            <button type="button" aria-label="Abrir el detalle" disabled={ocupado} onClick={() => navegar({ tipo: "detalle", id: e.id })}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M7 3h8v8M15 3L7 11M12 15H3V6" />
              </svg>
            </button>
            <button type="button" className="peligro" disabled={ocupado} onClick={() => setRechazando(true)}>
              Rechazar…
            </button>
            <button type="button" className="primario" disabled={ocupado} onClick={aprobar}>
              Aprobar
            </button>
          </div>
        </div>
      )}
    </HojaInferior>
  );
}

/**
 * Mantener presionada una fila activa la selección en lote. Devuelve los manejadores de la fila
 * y si el último toque fue largo (para que el clic que le sigue no abra la hoja).
 */
export function usePresionLarga(alPresionar: () => void, ms = 450) {
  const reloj = useRef<number | null>(null);
  const fueLarga = useRef(false);
  const cancelar = () => {
    if (reloj.current !== null) window.clearTimeout(reloj.current);
    reloj.current = null;
  };
  return {
    fueLarga,
    manejadores: {
      onPointerDown: () => {
        fueLarga.current = false;
        cancelar();
        reloj.current = window.setTimeout(() => {
          fueLarga.current = true;
          alPresionar();
        }, ms);
      },
      onPointerUp: cancelar,
      onPointerLeave: cancelar,
      onPointerCancel: cancelar,
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    },
  };
}
