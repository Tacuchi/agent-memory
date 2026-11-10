import { useCallback, useEffect, useRef, useState } from "react";
import type { Cliente } from "./api";
import { Bandeja } from "./pantallas/Bandeja";
import { Buscar } from "./pantallas/Buscar";
import { Detalle } from "./pantallas/Detalle";
import { Exportar } from "./pantallas/Exportar";
import { Fusionar } from "./pantallas/Fusionar";
import { Remoto } from "./pantallas/Remoto";
import { Resumen } from "./pantallas/Resumen";
import { Revision } from "./pantallas/Revision";
import { HojaInferior, useEsMovil } from "./movil";
import { useAtajos } from "./teclado";

export type Vista =
  | { tipo: "resumen" }
  | { tipo: "buscar" }
  | { tipo: "detalle"; id: number }
  | { tipo: "bandeja" }
  | { tipo: "fusionar"; ids: number[] }
  | { tipo: "revision" }
  | { tipo: "exportar" }
  | { tipo: "remoto" };

export interface Navegar {
  (vista: Vista): void;
}

type Pestana = "resumen" | "bandeja" | "buscar" | "revision" | "exportar" | "remoto";

const PESTANAS: { tipo: Pestana; etiqueta: string; hash: string }[] = [
  { tipo: "resumen", etiqueta: "Resumen", hash: "#resumen" },
  { tipo: "bandeja", etiqueta: "Pendientes", hash: "#pendientes" },
  { tipo: "buscar", etiqueta: "Buscar", hash: "#buscar" },
  { tipo: "revision", etiqueta: "Revisión", hash: "#revision" },
  { tipo: "exportar", etiqueta: "Exportar", hash: "#exportar" },
  { tipo: "remoto", etiqueta: "Acceso remoto", hash: "#remoto" },
];

const ATAJOS_GLOBALES: [string, string][] = [
  ["/", "buscar"],
  ["g r", "ir a Resumen"],
  ["g p", "ir a Pendientes"],
  ["g b", "ir a Buscar"],
  ["g v", "ir a Revisión"],
  ["?", "mostrar u ocultar los atajos"],
];
const ATAJOS_LISTAS: [string, string][] = [
  ["j  k", "bajar y subir en la lista"],
  ["↵", "abrir el detalle"],
  ["a", "aprobar la enfocada"],
  ["r", "escribir el motivo y rechazar"],
  ["x", "marcar la enfocada"],
  ["esc", "salir de un campo"],
];

/** Cada vista tiene su dirección: recargar o volver atrás no pierde la pantalla. */
function aHash(vista: Vista): string {
  if (vista.tipo === "detalle") return `#detalle/${vista.id}`;
  if (vista.tipo === "fusionar") return `#fusionar/${vista.ids.join(",")}`;
  return PESTANAS.find((p) => p.tipo === vista.tipo)?.hash ?? "#resumen";
}

function deHash(hash: string): Vista {
  const [ruta, dato] = hash.replace(/^#/, "").split("/");
  if (ruta === "detalle" && Number(dato) > 0) return { tipo: "detalle", id: Number(dato) };
  if (ruta === "fusionar" && dato) {
    const ids = dato.split(",").map(Number).filter((n) => n > 0);
    if (ids.length >= 2) return { tipo: "fusionar", ids };
  }
  const pestana = PESTANAS.find((p) => p.hash === `#${ruta}`);
  return pestana ? ({ tipo: pestana.tipo } as Vista) : { tipo: "resumen" };
}

function hashActual(): string {
  return typeof location === "undefined" ? "" : location.hash;
}

interface Conteos {
  pendientes: number | null;
  revisar: number | null;
}

export function App({ cliente }: { cliente: Cliente }) {
  const [vista, setVista] = useState<Vista>(() => deHash(hashActual()));
  const [conteos, setConteos] = useState<Conteos>({ pendientes: null, revisar: null });
  const [verAtajos, setVerAtajos] = useState(false);
  const [verMas, setVerMas] = useState(false);
  const esMovil = useEsMovil();
  const esperandoG = useRef<number | null>(null);

  const navegar = useCallback<Navegar>((destino) => {
    setVista(destino);
    const hash = aHash(destino);
    if (hashActual() !== hash) history.pushState(null, "", hash);
    window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    const alCambiar = () => setVista(deHash(hashActual()));
    window.addEventListener("popstate", alCambiar);
    window.addEventListener("hashchange", alCambiar);
    return () => {
      window.removeEventListener("popstate", alCambiar);
      window.removeEventListener("hashchange", alCambiar);
    };
  }, []);

  // Los conteos de las pestañas se refrescan al cambiar de pantalla. Si fallan quedan los
  // anteriores: cada pantalla muestra su propio error al cargar sus datos.
  useEffect(() => {
    let vigente = true;
    void Promise.allSettled([
      cliente<{ entradas: unknown[] }>("pendientes", {}),
      cliente<{ entradas: unknown[] }>("revision", {}),
    ]).then(([p, r]) => {
      if (!vigente) return;
      setConteos((c) => ({
        pendientes: p.status === "fulfilled" ? p.value.entradas.length : c.pendientes,
        revisar: r.status === "fulfilled" ? r.value.entradas.length : c.revisar,
      }));
    });
    return () => {
      vigente = false;
    };
  }, [cliente, vista]);

  const irA = (tipo: Pestana) => () => navegar({ tipo } as Vista);
  const conG: Record<string, () => void> = { r: irA("resumen"), p: irA("bandeja"), b: irA("buscar"), v: irA("revision") };

  useAtajos({
    "?": () => setVerAtajos((v) => !v),
    "/": () => {
      if (vista.tipo !== "buscar") navegar({ tipo: "buscar" });
      requestAnimationFrame(() => document.getElementById("consulta")?.focus());
    },
    g: () => {
      esperandoG.current = window.setTimeout(() => (esperandoG.current = null), 1200);
    },
    ...Object.fromEntries(
      Object.entries(conG).map(([tecla, accion]) => [
        tecla,
        () => {
          if (esperandoG.current === null) return false;
          window.clearTimeout(esperandoG.current);
          esperandoG.current = null;
          accion();
        },
      ]),
    ),
  }, { primero: true });

  const cuenta = (tipo: Pestana) => {
    // El conteo describe la pestaña sin cambiar su nombre: «Pendientes», descrita como «3».
    if (tipo === "bandeja" && conteos.pendientes) return <span id="cuenta-bandeja" aria-hidden="true" className="cuenta pendiente">{conteos.pendientes}</span>;
    if (tipo === "revision" && conteos.revisar) return <span id="cuenta-revision" aria-hidden="true" className="cuenta revisar">{conteos.revisar}</span>;
    return null;
  };

  return (
    <div className={esMovil ? "app app-movil" : "app"}>
      <header className="barra">
        <h1 className="marca">agent-memory</h1>
        {!esMovil && (
        <nav aria-label="Secciones">
          {PESTANAS.map((p) => (
            <button
              key={p.tipo}
              type="button"
              className={vista.tipo === p.tipo ? "pestana activa" : "pestana"}
              aria-current={vista.tipo === p.tipo ? "page" : undefined}
              aria-describedby={cuenta(p.tipo) ? `cuenta-${p.tipo}` : undefined}
              onClick={() => navegar({ tipo: p.tipo } as Vista)}
            >
              {p.etiqueta}
              {cuenta(p.tipo)}
            </button>
          ))}
        </nav>
        )}
        {!esMovil && (
        <button type="button" className="atajos-boton" aria-expanded={verAtajos} onClick={() => setVerAtajos((v) => !v)}>
          Atajos <span className="kbd" aria-hidden="true">?</span>
        </button>
        )}
      </header>
      {verAtajos && (
        <section className="panel-atajos" aria-label="Atajos de teclado">
          <dl>
            {[...ATAJOS_GLOBALES, ...ATAJOS_LISTAS].map(([tecla, uso]) => (
              <div key={tecla}>
                <dt>
                  {tecla.split(" ").filter(Boolean).map((t) => (
                    <span key={t} className="kbd" style={{ marginRight: 4 }}>
                      {t}
                    </span>
                  ))}
                </dt>
                <dd>{uso}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <main>
        {vista.tipo === "resumen" && <Resumen cliente={cliente} navegar={navegar} />}
        {vista.tipo === "buscar" && <Buscar cliente={cliente} navegar={navegar} />}
        {vista.tipo === "detalle" && <Detalle key={vista.id} id={vista.id} cliente={cliente} navegar={navegar} />}
        {vista.tipo === "bandeja" && <Bandeja cliente={cliente} navegar={navegar} />}
        {vista.tipo === "revision" && <Revision cliente={cliente} navegar={navegar} />}
        {vista.tipo === "exportar" && <Exportar cliente={cliente} />}
        {vista.tipo === "remoto" && <Remoto cliente={cliente} />}
        {vista.tipo === "fusionar" && <Fusionar ids={vista.ids} cliente={cliente} navegar={navegar} />}
      </main>
      {esMovil && (
        <nav className="nav-movil" aria-label="Secciones">
          <button type="button" aria-current={vista.tipo === "resumen" ? "page" : undefined} onClick={() => navegar({ tipo: "resumen" })}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="12" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="12" width="7" height="7" rx="1.5" /><rect x="12" y="12" width="7" height="7" rx="1.5" /></svg>
            Resumen
          </button>
          <button type="button" aria-current={vista.tipo === "bandeja" ? "page" : undefined} onClick={() => navegar({ tipo: "bandeja" })}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h14M4 11h14M4 16h9" /></svg>
            <span>Pendientes {conteos.pendientes ? <span className="cuenta pendiente">{conteos.pendientes}</span> : null}</span>
          </button>
          <button type="button" aria-current={vista.tipo === "buscar" ? "page" : undefined} onClick={() => navegar({ tipo: "buscar" })}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="M14.5 14.5l4 4" /></svg>
            Buscar
          </button>
          <button
            type="button"
            aria-current={["revision", "exportar", "remoto"].includes(vista.tipo) ? "page" : undefined}
            aria-expanded={verMas}
            onClick={() => setVerMas(true)}
          >
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="5" cy="11" r="1.4" /><circle cx="11" cy="11" r="1.4" /><circle cx="17" cy="11" r="1.4" /></svg>
            Más
          </button>
        </nav>
      )}
      {esMovil && verMas && (
        <HojaInferior etiqueta="Más secciones" cerrar={() => setVerMas(false)}>
          <div className="mas-lista">
            {(
              [
                ["revision", "Revisión"],
                ["exportar", "Exportar"],
                ["remoto", "Acceso remoto"],
              ] as const
            ).map(([tipo, etiqueta]) => (
              <button
                key={tipo}
                type="button"
                onClick={() => {
                  setVerMas(false);
                  navegar({ tipo });
                }}
              >
                {etiqueta}
                {tipo === "revision" && conteos.revisar ? <span className="cuenta revisar">{conteos.revisar}</span> : null}
              </button>
            ))}
          </div>
        </HojaInferior>
      )}
    </div>
  );
}
