import type { Cliente } from "../../api";
import { Aviso, fecha } from "../comunes";
import { useAccion } from "./comun";
import type { CodigoNuevo, PedidoPanel } from "./tipos";

// Pedidos hechos desde el panel del relé que amplían el acceso: nada cambia hasta que la persona los acepta (D01 de
// la spec 005). La sección solo aparece cuando hay alguno.

export function Pedidos({
  pedidos,
  cliente,
  recargar,
  alCodigo,
}: {
  pedidos: PedidoPanel[];
  cliente: Cliente;
  recargar: () => Promise<void>;
  alCodigo: (c: CodigoNuevo) => void;
}) {
  const accion = useAccion(recargar);
  if (!pedidos.length && !accion.error && !accion.hecho) return null;

  function resolver(p: PedidoPanel, aceptar: boolean) {
    void accion.ejecutar(
      async () => {
        const r = await cliente<{ codigo?: CodigoNuevo }>("remoto_pendiente", { id: p.id, aceptar });
        if (r.codigo) alCodigo(r.codigo);
      },
      `${aceptar ? "Aceptado" : "Rechazado"}: ${textoPedido(p)}${aceptar && p.accion === "codigo" ? "; el código está en «Leen esta memoria»" : ""}`,
    );
  }

  return (
    <section className="seccion-remota" aria-labelledby="titulo-pedidos">
      <header className="ph">
        <h3 id="titulo-pedidos">
          Pedidos del panel <span className="num cuenta pendiente">{pedidos.length || ""}</span>
        </h3>
      </header>
      {pedidos.length > 0 && (
        <>
          <p className="nota">Desde el panel del relé se pidió ampliar el acceso; nada cambia hasta que lo aceptes acá.</p>
          <ul className="pedidos-panel" aria-label="Pedidos del panel">
            {pedidos.map((p) => (
              <li key={p.id}>
                <span>
                  {p.accion === "alcance" ? (
                    <>
                      Cambiar el alcance de {nombreDispositivo(p)} a <ChipsPedido datos={p.datos} />
                    </>
                  ) : (
                    textoPedido(p)
                  )}{" "}
                  <span className="pedido-fecha num">· {fecha(p.creado_en)}</span>
                </span>
                <span className="pedido-acciones">
                  <button type="button" className="primario" disabled={accion.ocupado} aria-label={`Aceptar: ${textoPedido(p)}`} onClick={() => resolver(p, true)}>
                    Aceptar
                  </button>
                  <button type="button" className="peligro" disabled={accion.ocupado} aria-label={`Rechazar: ${textoPedido(p)}`} onClick={() => resolver(p, false)}>
                    Rechazar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="franja-avisos">
        <Aviso texto={accion.error} />
        <Aviso texto={accion.hecho} tipo="ok" />
      </div>
    </section>
  );
}

function nombreDispositivo(p: PedidoPanel): string {
  return p.dispositivo?.nombre ?? "una PC";
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

function ChipsPedido({ datos }: { datos: PedidoPanel["datos"] }) {
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
