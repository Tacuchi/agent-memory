import { useEffect, useState } from "react";
import { mensajeError, type Cliente } from "../../api";
import { Aviso } from "../comunes";
import { fechaHora } from "./comun";
import type { Dispositivo, Registro } from "./tipos";

// Registro de lecturas y rechazos: plegado, con el resumen de hoy en su línea (AC-15). Al desplegarlo, la tabla con
// sus filtros de siempre.

function useRegistro(cliente: Cliente, filtro: object | null, version: unknown) {
  const [filas, setFilas] = useState<Registro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clave = JSON.stringify(filtro);
  useEffect(() => {
    if (filtro === null) return;
    let vivo = true;
    cliente<{ registro: Registro[] }>("remoto_registro", filtro)
      .then((r) => vivo && (setFilas(r.registro), setError(null)))
      .catch((e: unknown) => vivo && setError(mensajeError(e)));
    return () => {
      vivo = false;
    };
    // El filtro se compara por su forma, no por identidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliente, clave, version]);
  return { filas, error };
}

function mismoDia(iso: string, ahora: number): boolean {
  return new Date(iso).toDateString() === new Date(ahora).toDateString();
}

export function RegistroRemoto({
  cliente,
  dispositivos,
  version,
  ahora,
}: {
  cliente: Cliente;
  dispositivos: Dispositivo[];
  version: unknown;
  ahora: () => number;
}) {
  const [abierto, setAbierto] = useState(false);
  const [dispositivo, setDispositivo] = useState("");
  const [soloRechazos, setSoloRechazos] = useState(false);
  const resumen = useRegistro(cliente, {}, version);
  const tabla = useRegistro(
    cliente,
    abierto && (dispositivo || soloRechazos)
      ? { ...(dispositivo ? { dispositivo_id: Number(dispositivo) } : {}), ...(soloRechazos ? { solo_rechazos: true } : {}) }
      : null,
    version,
  );
  const filtrado = dispositivo !== "" || soloRechazos;
  const filas = filtrado ? tabla.filas : resumen.filas;
  const hoy = (resumen.filas ?? []).filter((f) => mismoDia(f.fecha, ahora()));
  const lecturas = hoy.filter((f) => f.resultado === "lectura").length;
  const rechazos = hoy.length - lecturas;

  return (
    <section className="seccion-remota" aria-labelledby="titulo-registro">
      <details className="registro" open={abierto}>
        <summary
          onClick={(e) => {
            e.preventDefault();
            setAbierto(!abierto);
          }}
        >
          <h3 id="titulo-registro">Registro</h3>
          <span className="resumen-hoy">
            hoy: <span className="num">{lecturas}</span> {lecturas === 1 ? "lectura" : "lecturas"} ·{" "}
            <span className={`num${rechazos ? " con-rechazos" : ""}`}>{rechazos}</span> {rechazos === 1 ? "rechazo" : "rechazos"}
          </span>
        </summary>
        <div className="registro-cuerpo">
          <div className="filtros-registro">
            <label>
              PC
              <select value={dispositivo} onChange={(e) => setDispositivo(e.target.value)}>
                <option value="">todas</option>
                {dispositivos.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label className="casilla">
              <input type="checkbox" checked={soloRechazos} onChange={(e) => setSoloRechazos(e.target.checked)} />
              solo rechazos
            </label>
          </div>
          <Aviso texto={(filtrado ? tabla.error : null) ?? resumen.error} />
          {filas && filas.length === 0 && <p className="vacio">Sin registros.</p>}
          {filas && filas.length > 0 && (
            <div className="tabla">
              <table aria-label="Registro remoto">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>PC</th>
                    <th>Herramienta</th>
                    <th>Pedido</th>
                    <th>Ids</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.id}>
                      <td className="num">{fechaHora(f.fecha)}</td>
                      <td>{f.dispositivo ?? "—"}</td>
                      <td>{f.herramienta}</td>
                      <td className="pedido">{f.pedido ?? "—"}</td>
                      <td className="num">{f.ids.length ? f.ids.join(", ") : "—"}</td>
                      <td className={f.resultado === "rechazo" ? "rechazo" : undefined}>
                        {f.resultado === "lectura" ? "lectura" : `rechazo: ${f.motivo ?? "?"}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
