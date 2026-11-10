import { useEffect, useState } from "react";
import { mensajeError, type Cliente, type Pendiente } from "../api";
import type { Navegar } from "../App";
import { Aviso, fecha } from "./comunes";

/** Bandeja de pendientes (AC-11): aprobar cada una, o rechazarla con un motivo obligatorio. */
export function Bandeja({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  async function cargar() {
    try {
      setPendientes((await cliente<{ entradas: Pendiente[] }>("pendientes", {})).entradas);
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function actuar(op: "aprobar" | "rechazar", cuerpo: { id: number; motivo?: string }) {
    setError(null);
    setHecho(null);
    try {
      await cliente(op, cuerpo);
      setHecho(op === "aprobar" ? `#${cuerpo.id} aprobada` : `#${cuerpo.id} rechazada`);
      await cargar();
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  return (
    <section aria-labelledby="titulo-bandeja">
      <h2 id="titulo-bandeja">Pendientes</h2>
      <Aviso texto={error} />
      <Aviso texto={hecho} tipo="ok" />
      {pendientes && pendientes.length === 0 && <p>No hay entradas pendientes.</p>}
      {pendientes?.map((p) => (
        <TarjetaPendiente key={p.id} pendiente={p} navegar={navegar} actuar={actuar} />
      ))}
    </section>
  );
}

function TarjetaPendiente({
  pendiente: p,
  navegar,
  actuar,
}: {
  pendiente: Pendiente;
  navegar: Navegar;
  actuar: (op: "aprobar" | "rechazar", cuerpo: { id: number; motivo?: string }) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const sinMotivo = motivo.trim() === "";
  return (
    <article className="tarjeta" aria-label={`Pendiente #${p.id}`}>
      <h3>
        <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id: p.id })}>
          #{p.id} · {p.titulo}
        </button>
      </h3>
      <p className="meta">
        {p.tipo} · {p.ambito}
        {p.ambito_ref ? ` (${p.ambito_ref})` : ""} · {fecha(p.actualizada_en)}
      </p>
      {p.reemplazaria && (
        <p className="reemplazo">
          Reemplazaría a{" "}
          <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id: p.reemplazaria!.id })}>
            #{p.reemplazaria.id} · {p.reemplazaria.titulo}
          </button>
        </p>
      )}
      <pre className="contenido">{p.contenido}</pre>
      <div className="acciones">
        <button type="button" onClick={() => void actuar("aprobar", { id: p.id })}>
          Aprobar
        </button>
        <label>
          Motivo del rechazo
          <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={sinMotivo}
          title={sinMotivo ? "Escribí un motivo para rechazar" : undefined}
          onClick={() => void actuar("rechazar", { id: p.id, motivo })}
        >
          Rechazar
        </button>
      </div>
    </article>
  );
}
