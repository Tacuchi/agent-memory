import { useEffect, useRef, useState } from "react";
import { mensajeError, type Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { ChipsAlcance, elegidos, marcadosDe, SelectorAlcance, unirAmbitos } from "./Alcance";
import { Confirmar, Senal, useAccion } from "./comun";
import type { AmbitoExistente, CodigoNuevo, Dispositivo, Estado } from "./tipos";

// Columna «Leen esta memoria»: invitar una PC con el alcance listo y gobernar las que ya leen.

/** Los ámbitos existentes se piden una vez, cuando hacen falta (al invitar o al editar un alcance). */
function useAmbitos(cliente: Cliente, pedir: boolean) {
  const [ambitos, setAmbitos] = useState<AmbitoExistente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pedir || ambitos) return;
    let vivo = true;
    cliente<{ ambitos: AmbitoExistente[] }>("remoto_ambitos")
      .then((r) => vivo && setAmbitos(r.ambitos))
      .catch((e: unknown) => vivo && setError(mensajeError(e)));
    return () => {
      vivo = false;
    };
  }, [cliente, pedir, ambitos]);
  return { ambitos, error };
}

export function Leen({
  estado,
  cliente,
  recargar,
  codigo,
  setCodigo,
  ahora,
}: {
  estado: Estado;
  cliente: Cliente;
  recargar: () => Promise<void>;
  codigo: CodigoNuevo | null;
  setCodigo: (c: CodigoNuevo | null) => void;
  ahora: () => number;
}) {
  const [invitando, setInvitando] = useState(false);
  const [editando, setEditando] = useState<number | null>(null);
  const { ambitos, error: errorAmbitos } = useAmbitos(cliente, invitando || editando !== null);
  const apagado = !estado.interruptor;
  const activos = estado.dispositivos.filter((d) => d.estado !== "revocado");
  const revocados = estado.dispositivos.filter((d) => d.estado === "revocado");

  return (
    <section className={`col-remota${apagado ? " apagada" : ""}`} aria-labelledby="titulo-leen">
      <header className="ph">
        <h3 id="titulo-leen">Leen esta memoria</h3>
        {!invitando && !codigo && (
          <button type="button" className="ph-boton" disabled={apagado} onClick={() => setInvitando(true)}>
            Invitar una PC
          </button>
        )}
      </header>
      {apagado && (
        <p className="nota-apagado" role="note">
          <Senal tono="tenue">Acceso apagado: nadie puede leer.</Senal>
          <span>Encendelo en «Esta PC» para invitar o para que las PCs enlazadas vuelvan a leer.</span>
        </p>
      )}
      <div className="col-cuerpo">
        {codigo ? (
          <CodigoVigente codigo={codigo} ahora={ahora} cerrar={() => setCodigo(null)} />
        ) : (
          invitando && (
            <Invitar
              ambitos={ambitos}
              errorAmbitos={errorAmbitos}
              cliente={cliente}
              recargar={recargar}
              listo={(c) => {
                setInvitando(false);
                setCodigo(c);
              }}
              cancelar={() => setInvitando(false)}
            />
          )
        )}
        {!codigo && !invitando && estado.codigo && (
          <p className="meta franja">Hay un código vigente hasta las {estado.codigo.vence_en.slice(11, 16)}.</p>
        )}

        {activos.length === 0 && revocados.length === 0 ? (
          <div className="vacio">
            <p>Ninguna PC lee esta memoria.</p>
            <p className="meta">Invitá una con «Invitar una PC»: elegís qué ve y le pasás un código.</p>
          </div>
        ) : (
          <ul className="lista items-remotos" aria-label="PCs que leen esta memoria">
            {activos.map((d) => (
              <ItemDispositivo
                key={d.id}
                d={d}
                cliente={cliente}
                recargar={recargar}
                ambitos={editando === d.id ? ambitos : null}
                errorAmbitos={editando === d.id ? errorAmbitos : null}
                editando={editando === d.id}
                setEditando={(si) => setEditando(si ? d.id : null)}
              />
            ))}
          </ul>
        )}
        {revocados.length > 0 && (
          <details className="revocadas">
            <summary>
              Revocadas <span className="num">{revocados.length}</span>
            </summary>
            <ul className="lista items-remotos" aria-label="PCs revocadas">
              {revocados.map((d) => (
                <li key={d.id} className="item revocado">
                  <div className="item-texto">
                    <span className="item-nombre">{d.nombre}</span>
                    <span className="meta-linea">
                      revocada <span className="num">{fecha(d.revocado_en)}</span> · último uso{" "}
                      <span className="num">{fecha(d.usado_en)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function Invitar({
  ambitos,
  errorAmbitos,
  cliente,
  recargar,
  listo,
  cancelar,
}: {
  ambitos: AmbitoExistente[] | null;
  errorAmbitos: string | null;
  cliente: Cliente;
  recargar: () => Promise<void>;
  listo: (c: CodigoNuevo) => void;
  cancelar: () => void;
}) {
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [noValidadas, setNoValidadas] = useState(false);
  const generar = useAccion(recargar);
  const sinNada = marcados.size === 0 && !noValidadas;

  return (
    <div className="franja invitar" role="group" aria-label="Invitar una PC" onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <SelectorAlcance
        leyenda="Qué verá la otra PC"
        ambitos={errorAmbitos ? [] : ambitos}
        marcados={marcados}
        noValidadas={noValidadas}
        cambiar={setMarcados}
        cambiarNoValidadas={setNoValidadas}
      />
      <Aviso texto={errorAmbitos} />
      {sinNada && <p className="meta">Sin marcar nada, la PC queda enlazada pero no ve ninguna entrada hasta que le des alcance.</p>}
      <div className="barra-accion">
        <button
          type="button"
          className="primario"
          disabled={generar.ocupado || ambitos === null}
          onClick={() => {
            let nuevo: CodigoNuevo | null = null;
            void generar
              .ejecutar(async () => {
                nuevo = await cliente<CodigoNuevo>("remoto_codigo", { ambitos: elegidos(ambitos, marcados), no_validadas: noValidadas });
              }, null)
              .then((ok) => ok && nuevo && listo(nuevo));
          }}
        >
          Generar código
        </button>
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </div>
      <Aviso texto={generar.error} />
    </div>
  );
}

function CodigoVigente({ codigo, ahora, cerrar }: { codigo: CodigoNuevo; ahora: () => number; cerrar: () => void }) {
  const [restante, setRestante] = useState(() => new Date(codigo.vence_en).getTime() - ahora());
  const [copiado, setCopiado] = useState<string | null>(null);
  useEffect(() => {
    setRestante(new Date(codigo.vence_en).getTime() - ahora());
    const reloj = setInterval(() => setRestante(new Date(codigo.vence_en).getTime() - ahora()), 1000);
    return () => clearInterval(reloj);
  }, [codigo, ahora]);
  const segundos = Math.max(0, Math.floor(restante / 1000));

  async function copiar() {
    try {
      await navigator.clipboard.writeText(codigo.codigo);
      setCopiado("Copiado");
    } catch {
      setCopiado("No se pudo copiar: seleccioná el código y copialo a mano.");
    }
  }

  return (
    <div className="franja codigo-vigente" role="group" aria-label="Código para enlazar">
      <div className="codigo-fila">
        <code className="codigo-grande" aria-label="Código de enlace">
          {codigo.codigo}
        </code>
        <button type="button" onClick={() => void copiar()} disabled={segundos === 0}>
          Copiar
        </button>
      </div>
      <p className="codigo-estado">
        <span role="timer" className={segundos === 0 ? "vencido" : undefined}>
          {segundos > 0 ? (
            <>
              Vence en <span className="num">{`${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}`}</span>
            </>
          ) : (
            "Venció: generá otro"
          )}
        </span>
        <span aria-live="polite" className="meta">
          {copiado}
        </span>
      </p>
      <p>
        En la otra PC: <strong>Acceso remoto → Pegar un código</strong>. Sirve una sola vez.
      </p>
      <p className="meta">
        O en su terminal: <code>agent-memory remote link {codigo.codigo}</code>
      </p>
      <div className="barra-accion">
        <button type="button" onClick={cerrar}>
          Listo
        </button>
      </div>
    </div>
  );
}

function ItemDispositivo({
  d,
  cliente,
  recargar,
  ambitos,
  errorAmbitos,
  editando,
  setEditando,
}: {
  d: Dispositivo;
  cliente: Cliente;
  recargar: () => Promise<void>;
  ambitos: AmbitoExistente[] | null;
  errorAmbitos: string | null;
  editando: boolean;
  setEditando: (si: boolean) => void;
}) {
  const [revocando, setRevocando] = useState(false);
  const accion = useAccion(recargar);
  const sinAlcance = d.alcance.ambitos.length === 0 && !d.alcance.no_validadas;
  const alcanceRef = useRef<HTMLButtonElement>(null);

  return (
    <li className="item">
      <div className="item-texto">
        <span className="item-nombre">
          {d.nombre}
          {d.estado === "credencial_vencida" && <Senal tono="pendiente">vencida</Senal>}
        </span>
        {sinAlcance ? (
          <span className="sin-alcance">
            <Senal tono="pendiente">sin alcance: no ve nada</Senal>
            <button type="button" className="enlace azul" aria-label={`Elegir el alcance de ${d.nombre}`} onClick={() => setEditando(true)}>
              Elegir alcance
            </button>
          </span>
        ) : (
          <ChipsAlcance alcance={d.alcance} />
        )}
        <span className="meta-linea">
          último uso <span className="num">{fecha(d.usado_en)}</span> · vence <span className="num">{fecha(d.vence_en)}</span>
        </span>
      </div>
      <div className="item-acciones">
        <button type="button" ref={alcanceRef} aria-label={`Alcance de ${d.nombre}`} aria-expanded={editando} onClick={() => setEditando(!editando)}>
          Alcance
        </button>
        <button
          type="button"
          aria-label={`Renovar ${d.nombre}`}
          disabled={accion.ocupado}
          onClick={() => void accion.ejecutar(() => cliente("remoto_renovar", { id: d.id }), `${d.nombre}: renovada por 30 días`)}
        >
          Renovar
        </button>
        <button type="button" className="peligro" aria-label={`Revocar ${d.nombre}`} onClick={() => setRevocando(true)} disabled={revocando}>
          Revocar
        </button>
      </div>
      {revocando && (
        <div className="item-extra">
          <Confirmar
            accion={`Revocar ${d.nombre}`}
            ocupado={accion.ocupado}
            cancelar={() => setRevocando(false)}
            confirmar={() => void accion.ejecutar(() => cliente("remoto_revocar", { id: d.id }), `${d.nombre}: revocada`)}
          >
            {d.nombre} deja de leer en el acto. Para volver a enlazarla hace falta un código nuevo.
          </Confirmar>
        </div>
      )}
      {editando && (
        <div className="item-extra">
          <EditorAlcance
            d={d}
            ambitos={ambitos}
            errorAmbitos={errorAmbitos}
            ocupado={accion.ocupado}
            cancelar={() => {
              setEditando(false);
              alcanceRef.current?.focus();
            }}
            guardar={(ambitosElegidos, noValidadas) =>
              void accion
                .ejecutar(
                  () => cliente("remoto_alcance", { id: d.id, ambitos: ambitosElegidos, no_validadas: noValidadas }),
                  `${d.nombre}: alcance guardado; rige desde la próxima lectura`,
                )
                .then((ok) => ok && setEditando(false))
            }
          />
        </div>
      )}
      <div className="item-extra">
        <Aviso texto={accion.error} />
        <Aviso texto={accion.hecho} tipo="ok" />
      </div>
    </li>
  );
}

function EditorAlcance({
  d,
  ambitos,
  errorAmbitos,
  ocupado,
  guardar,
  cancelar,
}: {
  d: Dispositivo;
  ambitos: AmbitoExistente[] | null;
  errorAmbitos: string | null;
  ocupado: boolean;
  guardar: (ambitos: { ambito: "global" | "proyecto" | "repo"; ref: string | null }[], noValidadas: boolean) => void;
  cancelar: () => void;
}) {
  const [marcados, setMarcados] = useState(() => marcadosDe(d.alcance.ambitos));
  const [noValidadas, setNoValidadas] = useState(d.alcance.no_validadas);
  const todos = ambitos ? unirAmbitos(ambitos, d.alcance.ambitos) : errorAmbitos ? unirAmbitos([], d.alcance.ambitos) : null;
  return (
    <div className="editor-alcance" role="group" aria-label={`Editar alcance de ${d.nombre}`} onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <SelectorAlcance
        leyenda={`Qué ve ${d.nombre}`}
        ambitos={todos}
        marcados={marcados}
        noValidadas={noValidadas}
        cambiar={setMarcados}
        cambiarNoValidadas={setNoValidadas}
      />
      <Aviso texto={errorAmbitos} />
      <div className="barra-accion">
        <button type="button" className="primario" disabled={ocupado || todos === null} onClick={() => guardar(elegidos(todos, marcados), noValidadas)}>
          Guardar alcance
        </button>
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
