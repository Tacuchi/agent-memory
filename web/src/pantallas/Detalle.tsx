import { useEffect, useState, type FormEvent } from "react";
import { AMBITOS, mensajeError, type Cliente, type Entrada, type Relacion, type Revision } from "../api";
import type { Navegar } from "../App";
import { Aviso, Estados, fecha } from "./comunes";

/**
 * Detalle de una entrada (AC-10, AC-12): estados, relaciones en ambos sentidos, revisiones con
 * restaurar, edición que conserva la validación (S-10), cambio de ámbito, caducar y revertir.
 */
export function Detalle({ id, cliente, navegar }: { id: number; cliente: Cliente; navegar: Navegar }) {
  const [entrada, setEntrada] = useState<Entrada | null>(null);
  const [relaciones, setRelaciones] = useState<Relacion[]>([]);
  const [revisiones, setRevisiones] = useState<Revision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  async function cargar() {
    try {
      const [l, r] = await Promise.all([
        cliente<{ entrada: Entrada; relaciones: Relacion[] }>("leer", { id }),
        cliente<{ revisiones: Revision[] }>("revisiones", { id }),
      ]);
      setEntrada(l.entrada);
      setRelaciones(l.relaciones);
      setRevisiones(r.revisiones);
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function actuar(op: string, cuerpo: object, mensaje: string) {
    setError(null);
    setHecho(null);
    try {
      const r = await cliente<{ redactados?: string[] }>(op, { id, ...cuerpo });
      // AC-26: si al guardar se redactó un secreto, la persona lo sabe (sin el valor).
      const redactados = r?.redactados ?? [];
      setHecho(redactados.length ? `${mensaje} · se redactó: ${redactados.join(", ")}` : mensaje);
      await cargar();
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  if (!entrada) {
    return (
      <section>
        <Aviso texto={error} />
        {!error && <p>Cargando #{id}…</p>}
      </section>
    );
  }

  return (
    <section aria-labelledby="titulo-detalle">
      <h2 id="titulo-detalle">
        #{entrada.id} · {entrada.titulo}
      </h2>
      <Aviso texto={error} />
      <Aviso texto={hecho} tipo="ok" />
      <dl className="ficha">
        <dt>Estados</dt>
        <dd>
          <Estados entrada={entrada} />
        </dd>
        <dt>Tipo y ámbito</dt>
        <dd>
          {entrada.tipo} · {entrada.ambito}
          {entrada.ambito_ref ? ` (${entrada.ambito_ref})` : ""}
        </dd>
        <dt>Actualizada</dt>
        <dd>{fecha(entrada.actualizada_en)}</dd>
        {entrada.validacion_via && (
          <>
            <dt>Validada por</dt>
            <dd>{entrada.validacion_via}</dd>
          </>
        )}
        {entrada.motivo_rechazo && (
          <>
            <dt>Motivo del rechazo</dt>
            <dd>{entrada.motivo_rechazo}</dd>
          </>
        )}
        {entrada.reemplazada_por !== null && (
          <>
            <dt>Reemplazada por</dt>
            <dd>
              <IrA id={entrada.reemplazada_por} navegar={navegar} />
            </dd>
          </>
        )}
        {entrada.reemplaza_a !== null && (
          <>
            <dt>Reemplaza a</dt>
            <dd>
              <IrA id={entrada.reemplaza_a} navegar={navegar} />
            </dd>
          </>
        )}
        {entrada.caducidad && (
          <>
            <dt>Caducidad</dt>
            <dd>
              la caducó {entrada.caducidad.actor === "agente" ? "el agente" : "la persona"} con fecha {entrada.caducidad.fecha}
              {entrada.caducidad.trabajoCerrado ? " (trabajo cerrado)" : ""}{" "}
              <button type="button" onClick={() => void actuar("revertir_caducidad", {}, "caducidad revertida")}>
                Revertir caducidad
              </button>
            </dd>
          </>
        )}
      </dl>
      <pre className="contenido">{entrada.contenido}</pre>

      {entrada.validacion === "pendiente" && entrada.vida === "activa" && (
        <p className="barra">
          Pendiente de validar:{" "}
          <button type="button" onClick={() => navegar({ tipo: "bandeja" })}>
            ir a la bandeja
          </button>
        </p>
      )}

      {entrada.vida === "activa" && (
        <>
          <Editar entrada={entrada} actuar={actuar} />
          <CambiarAmbito entrada={entrada} actuar={actuar} />
          <Caducar actuar={actuar} />
        </>
      )}

      <h3>Relaciones</h3>
      {relaciones.length === 0 ? (
        <p>Sin relaciones.</p>
      ) : (
        <ul className="lista" aria-label="Relaciones">
          {relaciones.map((r) => (
            <li key={`${r.sentido}-${r.id}`}>
              <span className="chip">{r.sentido === "saliente" ? "→" : "←"} {r.sentido}</span>
              <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id: r.id })}>
                #{r.id} · {r.titulo}
              </button>
              <span className="meta">
                {r.tipo} · {r.vida} · {r.validacion ?? "trabajo"}
                {r.vigencia_hasta ? ` · vence ${r.vigencia_hasta}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Revisiones</h3>
      <ol className="revisiones" aria-label="Revisiones">
        {revisiones.map((r, i) => (
          <li key={r.numero}>
            <span className="meta">
              {r.numero} · {r.accion} · {r.actor} · {fecha(r.creada_en)} · {r.validacion ?? "trabajo"}
            </span>
            <details>
              <summary>{r.titulo}</summary>
              <pre className="contenido">{r.contenido}</pre>
            </details>
            {i < revisiones.length - 1 && entrada.vida === "activa" && (
              <button
                type="button"
                onClick={() => void actuar("restaurar", { numero: r.numero }, `revisión ${r.numero} restaurada`)}
              >
                Restaurar la revisión {r.numero}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

type Actuar = (op: string, cuerpo: object, mensaje: string) => Promise<void>;

function IrA({ id, navegar }: { id: number; navegar: Navegar }) {
  return (
    <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id })}>
      #{id}
    </button>
  );
}

function Editar({ entrada, actuar }: { entrada: Entrada; actuar: Actuar }) {
  const [titulo, setTitulo] = useState(entrada.titulo);
  const [contenido, setContenido] = useState(entrada.contenido ?? "");
  useEffect(() => {
    setTitulo(entrada.titulo);
    setContenido(entrada.contenido ?? "");
  }, [entrada]);
  function enviar(e: FormEvent) {
    e.preventDefault();
    void actuar("editar", { titulo, contenido }, "cambios guardados; el estado de validación se conserva");
  }
  return (
    <form className="bloque" onSubmit={enviar} aria-label="Editar">
      <h3>Editar</h3>
      <label>
        Título
        <input type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label>
        Contenido
        <textarea rows={8} value={contenido} onChange={(e) => setContenido(e.target.value)} />
      </label>
      <button type="submit" disabled={titulo === entrada.titulo && contenido === entrada.contenido}>
        Guardar cambios
      </button>
    </form>
  );
}

function CambiarAmbito({ entrada, actuar }: { entrada: Entrada; actuar: Actuar }) {
  const [ambito, setAmbito] = useState(entrada.ambito);
  const [ref, setRef] = useState(entrada.ambito_ref ?? "");
  function enviar(e: FormEvent) {
    e.preventDefault();
    void actuar("cambiar_ambito", { ambito, ambito_ref: ambito === "global" ? null : ref }, `ámbito cambiado a ${ambito}`);
  }
  return (
    <form className="bloque" onSubmit={enviar} aria-label="Cambiar ámbito">
      <h3>Ámbito</h3>
      <label>
        Ámbito
        <select value={ambito} onChange={(e) => setAmbito(e.target.value)}>
          {AMBITOS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      {ambito !== "global" && (
        <label>
          Referencia del {ambito}
          <input type="text" value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
      )}
      <button type="submit">Cambiar ámbito</button>
    </form>
  );
}

function Caducar({ actuar }: { actuar: Actuar }) {
  const [fechaElegida, setFechaElegida] = useState("");
  function enviar(e: FormEvent) {
    e.preventDefault();
    void actuar("caducar", fechaElegida ? { fecha: fechaElegida } : {}, fechaElegida ? `vence el ${fechaElegida}` : "vence hoy");
  }
  return (
    <form className="bloque" onSubmit={enviar} aria-label="Caducar">
      <h3>Caducar</h3>
      <label>
        Fecha (vacía = hoy)
        <input type="date" value={fechaElegida} onChange={(e) => setFechaElegida(e.target.value)} />
      </label>
      <button type="submit">{fechaElegida ? "Caducar en esa fecha" : "Caducar hoy"}</button>
    </form>
  );
}
