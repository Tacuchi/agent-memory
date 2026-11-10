import { useCallback, useEffect, useState } from "react";
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

interface Estado {
  interruptor: boolean;
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

export function Remoto({ cliente, ahora = () => Date.now() }: { cliente: Cliente; ahora?: () => number }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [codigo, setCodigo] = useState<{ codigo: string; vence_en: string } | null>(null);
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
      <section aria-labelledby="titulo-remoto">
        <h2 id="titulo-remoto">Acceso remoto</h2>
        <Aviso texto={error} />
        {!error && <p>Cargando…</p>}
      </section>
    );
  }

  const enEdicion = estado.dispositivos.find((d) => d.id === editando) ?? null;

  return (
    <section aria-labelledby="titulo-remoto">
      <h2 id="titulo-remoto">Acceso remoto</h2>
      <p>
        Otra instalación tuya puede leer (nunca escribir) lo que elijas compartir de esta memoria, a través de un relé que
        solo ve datos cifrados. Viene apagado.
      </p>
      <p>
        Relé: {estado.rele ? <code>{estado.rele.url}</code> : <>sin configurar: corré «agent-memory remote relay &lt;url&gt;»</>}
      </p>
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
