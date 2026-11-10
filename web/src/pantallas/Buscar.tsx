import { useEffect, useState, type FormEvent } from "react";
import { AMBITOS, TIPOS, VALIDACIONES, mensajeError, type Cliente, type Entrada } from "../api";
import type { Navegar } from "../App";
import { mover, useAtajos } from "../teclado";
import { Aviso, Estados, claseValidacion, fecha, lugar } from "./comunes";

interface Filtros {
  ambito: string;
  tipo: string;
  validacion: string[];
  reemplazadas: boolean;
  vencidas: boolean;
}

const INICIALES: Filtros = { ambito: "", tipo: "", validacion: ["validada", "pendiente"], reemplazadas: false, vencidas: false };

/** Búsqueda con filtros de ámbito, tipo y estado. Sin consulta, lista lo más reciente. */
export function Buscar({ cliente, navegar }: { cliente: Cliente; navegar: Navegar }) {
  const [consulta, setConsulta] = useState("");
  const [filtros, setFiltros] = useState<Filtros>(INICIALES);
  const [entradas, setEntradas] = useState<Entrada[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegidas, setElegidas] = useState<number[]>([]);
  const [foco, setFoco] = useState(0);
  const [previa, setPrevia] = useState<Entrada | null>(null);

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
        setFoco(0);
        setAviso(r.aviso);
      } else {
        const r = await cliente<{ entradas: Entrada[] }>("listar", cuerpo);
        setEntradas(r.entradas);
        setFoco(0);
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

  const indice = Math.min(foco, Math.max(0, (entradas?.length ?? 1) - 1));
  const enfocada = entradas?.[indice] ?? null;

  // La vista previa lee la entrada enfocada completa: el listado no trae el contenido.
  useEffect(() => {
    if (!enfocada) {
      setPrevia(null);
      return;
    }
    let vigente = true;
    cliente<{ entrada: Entrada }>("leer", { id: enfocada.id })
      .then((r) => vigente && setPrevia(r.entrada))
      .catch((e: unknown) => vigente && setError(mensajeError(e)));
    return () => {
      vigente = false;
    };
  }, [cliente, enfocada?.id]);

  useAtajos({
    j: () => setFoco(mover(indice, 1, entradas?.length ?? 0)),
    k: () => setFoco(mover(indice, -1, entradas?.length ?? 0)),
    x: () => (enfocada && enfocada.vida === "activa" ? alternarElegida(enfocada.id) : false),
    Enter: () => (enfocada ? navegar({ tipo: "detalle", id: enfocada.id }) : false),
  });

  return (
    <div className="tablero buscar">
      <section className="columna col-estado" aria-labelledby="titulo-buscar">
        <h2 id="titulo-buscar" className="ph">Buscar</h2>
        <form className="filtros" onSubmit={enviar} role="search">
          <label>
            Consulta
            <input id="consulta" type="search" value={consulta} onChange={(e) => setConsulta(e.target.value)} placeholder="palabras, símbolo o sigla" />
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
          <button type="submit" className="primario">Buscar</button>
        </form>
      </section>

      <section className="columna" aria-labelledby="titulo-resultados">
        <h2 id="titulo-resultados" className="ph">
          Resultados <span className="num">{entradas?.length ?? ""}</span>
        </h2>
        {(error || aviso || elegidas.length >= 2) && (
          <div className="cuerpo">
            <Aviso texto={error} />
            <Aviso texto={aviso} tipo="ok" />
            {elegidas.length >= 2 && (
              <p className="barra-accion">
                <button type="button" onClick={() => navegar({ tipo: "fusionar", ids: elegidas })}>
                  Fusionar {elegidas.length} seleccionadas
                </button>
              </p>
            )}
          </div>
        )}
        {entradas && entradas.length === 0 && (
          <div className="vacio">
            <p>Sin resultados.</p>
            <span>Un vacío no prueba que no exista: probá otra consulta o filtro.</span>
          </div>
        )}
        {entradas && entradas.length > 0 && (
          <ul className="lista desplaza" aria-label="Resultados">
            {entradas.map((e, i) => (
              <li key={e.id} className={`fila${i === indice ? " enfocada" : ""}`} aria-current={i === indice ? "true" : undefined} onMouseDown={() => setFoco(i)}>
                <input
                  type="checkbox"
                  aria-label={`Elegir #${e.id} para fusionar`}
                  checked={elegidas.includes(e.id)}
                  disabled={e.vida !== "activa"}
                  onChange={() => alternarElegida(e.id)}
                />
                <span className={`punto ${claseValidacion(e)}`} aria-hidden="true" />
                <button type="button" className="enlace titulo" onFocus={() => setFoco(i)} onClick={() => navegar({ tipo: "detalle", id: e.id })}>
                  #{e.id} · {e.titulo}
                </button>
                <span className="lateral">{fecha(e.actualizada_en)}</span>
                <span className="extracto">
                  {lugar(e)} · <Estados entrada={e} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="columna previa-col" aria-labelledby="titulo-previa">
        <h2 id="titulo-previa" className="ph">
          Vista previa {enfocada && <span className="num">#{enfocada.id}</span>}
        </h2>
        {previa && enfocada && previa.id === enfocada.id ? (
          <div className="previa">
            <h3>{previa.titulo}</h3>
            <p className="meta">
              <Estados entrada={previa} /> · {lugar(previa)} · <span className="num">{fecha(previa.actualizada_en)}</span>
            </p>
            <pre className="contenido">{previa.contenido}</pre>
            <div className="acciones">
              <button type="button" onClick={() => navegar({ tipo: "detalle", id: previa.id })}>
                Abrir detalle <span className="kbd" aria-hidden="true">↵</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="vacio">{entradas?.length === 0 ? "Nada que previsualizar." : "Cargando…"}</div>
        )}
      </section>
    </div>
  );
}
