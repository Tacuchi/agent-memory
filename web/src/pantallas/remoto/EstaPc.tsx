import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { mensajeError, type Cliente } from "../../api";
import { Aviso } from "../comunes";
import { alEscape, Senal, useAccion } from "./comun";
import type { Estado, PruebaRele } from "./tipos";

// Barra «Esta PC»: cómo se llama esta PC, si su memoria está abierta, por qué relé pasa y si el panel la ve.

/** El nombre visible no puede pasar de lo que guarda el servicio (LARGO_NOMBRE_PC). */
const LARGO_NOMBRE = 60;

const PANEL: Record<NonNullable<Estado["panel"]>, { tono: "validada" | "pendiente" | "tenue"; texto: string }> = {
  conectado: { tono: "validada", texto: "conectado" },
  conectando: { tono: "pendiente", texto: "conectando…" },
  inactivo: { tono: "tenue", texto: "inactivo" },
};

const PRUEBA: Record<Exclude<PruebaRele, "sin_rele">, { tono: "validada" | "rechazada"; texto: string }> = {
  responde: { tono: "validada", texto: "responde" },
  no_responde: { tono: "rechazada", texto: "no responde" },
  clave_rechazada: { tono: "rechazada", texto: "rechaza la clave" },
};

export function EstaPc({
  estado,
  cliente,
  recargar,
  alApagar,
}: {
  estado: Estado;
  cliente: Cliente;
  recargar: () => Promise<void>;
  alApagar: () => void;
}) {
  const nombre = useAccion(recargar);
  const acceso = useAccion(recargar);
  const actual = estado.nombre_pc !== undefined;

  return (
    <div className="esta-pc" role="group" aria-labelledby="titulo-esta-pc">
      <h3 id="titulo-esta-pc" className="ph">
        Esta PC
      </h3>
      <div className="celdas">
        <div className="celda">
          <span className="rotulo">Nombre</span>
          {actual ? (
            <NombrePc
              nombre={estado.nombre_pc!}
              guardar={(n) =>
                nombre.ejecutar(() => cliente("remoto_nombre", { nombre: n }), `Nombre guardado: el panel del relé muestra «${n}»`)
              }
            />
          ) : (
            <span className="meta">—</span>
          )}
          <Aviso texto={nombre.error} />
          <Aviso texto={nombre.hecho} tipo="ok" />
        </div>

        <div className="celda">
          <span className="rotulo" id="rotulo-acceso">
            Acceso
          </span>
          <label className="interruptor">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby="rotulo-acceso"
              aria-describedby="estado-acceso"
              checked={estado.interruptor}
              disabled={acceso.ocupado}
              onChange={(e) => {
                const encendido = e.target.checked;
                void acceso.ejecutar(async () => {
                  await cliente("remoto_interruptor", { encendido });
                  if (!encendido) alApagar();
                }, encendido ? "Acceso encendido: las PCs enlazadas pueden leer" : "Acceso apagado: ninguna PC puede leer");
              }}
            />
            <span id="estado-acceso" className={estado.interruptor ? "encendido" : undefined}>
              {estado.interruptor ? "encendido" : "apagado"}
            </span>
          </label>
          <Aviso texto={acceso.error} />
          <Aviso texto={acceso.hecho} tipo="ok" />
        </div>

        <Rele estado={estado} cliente={cliente} recargar={recargar} />

        <div className="celda">
          <span className="rotulo">Panel del relé</span>
          {estado.panel ? (
            <>
              <Senal tono={PANEL[estado.panel].tono}>{PANEL[estado.panel].texto}</Senal>
              {estado.panel === "inactivo" && (
                <span className="meta">Se conecta con el relé configurado y el acceso encendido o algún enlace.</span>
              )}
            </>
          ) : (
            <span className="meta">—</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Nombre editable en sitio: se ve como texto y se cambia sin salir de la barra. */
function NombrePc({ nombre, guardar }: { nombre: string; guardar: (nombre: string) => Promise<boolean> }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nombre);
  const campo = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editando) campo.current?.select();
  }, [editando]);
  const limpio = valor.trim();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!limpio || limpio === nombre) return setEditando(false);
    if (await guardar(limpio)) setEditando(false);
  }

  if (!editando) {
    return (
      <span className="en-sitio">
        <strong className="valor">{nombre}</strong>
        <button
          type="button"
          className="enlace azul"
          aria-label={`Cambiar el nombre de esta PC (${nombre})`}
          onClick={() => {
            setValor(nombre);
            setEditando(true);
          }}
        >
          Cambiar
        </button>
      </span>
    );
  }
  return (
    <form className="en-sitio" onSubmit={(e) => void enviar(e)} onKeyDown={alEscape(() => setEditando(false))}>
      <label htmlFor={id} className="oculto">
        Nombre de esta PC
      </label>
      <input id={id} ref={campo} value={valor} maxLength={LARGO_NOMBRE} onChange={(e) => setValor(e.target.value)} />
      <button type="submit" className="primario" disabled={!limpio}>
        Guardar
      </button>
      <button type="button" onClick={() => setEditando(false)}>
        Cancelar
      </button>
    </form>
  );
}

/** Relé: URL y si responde. Sin relé (o con la clave rechazada), el formulario para configurarlo (AC-09, AC-10). */
function Rele({ estado, cliente, recargar }: { estado: Estado; cliente: Cliente; recargar: () => Promise<void> }) {
  const [prueba, setPrueba] = useState<PruebaRele | "probando" | null>(null);
  const [errorPrueba, setErrorPrueba] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const guardar = useAccion(recargar);
  const url = estado.rele?.url ?? null;
  // Un servicio anterior a esta web no conoce la prueba: no se la pide.
  const puedeProbar = estado.nombre_pc !== undefined;

  const probar = useCallback(async () => {
    setErrorPrueba(null);
    setPrueba("probando");
    try {
      setPrueba((await cliente<{ estado: PruebaRele }>("remoto_rele_probar")).estado);
    } catch (e) {
      setPrueba(null);
      setErrorPrueba(mensajeError(e));
    }
  }, [cliente]);

  useEffect(() => {
    if (url && puedeProbar) void probar();
  }, [url, puedeProbar, probar]);

  const formulario = !url || editando || prueba === "clave_rechazada" || prueba === "sin_rele";

  return (
    <div className="celda celda-rele">
      <span className="rotulo">Relé</span>
      {url && (
        <span className="rele-linea">
          <code className="valor-url">{url}</code>
          {prueba === "probando" && <Senal tono="tenue">probando…</Senal>}
          {prueba && prueba !== "probando" && prueba !== "sin_rele" && (
            <Senal tono={PRUEBA[prueba].tono}>{PRUEBA[prueba].texto}</Senal>
          )}
        </span>
      )}
      {url && puedeProbar && (
        <span className="barra-accion compacta">
          <button type="button" className="enlace azul" disabled={prueba === "probando"} onClick={() => void probar()}>
            Probar de nuevo
          </button>
          {!formulario && (
            <button type="button" className="enlace azul" onClick={() => setEditando(true)}>
              Cambiar relé
            </button>
          )}
        </span>
      )}
      <Aviso texto={errorPrueba} />
      {formulario && (
        <FormularioRele
          url={url}
          cancelar={editando ? () => setEditando(false) : null}
          enviar={async (nuevaUrl, clave) => {
            const ok = await guardar.ejecutar(() => cliente("remoto_rele", { url: nuevaUrl, clave }), "Relé guardado");
            if (ok) {
              setEditando(false);
              void probar();
            }
            return ok;
          }}
          ocupado={guardar.ocupado}
        />
      )}
      <Aviso texto={guardar.error} />
      <Aviso texto={guardar.hecho} tipo="ok" />
    </div>
  );
}

/** La clave se escribe una vez: el campo se vacía al guardar y nunca se vuelve a mostrar (D05). */
function FormularioRele({
  url,
  enviar,
  cancelar,
  ocupado,
}: {
  url: string | null;
  enviar: (url: string, clave: string) => Promise<boolean>;
  cancelar: (() => void) | null;
  ocupado: boolean;
}) {
  const [nuevaUrl, setNuevaUrl] = useState(url ?? "");
  const [clave, setClave] = useState("");
  const listo = nuevaUrl.trim() !== "" && clave !== "";

  async function alEnviar(e: FormEvent) {
    e.preventDefault();
    if (!listo) return;
    await enviar(nuevaUrl.trim(), clave);
    setClave("");
  }

  return (
    <form className="form-rele" aria-label="Configurar el relé" onSubmit={(e) => void alEnviar(e)} onKeyDown={cancelar ? alEscape(cancelar) : undefined}>
      <label>
        URL del relé
        <input
          type="url"
          inputMode="url"
          placeholder="wss://rele.ejemplo.com"
          spellCheck={false}
          autoComplete="off"
          value={nuevaUrl}
          onChange={(e) => setNuevaUrl(e.target.value)}
        />
      </label>
      <label>
        Clave
        <input type="password" autoComplete="new-password" value={clave} onChange={(e) => setClave(e.target.value)} />
      </label>
      <div className="barra-accion">
        <button type="submit" className="primario" disabled={!listo || ocupado}>
          Guardar relé
        </button>
        {cancelar && (
          <button type="button" onClick={cancelar}>
            Cancelar
          </button>
        )}
      </div>
      <p className="meta">La clave se guarda en esta PC y no se vuelve a mostrar.</p>
    </form>
  );
}
