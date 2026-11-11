import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { alEscape, Confirmar, useAccion } from "./comun";
import type { Enlace, Estado } from "./tipos";

// Columna «Esta PC lee»: las memorias de otras PCs que esta lee. Se canjea un código pegándolo, sin escribir nombres;
// después solo se renombra el identificador o se quita el enlace (D03).

/** La misma regla que valida el servicio para un identificador de enlace. */
const ORIGEN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function Lee({ estado, cliente, recargar }: { estado: Estado; cliente: Cliente; recargar: () => Promise<void> }) {
  const [pegando, setPegando] = useState(false);
  const canje = useAccion(recargar);
  const pegarRef = useRef<HTMLButtonElement>(null);

  return (
    <section className="col-remota" aria-labelledby="titulo-lee">
      <header className="ph">
        <h3 id="titulo-lee">Esta PC lee</h3>
        {!pegando && (
          <button
            type="button"
            ref={pegarRef}
            className="ph-boton"
            onClick={() => {
              canje.limpiar();
              setPegando(true);
            }}
          >
            Pegar un código
          </button>
        )}
      </header>
      <div className="col-cuerpo">
        {pegando && (
          <PegarCodigo
            ocupado={canje.ocupado}
            cancelar={() => {
              setPegando(false);
              canje.limpiar();
            }}
            enlazar={(codigo) =>
              void canje
                .ejecutar(
                  () => cliente<{ origen: string; nombre: string | null }>("remoto_canjear", { codigo }),
                  (r) => `Ahora leés «${r.nombre ?? r.origen}» como «${r.origen}».`,
                )
                .then((ok) => ok && setPegando(false))
            }
          />
        )}
        {(canje.error || canje.hecho) && (
          <div className="franja">
            <Aviso texto={canje.error} />
            <Aviso texto={canje.hecho} tipo="ok" />
          </div>
        )}
        {estado.enlaces.length === 0 ? (
          <div className="vacio">
            <p>Esta PC no lee ninguna otra memoria.</p>
            <p className="meta">En la otra PC elegí «Invitar una PC» y pegá acá el código que te da.</p>
          </div>
        ) : (
          <ul className="lista items-remotos" aria-label="Memorias que lee esta PC">
            {estado.enlaces.map((e) => (
              <ItemEnlace key={e.origen} e={e} cliente={cliente} recargar={recargar} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PegarCodigo({ enlazar, cancelar, ocupado }: { enlazar: (codigo: string) => void; cancelar: () => void; ocupado: boolean }) {
  const [codigo, setCodigo] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => campo.current?.focus(), []);
  const limpio = codigo.trim();
  function enviar(e: FormEvent) {
    e.preventDefault();
    if (limpio) enlazar(limpio);
  }
  return (
    <form className="franja pegar" aria-label="Pegar un código" onSubmit={enviar} onKeyDown={alEscape(cancelar)}>
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
        <button type="submit" className="primario" disabled={!limpio || ocupado}>
          {ocupado ? "Enlazando…" : "Enlazar"}
        </button>
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </div>
      <p className="meta">Lo genera la otra PC en «Invitar una PC». No hace falta escribir ningún nombre.</p>
    </form>
  );
}

function ItemEnlace({ e, cliente, recargar }: { e: Enlace; cliente: Cliente; recargar: () => Promise<void> }) {
  const [modo, setModo] = useState<"renombrar" | "quitar" | null>(null);
  const accion = useAccion(recargar);
  const nombre = e.nombre || e.origen;
  return (
    <li className="item">
      <div className="item-texto">
        {e.nombre ? (
          <>
            <span className="item-nombre">{e.nombre}</span>
            <span className="meta-linea">
              los agentes la consultan como <code className="origen">{e.origen}</code>
            </span>
          </>
        ) : (
          <>
            <code className="item-nombre">{e.origen}</code>
            <span className="meta-linea tenue">PC de una versión anterior: no comunica su nombre</span>
          </>
        )}
        <span className="meta-linea">
          última lectura <span className="num">{fecha(e.usado_en)}</span> · vence <span className="num">{fecha(e.vence_en)}</span>
        </span>
      </div>
      <div className="item-acciones">
        <button type="button" aria-label={`Renombrar ${e.origen}`} aria-expanded={modo === "renombrar"} onClick={() => setModo(modo === "renombrar" ? null : "renombrar")}>
          Renombrar
        </button>
        <button type="button" className="peligro" aria-label={`Quitar ${e.origen}`} disabled={modo === "quitar"} onClick={() => setModo("quitar")}>
          Quitar
        </button>
      </div>
      {modo === "renombrar" && (
        <div className="item-extra">
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
        </div>
      )}
      {modo === "quitar" && (
        <div className="item-extra">
          <Confirmar
            accion={`Quitar ${e.origen}`}
            ocupado={accion.ocupado}
            cancelar={() => setModo(null)}
            confirmar={() => void accion.ejecutar(() => cliente("remoto_enlace_quitar", { origen: e.origen }), null).then((ok) => ok && setModo(null))}
          >
            Esta PC deja de leer «{nombre}». Para volver a leerla hace falta un código nuevo de esa PC.
          </Confirmar>
        </div>
      )}
      <div className="item-extra">
        <Aviso texto={accion.error} />
        <Aviso texto={accion.hecho} tipo="ok" />
      </div>
    </li>
  );
}

function Renombrar({
  origen,
  guardar,
  cancelar,
  ocupado,
}: {
  origen: string;
  guardar: (nuevo: string) => void;
  cancelar: () => void;
  ocupado: boolean;
}) {
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
