import { useEffect, useRef, useState } from "react";
import { ErrorApi, mensajeError, type Cliente, type Pendiente } from "../api";
import type { Navegar } from "../App";
import { useEsMovil } from "../movil";
import { mover, useAtajos } from "../teclado";
import { Bandeja } from "./Bandeja";
import { Aviso, extracto, fecha, lugar } from "./comunes";
import { VistaPrevia } from "./VistaPrevia";

interface ParaRevisar {
  id: number;
  titulo: string;
  motivos: ("sin_uso" | "sin_verificar")[];
}

interface Estado {
  pendientes: Pendiente[];
  revisar: ParaRevisar[];
  validadas: number;
  rechazadas: number;
}

/** El listado devuelve como mucho 100: más que eso se muestra como «100+». */
const TOPE = 100;
const MOTIVOS = { sin_uso: "sin uso", sin_verificar: "sin verificar" } as const;

/**
 * Pantalla de entrada: estado de la memoria, la cola de pendientes y la enfocada completa,
 * para aprobar o rechazar sin cambiar de pantalla.
 */
export function Resumen({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [remoto, setRemoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const [foco, setFoco] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  const refMotivo = useRef<HTMLInputElement>(null);
  const esMovil = useEsMovil();

  async function cargar() {
    const cuantas = async (validacion: string) =>
      (await cliente<{ entradas: unknown[] }>("listar", { filtros: { todos_los_ambitos: true, validacion: [validacion] }, limite: TOPE })).entradas.length;
    try {
      const [p, r, validadas, rechazadas] = await Promise.all([
        cliente<{ entradas: Pendiente[] }>("pendientes", {}),
        cliente<{ entradas: ParaRevisar[] }>("revision", {}),
        cuantas("validada"),
        cuantas("rechazada"),
      ]);
      setEstado({ pendientes: p.entradas, revisar: r.entradas, validadas, rechazadas });
      setFoco((f) => Math.min(f, Math.max(0, p.entradas.length - 1)));
    } catch (e) {
      setError(`No se pudo cargar el resumen: ${mensajeError(e)}`);
    }
  }

  async function cargarRemoto() {
    try {
      const r = await cliente<{ interruptor: boolean; dispositivos: unknown[] }>("remoto_estado", {});
      const n = r.dispositivos.length;
      setRemoto(`${r.interruptor ? "encendido" : "apagado"} · ${n} ${n === 1 ? "dispositivo enlazado" : "dispositivos enlazados"}`);
    } catch (e) {
      setRemoto(e instanceof ErrorApi && e.codigo === "sin_enlace_remoto" ? "no disponible en esta instalación" : `sin datos: ${mensajeError(e)}`);
    }
  }

  useEffect(() => {
    void cargar();
    void cargarRemoto();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendientes = estado?.pendientes ?? [];
  const enfocada = pendientes[foco] ?? null;

  async function decidir(op: "aprobar" | "rechazar", motivo?: string) {
    if (!enfocada || ocupado) return;
    setOcupado(true);
    setError(null);
    setHecho(null);
    try {
      await cliente(op, { id: enfocada.id, ...(op === "rechazar" ? { motivo: motivo?.trim() } : {}) });
      setHecho(`#${enfocada.id} ${op === "aprobar" ? "aprobada" : "rechazada"} · ${enfocada.titulo}`);
      await cargar();
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setOcupado(false);
    }
  }

  useAtajos({
    j: () => setFoco((f) => mover(f, 1, pendientes.length)),
    k: () => setFoco((f) => mover(f, -1, pendientes.length)),
    a: () => void decidir("aprobar"),
    r: () => refMotivo.current?.focus(),
    Enter: () => (enfocada ? navegar({ tipo: "detalle", id: enfocada.id }) : false),
  });

  const cifra = (n: number) => (n >= TOPE ? `${TOPE}+` : String(n));

  // En el celular: las cifras arriba y la cola de la bandeja (hoja inferior y lote) debajo.
  if (esMovil) {
    const encabezado = (
      <>
        <div className="cifras">
          <button type="button" onClick={() => navegar({ tipo: "bandeja" })}>
            <span className="num pendiente">{estado ? estado.pendientes.length : "…"}</span>
            <span>pendientes</span>
          </button>
          <button type="button" onClick={() => navegar({ tipo: "revision" })}>
            <span className="num revisar">{estado ? estado.revisar.length : "…"}</span>
            <span>revisar</span>
          </button>
          <button type="button" onClick={() => navegar({ tipo: "buscar" })}>
            <span className="num">{estado ? cifra(estado.validadas) : "…"}</span>
            <span>validadas</span>
          </button>
          <button type="button" onClick={() => navegar({ tipo: "buscar" })}>
            <span className="num">{estado ? cifra(estado.rechazadas) : "…"}</span>
            <span>rechazadas</span>
          </button>
        </div>
        {error && (
          <div className="cuerpo">
            <Aviso texto={error} />
          </div>
        )}
      </>
    );
    return <Bandeja cliente={cliente} navegar={navegar} encabezadoMovil={encabezado} alCambiar={() => void cargar()} />;
  }

  return (
    <div className="tablero">
      <section className="columna col-estado" aria-labelledby="titulo-resumen">
        <h2 id="titulo-resumen" className="ph">Estado</h2>
        <button type="button" className="estado-item" onClick={() => navegar({ tipo: "bandeja" })}>
          <span className="punto pendiente" aria-hidden="true" />
          Pendientes
          <span className="num">{estado ? estado.pendientes.length : "…"}</span>
        </button>
        <button type="button" className="estado-item" onClick={() => navegar({ tipo: "revision" })}>
          <span className="punto revisar" aria-hidden="true" />
          Para revisar
          <span className="num">{estado ? estado.revisar.length : "…"}</span>
        </button>
        <button type="button" className="estado-item" onClick={() => navegar({ tipo: "buscar" })}>
          <span className="punto validada" aria-hidden="true" />
          Validadas
          <span className="num">{estado ? cifra(estado.validadas) : "…"}</span>
        </button>
        <button type="button" className="estado-item" onClick={() => navegar({ tipo: "buscar" })}>
          <span className="punto rechazada" aria-hidden="true" />
          Rechazadas
          <span className="num">{estado ? cifra(estado.rechazadas) : "…"}</span>
        </button>
        {estado && estado.revisar.length > 0 && (
          <>
            <h3 className="ph">Para revisar</h3>
            <ul className="lista" aria-label="Para revisar">
              {estado.revisar.slice(0, 5).map((e) => (
                <li key={e.id} className="fila sin-casilla">
                  <span className="punto revisar" aria-hidden="true" />
                  <button type="button" className="enlace titulo" onClick={() => navegar({ tipo: "detalle", id: e.id })}>
                    {e.titulo}
                  </button>
                  <span className="lateral">#{e.id}</span>
                  <span className="extracto">{e.motivos.map((m) => MOTIVOS[m]).join(" · ")}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h3 className="ph">Acceso remoto</h3>
        <p className="nota">{remoto ?? "…"}</p>
      </section>

      <section className="columna" aria-labelledby="titulo-cola">
        <h2 id="titulo-cola" className="ph">
          Cola de pendientes <span className="num">{estado?.pendientes.length ?? ""}</span>
        </h2>
        {(error || hecho) && (
          <div className="cuerpo" style={{ paddingBottom: 0 }}>
            <Aviso texto={error} />
            <Aviso texto={hecho} tipo="ok" />
          </div>
        )}
        {estado && pendientes.length === 0 && (
          <div className="vacio">
            <strong>No hay pendientes.</strong>
            <span>Lo que guarden los agentes aparece acá para que lo apruebes o lo rechaces.</span>
          </div>
        )}
        <ul className="lista desplaza" aria-label="Cola de pendientes">
          {pendientes.map((p, i) => (
            <li key={p.id} className={`fila sin-casilla${i === foco ? " enfocada" : ""}`} aria-current={i === foco ? "true" : undefined}>
              <span className="punto pendiente" aria-hidden="true" />
              <button type="button" className="enlace titulo" onClick={() => setFoco(i)}>
                {p.titulo}
              </button>
              <span className="lateral">
                #{p.id} · {fecha(p.actualizada_en)}
              </span>
              <span className="extracto">
                {lugar(p)} — {extracto(p.contenido)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="columna previa-col" aria-labelledby="titulo-previa">
        <h2 id="titulo-previa" className="ph">
          Vista previa {enfocada && <span className="num">#{enfocada.id}</span>}
        </h2>
        {enfocada ? (
          <VistaPrevia
            key={enfocada.id}
            entrada={enfocada}
            ocupado={ocupado}
            aprobar={() => void decidir("aprobar")}
            rechazar={(motivo) => void decidir("rechazar", motivo)}
            navegar={navegar}
            refMotivo={refMotivo}
          />
        ) : (
          <div className="vacio">{estado ? "Nada que previsualizar." : "Cargando…"}</div>
        )}
      </section>
    </div>
  );
}
