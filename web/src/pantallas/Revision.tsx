import { useEffect, useState } from "react";
import { mensajeError, type Cliente, type Entrada } from "../api";
import type { Navegar } from "../App";
import { Aviso, Estados, fecha } from "./comunes";

type ParaRevisar = Entrada & {
  motivos: ("sin_uso" | "sin_verificar")[];
  mostrada_en: string | null;
  mostrada_veces: number;
  leida_en: string | null;
  leida_veces: number;
  verificada_en: string | null;
  validada_en: string | null;
};

const MOTIVOS = { sin_uso: "sin uso", sin_verificar: "sin verificar" } as const;

/**
 * Vista de revisión: lo que lleva tiempo sin uso o sin verificar. Desde aquí se confirma
 * que sigue vigente (queda la fecha), se caduca o se edita. Nada vence solo.
 */
export function Revision({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [entradas, setEntradas] = useState<ParaRevisar[] | null>(null);
  const [umbrales, setUmbrales] = useState<{ dias_sin_uso: number; dias_sin_verificar: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  async function cargar() {
    try {
      const r = await cliente<{ entradas: ParaRevisar[]; umbrales: { dias_sin_uso: number; dias_sin_verificar: number } }>("revision", {});
      setEntradas(r.entradas);
      setUmbrales(r.umbrales);
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function actuar(op: "confirmar_vigencia" | "caducar", id: number) {
    setError(null);
    setHecho(null);
    try {
      await cliente(op, { id });
      setHecho(op === "caducar" ? `#${id} caducada hoy` : `#${id} confirmada como vigente`);
      await cargar();
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  return (
    <section className="hoja" aria-labelledby="titulo-revision">
      <h2 id="titulo-revision">Revisión</h2>
      {umbrales && (
        <p className="meta">
          Entradas sin uso hace {umbrales.dias_sin_uso} días o sin verificar hace {umbrales.dias_sin_verificar}. Ninguna vence sola: vos
          decidís.
        </p>
      )}
      <Aviso texto={error} />
      <Aviso texto={hecho} tipo="ok" />
      {entradas && entradas.length === 0 && <p>Nada para revisar.</p>}
      {entradas?.map((e) => (
        <article key={e.id} className="tarjeta" aria-label={`Revisar #${e.id}`}>
          <h3>
            <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id: e.id })}>
              #{e.id} · {e.titulo}
            </button>
          </h3>
          <p className="meta">
            {e.motivos.map((m) => MOTIVOS[m]).join(" · ")} · leída {fecha(e.leida_en)} · mostrada en búsquedas {fecha(e.mostrada_en)} · verificada{" "}
            {fecha(e.verificada_en ?? e.validada_en)}
          </p>
          <Estados entrada={e} />
          <div className="acciones">
            <button type="button" onClick={() => void actuar("confirmar_vigencia", e.id)}>
              Sigue vigente
            </button>
            <button type="button" onClick={() => void actuar("caducar", e.id)}>
              Caducar hoy
            </button>
            <button type="button" onClick={() => navegar({ tipo: "detalle", id: e.id })}>
              Editar
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
