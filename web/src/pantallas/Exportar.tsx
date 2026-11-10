import { useState } from "react";
import { mensajeError, type Cliente } from "../api";
import { Aviso } from "./comunes";

/** Exportación desde la web: la escribe el servicio en una carpeta nueva con fecha. */
export function Exportar({ cliente }: { cliente: Cliente }) {
  const [completa, setCompleta] = useState(false);
  const [hecho, setHecho] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportar() {
    setError(null);
    setHecho(null);
    try {
      const r = await cliente<{ destino: string; archivos: number }>("exportar", completa ? { completa: true } : {});
      setHecho(`${r.archivos} entradas exportadas en ${r.destino}`);
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  return (
    <section className="hoja" aria-labelledby="titulo-exportar">
      <h2 id="titulo-exportar">Exportar</h2>
      <p>Un archivo markdown por entrada, con sus estados en la cabecera; se lee sin el servicio.</p>
      <label className="casilla">
        <input type="checkbox" checked={completa} onChange={(e) => setCompleta(e.target.checked)} />
        completa: todas las entradas con su historia
      </label>
      <p>
        <button type="button" onClick={() => void exportar()}>
          Exportar
        </button>
      </p>
      <Aviso texto={error} />
      <Aviso texto={hecho} tipo="ok" />
    </section>
  );
}
