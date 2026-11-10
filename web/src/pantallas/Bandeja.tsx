import { useEffect, useRef, useState } from "react";
import { AMBITOS, TIPOS, mensajeError, type Cliente, type Pendiente } from "../api";
import type { Navegar } from "../App";
import { Aviso, fecha } from "./comunes";

type Operacion = "aprobar" | "rechazar";
interface Resultado {
  id: number;
  titulo: string;
  estado: "esperando" | "procesando" | "aprobada" | "rechazada" | "fallida";
  error?: string;
}
interface Referencia {
  clave: string;
  etiqueta: string;
}

function claveAmbito(p: Pendiente): string {
  return JSON.stringify([p.ambito, p.ambito_ref]);
}

export function Bandeja({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ambito, setAmbito] = useState("");
  const [referencia, setReferencia] = useState<Referencia | null>(null);
  const [tipo, setTipo] = useState("");
  const [seleccionadas, setSeleccionadas] = useState<number[]>([]);
  const [motivo, setMotivo] = useState("");
  const [procesando, setProcesando] = useState(false);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const enCurso = useRef(false);

  const delAmbito = (pendientes ?? []).filter((p) => !ambito || p.ambito === ambito);
  const referencias = new Map(delAmbito.filter((p) => p.ambito_ref).map((p) => [claveAmbito(p), {
    clave: claveAmbito(p), etiqueta: `${p.ambito} · ${p.ambito_ref}`,
  }]));
  if (referencia) referencias.set(referencia.clave, referencia);
  const visibles = delAmbito.filter((p) => (!referencia || claveAmbito(p) === referencia.clave) && (!tipo || p.tipo === tipo));
  const elegidas = visibles.filter((p) => seleccionadas.includes(p.id));
  const todas = visibles.length > 0 && elegidas.length === visibles.length;
  const correctas = resultados.filter((r) => r.estado === "aprobada" || r.estado === "rechazada").length;
  const fallidas = resultados.filter((r) => r.estado === "fallida").length;
  const completadas = correctas + fallidas;

  async function cargar() {
    try {
      setPendientes((await cliente<{ entradas: Pendiente[] }>("pendientes", {})).entradas);
    } catch (e) {
      setError(`No se pudo cargar la bandeja: ${mensajeError(e)}`);
    }
  }

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function actuar(op: Operacion, entradas: Pendiente[], motivoRechazo?: string) {
    if (enCurso.current || entradas.length === 0) return;
    const motivoLimpio = motivoRechazo?.trim() ?? "";
    if (op === "rechazar" && !motivoLimpio) {
      setError("Escribí un motivo para rechazar");
      return;
    }
    enCurso.current = true;
    setProcesando(true);
    setError(null);
    setResultados(entradas.map((p) => ({ id: p.id, titulo: p.titulo, estado: "esperando" })));

    function registrar(id: number, cambio: Partial<Resultado>) {
      setResultados((rs) => rs.map((r) => r.id === id ? { ...r, ...cambio } : r));
    }

    try {
      for (const p of entradas) {
        registrar(p.id, { estado: "procesando" });
        try {
          await cliente(op, { id: p.id, ...(op === "rechazar" ? { motivo: motivoLimpio } : {}) });
          registrar(p.id, { estado: op === "aprobar" ? "aprobada" : "rechazada" });
        } catch (e) {
          registrar(p.id, { estado: "fallida", error: mensajeError(e) });
        }
      }
      await cargar();
    } finally {
      setSeleccionadas([]);
      setProcesando(false);
      enCurso.current = false;
    }
  }

  return (
    <section aria-labelledby="titulo-bandeja">
      <h2 id="titulo-bandeja">Pendientes</h2>
      <Aviso texto={error} />
      {error && <button type="button" disabled={procesando} onClick={() => { setError(null); void cargar(); }}>Recargar pendientes</button>}
      <div className="filtros">
        <label>
          Ámbito
          <select disabled={procesando} value={ambito} onChange={(e) => { setAmbito(e.target.value); setReferencia(null); setSeleccionadas([]); }}>
            <option value="">todos</option>
            {AMBITOS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>
          Proyecto o repositorio
          <select disabled={procesando} value={referencia?.clave ?? ""} onChange={(e) => { setReferencia(referencias.get(e.target.value) ?? null); setSeleccionadas([]); }}>
            <option value="">todos</option>
            {[...referencias.values()].map((r) => <option key={r.clave} value={r.clave}>{r.etiqueta}</option>)}
          </select>
        </label>
        <label>
          Tipo
          <select disabled={procesando} value={tipo} onChange={(e) => { setTipo(e.target.value); setSeleccionadas([]); }}>
            <option value="">todos</option>
            {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <div className="acciones">
        <label className="casilla">
          <input
            type="checkbox"
            checked={todas}
            ref={(elemento) => { if (elemento) elemento.indeterminate = elegidas.length > 0 && !todas; }}
            disabled={procesando || visibles.length === 0}
            onChange={(e) => setSeleccionadas(e.target.checked ? visibles.map((p) => p.id) : [])}
          />
          Seleccionar todas las visibles
        </label>
        <span>{elegidas.length} seleccionadas · {visibles.length} visibles</span>
        <button type="button" disabled={procesando || elegidas.length === 0} onClick={() => void actuar("aprobar", elegidas)}>
          Aprobar seleccionadas
        </button>
        <label>
          Motivo del rechazo de las seleccionadas
          <input type="text" disabled={procesando} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={procesando || elegidas.length === 0 || !motivo.trim()}
          title={!motivo.trim() ? "Escribí un motivo para rechazar" : undefined}
          onClick={() => void actuar("rechazar", elegidas, motivo)}
        >
          Rechazar seleccionadas
        </button>
      </div>
      {resultados.length > 0 && (
        <section className="bloque" aria-label="Resultado de la acción">
          <p role="status">
            Procesadas {completadas} de {resultados.length} · {correctas} correctas · {fallidas} fallidas
            {procesando && completadas === resultados.length ? " · Actualizando pendientes…" : ""}
          </p>
          <progress aria-label="Progreso de la acción" value={completadas} max={resultados.length} />
          <ul aria-label="Resultados por entrada">
            {resultados.map((r) => (
              <li key={r.id}>
                <span role={r.estado === "fallida" ? "alert" : undefined}>
                  <span>#{r.id} {r.estado}</span> · {r.titulo}{r.error ? ` · ${r.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pendientes && pendientes.length === 0 && <p>No hay entradas pendientes.</p>}
      {pendientes && pendientes.length > 0 && visibles.length === 0 && <p>No hay pendientes con estos filtros.</p>}
      {visibles.map((p) => (
        <TarjetaPendiente
          key={p.id}
          pendiente={p}
          navegar={navegar}
          actuar={(op, cuerpo) => actuar(op, [p], cuerpo.motivo)}
          procesando={procesando}
          seleccionada={seleccionadas.includes(p.id)}
          alternar={() => setSeleccionadas((ids) => ids.includes(p.id) ? ids.filter((id) => id !== p.id) : [...ids, p.id])}
        />
      ))}
    </section>
  );
}

function TarjetaPendiente({
  pendiente: p,
  navegar,
  actuar,
  procesando,
  seleccionada,
  alternar,
}: {
  pendiente: Pendiente;
  navegar: Navegar;
  actuar: (op: "aprobar" | "rechazar", cuerpo: { id: number; motivo?: string }) => Promise<void>;
  procesando: boolean;
  seleccionada: boolean;
  alternar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const sinMotivo = motivo.trim() === "";
  return (
    <article className="tarjeta" aria-label={`Pendiente #${p.id}`}>
      <label className="casilla">
        <input type="checkbox" checked={seleccionada} disabled={procesando} onChange={alternar} />
        Seleccionar #{p.id}
      </label>
      <h3>
        <button type="button" className="enlace" disabled={procesando} onClick={() => navegar({ tipo: "detalle", id: p.id })}>
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
          <button type="button" className="enlace" disabled={procesando} onClick={() => navegar({ tipo: "detalle", id: p.reemplazaria!.id })}>
            #{p.reemplazaria.id} · {p.reemplazaria.titulo}
          </button>
        </p>
      )}
      <pre className="contenido">{p.contenido}</pre>
      <div className="acciones">
        <button type="button" disabled={procesando} onClick={() => void actuar("aprobar", { id: p.id })}>
          Aprobar
        </button>
        <label>
          Motivo del rechazo
          <input type="text" disabled={procesando} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={procesando || sinMotivo}
          title={sinMotivo ? "Escribí un motivo para rechazar" : undefined}
          onClick={() => void actuar("rechazar", { id: p.id, motivo })}
        >
          Rechazar
        </button>
      </div>
    </article>
  );
}
