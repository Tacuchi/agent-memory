import { useState, type RefObject } from "react";
import type { Pendiente } from "../api";
import type { Navegar } from "../App";
import { Estados, fecha, lugar, textoImportacion } from "./comunes";

/**
 * La pendiente enfocada, completa: se lee y se decide sin salir de la cola. Rechazar queda
 * apartado abajo y pide motivo. El padre la monta con `key` por id, así el motivo no pasa a otra.
 */
export function VistaPrevia({
  entrada: e,
  ocupado,
  aprobar,
  rechazar,
  navegar,
  refMotivo,
}: {
  entrada: Pendiente;
  ocupado: boolean;
  aprobar: () => void;
  rechazar: (motivo: string) => void;
  navegar: Navegar;
  refMotivo?: RefObject<HTMLInputElement | null>;
}) {
  const [motivo, setMotivo] = useState("");
  const sinMotivo = motivo.trim() === "";
  return (
    <section className="previa" aria-label="Vista previa">
      <h2>{e.titulo}</h2>
      <p className="meta">
        <Estados entrada={e} /> · {lugar(e)} · <span className="num">{fecha(e.actualizada_en)}</span>
      </p>
      {e.importacion && <p className="meta">{textoImportacion(e.importacion)}</p>}
      <pre className="contenido">{e.contenido}</pre>
      {e.reemplazaria && (
        <p className="meta">
          Al aprobarla reemplaza a{" "}
          <button type="button" className="enlace azul" disabled={ocupado} onClick={() => navegar({ tipo: "detalle", id: e.reemplazaria!.id })}>
            #{e.reemplazaria.id} · {e.reemplazaria.titulo}
          </button>
        </p>
      )}
      <div className="acciones">
        <button type="button" className="primario" disabled={ocupado} onClick={aprobar}>
          Aprobar <span className="kbd" aria-hidden="true">a</span>
        </button>
        <button type="button" disabled={ocupado} onClick={() => navegar({ tipo: "detalle", id: e.id })}>
          Abrir detalle <span className="kbd" aria-hidden="true">↵</span>
        </button>
      </div>
      <form
        className="zona-peligro"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (!sinMotivo) rechazar(motivo);
        }}
      >
        <label>
          Motivo del rechazo
          <input ref={refMotivo} type="text" disabled={ocupado} value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="por qué no entra a la memoria" />
        </label>
        <button type="submit" className="peligro" disabled={ocupado || sinMotivo} title={sinMotivo ? "Escribí un motivo para rechazar" : undefined}>
          Rechazar <span className="kbd" aria-hidden="true">r</span>
        </button>
      </form>
    </section>
  );
}
