import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { mensajeError, type Cliente } from "../api";
import { Aviso, fecha } from "./comunes";

// «Acceso remoto»: la persona abre (o cierra) su memoria a otra instalación, solo para leer. Todo pasa por las
// operaciones remoto_* del servicio, que solo responden a la sesión de la web.

interface AmbitoAlcance {
  ambito: "global" | "proyecto" | "repo";
  ref: string | null;
}

interface Dispositivo {
  id: number;
  nombre: string;
  enlazado_en: string;
  usado_en: string | null;
  vence_en: string;
  revocado_en: string | null;
  estado: "vigente" | "revocado" | "credencial_vencida";
  alcance: { ambitos: AmbitoAlcance[]; no_validadas: boolean };
}

/** Un pedido hecho desde el panel del relé que amplía el acceso: espera la decisión de la persona (D01). */
interface PedidoPanel {
  id: number;
  accion: "renovar" | "alcance" | "codigo";
  dispositivo: { id: number; nombre: string } | null;
  datos: { ambitos: string[]; pendientes: boolean } | null;
  creado_en: string;
  estado: string;
}

type CodigoNuevo = { codigo: string; vence_en: string };

interface Estado {
  interruptor: boolean;
  nombre_pc: string;
  panel: "conectado" | "conectando" | "inactivo";
  pendientes: PedidoPanel[];
  rele: { url: string } | null;
  codigo: { vence_en: string; intentos_restantes: number } | null;
  dispositivos: Dispositivo[];
  enlaces: { origen: string; vence_en: string }[];
}

interface Registro {
  id: number;
  fecha: string;
  dispositivo_id: number | null;
  dispositivo: string | null;
  herramienta: string;
  pedido: string | null;
  ids: number[];
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

const ESTADOS: Record<Dispositivo["estado"], string> = { vigente: "vigente", revocado: "revocado", credencial_vencida: "vencido" };

const PANEL: Record<Estado["panel"], string> = {
  conectado: "conectada",
  conectando: "conectando…",
  inactivo: "inactiva: se abre con el relé configurado y el acceso encendido o algún enlace",
};

/** El nombre visible no puede pasar de lo que guarda el servicio (LARGO_NOMBRE_PC). */
const LARGO_NOMBRE = 60;

export function Remoto({ cliente, ahora = () => Date.now() }: { cliente: Cliente; ahora?: () => number }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [codigo, setCodigo] = useState<CodigoNuevo | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setEstado(await cliente<Estado>("remoto_estado"));
    } catch (e) {
      setError(mensajeError(e));
    }
  }, [cliente]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function accion(trabajo: () => Promise<unknown>, mensaje: string) {
    setError(null);
    setHecho(null);
    try {
      await trabajo();
      setHecho(mensaje);
      await cargar();
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  if (!estado) {
    return (
      <section className="hoja" aria-labelledby="titulo-remoto">
        <h2 id="titulo-remoto">Acceso remoto</h2>
        <Aviso texto={error} />
        {!error && <p>Cargando…</p>}
      </section>
    );
  }

  const enEdicion = estado.dispositivos.find((d) => d.id === editando) ?? null;

  return (
    <section className="hoja" aria-labelledby="titulo-remoto">
      <h2 id="titulo-remoto">Acceso remoto</h2>
      <p>
        Otra instalación tuya puede leer (nunca escribir) lo que elijas compartir de esta memoria, a través de un relé que
        solo ve datos cifrados. Viene apagado.
      </p>
      <p>
        Relé: {estado.rele ? <code>{estado.rele.url}</code> : <>sin configurar: corré «agent-memory remote relay &lt;url&gt;»</>}
      </p>
      <NombrePc
        estado={estado}
        guardar={(nombre) =>
          void accion(async () => setEstado(await cliente<Estado>("remoto_nombre", { nombre })), `Nombre guardado: el panel del relé muestra «${nombre}»`)
        }
      />
      <label className="casilla">
        <input
          type="checkbox"
          checked={estado.interruptor}
          onChange={(e) => {
            const encendido = e.target.checked;
            void accion(async () => {
              await cliente("remoto_interruptor", { encendido });
              if (!encendido) setCodigo(null);
            }, encendido ? "Acceso remoto encendido" : "Acceso remoto apagado: ningún dispositivo puede leer");
          }}
        />
        Acceso remoto {estado.interruptor ? "encendido" : "apagado"}
      </label>

      <PedidosPanel
        pedidos={estado.pendientes}
        resolver={(p, aceptar) =>
          void accion(async () => {
            const r = await cliente<{ codigo?: CodigoNuevo }>("remoto_pendiente", { id: p.id, aceptar });
            if (r.codigo) setCodigo(r.codigo);
          }, `${aceptar ? "Aceptado" : "Rechazado"}: ${textoPedido(p)}${aceptar && p.accion === "codigo" ? "; el código está abajo" : ""}`)
        }
      />

      <h3>Código para enlazar un dispositivo</h3>
      <p>
        <button
          type="button"
          disabled={!estado.interruptor}
          onClick={() => void accion(async () => setCodigo(await cliente<{ codigo: string; vence_en: string }>("remoto_codigo")), "Código generado")}
        >
          Generar código
        </button>
      </p>
      {codigo && <CodigoVigente codigo={codigo} ahora={ahora} />}
      {!codigo && estado.codigo && <p>Hay un código vigente hasta las {estado.codigo.vence_en.slice(11, 16)}.</p>}

      <h3>Dispositivos que leen esta memoria</h3>
      {estado.dispositivos.length === 0 ? (
        <p>Ningún dispositivo enlazado.</p>
      ) : (
        <div className="tabla">
        <table aria-label="Dispositivos enlazados">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Enlazado</th>
              <th>Último uso</th>
              <th>Vence</th>
              <th>Alcance</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {estado.dispositivos.map((d) => (
              <tr key={d.id}>
                <td>{d.nombre}</td>
                <td>{fecha(d.enlazado_en)}</td>
                <td>{fecha(d.usado_en)}</td>
                <td>{fecha(d.vence_en)}</td>
                <td>{resumenAlcance(d.alcance)}</td>
                <td>{ESTADOS[d.estado]}</td>
                <td>
                  <button type="button" aria-label={`Editar alcance de ${d.nombre}`} onClick={() => setEditando(d.id)}>
                    Alcance
                  </button>{" "}
                  <button
                    type="button"
                    aria-label={`Renovar ${d.nombre}`}
                    disabled={d.estado === "revocado"}
                    onClick={() => void accion(() => cliente("remoto_renovar", { id: d.id }), `${d.nombre}: renovado por 30 días`)}
                  >
                    Renovar
                  </button>{" "}
                  <button
                    type="button"
                    aria-label={`Revocar ${d.nombre}`}
                    disabled={d.estado === "revocado"}
                    onClick={() => void accion(() => cliente("remoto_revocar", { id: d.id }), `${d.nombre}: revocado`)}
                  >
                    Revocar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {enEdicion && (
        <EditorAlcance
          key={enEdicion.id}
          dispositivo={enEdicion}
          guardar={(ambitos, noValidadas) =>
            void accion(async () => {
              await cliente("remoto_alcance", { id: enEdicion.id, ambitos, no_validadas: noValidadas });
              setEditando(null);
            }, `${enEdicion.nombre}: alcance guardado; rige desde la próxima lectura`)
          }
          cancelar={() => setEditando(null)}
        />
      )}

      <Aviso texto={error} />
      <Aviso texto={hecho} tipo="ok" />

      <RegistroRemoto cliente={cliente} dispositivos={estado.dispositivos} version={estado} />
    </section>
  );
}

function NombrePc({ estado, guardar }: { estado: Estado; guardar: (nombre: string) => void }) {
  const [nombre, setNombre] = useState(estado.nombre_pc);
  const id = useId();
  useEffect(() => setNombre(estado.nombre_pc), [estado.nombre_pc]);
  const limpio = nombre.trim();
  function enviar(e: FormEvent) {
    e.preventDefault();
    if (limpio && limpio !== estado.nombre_pc) guardar(limpio);
  }
  return (
    <>
      <h3>Esta PC en el panel del relé</h3>
      <form className="nombre-pc" onSubmit={enviar}>
        <label htmlFor={id}>Nombre de esta PC</label>
        <input id={id} value={nombre} maxLength={LARGO_NOMBRE} onChange={(e) => setNombre(e.target.value)} />
        <button type="submit" disabled={!limpio || limpio === estado.nombre_pc}>
          Guardar
        </button>
      </form>
      <p>
        En el panel del relé figura como «{estado.nombre_pc}». Conexión con el panel: {PANEL[estado.panel]}.
      </p>
    </>
  );
}

function PedidosPanel({ pedidos, resolver }: { pedidos: PedidoPanel[]; resolver: (p: PedidoPanel, aceptar: boolean) => void }) {
  return (
    <>
      <h3>Pedidos del panel</h3>
      <p>Desde el panel del relé se puede pedir ampliar el acceso; nada cambia hasta que lo aceptes acá.</p>
      {pedidos.length === 0 ? (
        <p>No hay pedidos del panel.</p>
      ) : (
        <ul className="pedidos-panel" aria-label="Pedidos del panel">
          {pedidos.map((p) => (
            <li key={p.id}>
              <span>
                {p.accion === "alcance" ? (
                  <>
                    Cambiar el alcance de {nombreDispositivo(p)} a <ChipsAlcance datos={p.datos} />
                  </>
                ) : (
                  textoPedido(p)
                )}{" "}
                <span className="pedido-fecha">· {fecha(p.creado_en)}</span>
              </span>
              <span className="pedido-acciones">
                <button type="button" className="primario" aria-label={`Aceptar: ${textoPedido(p)}`} onClick={() => resolver(p, true)}>
                  Aceptar
                </button>
                <button type="button" className="peligro" aria-label={`Rechazar: ${textoPedido(p)}`} onClick={() => resolver(p, false)}>
                  Rechazar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function nombreDispositivo(p: PedidoPanel): string {
  return p.dispositivo?.nombre ?? "un dispositivo";
}

/** Lo que cambia el pedido, en una línea. */
function textoPedido(p: PedidoPanel): string {
  if (p.accion === "renovar") return `renovar ${nombreDispositivo(p)} 30 días`;
  if (p.accion === "codigo") return "código de enlace nuevo";
  return `cambiar el alcance de ${nombreDispositivo(p)} a ${p.datos ? textoAmbitos(p.datos) : "?"}`;
}

/** Ámbito del panel para leer: «proyecto:x» se muestra «x»; «global» y «repo:x», tal cual. */
function ambitoVisible(a: string): string {
  return a.startsWith("proyecto:") ? a.slice("proyecto:".length) : a;
}

function textoAmbitos(d: { ambitos: string[]; pendientes: boolean }): string {
  const partes = d.ambitos.map(ambitoVisible);
  return `${partes.length ? partes.join(", ") : "nada"}${d.pendientes ? " (+ no validadas)" : ""}`;
}

function ChipsAlcance({ datos }: { datos: PedidoPanel["datos"] }) {
  if (!datos || (!datos.ambitos.length && !datos.pendientes)) return <span className="chip">nada</span>;
  return (
    <>
      {datos.ambitos.map((a) => (
        <span key={a} className="chip" title={a}>
          {ambitoVisible(a)}
        </span>
      ))}
      {datos.pendientes && <span className="chip">+ no validadas</span>}
    </>
  );
}

function CodigoVigente({ codigo, ahora }: { codigo: { codigo: string; vence_en: string }; ahora: () => number }) {
  const [restante, setRestante] = useState(() => new Date(codigo.vence_en).getTime() - ahora());
  useEffect(() => {
    const reloj = setInterval(() => setRestante(new Date(codigo.vence_en).getTime() - ahora()), 1000);
    return () => clearInterval(reloj);
  }, [codigo, ahora]);
  const segundos = Math.max(0, Math.floor(restante / 1000));
  return (
    <div className="codigo-remoto">
      <p>
        Escribilo en el otro dispositivo con «agent-memory remote link &lt;código&gt; --nombre &lt;nombre&gt;». Sirve una
        sola vez y admite 5 intentos.
      </p>
      <p>
        <code aria-label="Código de enlace">{codigo.codigo}</code>
      </p>
      <p role="timer">
        {segundos > 0 ? `Vence en ${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}` : "Venció: generá otro"}
      </p>
    </div>
  );
}

function EditorAlcance({
  dispositivo,
  guardar,
  cancelar,
}: {
  dispositivo: Dispositivo;
  guardar: (ambitos: AmbitoAlcance[], noValidadas: boolean) => void;
  cancelar: () => void;
}) {
  const inicial = dispositivo.alcance.ambitos;
  const [global, setGlobal] = useState(inicial.some((a) => a.ambito === "global"));
  const [proyectos, setProyectos] = useState(lista(inicial, "proyecto"));
  const [repos, setRepos] = useState(lista(inicial, "repo"));
  const [noValidadas, setNoValidadas] = useState(dispositivo.alcance.no_validadas);

  function enviar() {
    const ambitos: AmbitoAlcance[] = [
      ...(global ? [{ ambito: "global" as const, ref: null }] : []),
      ...partir(proyectos).map((ref) => ({ ambito: "proyecto" as const, ref })),
      ...partir(repos).map((ref) => ({ ambito: "repo" as const, ref })),
    ];
    guardar(ambitos, noValidadas);
  }

  return (
    <fieldset aria-label={`Alcance de ${dispositivo.nombre}`}>
      <legend>Qué ve {dispositivo.nombre}</legend>
      <p>Nunca se comparten las rechazadas, las vencidas ni las reemplazadas.</p>
      <label className="casilla">
        <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />
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
        <input type="checkbox" checked={noValidadas} onChange={(e) => setNoValidadas(e.target.checked)} />
        Incluir las no validadas (pendientes y estado de proyecto)
      </label>
      <p>
        <button type="button" onClick={enviar}>
          Guardar alcance
        </button>{" "}
        <button type="button" onClick={cancelar}>
          Cancelar
        </button>
      </p>
    </fieldset>
  );
}

function RegistroRemoto({ cliente, dispositivos, version }: { cliente: Cliente; dispositivos: Dispositivo[]; version: unknown }) {
  const [filas, setFilas] = useState<Registro[]>([]);
  const [dispositivo, setDispositivo] = useState<string>("");
  const [soloRechazos, setSoloRechazos] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    cliente<{ registro: Registro[] }>("remoto_registro", {
      ...(dispositivo ? { dispositivo_id: Number(dispositivo) } : {}),
      ...(soloRechazos ? { solo_rechazos: true } : {}),
    })
      .then((r) => {
        if (vivo) setFilas(r.registro);
      })
      .catch((e: unknown) => {
        if (vivo) setError(mensajeError(e));
      });
    return () => {
      vivo = false;
    };
  }, [cliente, dispositivo, soloRechazos, version]);

  return (
    <>
      <h3>Registro de lecturas y rechazos</h3>
      <p>
        <label>
          Dispositivo{" "}
          <select value={dispositivo} onChange={(e) => setDispositivo(e.target.value)}>
            <option value="">todos</option>
            {dispositivos.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.nombre}
              </option>
            ))}
          </select>
        </label>{" "}
        <label className="casilla">
          <input type="checkbox" checked={soloRechazos} onChange={(e) => setSoloRechazos(e.target.checked)} />
          solo rechazos
        </label>
      </p>
      <Aviso texto={error} />
      {filas.length === 0 ? (
        <p>Sin registros.</p>
      ) : (
        <div className="tabla">
        <table aria-label="Registro remoto">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Dispositivo</th>
              <th>Herramienta</th>
              <th>Pedido</th>
              <th>Ids</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.id}>
                <td>{f.fecha.slice(0, 16).replace("T", " ")}</td>
                <td>{f.dispositivo ?? "—"}</td>
                <td>{f.herramienta}</td>
                <td>{f.pedido ?? "—"}</td>
                <td>{f.ids.length ? f.ids.join(", ") : "—"}</td>
                <td>{f.resultado === "lectura" ? "lectura" : `rechazo: ${f.motivo ?? "?"}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function resumenAlcance(a: Dispositivo["alcance"]): string {
  if (!a.ambitos.length) return "nada";
  const partes = a.ambitos.map((x) => (x.ambito === "global" ? "global" : `${x.ambito} ${x.ref}`));
  return `${partes.join(", ")}${a.no_validadas ? " (+ no validadas)" : ""}`;
}

function lista(ambitos: AmbitoAlcance[], tipo: "proyecto" | "repo"): string {
  return ambitos
    .filter((a) => a.ambito === tipo)
    .map((a) => a.ref)
    .join("\n");
}

function partir(texto: string): string[] {
  return [...new Set(texto.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
}
