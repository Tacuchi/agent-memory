import { useEffect, useRef, useState, type ReactNode } from "react";
import { AMBITOS, TIPOS, mensajeError, type Cliente, type Pendiente } from "../api";
import type { Navegar } from "../App";
import { FormRechazo, HojaEntrada, HojaInferior, useEsMovil, usePresionLarga } from "../movil";
import { mover, useAtajos } from "../teclado";
import { Aviso, extracto, fecha, lugar, textoImportacion } from "./comunes";
import { VistaPrevia } from "./VistaPrevia";

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

/**
 * Bandeja de pendientes. En escritorio: filtros y lote, cola y vista previa. En el celular: la cola
 * a lo ancho, una hoja inferior para decidir y selección en lote al mantener presionada una fila.
 * Resumen la reutiliza en el celular con sus cifras como encabezado.
 */
export function Bandeja({
  cliente,
  navegar,
  encabezadoMovil,
  alCambiar,
}: {
  cliente: Cliente;
  navegar: Navegar;
  encabezadoMovil?: ReactNode;
  alCambiar?: () => void;
}) {
  const esMovil = useEsMovil();
  const [seleccionando, setSeleccionando] = useState(false);
  const [hoja, setHoja] = useState<"entrada" | "lote" | "importacion" | null>(null);
  const [hojaId, setHojaId] = useState<number | null>(null);
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ambito, setAmbito] = useState("");
  const [referencia, setReferencia] = useState<Referencia | null>(null);
  const [tipo, setTipo] = useState("");
  const [importacion, setImportacion] = useState("");
  const [motivoImportacion, setMotivoImportacion] = useState("");
  const [hecho, setHecho] = useState<string | null>(null);
  const [seleccionadas, setSeleccionadas] = useState<number[]>([]);
  const [motivo, setMotivo] = useState("");
  const [procesando, setProcesando] = useState(false);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [foco, setFoco] = useState(0);
  const enCurso = useRef(false);
  const refMotivo = useRef<HTMLInputElement>(null);

  const delAmbito = (pendientes ?? []).filter((p) => !ambito || p.ambito === ambito);
  const referencias = new Map(delAmbito.filter((p) => p.ambito_ref).map((p) => [claveAmbito(p), {
    clave: claveAmbito(p), etiqueta: `${p.ambito} · ${p.ambito_ref}`,
  }]));
  if (referencia) referencias.set(referencia.clave, referencia);
  const importaciones = new Map((pendientes ?? []).filter((p) => p.importacion).map((p) => [String(p.importacion!.id), p.importacion!]));
  const elegida = importaciones.get(importacion) ?? null;
  const deLaImportacion = elegida ? (pendientes ?? []).filter((p) => p.importacion?.id === elegida.id) : [];
  const visibles = delAmbito.filter(
    (p) => (!referencia || claveAmbito(p) === referencia.clave) && (!tipo || p.tipo === tipo) && (!elegida || p.importacion?.id === elegida.id),
  );
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
      alCambiar?.();
    } finally {
      setSeleccionadas([]);
      setProcesando(false);
      enCurso.current = false;
    }
  }

  /** Rechaza la importación entera: sus pendientes y lo que siga en espera, con un solo motivo. */
  async function rechazarImportacion(id: number, motivoRechazo: string) {
    const motivoLimpio = motivoRechazo.trim();
    if (enCurso.current || !motivoLimpio) return;
    enCurso.current = true;
    setProcesando(true);
    setError(null);
    setHecho(null);
    try {
      const r = await cliente<{ rechazadas: number; descartadas: number }>("rechazar_importacion", { importacion: id, motivo: motivoLimpio });
      setHecho(`Importación ${id} rechazada: ${r.rechazadas} pendientes rechazadas y ${r.descartadas} en espera descartadas.`);
      setImportacion("");
      setMotivoImportacion("");
      await cargar();
      alCambiar?.();
    } catch (e) {
      setError(`No se pudo rechazar la importación ${id}: ${mensajeError(e)}`);
    } finally {
      setSeleccionadas([]);
      setProcesando(false);
      enCurso.current = false;
    }
  }

  const indice = Math.min(foco, Math.max(0, visibles.length - 1));
  const enfocada = visibles[indice] ?? null;

  function alternar(id: number) {
    setSeleccionadas((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  useAtajos({
    j: () => setFoco(mover(indice, 1, visibles.length)),
    k: () => setFoco(mover(indice, -1, visibles.length)),
    x: () => (enfocada && !procesando ? alternar(enfocada.id) : false),
    a: () => (enfocada ? void actuar("aprobar", [enfocada]) : false),
    r: () => refMotivo.current?.focus(),
    Enter: () => (enfocada ? navegar({ tipo: "detalle", id: enfocada.id }) : false),
  });

  function filtrar(cambio: () => void) {
    cambio();
    setSeleccionadas([]);
    setFoco(0);
  }

  const filtrosJsx = (
    <div className="filtros">
      <label>
        Ámbito
        <select disabled={procesando} value={ambito} onChange={(e) => filtrar(() => { setAmbito(e.target.value); setReferencia(null); })}>
          <option value="">todos</option>
          {AMBITOS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label>
        Proyecto o repositorio
        <select disabled={procesando} value={referencia?.clave ?? ""} onChange={(e) => filtrar(() => setReferencia(referencias.get(e.target.value) ?? null))}>
          <option value="">todos</option>
          {[...referencias.values()].map((r) => <option key={r.clave} value={r.clave}>{r.etiqueta}</option>)}
        </select>
      </label>
      <label>
        Tipo
        <select disabled={procesando} value={tipo} onChange={(e) => filtrar(() => setTipo(e.target.value))}>
          <option value="">todos</option>
          {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      {importaciones.size > 0 && (
        <label>
          Importación
          <select disabled={procesando} value={importacion} onChange={(e) => filtrar(() => setImportacion(e.target.value))}>
            <option value="">todas</option>
            {[...importaciones.values()].map((o) => <option key={o.id} value={String(o.id)}>{textoImportacion(o)}</option>)}
          </select>
        </label>
      )}
    </div>
  );

  const importacionJsx = elegida && (
    <div className="lote" role="group" aria-label={`Importación ${elegida.id}`}>
      <span className="meta">{textoImportacion(elegida)} · {deLaImportacion.length} pendientes. Rechazarla descarta también lo que siga en espera.</span>
      <button type="button" className="primario" disabled={procesando || deLaImportacion.length === 0} onClick={() => void actuar("aprobar", deLaImportacion)}>
        Aprobar importación
      </button>
      <label>
        Motivo del rechazo de la importación
        <input type="text" disabled={procesando} value={motivoImportacion} onChange={(e) => setMotivoImportacion(e.target.value)} />
      </label>
      <button
        type="button"
        className="peligro"
        disabled={procesando || !motivoImportacion.trim()}
        title={!motivoImportacion.trim() ? "Escribí un motivo para rechazar" : undefined}
        onClick={() => void rechazarImportacion(elegida.id, motivoImportacion)}
      >
        Rechazar importación
      </button>
    </div>
  );

  const avisosJsx = (
    <>
      {error && (
        <div className="cuerpo">
          <Aviso texto={error} />
          <button type="button" disabled={procesando} onClick={() => { setError(null); void cargar(); }}>Recargar pendientes</button>
        </div>
      )}
      {hecho && (
        <p className="cuerpo" role="status">
          {hecho}
        </p>
      )}
      {resultados.length > 0 && (
        <section className="resultado" aria-label="Resultado de la acción">
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
      {pendientes && pendientes.length === 0 && (
        <div className="vacio">
          <p>No hay entradas pendientes.</p>
          <span>Lo que guarden los agentes aparece acá para que lo apruebes o lo rechaces.</span>
        </div>
      )}
      {pendientes && pendientes.length > 0 && visibles.length === 0 && (
        <div className="vacio">
          <p>No hay pendientes con estos filtros.</p>
          <span>Hay {pendientes.length} en total: cambiá el ámbito, el proyecto o el tipo.</span>
        </div>
      )}
    </>
  );

  if (esMovil) {
    const hojaEntrada = hoja === "entrada" ? visibles.find((p) => p.id === hojaId) ?? null : null;
    const cerrarHoja = () => setHoja(null);
    const elegir = (id: number) => {
      setSeleccionando(true);
      setSeleccionadas((ids) => (ids.includes(id) ? ids : [...ids, id]));
    };
    const salir = () => {
      setSeleccionando(false);
      setSeleccionadas([]);
    };
    return (
      <div className={seleccionando ? "movil seleccionando" : "movil"}>
        {seleccionando ? (
          <header className="cabecera-movil seleccionando">
            <button type="button" className="icono" aria-label="Salir de la selección" onClick={salir}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" /></svg>
            </button>
            <strong><span className="num">{elegidas.length}</span> seleccionadas</strong>
            <button type="button" className="enlace azul" onClick={() => setSeleccionadas(visibles.map((p) => p.id))}>
              Todas ({visibles.length})
            </button>
          </header>
        ) : encabezadoMovil ? (
          <>
            {encabezadoMovil}
            <h2 className="ph">
              <span>Cola de pendientes</span>
              <button type="button" className="enlace azul" disabled={procesando || visibles.length === 0} onClick={() => setSeleccionando(true)}>Elegir</button>
            </h2>
          </>
        ) : (
          <header className="cabecera-movil">
            <h2>Pendientes <span className="num cuenta pendiente">{visibles.length}</span></h2>
            <button type="button" className="enlace azul" disabled={procesando || visibles.length === 0} onClick={() => setSeleccionando(true)}>Elegir</button>
          </header>
        )}
        {!encabezadoMovil && !seleccionando && (
          <details className="filtros-movil">
            <summary>Filtros{ambito || referencia || tipo || elegida ? " · activos" : ""}</summary>
            {filtrosJsx}
          </details>
        )}
        {elegida && !seleccionando && (
          <div className="barra-lote">
            <span className="meta">{textoImportacion(elegida)} · {deLaImportacion.length} pendientes</span>
            <div>
              <button type="button" className="peligro" disabled={procesando} onClick={() => setHoja("importacion")}>
                Rechazar importación…
              </button>
              <button type="button" className="primario" disabled={procesando || deLaImportacion.length === 0} onClick={() => void actuar("aprobar", deLaImportacion)}>
                Aprobar importación
              </button>
            </div>
          </div>
        )}
        {avisosJsx}
        <ul className="lista" aria-label="Cola de pendientes">
          {visibles.map((p) => (
            <li key={p.id}>
            <FilaMovil
              pendiente={p}
              seleccionando={seleccionando}
              elegida={seleccionadas.includes(p.id)}
              ocupado={procesando}
              tocar={() => {
                if (seleccionando) alternar(p.id);
                else {
                  setHojaId(p.id);
                  setHoja("entrada");
                }
              }}
              presionarLargo={() => elegir(p.id)}
            />
            </li>
          ))}
        </ul>
        {visibles.length > 0 && !seleccionando && <p className="nota">Mantené presionada una fila para elegir varias.</p>}
        {seleccionando && (
          <div className="barra-lote">
            <span className="meta">Se procesan de a una; si alguna falla, las demás siguen y te digo cuál.</span>
            <div>
              <button type="button" className="peligro" disabled={procesando || elegidas.length === 0} onClick={() => setHoja("lote")}>
                Rechazar {elegidas.length}…
              </button>
              <button
                type="button"
                className="primario"
                disabled={procesando || elegidas.length === 0}
                onClick={() => {
                  setSeleccionando(false);
                  void actuar("aprobar", elegidas);
                }}
              >
                Aprobar {elegidas.length}
              </button>
            </div>
          </div>
        )}
        {hojaEntrada && (
          <HojaEntrada
            key={hojaEntrada.id}
            entrada={hojaEntrada}
            ocupado={procesando}
            aprobar={() => {
              cerrarHoja();
              void actuar("aprobar", [hojaEntrada]);
            }}
            rechazar={(m) => {
              cerrarHoja();
              void actuar("rechazar", [hojaEntrada], m);
            }}
            navegar={navegar}
            cerrar={cerrarHoja}
          />
        )}
        {hoja === "importacion" && elegida && (
          <HojaInferior etiqueta="Rechazar importación" cerrar={cerrarHoja}>
            <FormRechazo
              titulo={`Rechazar la importación ${elegida.id}: sus ${deLaImportacion.length} pendientes y lo que siga en espera`}
              ocupado={procesando}
              cancelar={cerrarHoja}
              rechazar={(m) => {
                cerrarHoja();
                void rechazarImportacion(elegida.id, m);
              }}
            />
          </HojaInferior>
        )}
        {hoja === "lote" && (
          <HojaInferior etiqueta="Rechazar seleccionadas" cerrar={cerrarHoja}>
            <FormRechazo
              titulo={`Rechazar ${elegidas.length} seleccionadas`}
              ocupado={procesando}
              cancelar={cerrarHoja}
              rechazar={(m) => {
                cerrarHoja();
                setSeleccionando(false);
                void actuar("rechazar", elegidas, m);
              }}
            />
          </HojaInferior>
        )}
      </div>
    );
  }

  return (
    <div className="tablero">
      <section className="columna col-estado" aria-labelledby="titulo-bandeja">
        <h2 id="titulo-bandeja" className="ph">Pendientes</h2>
        {filtrosJsx}
        <h3 className="ph">En lote</h3>
        <div className="lote">
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
          <span className="meta num">{elegidas.length} seleccionadas · {visibles.length} visibles</span>
          <button type="button" className="primario" disabled={procesando || elegidas.length === 0} onClick={() => void actuar("aprobar", elegidas)}>
            Aprobar seleccionadas
          </button>
          <label>
            Motivo del rechazo de las seleccionadas
            <input type="text" disabled={procesando} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </label>
          <button
            type="button"
            className="peligro"
            disabled={procesando || elegidas.length === 0 || !motivo.trim()}
            title={!motivo.trim() ? "Escribí un motivo para rechazar" : undefined}
            onClick={() => void actuar("rechazar", elegidas, motivo)}
          >
            Rechazar seleccionadas
          </button>
        </div>
        {importacionJsx}
      </section>

      <section className="columna" aria-labelledby="titulo-cola">
        <h2 id="titulo-cola" className="ph">
          Cola <span className="num">{visibles.length}</span>
        </h2>
        {avisosJsx}
        <div className="desplaza">
          {visibles.map((p, i) => (
            <FilaPendiente
              key={p.id}
              pendiente={p}
              enfocada={i === indice}
              enfocar={() => setFoco(i)}
              navegar={navegar}
              procesando={procesando}
              seleccionada={seleccionadas.includes(p.id)}
              alternar={() => alternar(p.id)}
            />
          ))}
        </div>
      </section>

      <section className="columna previa-col" aria-labelledby="titulo-previa">
        <h2 id="titulo-previa" className="ph">
          Vista previa {enfocada && <span className="num">#{enfocada.id}</span>}
        </h2>
        {enfocada ? (
          <VistaPrevia
            key={enfocada.id}
            entrada={enfocada}
            ocupado={procesando}
            aprobar={() => void actuar("aprobar", [enfocada])}
            rechazar={(m) => void actuar("rechazar", [enfocada], m)}
            navegar={navegar}
            refMotivo={refMotivo}
          />
        ) : (
          <div className="vacio">{pendientes ? "Nada que previsualizar." : "Cargando…"}</div>
        )}
      </section>
    </div>
  );
}

function FilaPendiente({
  pendiente: p,
  enfocada,
  enfocar,
  navegar,
  procesando,
  seleccionada,
  alternar,
}: {
  pendiente: Pendiente;
  enfocada: boolean;
  enfocar: () => void;
  navegar: Navegar;
  procesando: boolean;
  seleccionada: boolean;
  alternar: () => void;
}) {
  return (
    <article className={`fila${enfocada ? " enfocada" : ""}`} aria-label={`Pendiente #${p.id}`} aria-current={enfocada ? "true" : undefined}>
      <input type="checkbox" aria-label={`Seleccionar #${p.id}`} checked={seleccionada} disabled={procesando} onChange={alternar} />
      <span className="punto pendiente" aria-hidden="true" />
      <button type="button" className="enlace titulo" onClick={enfocar}>
        {p.titulo}
      </button>
      <span className="lateral">#{p.id} · {fecha(p.actualizada_en)}</span>
      <span className="extracto">{lugar(p)} — {extracto(p.contenido)}</span>
      {p.importacion && <span className="extracto">{textoImportacion(p.importacion)}</span>}
      {p.reemplazaria && (
        <span className="extracto">
          Reemplazaría a{" "}
          <button type="button" className="enlace azul" disabled={procesando} onClick={() => navegar({ tipo: "detalle", id: p.reemplazaria!.id })}>
            #{p.reemplazaria.id} · {p.reemplazaria.titulo}
          </button>
        </span>
      )}
    </article>
  );
}

/** Fila de la cola en el celular: tocar abre la hoja; mantener presionado entra en selección. */
function FilaMovil({
  pendiente: p,
  seleccionando,
  elegida,
  ocupado,
  tocar,
  presionarLargo,
}: {
  pendiente: Pendiente;
  seleccionando: boolean;
  elegida: boolean;
  ocupado: boolean;
  tocar: () => void;
  presionarLargo: () => void;
}) {
  const { fueLarga, manejadores } = usePresionLarga(presionarLargo);
  return (
    <button
      type="button"
      className={elegida ? "fila-movil elegida" : "fila-movil"}
      aria-pressed={seleccionando ? elegida : undefined}
      disabled={ocupado}
      {...manejadores}
      onClick={() => {
        if (fueLarga.current) {
          fueLarga.current = false;
          return;
        }
        tocar();
      }}
    >
      {seleccionando ? (
        <span className={elegida ? "caja marcada" : "caja"} aria-hidden="true">
          {elegida && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M3 7.5l2.5 2.5L11 4.5" /></svg>}
        </span>
      ) : (
        <span className="punto pendiente" aria-hidden="true" />
      )}
      <span className="titulo">{p.titulo}</span>
      <span className="lateral">#{p.id}</span>
      <span className="extracto">{lugar(p)}{p.importacion ? ` · ${textoImportacion(p.importacion)}` : ""}</span>
    </button>
  );
}
