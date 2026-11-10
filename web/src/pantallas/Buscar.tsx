import { useEffect, useState, type FormEvent } from "react";
import { AMBITOS, TIPOS, VALIDACIONES, mensajeError, type Cliente, type Entrada } from "../api";
import type { Navegar } from "../App";
import { Aviso, Estados, fecha } from "./comunes";

interface Filtros {
  ambito: string;
  tipo: string;
  validacion: string[];
  reemplazadas: boolean;
  vencidas: boolean;
}

const INICIALES: Filtros = { ambito: "", tipo: "", validacion: ["validada", "pendiente"], reemplazadas: false, vencidas: false };

/** Búsqueda con filtros de ámbito, tipo y estado (AC-10). Sin consulta, lista lo más reciente. */
export function Buscar({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [consulta, setConsulta] = useState("");
  const [filtros, setFiltros] = useState<Filtros>(INICIALES);
  const [entradas, setEntradas] = useState<Entrada[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegidas, setElegidas] = useState<number[]>([]);

  async function cargar(texto: string, f: Filtros) {
    setError(null);
    const cuerpo = {
      filtros: {
        todos_los_ambitos: true,
        ...(f.ambito ? { ambito: f.ambito } : {}),
        ...(f.tipo ? { tipos: [f.tipo] } : {}),
        // Sin ningún estado marcado no se filtra por estado: salen los tres, también las rechazadas.
        validacion: f.validacion.length ? f.validacion : [...VALIDACIONES],
        incluir_reemplazadas: f.reemplazadas,
        incluir_vencidas: f.vencidas,
      },
      limite: 100,
    };
    try {
      if (texto.trim()) {
        const r = await cliente<{ resultados: Entrada[]; aviso: string | null }>("buscar", { consulta: texto, ...cuerpo });
        setEntradas(r.resultados);
        setAviso(r.aviso);
      } else {
        const r = await cliente<{ entradas: Entrada[] }>("listar", cuerpo);
        setEntradas(r.entradas);
        setAviso(null);
      }
    } catch (e) {
      setError(mensajeError(e));
    }
  }

  useEffect(() => {
    void cargar("", INICIALES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function enviar(evento: FormEvent) {
    evento.preventDefault();
    void cargar(consulta, filtros);
  }

  function alternarValidacion(v: string) {
    setFiltros((f) => ({ ...f, validacion: f.validacion.includes(v) ? f.validacion.filter((x) => x !== v) : [...f.validacion, v] }));
  }

  function alternarElegida(id: number) {
    setElegidas((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  }

  return (
    <section aria-labelledby="titulo-buscar">
      <h2 id="titulo-buscar">Buscar</h2>
      <form className="filtros" onSubmit={enviar} role="search">
        <label>
          Consulta
          <input type="search" value={consulta} onChange={(e) => setConsulta(e.target.value)} placeholder="palabras, símbolo o sigla" />
        </label>
        <label>
          Ámbito
          <select value={filtros.ambito} onChange={(e) => setFiltros({ ...filtros, ambito: e.target.value })}>
            <option value="">todos</option>
            {AMBITOS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo
          <select value={filtros.tipo} onChange={(e) => setFiltros({ ...filtros, tipo: e.target.value })}>
            <option value="">todos</option>
            {TIPOS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Estado</legend>
          {VALIDACIONES.map((v) => (
            <label key={v} className="casilla">
              <input type="checkbox" checked={filtros.validacion.includes(v)} onChange={() => alternarValidacion(v)} />
              {v}
            </label>
          ))}
          <label className="casilla">
            <input type="checkbox" checked={filtros.reemplazadas} onChange={(e) => setFiltros({ ...filtros, reemplazadas: e.target.checked })} />
            reemplazadas
          </label>
          <label className="casilla">
            <input type="checkbox" checked={filtros.vencidas} onChange={(e) => setFiltros({ ...filtros, vencidas: e.target.checked })} />
            vencidas
          </label>
        </fieldset>
        <button type="submit">Buscar</button>
      </form>
      <Aviso texto={error} />
      <Aviso texto={aviso} tipo="ok" />
      {elegidas.length >= 2 && (
        <p className="barra">
          <button type="button" onClick={() => navegar({ tipo: "fusionar", ids: elegidas })}>
            Fusionar {elegidas.length} seleccionadas
          </button>
        </p>
      )}
      {entradas && entradas.length === 0 && <p>Sin resultados. Un vacío no prueba que no exista: probá otra consulta o filtro.</p>}
      {entradas && entradas.length > 0 && (
        <ul className="lista" aria-label="Resultados">
          {entradas.map((e) => (
            <li key={e.id}>
              <input
                type="checkbox"
                aria-label={`Elegir #${e.id} para fusionar`}
                checked={elegidas.includes(e.id)}
                disabled={e.vida !== "activa"}
                onChange={() => alternarElegida(e.id)}
              />
              <button type="button" className="enlace" onClick={() => navegar({ tipo: "detalle", id: e.id })}>
                #{e.id} · {e.titulo}
              </button>
              <span className="meta">
                {e.tipo} · {e.ambito}
                {e.ambito_ref ? ` (${e.ambito_ref})` : ""} · {fecha(e.actualizada_en)}
              </span>
              <Estados entrada={e} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
