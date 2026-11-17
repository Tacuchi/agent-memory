import { useEffect, useRef, useState } from "react";
import { mensajeError, type Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { ChipsAlcance, elegidos, marcadosDe, SelectorAlcance, unirAmbitos } from "./Alcance";
import { Confirmar, Senal, useAccion } from "./comun";
import type { Alcance, AmbitoAlcance, AmbitoExistente, CodigoNuevo, Conexion } from "./tipos";

// Sentido «Le compartís tu memoria»: invitar con el alcance listo (código) y gobernar lo que la otra PC ve.

/** Los ámbitos existentes se piden una vez, cuando hacen falta (al invitar o al editar un alcance). */
export function useAmbitos(cliente: Cliente, pedir: boolean) {
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

export function Flecha({ sentido }: { sentido: "sale" | "entra" }) {
  return (
    <svg className={`flecha ${sentido}`} aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {sentido === "sale" ? <path d="M3 8h9M9 4l4 4-4 4" /> : <path d="M13 8H4M7 4L3 8l4 4" />}
    </svg>
  );
}

/** Elegir qué verá la otra PC y generar el código (D02 de la spec 006). */
export function Invitar({
  cliente,
  recargar,
  listo,
  cancelar,
}: {
  cliente: Cliente;
  recargar: () => Promise<void>;
  listo: (c: CodigoNuevo) => void;
  cancelar?: () => void;
}) {
  const { ambitos, error: errorAmbitos } = useAmbitos(cliente, true);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [noValidadas, setNoValidadas] = useState(false);
  const generar = useAccion(recargar);
  const sinNada = marcados.size === 0 && !noValidadas;

  return (
    <div className="invitar" role="group" aria-label="Elegir qué verá la otra PC" onKeyDown={(e) => e.key === "Escape" && cancelar?.()}>
      <SelectorAlcance
        leyenda="Qué verá la otra PC"
        ambitos={errorAmbitos ? [] : ambitos}
        marcados={marcados}
        noValidadas={noValidadas}
        cambiar={setMarcados}
        cambiarNoValidadas={setNoValidadas}
      />
      <Aviso texto={errorAmbitos} />
      {sinNada && <p className="meta">Sin marcar nada, la PC queda conectada pero no ve ninguna entrada hasta que le des alcance.</p>}
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
        {cancelar && (
          <button type="button" onClick={cancelar}>
            Cancelar
          </button>
        )}
      </div>
      <Aviso texto={generar.error} />
    </div>
  );
}

/**
 * El código recién generado. Con la conexión directa escuchando llega además la invitación directa (código y dirección
 * de esta PC); si también hay relé, la persona elige cuál pasar, con la directa primero.
 */
export function CodigoVigente({ codigo, ahora, cerrar, rele }: { codigo: CodigoNuevo; ahora: () => number; cerrar: () => void; rele: boolean }) {
  const [restante, setRestante] = useState(() => new Date(codigo.vence_en).getTime() - ahora());
  const [copiado, setCopiado] = useState<string | null>(null);
  const [modo, setModo] = useState<"directo" | "rele">(codigo.invitacion ? "directo" : "rele");
  const directo = modo === "directo" && Boolean(codigo.invitacion);
  const texto = directo ? (codigo.invitacion as string) : codigo.codigo;
  useEffect(() => setModo(codigo.invitacion ? "directo" : "rele"), [codigo]);
  useEffect(() => {
    setRestante(new Date(codigo.vence_en).getTime() - ahora());
    const reloj = setInterval(() => setRestante(new Date(codigo.vence_en).getTime() - ahora()), 1000);
    return () => clearInterval(reloj);
  }, [codigo, ahora]);
  const segundos = Math.max(0, Math.floor(restante / 1000));

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado("Copiado");
    } catch {
      setCopiado("No se pudo copiar: seleccioná el código y copialo a mano.");
    }
  }

  return (
    <div className="codigo-vigente" role="group" aria-label="Código para conectar">
      {codigo.invitacion && rele && (
        <div className="modo-codigo" role="radiogroup" aria-label="Cómo se conecta la otra PC">
          <label>
            <input type="radio" name="modo-codigo" checked={modo === "directo"} onChange={() => setModo("directo")} />
            Directa
          </label>
          <label>
            <input type="radio" name="modo-codigo" checked={modo === "rele"} onChange={() => setModo("rele")} />
            Por relé
          </label>
        </div>
      )}
      <div className="codigo-fila">
        <code className="codigo-grande" aria-label={directo ? "Invitación directa" : "Código de enlace"}>
          {texto}
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
        En la otra PC: <strong>Acceso remoto → Conectar otra PC → Leer su memoria</strong>. Sirve una sola vez.
      </p>
      {directo && <p className="meta">La otra PC tiene que estar en tu tailnet de Tailscale o en la misma red que esta.</p>}
      <p className="meta">
        O en su terminal: <code>agent-memory remote link {texto}</code>
      </p>
      <div className="barra-accion">
        <button type="button" onClick={cerrar}>
          Listo
        </button>
      </div>
    </div>
  );
}

/** El sentido «Le compartís tu memoria» de una conexión. */
export function PaneComparto({
  c,
  cliente,
  recargar,
  apagado,
  compartirle,
}: {
  c: Conexion;
  cliente: Cliente;
  recargar: () => Promise<void>;
  apagado: boolean;
  compartirle: () => void;
}) {
  const [modo, setModo] = useState<"alcance" | "revocar" | null>(null);
  const accion = useAccion(recargar);
  const alcanceRef = useRef<HTMLButtonElement>(null);
  const d = c.comparto;

  if (!d || d.estado === "revocado") {
    return (
      <div className="sentido vacio" role="group" aria-label={`Le compartís tu memoria a ${c.nombre}`}>
        <p className="sentido-titulo">
          <Flecha sentido="sale" />
          No le compartís tu memoria
        </p>
        <p className="meta">
          {d?.revocado_en ? (
            <>
              Dejaste de compartirle el <span className="num">{fecha(d.revocado_en)}</span>.{" "}
            </>
          ) : null}
          Elegí qué verá y pasale un código.
        </p>
        <div>
          <button type="button" onClick={compartirle} aria-label={`Compartirle tu memoria a ${c.nombre}`}>
            Compartirle
          </button>
        </div>
      </div>
    );
  }

  const sinAlcance = d.alcance.ambitos.length === 0 && !d.alcance.no_validadas;
  return (
    <div className={`sentido${apagado ? " apagado" : ""}`} role="group" aria-label={`Le compartís tu memoria a ${c.nombre}`}>
      <p className="sentido-titulo">
        <Flecha sentido="sale" />
        <strong>Le compartís tu memoria</strong>
        {d.estado === "credencial_vencida" && <Senal tono="pendiente">venció</Senal>}
      </p>
      {sinAlcance ? (
        <Senal tono="pendiente">sin alcance: todavía no ve nada</Senal>
      ) : (
        <ChipsAlcance alcance={d.alcance} />
      )}
      <span className="meta-linea">
        leyó <span className="num">{fecha(d.usado_en)}</span> · vence <span className="num">{fecha(d.vence_en)}</span>
      </span>
      <div className="acciones">
        <button
          type="button"
          ref={alcanceRef}
          aria-label={`Qué ve ${c.nombre}`}
          aria-expanded={modo === "alcance"}
          onClick={() => setModo(modo === "alcance" ? null : "alcance")}
        >
          {sinAlcance ? "Elegir qué ve" : "Qué ve"}
        </button>
        <button
          type="button"
          aria-label={`Renovar ${c.nombre}`}
          disabled={accion.ocupado}
          onClick={() => void accion.ejecutar(() => cliente("remoto_renovar", { id: d.id }), `${c.nombre}: renovada por 30 días`)}
        >
          Renovar
        </button>
        <button type="button" className="peligro" aria-label={`Dejar de compartirle a ${c.nombre}`} disabled={modo === "revocar"} onClick={() => setModo("revocar")}>
          Dejar de compartir
        </button>
      </div>
      {modo === "revocar" && (
        <Confirmar
          accion="Dejar de compartir"
          ocupado={accion.ocupado}
          cancelar={() => setModo(null)}
          confirmar={() => void accion.ejecutar(() => cliente("remoto_revocar", { id: d.id }), null).then((ok) => ok && setModo(null))}
        >
          {c.nombre} deja de leer tu memoria en el acto. Para volver, hace falta un código nuevo.
        </Confirmar>
      )}
      {modo === "alcance" && (
        <EditorAlcance
          nombre={c.nombre}
          alcance={d.alcance}
          cliente={cliente}
          ocupado={accion.ocupado}
          cancelar={() => {
            setModo(null);
            alcanceRef.current?.focus();
          }}
          guardar={(ambitos, noValidadas) =>
            void accion
              .ejecutar(
                () => cliente("remoto_alcance", { id: d.id, ambitos, no_validadas: noValidadas }),
                `${c.nombre}: alcance guardado; rige desde la próxima lectura`,
              )
              .then((ok) => ok && setModo(null))
          }
        />
      )}
      <Aviso texto={accion.error} />
      <Aviso texto={accion.hecho} tipo="ok" />
    </div>
  );
}

function EditorAlcance({
  nombre,
  alcance,
  cliente,
  ocupado,
  guardar,
  cancelar,
}: {
  nombre: string;
  alcance: Alcance;
  cliente: Cliente;
  ocupado: boolean;
  guardar: (ambitos: AmbitoAlcance[], noValidadas: boolean) => void;
  cancelar: () => void;
}) {
  const { ambitos, error } = useAmbitos(cliente, true);
  const [marcados, setMarcados] = useState(() => marcadosDe(alcance.ambitos));
  const [noValidadas, setNoValidadas] = useState(alcance.no_validadas);
  const todos = ambitos ? unirAmbitos(ambitos, alcance.ambitos) : error ? unirAmbitos([], alcance.ambitos) : null;
  return (
    <div className="editor-alcance" role="group" aria-label={`Editar qué ve ${nombre}`} onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <SelectorAlcance
        leyenda={`Qué ve ${nombre}`}
        ambitos={todos}
        marcados={marcados}
        noValidadas={noValidadas}
        cambiar={setMarcados}
        cambiarNoValidadas={setNoValidadas}
      />
      <Aviso texto={error} />
      <div className="barra-accion">
        <button type="button" className="primario" disabled={ocupado || todos === null} onClick={() => guardar(elegidos(todos, marcados), noValidadas)}>
          Guardar
        </button>
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
