import { useEffect, useRef, useState } from "react";
import { mensajeError, type Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { CodigoVigente, Invitar, PaneComparto } from "./Compartir";
import { fechaHora, Senal } from "./comun";
import { PaneLeo, PegarCodigo } from "./Leer";
import type { CodigoNuevo, Conexion, Estado, FilaActividad, Registro } from "./tipos";

// «Conexiones»: esta PC es la única local; cada otra PC aparece una sola vez, con los dos sentidos (le compartís tu
// memoria / te comparte la suya), como al compartir la ubicación, y con su propia actividad.

const activa = (c: Conexion) => Boolean(c.leo) || Boolean(c.comparto && c.comparto.estado !== "revocado");

function resumenSentidos(c: Conexion): string {
  const comparto = Boolean(c.comparto && c.comparto.estado !== "revocado");
  if (comparto && c.leo) return "en los dos sentidos";
  return comparto ? "solo le compartís" : "solo te comparte";
}

export function Conexiones({
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
  const [conectar, setConectar] = useState<"abierto" | "leer" | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const conexiones = estado.conexiones ?? [];
  const activas = conexiones.filter(activa);
  const terminadas = conexiones.filter((c) => !activa(c));
  const apagado = !estado.interruptor;
  const abierto = conectar !== null || codigo !== null;

  const abrir = (modo: "abierto" | "leer") => {
    setConectar(modo);
    requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "nearest" }));
  };

  return (
    <section className="conexiones" aria-labelledby="titulo-conexiones">
      <header className="ph">
        <h3 id="titulo-conexiones">
          Conexiones <span className="num">· {activas.length}</span>
        </h3>
        <button
          type="button"
          className="ph-boton"
          aria-expanded={abierto}
          onClick={() => {
            if (abierto) {
              setConectar(null);
              setCodigo(null);
            } else abrir("abierto");
          }}
        >
          {abierto ? "Cerrar" : "+ Conectar otra PC"}
        </button>
      </header>
      {apagado && (
        <p className="nota-apagado" role="note">
          <Senal tono="tenue">Compartir está apagado: ninguna PC puede leer tu memoria.</Senal>
          <span>Encendelo en «Esta PC». Leer las memorias de otras PCs sigue funcionando.</span>
        </p>
      )}

      {abierto && (
        <div className="conectar" ref={panel}>
          <div className="camino" role="group" aria-labelledby="titulo-compartirle">
            <h4 id="titulo-compartirle">Compartirle tu memoria</h4>
            {codigo ? (
              <CodigoVigente codigo={codigo} ahora={ahora} cerrar={() => setCodigo(null)} />
            ) : apagado ? (
              <p className="meta">Encendé «Compartir» en «Esta PC» para generar un código.</p>
            ) : (
              <>
                <p className="meta">Elegís qué verá y generás un código; la otra PC lo pega en «Leer su memoria».</p>
                <Invitar cliente={cliente} recargar={recargar} listo={setCodigo} />
              </>
            )}
          </div>
          <div className="camino" role="group" aria-labelledby="titulo-leer">
            <h4 id="titulo-leer">Leer su memoria</h4>
            <p className="meta">Pegá el código que te dio la otra PC. No hace falta escribir ningún nombre.</p>
            <PegarCodigo cliente={cliente} recargar={recargar} enfocar={conectar === "leer"} />
          </div>
        </div>
      )}

      {activas.length === 0 && !abierto && (
        <div className="vacio">
          <p>Todavía no hay otras PCs conectadas.</p>
          <p className="meta">Con «+ Conectar otra PC» le compartís tu memoria o leés la suya con un código.</p>
        </div>
      )}
      <ul className="lista tarjetas" aria-label="PCs conectadas">
        {activas.map((c) => (
          <li key={c.huella} className="conexion">
            <div className="conexion-cab">
              <span className="item-nombre">{c.nombre}</span>
              <span className="meta">{resumenSentidos(c)}</span>
            </div>
            <div className="sentidos">
              <PaneComparto c={c} cliente={cliente} recargar={recargar} apagado={apagado} compartirle={() => abrir("abierto")} />
              <PaneLeo c={c} cliente={cliente} recargar={recargar} pegarSuCodigo={() => abrir("leer")} />
            </div>
            <Actividad c={c} cliente={cliente} ahora={ahora} />
          </li>
        ))}
      </ul>

      {terminadas.length > 0 && (
        <details className="terminadas">
          <summary>
            Conexiones terminadas <span className="num">· {terminadas.length}</span>
          </summary>
          <ul className="lista" aria-label="Conexiones terminadas">
            {terminadas.map((c) => (
              <li key={c.huella} className="conexion terminada">
                <span className="meta-linea">
                  <strong>{c.nombre}</strong> · dejaste de compartirle el <span className="num">{fecha(c.comparto?.revocado_en)}</span>
                </span>
                <Actividad c={c} cliente={cliente} ahora={ahora} etiqueta="ver su historial" />
              </li>
            ))}
          </ul>
        </details>
      )}

      <Desconocidas cliente={cliente} hoy={estado.desconocidas_hoy ?? 0} />
    </section>
  );
}

function resumenHoy(h: Conexion["hoy"]): string {
  const partes: string[] = [];
  if (h.leyo) partes.push(`leyó ${h.leyo} de las tuyas`);
  if (h.lei) partes.push(`leíste ${h.lei} de la suya`);
  if (h.rechazos) partes.push(`${h.rechazos} ${h.rechazos === 1 ? "rechazo" : "rechazos"}`);
  return partes.length ? `hoy: ${partes.join(" · ")}` : "hoy, sin lecturas";
}

/** La actividad de una conexión, plegada; se pide al abrirla. */
function Actividad({ c, cliente, ahora, etiqueta }: { c: Conexion; cliente: Cliente; ahora: () => number; etiqueta?: string }) {
  const [abierta, setAbierta] = useState(false);
  const [limite, setLimite] = useState(50);
  const [datos, setDatos] = useState<{ leyo: FilaActividad[]; lei: FilaActividad[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!abierta) return;
    let vivo = true;
    cliente<{ leyo: FilaActividad[]; lei: FilaActividad[] }>("remoto_actividad", { huella: c.huella, limite })
      .then((r) => vivo && (setDatos(r), setError(null)))
      .catch((e: unknown) => vivo && setError(mensajeError(e)));
    return () => {
      vivo = false;
    };
  }, [abierta, cliente, c.huella, limite, c.hoy.leyo, c.hoy.lei, c.hoy.rechazos]);

  return (
    <details
      className="actividad"
      open={abierta}
      onToggle={(e) => setAbierta((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="rotulo">{etiqueta ?? "Actividad"}</span>
        {!etiqueta && <span className={`meta${c.hoy.rechazos ? " con-rechazos" : ""}`}>{resumenHoy(c.hoy)}</span>}
      </summary>
      <Aviso texto={error} />
      {datos && (
        <div className="actividad-listas">
          <ListaActividad titulo="→ Lo que leyó de tu memoria" filas={datos.leyo} ahora={ahora} vacio="No leyó nada de tu memoria." />
          <ListaActividad titulo="← Lo que leíste de la suya" filas={datos.lei} ahora={ahora} vacio="No leíste nada de su memoria." />
        </div>
      )}
      {datos && limite < 500 && (datos.leyo.length >= limite || datos.lei.length >= limite) && (
        <button type="button" className="enlace azul" onClick={() => setLimite(500)}>
          Ver todo el historial de {c.nombre}
        </button>
      )}
    </details>
  );
}

function ListaActividad({ titulo, filas, ahora, vacio }: { titulo: string; filas: FilaActividad[]; ahora: () => number; vacio: string }) {
  return (
    <div className="lista-actividad">
      <h5>{titulo}</h5>
      {filas.length === 0 ? (
        <p className="meta">{vacio}</p>
      ) : (
        <ul className="lista" aria-label={titulo.slice(2)}>
          {filas.map((f, i) => (
            <li key={`${f.fecha}-${i}`} className={`act-fila${f.resultado === "rechazo" ? " rechazo" : ""}`}>
              <span className="num">{cuando(f.fecha, ahora())}</span>
              <span>{f.resultado === "rechazo" ? "rechazo" : (HERRAMIENTAS[f.herramienta] ?? f.herramienta)}</span>
              <span className="act-detalle">{detalle(f)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Lo que no es una lectura se dice con palabras: canjear el código es cuando la PC se conectó. */
const HERRAMIENTAS: Record<string, string> = { enlazar: "se conectó" };

/** Hora si es de hoy; fecha y hora si no. */
function cuando(iso: string, ahora: number): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date(ahora).toDateString()) return d.toTimeString().slice(0, 5);
  return fechaHora(iso);
}

/** El pedido en palabras: «consulta» → ids, o el id leído; los rechazos dicen por qué. */
function detalle(f: FilaActividad): string {
  let pedido = "";
  try {
    const p = f.pedido ? (JSON.parse(f.pedido) as { consulta?: string; id?: number }) : {};
    if (p.consulta) pedido = `«${p.consulta}»`;
    else if (typeof p.id === "number") pedido = `#${p.id}`;
  } catch {
    pedido = f.pedido ?? "";
  }
  if (f.resultado === "rechazo") return [f.herramienta, pedido, f.motivo ? `: ${f.motivo}` : ""].filter(Boolean).join(" ").replace(" :", ":");
  const ids = f.ids.length ? f.ids.map((x) => `#${x}`).join(", ") : "";
  if (pedido && ids && pedido !== ids) return `${pedido} → ${ids}`;
  return pedido || ids || "—";
}

/** Intentos sin una conexión conocida: una línea; el detalle, a pedido. */
function Desconocidas({ cliente, hoy }: { cliente: Cliente; hoy: number }) {
  const [filas, setFilas] = useState<Registro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function ver() {
    try {
      setFilas((await cliente<{ registro: Registro[] }>("remoto_registro", { solo_desconocidas: true })).registro);
    } catch (e) {
      setError(mensajeError(e));
    }
  }
  return (
    <div className="desconocidas">
      <p className="meta">
        Intentos de PCs desconocidas: <span className="num">{hoy}</span> hoy.{" "}
        {filas === null && (
          <button type="button" className="enlace azul" onClick={() => void ver()}>
            Ver
          </button>
        )}
      </p>
      <Aviso texto={error} />
      {filas && filas.length === 0 && <p className="meta">Ninguno registrado.</p>}
      {filas && filas.length > 0 && (
        <ul className="lista" aria-label="Intentos de PCs desconocidas">
          {filas.map((f) => (
            <li key={f.id} className="act-fila rechazo">
              <span className="num">{fechaHora(f.fecha)}</span>
              <span>{f.herramienta}</span>
              <span className="act-detalle">{f.motivo ?? "?"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
