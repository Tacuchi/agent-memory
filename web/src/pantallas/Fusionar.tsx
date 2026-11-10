import { useEffect, useState, type FormEvent } from "react";
import { AMBITOS, TIPOS, mensajeError, type Cliente, type Entrada } from "../api";
import type { Navegar } from "../App";
import { Aviso, Estados } from "./comunes";

/** Fusión: la resultante nace validada por la web y las originales quedan reemplazadas. */
export function Fusionar({ ids, cliente, navegar }: { ids: number[]; cliente: Cliente; navegar: Navegar }) {
  const [originales, setOriginales] = useState<Entrada[]>([]);
  const [titulo, setTitulo] = useState("");
  const [contenido, setContenido] = useState("");
  const [tipo, setTipo] = useState("");
  const [ambito, setAmbito] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all(ids.map((id) => cliente<{ entrada: Entrada }>("leer", { id })))
      .then((rs) => {
        const es = rs.map((r) => r.entrada);
        const primera = es[0];
        setOriginales(es);
        if (!primera) return;
        setTitulo(primera.titulo);
        setContenido(es.map((e) => e.contenido ?? "").join("\n\n"));
        setTipo(primera.tipo);
        setAmbito(primera.ambito);
        setRef(primera.ambito_ref ?? "");
      })
      .catch((e: unknown) => setError(mensajeError(e)));
  }, [ids, cliente]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await cliente<{ entrada: Entrada }>("fusionar", {
        ids,
        titulo,
        contenido,
        tipo,
        ambito,
        ambito_ref: ambito === "global" ? null : ref,
      });
      navegar({ tipo: "detalle", id: r.entrada.id });
    } catch (err) {
      setError(mensajeError(err));
    }
  }

  return (
    <section aria-labelledby="titulo-fusionar">
      <h2 id="titulo-fusionar">Fusionar {ids.length} entradas</h2>
      <Aviso texto={error} />
      <ul className="lista" aria-label="Originales">
        {originales.map((o) => (
          <li key={o.id}>
            #{o.id} · {o.titulo} <Estados entrada={o} />
          </li>
        ))}
      </ul>
      <p>La entrada resultante nace validada y las originales quedan reemplazadas por ella, con su historia.</p>
      <form className="bloque" onSubmit={(e) => void enviar(e)} aria-label="Entrada resultante">
        <label>
          Título
          <input type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <label>
          Contenido
          <textarea rows={10} value={contenido} onChange={(e) => setContenido(e.target.value)} />
        </label>
        <label>
          Tipo
          <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {TIPOS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ámbito
          <select value={ambito} onChange={(e) => setAmbito(e.target.value)}>
            {AMBITOS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {ambito !== "global" && (
          <label>
            Referencia del {ambito}
            <input type="text" value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
        )}
        <button type="submit" disabled={originales.length < 2 || !titulo.trim() || !contenido.trim()}>
          Fusionar
        </button>
      </form>
    </section>
  );
}
