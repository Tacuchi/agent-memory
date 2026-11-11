import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { mover, useAtajos } from "../src/teclado";
import { textoDe, textoError, type ApiPanel } from "./api";
import { bytes, cuenta, diaSemana, falta, fecha, hace, hora, plural } from "./formato";
import type { Accion, Alcance, Bloqueo, Desconocida, Duracion, Estado, Lector, Lectura, Pc } from "./tipos";

// Panel del relé (diseño D · Por PC). Lista de PCs, IPs desconocidas y bloqueos a la izquierda; el
// detalle de la elegida a la derecha. Restringir (cerrar, bloquear, revocar, quitar) se confirma en
// línea y se cumple al momento; ampliar (renovar, alcance, código) queda pendiente en la PC dueña
// (D01). El valor de un código de enlace nunca pasa por aquí (D04): solo si hay uno y cuánto le queda.

type Seleccion = { tipo: "pc"; huella: string } | { tipo: "ip"; ip: string } | { tipo: "bloqueo"; clase: "pc" | "ip"; valor: string };
type Pestana = "enlaces" | "codigos" | "conexiones" | "uso";
type Hacer = (cuerpo: Accion, hecho: string) => Promise<boolean>;

/** Acciones que amplían: quedan pendientes en la PC dueña (D01). */
const AMPLIAN = new Set<Accion["accion"]>(["renovar", "alcance", "codigo"]);

const PESTANAS: { id: Pestana; nombre: string }[] = [
  { id: "enlaces", nombre: "Enlaces" },
  { id: "codigos", nombre: "Códigos" },
  { id: "conexiones", nombre: "Conexiones" },
  { id: "uso", nombre: "Uso" },
];

const DURACIONES: { valor: Duracion; nombre: string }[] = [
  { valor: "1h", nombre: "1 h" },
  { valor: "24h", nombre: "24 h" },
  { valor: "indefinido", nombre: "Indefinido" },
];

function clave(s: Seleccion): string {
  return s.tipo === "pc" ? `pc:${s.huella}` : s.tipo === "ip" ? `ip:${s.ip}` : `bloqueo:${s.clase}:${s.valor}`;
}

function elementos(estado: Estado): Seleccion[] {
  return [
    ...estado.pcs.map((p): Seleccion => ({ tipo: "pc", huella: p.huella })),
    ...estado.desconocidas.map((d): Seleccion => ({ tipo: "ip", ip: d.ip })),
    ...estado.bloqueos.map((b): Seleccion => ({ tipo: "bloqueo", clase: b.tipo, valor: b.valor })),
  ];
}

function nombrePc(estado: Estado, huella: string): string {
  const pc = estado.pcs.find((p) => p.huella === huella);
  return pc?.nombre || `${huella.slice(0, 8)}…`;
}

function bloqueoDe(estado: Estado, clase: "pc" | "ip", valor: string | null): Bloqueo | undefined {
  return valor ? estado.bloqueos.find((b) => b.tipo === clase && b.valor === valor) : undefined;
}

export interface PropsApp {
  api: ApiPanel;
  ahora?: () => number;
  /** Refresco del estado: 10 s, bajo el límite de 30 pedidos por minuto del proxy. */
  intervaloMs?: number;
  /** Paso del reloj de «actualizado hace N s» y de las cuentas regresivas. */
  ticMs?: number;
}

export function App({ api, ahora = Date.now, intervaloMs = 10_000, ticMs = 1000 }: PropsApp) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [actualizado, setActualizado] = useState<number | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [sel, setSel] = useState<Seleccion | null>(null);
  const [pestana, setPestana] = useState<Pestana>("enlaces");
  const [, setReloj] = useState(0);
  const cargando = useRef(false);
  const enfocarLista = useRef(false);

  const cargar = useCallback(async () => {
    if (cargando.current) return;
    cargando.current = true;
    try {
      const e = await api.estado();
      setEstado(e);
      setActualizado(ahora());
      setErrorCarga(null);
    } catch (e) {
      setErrorCarga(textoError(e));
    } finally {
      cargando.current = false;
    }
  }, [api, ahora]);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => void cargar(), intervaloMs);
    return () => clearInterval(id);
  }, [cargar, intervaloMs]);

  useEffect(() => {
    const id = setInterval(() => setReloj((n) => n + 1), ticMs);
    return () => clearInterval(id);
  }, [ticMs]);

  const lista = estado ? elementos(estado) : [];
  const actual = (sel && lista.find((x) => clave(x) === clave(sel))) || lista[0] || null;
  const claveActual = actual ? clave(actual) : null;

  useAtajos({
    j: () => moverSel(1),
    k: () => moverSel(-1),
  });

  function moverSel(delta: number): boolean {
    if (!lista.length) return false;
    const i = actual ? lista.findIndex((x) => clave(x) === clave(actual)) : -1;
    const siguiente = lista[mover(i < 0 ? 0 : i, i < 0 ? 0 : delta, lista.length)];
    if (!siguiente) return false;
    enfocarLista.current = true;
    setSel(siguiente);
    return true;
  }

  useEffect(() => {
    if (!enfocarLista.current || !claveActual) return;
    enfocarLista.current = false;
    for (const el of document.querySelectorAll<HTMLElement>("[data-clave]")) {
      if (el.dataset.clave === claveActual) el.focus();
    }
  }, [claveActual]);

  const hacer: Hacer = async (cuerpo, hecho) => {
    setAviso(null);
    let ok = true;
    try {
      const r = await api.accion(cuerpo);
      const mensaje = textoDe(r, "mensaje");
      if (r.estado === "pendiente") {
        // Ampliar (renovar, alcance, código) ya trae su texto de pendiente con el nombre de la dueña.
        const base = AMPLIAN.has(cuerpo.accion) ? hecho : "Queda pendiente de confirmar en la PC dueña.";
        setAviso({ tipo: "ok", texto: mensaje ? `${base} ${mensaje}` : base });
      } else {
        setAviso({ tipo: "ok", texto: mensaje ?? hecho });
      }
    } catch (e) {
      ok = false;
      setAviso({ tipo: "error", texto: textoError(e) });
    }
    await cargar();
    return ok;
  };

  const t = ahora();
  const pcActual = actual?.tipo === "pc" && estado ? estado.pcs.find((p) => p.huella === actual.huella) : undefined;

  return (
    <div className="app">
      <header className="barra">
        <span className="marca">agent-memory · relé</span>
        {estado && (
          <span className="resumen">
            {plural(estado.pcs.filter((p) => p.en_linea).length, "PC en línea", "PCs en línea")} ·{" "}
            {plural(estado.rele.conexiones, "conexión", "conexiones")} · {plural(estado.desconocidas.length, "aviso", "avisos")}
          </span>
        )}
        <span className="empuje" />
        <span className="actualizado">
          {actualizado !== null ? `actualizado ${hace(new Date(actualizado).toISOString(), t)}` : "sin datos todavía"}
        </span>
        <button type="button" className="chico" onClick={() => void cargar()}>
          Actualizar
        </button>
        <button
          type="button"
          className="primario"
          disabled={!pcActual?.informe}
          title={pcActual ? undefined : "Primero hay que elegir una PC de la lista"}
          onClick={() =>
            pcActual &&
            void hacer(
              { accion: "codigo", pc: pcActual.huella },
              `Pedido de código enviado: queda pendiente de confirmar en ${pcActual.nombre ?? "la PC"}; el código se ve solo en su web local.`,
            )
          }
        >
          Nuevo código de enlace
        </button>
        <span className="aislado">
          <Confirmar
            etiqueta="Cortar todo"
            pregunta="¿Cortar todas las conexiones del relé?"
            confirmar="Sí, cortar todo"
            alConfirmar={() => hacer({ accion: "cerrar_todo" }, "Se cortaron todas las conexiones; las PCs vuelven a conectarse solas.")}
          />
        </span>
      </header>

      {errorCarga && (
        <p className="banda error" role="alert">
          No se pudo actualizar: {errorCarga}
          {estado && actualizado !== null ? ` Se muestran los datos de ${hace(new Date(actualizado).toISOString(), t)}.` : ""}
        </p>
      )}
      {aviso && (
        <p className={`banda ${aviso.tipo}`} role={aviso.tipo === "error" ? "alert" : "status"}>
          {aviso.texto}
        </p>
      )}

      {!estado ? (
        <p className="cargando">{errorCarga ? "Sin datos del relé. Se reintenta cada 10 s." : "Cargando el estado del relé…"}</p>
      ) : (
        <div className="cuerpo">
          <Lista estado={estado} actual={claveActual} elegir={setSel} ahora={t} />
          <main className="detalle">
            {actual?.tipo === "pc" && pcActual && (
              <DetallePc key={claveActual} estado={estado} pc={pcActual} pestana={pestana} setPestana={setPestana} hacer={hacer} ahora={t} />
            )}
            {actual?.tipo === "ip" && (
              <DetalleIp key={claveActual} estado={estado} d={estado.desconocidas.find((d) => d.ip === actual.ip)!} hacer={hacer} ahora={t} />
            )}
            {actual?.tipo === "bloqueo" && (
              <DetalleBloqueo
                key={claveActual}
                estado={estado}
                b={estado.bloqueos.find((b) => b.tipo === actual.clase && b.valor === actual.valor)!}
                hacer={hacer}
                ahora={t}
              />
            )}
            {!actual && <p className="vacio">Nada para mostrar todavía.</p>}
          </main>
        </div>
      )}
    </div>
  );
}

function Lista({ estado, actual, elegir, ahora }: { estado: Estado; actual: string | null; elegir: (s: Seleccion) => void; ahora: number }) {
  function boton(s: Seleccion, color: string, titulo: ReactNode, sub: string) {
    const k = clave(s);
    return (
      <button
        key={k}
        type="button"
        className={`pc${k === actual ? " foco" : ""}`}
        aria-current={k === actual ? "true" : undefined}
        data-clave={k}
        onClick={() => elegir(s)}
      >
        <span className="pcnom">
          <span className="bola" style={{ background: `var(--${color})` }} aria-hidden="true" />
          {titulo}
        </span>
        <span className="sub">{sub}</span>
      </button>
    );
  }
  return (
    <nav className="lista" aria-label="PCs e IPs del relé">
      <div className="cab">
        <span className="rot">PCs configuradas</span>
        <span className="num sub">{estado.pcs.length}</span>
      </div>
      {estado.pcs.length === 0 && (
        <p className="vacio">Todavía no hay PCs. Una PC aparece aquí cuando se conecta al relé con agent-memory 0.3.0 o posterior.</p>
      )}
      {estado.pcs.map((p) =>
        boton(
          { tipo: "pc", huella: p.huella },
          p.en_linea ? "validada" : "tenue",
          p.nombre || `${p.huella.slice(0, 8)}…`,
          [
            p.en_linea ? "en línea" : `sin conexión · visto ${hace(p.visto, ahora)}`,
            ...(p.informe ? [`comparte con ${activos(p.leen).length}`, `lee de ${p.lee.length}`] : ["sin informe"]),
            ...(bloqueoDe(estado, "pc", p.huella) ? ["bloqueada"] : []),
          ].join(" · "),
        ),
      )}

      <div className="cab separada">
        <span className="rot rechazada">Desconocidas</span>
        <span className="num sub">{estado.desconocidas.length}</span>
      </div>
      {estado.desconocidas.length === 0 && <p className="vacio">Ninguna IP falló la clave del relé en la última hora.</p>}
      {estado.desconocidas.map((d) =>
        boton({ tipo: "ip", ip: d.ip }, "rechazada", <span className="num">{d.ip}</span>, `${plural(d.rechazos, "intento", "intentos")} con clave equivocada en 1 h`),
      )}

      <div className="cab separada">
        <span className="rot revisar">Bloqueadas</span>
        <span className="num sub">{estado.bloqueos.length}</span>
      </div>
      {estado.bloqueos.length === 0 && <p className="vacio">No hay PCs ni IPs bloqueadas.</p>}
      {estado.bloqueos.map((b) =>
        boton(
          { tipo: "bloqueo", clase: b.tipo, valor: b.valor },
          "revisar",
          b.tipo === "pc" ? nombrePc(estado, b.valor) : <span className="num">{b.valor}</span>,
          b.hasta ? `bloqueada hasta las ${hora(b.hasta)}` : "bloqueada sin vencimiento",
        ),
      )}
    </nav>
  );
}

function activos(leen: Lector[]): Lector[] {
  return leen.filter((l) => !l.revocado);
}

function Ficha({ titulo, children, etiquetas }: { titulo: ReactNode; etiquetas: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ficha" aria-labelledby={id}>
      <h1 id={id}>{titulo}</h1>
      {etiquetas}
      <dl>{children}</dl>
    </section>
  );
}

function Dato({ nombre, children, num }: { nombre: string; children: ReactNode; num?: boolean }) {
  return (
    <div>
      <dt>{nombre}</dt>
      <dd className={num ? "num" : undefined}>{children}</dd>
    </div>
  );
}

function Etiqueta({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="etq" style={{ color: `var(--${color})` }}>
      <span className="bola" style={{ background: `var(--${color})` }} aria-hidden="true" />
      {children}
    </span>
  );
}

function DetallePc({
  estado,
  pc,
  pestana,
  setPestana,
  hacer,
  ahora,
}: {
  estado: Estado;
  pc: Pc;
  pestana: Pestana;
  setPestana: (p: Pestana) => void;
  hacer: Hacer;
  ahora: number;
}) {
  const base = useId();
  const nombre = pc.nombre || `${pc.huella.slice(0, 8)}…`;
  const bloqueo = bloqueoDe(estado, "pc", pc.huella);
  const cuentas: Record<Pestana, number | null> = {
    enlaces: pc.leen.length + pc.lee.length,
    codigos: pc.codigo ? 1 : 0,
    conexiones: pc.conexiones.length,
    uso: null,
  };

  function teclaPestanas(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = PESTANAS.findIndex((p) => p.id === pestana);
    const otra = PESTANAS[(i + (e.key === "ArrowRight" ? 1 : PESTANAS.length - 1)) % PESTANAS.length]!;
    setPestana(otra.id);
    document.getElementById(`${base}-${otra.id}`)?.focus();
  }

  return (
    <>
      <Ficha
        titulo={nombre}
        etiquetas={
          <>
            {pc.en_linea ? <Etiqueta color="validada">en línea</Etiqueta> : <Etiqueta color="tenue">sin conexión</Etiqueta>}
            {!pc.informe && <Etiqueta color="pendiente">sin informe</Etiqueta>}
            {bloqueo && <Etiqueta color="revisar">bloqueada</Etiqueta>}
          </>
        }
      >
        <Dato nombre="Versión" num>
          {pc.version ?? "—"}
        </Dato>
        <Dato nombre="Visto">{hace(pc.visto, ahora)}</Dato>
        <Dato nombre="IP" num>
          {pc.ip ?? "—"}
        </Dato>
        {pc.informe && <Dato nombre="Acceso remoto">{pc.acceso ? "encendido" : "apagado"}</Dato>}
      </Ficha>

      {!pc.informe ? (
        <section className="seccion">
          <h2>Sin informe</h2>
          <p className="guia">
            Esta PC se conecta con una versión de agent-memory anterior a 0.3.0, que no manda informe: el relé ve sus conexiones pero no sus
            enlaces, códigos ni uso. Al actualizarla aparece el detalle.
          </p>
        </section>
      ) : (
        <>
          <div className="pestanas" role="tablist" aria-label="Secciones de la PC" onKeyDown={teclaPestanas}>
            {PESTANAS.map((p) => (
              <button
                key={p.id}
                id={`${base}-${p.id}`}
                type="button"
                role="tab"
                className={`pestana${p.id === pestana ? " activa" : ""}`}
                aria-selected={p.id === pestana}
                aria-controls={`${base}-panel`}
                tabIndex={p.id === pestana ? 0 : -1}
                onClick={() => setPestana(p.id)}
              >
                {p.nombre}
                {cuentas[p.id] !== null && <span className="cuenta">{cuentas[p.id]}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${pestana}`}>
            {pestana === "enlaces" && <Enlaces estado={estado} pc={pc} hacer={hacer} ahora={ahora} />}
            {pestana === "codigos" && <Codigos pc={pc} hacer={hacer} ahora={ahora} />}
            {pestana === "conexiones" && <Conexiones pc={pc} hacer={hacer} />}
            {pestana === "uso" && <Uso pc={pc} />}
          </div>
        </>
      )}

      <section className="seccion final" aria-label="Esta PC">
        <h2>Esta PC</h2>
        <div className="zona">
          <p>Cerrar corta las conexiones de ahora; la PC vuelve a conectarse sola. Bloquear le impide usar el relé hasta que se desbloquee.</p>
          <Confirmar
            etiqueta="Cerrar conexiones"
            pregunta={`¿Cerrar las conexiones de ${nombre}?`}
            confirmar="Sí, cerrar"
            clase=""
            alConfirmar={() => hacer({ accion: "cerrar_pc", pc: pc.huella }, `Se cerraron las conexiones de ${nombre}.`)}
          />
          {bloqueo ? (
            <button type="button" onClick={() => void hacer({ accion: "desbloquear", pc: pc.huella }, `${nombre} quedó desbloqueada.`)}>
              Desbloquear
            </button>
          ) : (
            <Bloquear
              etiqueta="Bloquear esta PC"
              quien={nombre}
              alConfirmar={(duracion) => hacer({ accion: "bloquear", pc: pc.huella, duracion }, `${nombre} quedó bloqueada (${textoDuracion(duracion)}).`)}
            />
          )}
        </div>
      </section>
    </>
  );
}

function textoDuracion(d: Duracion): string {
  return d === "indefinido" ? "sin vencimiento" : `por ${d === "1h" ? "1 h" : "24 h"}`;
}

function Vence({ iso, ahora }: { iso: string | null; ahora: number }) {
  if (!iso) return <>sin vencimiento</>;
  return (
    <>
      {fecha(iso)} · <span className="sub">{falta(iso, ahora)}</span>
    </>
  );
}

function Pendientes({ textos }: { textos: string[] }) {
  if (!textos.length) return null;
  return (
    <ul className="pendientes">
      {textos.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

const NOMBRE_PEDIDO: Record<string, string> = { renovar: "Renovación", alcance: "Cambio de alcance", codigo: "Código nuevo" };

function Enlaces({ estado, pc, hacer, ahora }: { estado: Estado; pc: Pc; hacer: Hacer; ahora: number }) {
  const [editando, setEditando] = useState<string | null>(null);
  const nombre = pc.nombre || "esta PC";
  return (
    <>
      <section className="seccion" aria-labelledby="quien">
        <h2 id="quien">Quién lee la memoria de esta PC</h2>
        <p className="guia">Cada fila es otra PC con permiso de lectura sobre esta memoria.</p>
        {pc.leen.length === 0 ? (
          <p className="vacio">Ninguna otra PC lee esta memoria.</p>
        ) : (
          <div className="envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  <th scope="col">PC</th>
                  <th scope="col">Qué puede leer</th>
                  <th scope="col">Vence</th>
                  <th scope="col">Último uso</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pc.leen.map((l) => (
                  <FilaLector
                    key={l.huella}
                    pc={pc}
                    nombrePc={nombre}
                    l={l}
                    hacer={hacer}
                    ahora={ahora}
                    editando={editando === l.huella}
                    setEditando={(si) => setEditando(si ? l.huella : null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="seccion" aria-labelledby="que">
        <h2 id="que">Qué memorias lee esta PC</h2>
        <p className="guia">La renovación de estas la decide la otra PC, que es la dueña.</p>
        {pc.lee.length === 0 ? (
          <p className="vacio">Esta PC no lee memorias de otras.</p>
        ) : (
          <div className="envoltura">
            <table className="tabla">
              <thead>
                <tr>
                  <th scope="col">Memoria de</th>
                  <th scope="col">Nombre aquí</th>
                  <th scope="col">Vence</th>
                  <th scope="col">Último uso</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pc.lee.map((x) => (
                  <FilaLectura key={`${x.duena}:${x.origen}`} estado={estado} pc={pc} x={x} hacer={hacer} ahora={ahora} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function FilaLector({
  pc,
  nombrePc: duena,
  l,
  hacer,
  ahora,
  editando,
  setEditando,
}: {
  pc: Pc;
  nombrePc: string;
  l: Lector;
  hacer: Hacer;
  ahora: number;
  editando: boolean;
  setEditando: (si: boolean) => void;
}) {
  const pedidos = pc.pendientes
    .filter((p) => p.objetivo === l.huella)
    .map((p) => `${NOMBRE_PEDIDO[p.accion] ?? p.accion}: pendiente de confirmar en ${duena}`);
  const pedido = `queda pendiente de confirmar en ${duena}.`;
  return (
    <>
      <tr>
        <td>
          <strong>{l.nombre}</strong>
          {l.revocado ? <span className="sub"> · revocada</span> : null}
          <Pendientes textos={pedidos} />
        </td>
        <td>
          <Chips alcance={l.alcance} />
        </td>
        <td>
          <Vence iso={l.vence} ahora={ahora} />
        </td>
        <td>{hace(l.usado, ahora)}</td>
        <td>
          {!l.revocado && (
            <div className="acciones">
              <button
                type="button"
                className="chico"
                onClick={() => void hacer({ accion: "renovar", pc: pc.huella, objetivo: l.huella }, `Renovación de ${l.nombre} pedida: ${pedido}`)}
              >
                Renovar 30 días
              </button>
              <button type="button" className="chico" aria-expanded={editando} onClick={() => setEditando(!editando)}>
                Cambiar alcance
              </button>
              <Confirmar
                etiqueta="Revocar"
                pregunta={`¿Revocar a ${l.nombre}?`}
                confirmar="Sí, revocar"
                chico
                alConfirmar={() => hacer({ accion: "revocar", pc: pc.huella, objetivo: l.huella }, `${l.nombre} ya no lee la memoria de ${duena}.`)}
              />
            </div>
          )}
        </td>
      </tr>
      {editando && (
        <tr>
          <td colSpan={5}>
            <EditorAlcance
              lector={l}
              cancelar={() => setEditando(false)}
              guardar={async (alcance) => {
                const ok = await hacer(
                  { accion: "alcance", pc: pc.huella, objetivo: l.huella, alcance },
                  `Cambio de alcance de ${l.nombre} pedido: ${pedido}`,
                );
                if (ok) setEditando(false);
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function FilaLectura({ estado, pc, x, hacer, ahora }: { estado: Estado; pc: Pc; x: Lectura; hacer: Hacer; ahora: number }) {
  const duena = nombrePc(estado, x.duena);
  const pedidos = (estado.pcs.find((p) => p.huella === x.duena)?.pendientes ?? [])
    .filter((p) => p.objetivo === pc.huella)
    .map((p) => `${NOMBRE_PEDIDO[p.accion] ?? p.accion}: pendiente de confirmar en ${duena}`);
  return (
    <tr>
      <td>
        <strong>{duena}</strong>
        <Pendientes textos={pedidos} />
      </td>
      <td className="num">{x.origen}</td>
      <td>
        <Vence iso={x.vence} ahora={ahora} />
      </td>
      <td>{hace(x.usado, ahora)}</td>
      <td>
        <div className="acciones">
          <button
            type="button"
            className="chico"
            onClick={() =>
              void hacer({ accion: "renovar", pc: x.duena, objetivo: pc.huella }, `Renovación pedida: queda pendiente de confirmar en ${duena}.`)
            }
          >
            Pedir renovación
          </button>
          <Confirmar
            etiqueta="Quitar enlace"
            pregunta={`¿Quitar el enlace «${x.origen}»?`}
            confirmar="Sí, quitar"
            chico
            alConfirmar={() => hacer({ accion: "quitar_enlace", pc: pc.huella, objetivo: x.origen }, `Se quitó el enlace «${x.origen}».`)}
          />
        </div>
      </td>
    </tr>
  );
}

function Chips({ alcance }: { alcance: Alcance }) {
  if (!alcance.ambitos.length && !alcance.pendientes) return <span className="sub">nada</span>;
  return (
    <div className="alcance">
      {alcance.ambitos.map((a) => (
        <span key={a} className="alc" title={a}>
          {a.startsWith(PROYECTO) ? a.slice(PROYECTO.length) : a}
        </span>
      ))}
      {alcance.pendientes && <span className="alc">+ no validadas</span>}
    </div>
  );
}

const PROYECTO = "proyecto:";
const REPO = "repo:";

/** Lo escrito en el editor, con su prefijo una sola vez aunque la persona ya lo haya puesto. */
function conPrefijo(prefijo: string, texto: string): string[] {
  return partir(texto).map((ref) => (ref.startsWith(prefijo) ? ref : `${prefijo}${ref}`));
}

function partir(texto: string): string[] {
  return texto
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EditorAlcance({ lector, guardar, cancelar }: { lector: Lector; guardar: (a: Alcance) => Promise<void>; cancelar: () => void }) {
  const inicial = lector.alcance.ambitos;
  const refs = (prefijo: string) =>
    inicial
      .filter((a) => a.startsWith(prefijo))
      .map((a) => a.slice(prefijo.length))
      .join("\n");
  const [global, setGlobal] = useState(inicial.includes("global"));
  const [proyectos, setProyectos] = useState(refs(PROYECTO));
  const [repos, setRepos] = useState(refs(REPO));
  const [pendientes, setPendientes] = useState(lector.alcance.pendientes);
  const primero = useRef<HTMLInputElement>(null);
  useEffect(() => primero.current?.focus(), []);

  return (
    <fieldset className="editor" onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <legend>Qué puede leer {lector.nombre}</legend>
      <p className="sub">El cambio queda pendiente hasta que la PC dueña lo acepte en su web local.</p>
      <label className="casilla">
        <input ref={primero} type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />
        Global
      </label>
      <label>
        Proyectos (uno por línea)
        <textarea value={proyectos} onChange={(e) => setProyectos(e.target.value)} rows={2} />
      </label>
      <label>
        Repos (uno por línea)
        <textarea value={repos} onChange={(e) => setRepos(e.target.value)} rows={2} />
      </label>
      <label className="casilla">
        <input type="checkbox" checked={pendientes} onChange={(e) => setPendientes(e.target.checked)} />
        Incluir las no validadas
      </label>
      <div className="acciones">
        <button
          type="button"
          className="chico"
          onClick={() =>
            void guardar({
              ambitos: [
                ...(global ? ["global"] : []),
                ...conPrefijo(PROYECTO, proyectos),
                ...conPrefijo(REPO, repos),
              ],
              pendientes,
            })
          }
        >
          Pedir cambio de alcance
        </button>
        <button type="button" className="chico" onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </fieldset>
  );
}

function Codigos({ pc, hacer, ahora }: { pc: Pc; hacer: Hacer; ahora: number }) {
  const nombre = pc.nombre || "la PC";
  const pedidos = pc.pendientes.filter((p) => p.accion === "codigo");
  return (
    <section className="seccion" aria-labelledby="codigos">
      <h2 id="codigos">Código de enlace</h2>
      <p className="guia">El código se genera y se ve solo en la web local de {nombre}; el relé solo sabe si hay uno vigente.</p>
      <div className="zona">
        <p>
          {pc.codigo && Date.parse(pc.codigo.vence) > ahora ? (
            <>
              Hay un código vigente: vence en <span className="num">{cuenta(pc.codigo.vence, ahora)}</span>.
            </>
          ) : (
            "No hay un código vigente."
          )}
          {pedidos.length > 0 && <> Código nuevo: pendiente de confirmar en {nombre}.</>}
        </p>
        <button
          type="button"
          onClick={() =>
            void hacer(
              { accion: "codigo", pc: pc.huella },
              `Pedido de código enviado: queda pendiente de confirmar en ${nombre}; el código se ve solo en su web local.`,
            )
          }
        >
          Pedir código nuevo
        </button>
      </div>
    </section>
  );
}

function Conexiones({ pc, hacer }: { pc: Pc; hacer: Hacer }) {
  const nombre = pc.nombre || "esta PC";
  return (
    <section className="seccion" aria-labelledby="conexiones">
      <h2 id="conexiones">Conexiones abiertas</h2>
      <p className="guia">Buzones de esta PC abiertos en el relé ahora.</p>
      {pc.conexiones.length === 0 ? (
        <p className="vacio">Sin conexiones abiertas ahora.</p>
      ) : (
        <div className="envoltura">
          <table className="tabla">
            <thead>
              <tr>
                <th scope="col">Buzón</th>
                <th scope="col">Estado</th>
                <th scope="col">Datos</th>
                <th scope="col">Inactiva</th>
              </tr>
            </thead>
            <tbody>
              {pc.conexiones.map((c) => (
                <tr key={c.buzon}>
                  <td className="num">{c.buzon}</td>
                  <td>{c.estado}</td>
                  <td className="num">{bytes(c.bytes)}</td>
                  <td className="num">{c.inactivo_s < 60 ? `${c.inactivo_s} s` : `${Math.floor(c.inactivo_s / 60)} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="zona">
        <Confirmar
          etiqueta="Cerrar conexiones"
          pregunta={`¿Cerrar las conexiones de ${nombre}?`}
          confirmar="Sí, cerrar"
          clase=""
          alConfirmar={() => hacer({ accion: "cerrar_pc", pc: pc.huella }, `Se cerraron las conexiones de ${nombre}.`)}
        />
      </div>
    </section>
  );
}

function Uso({ pc }: { pc: Pc }) {
  const dias = pc.uso.slice(-7);
  if (!dias.length) {
    return (
      <section className="seccion" aria-labelledby="uso">
        <h2 id="uso">Uso de los últimos 7 días</h2>
        <p className="vacio">Sin uso registrado.</p>
      </section>
    );
  }
  const suma = (k: "recibidas" | "hechas" | "bytes" | "rechazos") => dias.reduce((n, d) => n + d[k], 0);
  const max = Math.max(1, ...dias.map((d) => d.recibidas));
  return (
    <section className="seccion" aria-labelledby="uso">
      <h2 id="uso">Uso de los últimos 7 días</h2>
      <div className="uso">
        <div>
          <span className="sub">Lecturas recibidas</span>
          <strong className="num">{suma("recibidas")}</strong>
        </div>
        <div>
          <span className="sub">Lecturas hechas</span>
          <strong className="num">{suma("hechas")}</strong>
        </div>
        <div>
          <span className="sub">Datos por el relé</span>
          <strong className="num">{bytes(suma("bytes"))}</strong>
        </div>
        <div>
          <span className="sub">Rechazos</span>
          <strong className="num">{suma("rechazos")}</strong>
        </div>
      </div>
      <div className="barras" role="img" aria-label={`Lecturas recibidas por día: ${dias.map((d) => d.recibidas).join(", ")}`}>
        {dias.map((d) => (
          <span key={d.dia} style={{ height: `${(d.recibidas / max) * 100}%` }} />
        ))}
      </div>
      <div className="dias" aria-hidden="true">
        {dias.map((d) => (
          <span key={d.dia}>{diaSemana(d.dia)}</span>
        ))}
      </div>
      <div className="envoltura">
        <table className="tabla">
          <caption className="oculto">Uso por día</caption>
          <thead>
            <tr>
              <th scope="col">Día</th>
              <th scope="col">Recibidas</th>
              <th scope="col">Hechas</th>
              <th scope="col">Datos</th>
              <th scope="col">Rechazos</th>
            </tr>
          </thead>
          <tbody>
            {dias.map((d) => (
              <tr key={d.dia}>
                <th scope="row" className="num">
                  {diaSemana(d.dia)} {d.dia.slice(5)}
                </th>
                <td className="num">{d.recibidas}</td>
                <td className="num">{d.hechas}</td>
                <td className="num">{bytes(d.bytes)}</td>
                <td className="num">{d.rechazos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetalleIp({ estado, d, hacer, ahora }: { estado: Estado; d: Desconocida; hacer: Hacer; ahora: number }) {
  const bloqueo = bloqueoDe(estado, "ip", d.ip);
  return (
    <>
      <Ficha titulo={<span className="num">{d.ip}</span>} etiquetas={<Etiqueta color="rechazada">clave equivocada</Etiqueta>}>
        <Dato nombre="Intentos en 1 h" num>
          {d.rechazos}
        </Dato>
        <Dato nombre="Primero">{hace(d.primera, ahora)}</Dato>
        <Dato nombre="Último">{hace(d.ultima, ahora)}</Dato>
      </Ficha>
      <section className="seccion final" aria-label="Esta IP">
        <h2>Esta IP</h2>
        <div className="zona">
          <p>Intenta usar el relé con una clave que no es la suya. Bloquearla le corta el acceso antes de comprobar la clave.</p>
          {bloqueo ? (
            <span className="sub">Ya está bloqueada.</span>
          ) : (
            <Bloquear
              etiqueta="Bloquear esta IP"
              quien={d.ip}
              alConfirmar={(duracion) => hacer({ accion: "bloquear", ip: d.ip, duracion }, `${d.ip} quedó bloqueada (${textoDuracion(duracion)}).`)}
            />
          )}
        </div>
      </section>
    </>
  );
}

function DetalleBloqueo({ estado, b, hacer, ahora }: { estado: Estado; b: Bloqueo; hacer: Hacer; ahora: number }) {
  const nombre = b.tipo === "pc" ? nombrePc(estado, b.valor) : b.valor;
  const cuerpo: Accion = b.tipo === "pc" ? { accion: "desbloquear", pc: b.valor } : { accion: "desbloquear", ip: b.valor };
  return (
    <>
      <Ficha titulo={b.tipo === "ip" ? <span className="num">{nombre}</span> : nombre} etiquetas={<Etiqueta color="revisar">bloqueada</Etiqueta>}>
        <Dato nombre="Tipo">{b.tipo === "pc" ? "PC" : "IP"}</Dato>
        <Dato nombre="Hasta">{b.hasta ? `${hora(b.hasta)} (${falta(b.hasta, ahora)})` : "sin vencimiento"}</Dato>
      </Ficha>
      <section className="seccion final" aria-label="Bloqueo">
        <h2>Bloqueo</h2>
        <div className="zona">
          <p>Mientras dure, el relé rechaza {b.tipo === "pc" ? "a esta PC" : "a esta IP"} sin comprobar la clave.</p>
          <button type="button" onClick={() => void hacer(cuerpo, `${nombre} quedó desbloqueada.`)}>
            Desbloquear
          </button>
        </div>
      </section>
    </>
  );
}

/** Botón de una acción restrictiva: pide confirmación en línea, sin modal. Escape cancela. */
function Confirmar({
  etiqueta,
  pregunta,
  confirmar,
  alConfirmar,
  clase = "peligro",
  chico,
}: {
  etiqueta: string;
  pregunta: string;
  confirmar: string;
  alConfirmar: () => Promise<unknown>;
  clase?: string;
  chico?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const si = useRef<HTMLButtonElement>(null);
  const disparador = useRef<HTMLButtonElement>(null);
  const volver = useRef(false);
  useEffect(() => {
    if (abierto) si.current?.focus();
    else if (volver.current) {
      volver.current = false;
      disparador.current?.focus();
    }
  }, [abierto]);
  const tam = chico ? " chico" : "";
  if (!abierto) {
    return (
      <button ref={disparador} type="button" className={`${clase}${tam}`} onClick={() => setAbierto(true)}>
        {etiqueta}
      </button>
    );
  }
  const cancelar = () => {
    volver.current = true;
    setAbierto(false);
  };
  return (
    <span className="confirma" role="group" aria-label={pregunta} onKeyDown={(e) => e.key === "Escape" && cancelar()}>
      <span>{pregunta}</span>
      <button
        ref={si}
        type="button"
        className={`peligro${tam}`}
        onClick={() => {
          volver.current = true;
          setAbierto(false);
          void alConfirmar();
        }}
      >
        {confirmar}
      </button>
      <button type="button" className={`enlace${tam}`} onClick={cancelar}>
        Cancelar
      </button>
    </span>
  );
}

/** Bloquear con duración (1 h, 24 h o indefinido, D03) y confirmación en línea. */
function Bloquear({ etiqueta, quien, alConfirmar }: { etiqueta: string; quien: string; alConfirmar: (d: Duracion) => Promise<unknown> }) {
  const [abierto, setAbierto] = useState(false);
  const [duracion, setDuracion] = useState<Duracion>("1h");
  const nombre = useId();
  const primero = useRef<HTMLInputElement>(null);
  const disparador = useRef<HTMLButtonElement>(null);
  const volver = useRef(false);
  useEffect(() => {
    if (abierto) primero.current?.focus();
    else if (volver.current) {
      volver.current = false;
      disparador.current?.focus();
    }
  }, [abierto]);
  if (!abierto) {
    return (
      <button ref={disparador} type="button" className="peligro" onClick={() => setAbierto(true)}>
        {etiqueta}
      </button>
    );
  }
  const cerrar = () => {
    volver.current = true;
    setAbierto(false);
  };
  return (
    <fieldset className="confirma" onKeyDown={(e) => e.key === "Escape" && cerrar()}>
      <legend>¿Bloquear {quien}? Por cuánto tiempo:</legend>
      {DURACIONES.map((d, i) => (
        <label key={d.valor} className="casilla">
          <input
            ref={i === 0 ? primero : undefined}
            type="radio"
            name={nombre}
            value={d.valor}
            checked={duracion === d.valor}
            onChange={() => setDuracion(d.valor)}
          />
          {d.nombre}
        </label>
      ))}
      <button
        type="button"
        className="peligro"
        onClick={() => {
          cerrar();
          void alConfirmar(duracion);
        }}
      >
        Confirmar bloqueo
      </button>
      <button type="button" className="enlace" onClick={cerrar}>
        Cancelar
      </button>
    </fieldset>
  );
}
