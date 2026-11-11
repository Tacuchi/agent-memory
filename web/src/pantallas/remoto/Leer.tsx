import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { Flecha } from "./Compartir";
import { alEscape, Confirmar, useAccion } from "./comun";
import type { Conexion } from "./tipos";

// Sentido «Te comparte la suya»: leer otra memoria pegando su código, sin escribir nombres; después solo se renombra el
// identificador que usan los agentes o se deja de leer.

/** La misma regla que valida el servicio para un identificador de enlace. */
const ORIGEN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function PegarCodigo({ cliente, recargar, enfocar = false }: { cliente: Cliente; recargar: () => Promise<void>; enfocar?: boolean }) {
  const [codigo, setCodigo] = useState("");
  const canje = useAccion(recargar);
  const campo = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (enfocar) campo.current?.focus();
  }, [enfocar]);
  const limpio = codigo.trim();
  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!limpio) return;
    void canje
      .ejecutar(
        () => cliente<{ origen: string; nombre: string | null }>("remoto_canjear", { codigo: limpio }),
        (r) => `Ahora leés «${r.nombre ?? r.origen}» como «${r.origen}».`,
      )
      .then((ok) => ok && setCodigo(""));
  }
  return (
    <form className="pegar" aria-label="Leer su memoria" onSubmit={enviar}>
      <label htmlFor={id}>Código de la otra PC</label>
      <div className="en-linea">
        <input
          id={id}
          ref={campo}
          className="mono"
          value={codigo}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-…"
          onChange={(e) => setCodigo(e.target.value)}
        />
        <button type="submit" className="primario" disabled={!limpio || canje.ocupado}>
          {canje.ocupado ? "Conectando…" : "Conectar"}
        </button>
      </div>
      <Aviso texto={canje.error} />
      <Aviso texto={canje.hecho} tipo="ok" />
    </form>
  );
}

/** El sentido «Te comparte la suya» de una conexión. */
export function PaneLeo({ c, cliente, recargar, pegarSuCodigo }: { c: Conexion; cliente: Cliente; recargar: () => Promise<void>; pegarSuCodigo: () => void }) {
  const [modo, setModo] = useState<"renombrar" | "quitar" | null>(null);
  const accion = useAccion(recargar);
  const e = c.leo;

  if (!e) {
    return (
      <div className="sentido vacio" role="group" aria-label={`${c.nombre} te comparte la suya`}>
        <p className="sentido-titulo">
          <Flecha sentido="entra" />
          No te comparte la suya
        </p>
        <p className="meta">Si querés leerla, pedile un código desde esa PC.</p>
        <div>
          <button type="button" onClick={pegarSuCodigo} aria-label={`Pegar el código de ${c.nombre}`}>
            Pegar su código
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sentido" role="group" aria-label={`${c.nombre} te comparte la suya`}>
      <p className="sentido-titulo">
        <Flecha sentido="entra" />
        <strong>Te comparte la suya</strong>
      </p>
      <span className="meta-linea">
        los agentes la consultan como <code className="origen">{e.origen}</code>
      </span>
      <span className="meta-linea">
        leíste <span className="num">{fecha(e.usado_en)}</span> · vence <span className="num">{fecha(e.vence_en)}</span>
      </span>
      <div className="acciones">
        <button type="button" aria-label={`Renombrar ${e.origen}`} aria-expanded={modo === "renombrar"} onClick={() => setModo(modo === "renombrar" ? null : "renombrar")}>
          Renombrar
        </button>
        <button type="button" className="peligro" aria-label={`Dejar de leer ${c.nombre}`} disabled={modo === "quitar"} onClick={() => setModo("quitar")}>
          Dejar de leer
        </button>
      </div>
      {modo === "renombrar" && (
        <Renombrar
          origen={e.origen}
          ocupado={accion.ocupado}
          cancelar={() => setModo(null)}
          guardar={(nuevo) =>
            void accion
              .ejecutar(() => cliente("remoto_enlace_renombrar", { origen: e.origen, nuevo }), `Los agentes ahora la consultan como «${nuevo}»`)
              .then((ok) => ok && setModo(null))
          }
        />
      )}
      {modo === "quitar" && (
        <Confirmar
          accion="Dejar de leer"
          ocupado={accion.ocupado}
          cancelar={() => setModo(null)}
          confirmar={() => void accion.ejecutar(() => cliente("remoto_enlace_quitar", { origen: e.origen }), null).then((ok) => ok && setModo(null))}
        >
          Esta PC deja de leer la memoria de {c.nombre}. Para volver hace falta un código nuevo de esa PC.
        </Confirmar>
      )}
      <Aviso texto={accion.error} />
      <Aviso texto={accion.hecho} tipo="ok" />
    </div>
  );
}

function Renombrar({ origen, guardar, cancelar, ocupado }: { origen: string; guardar: (nuevo: string) => void; cancelar: () => void; ocupado: boolean }) {
  const [nuevo, setNuevo] = useState(origen);
  const campo = useRef<HTMLInputElement>(null);
  const id = useId();
  const ayuda = useId();
  useEffect(() => campo.current?.select(), []);
  const valido = ORIGEN.test(nuevo);
  function enviar(ev: FormEvent) {
    ev.preventDefault();
    if (valido && nuevo !== origen) guardar(nuevo);
  }
  return (
    <form className="renombrar" onSubmit={enviar} onKeyDown={alEscape(cancelar)}>
      <label htmlFor={id}>Identificador para los agentes</label>
      <div className="en-linea">
        <input
          id={id}
          ref={campo}
          className="mono"
          value={nuevo}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={ayuda}
          aria-invalid={!valido}
          onChange={(ev) => setNuevo(ev.target.value)}
        />
        <button type="submit" className="primario" disabled={!valido || nuevo === origen || ocupado}>
          Guardar
        </button>
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </div>
      <p id={ayuda} className={`meta${valido ? "" : " invalido"}`}>
        Minúsculas, números, «-» y «_»; hasta 40. Las consultas guardadas con «{origen}» dejan de servir.
      </p>
    </form>
  );
}
