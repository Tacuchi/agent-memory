import { useState } from "react";
import type { Cliente } from "./api";
import { Bandeja } from "./pantallas/Bandeja";
import { Buscar } from "./pantallas/Buscar";
import { Detalle } from "./pantallas/Detalle";
import { Exportar } from "./pantallas/Exportar";
import { Fusionar } from "./pantallas/Fusionar";
import { Remoto } from "./pantallas/Remoto";
import { Revision } from "./pantallas/Revision";

export type Vista =
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

const PESTANAS: { tipo: Vista["tipo"]; etiqueta: string }[] = [
  { tipo: "buscar", etiqueta: "Buscar" },
  { tipo: "bandeja", etiqueta: "Pendientes" },
  { tipo: "revision", etiqueta: "Revisión" },
  { tipo: "exportar", etiqueta: "Exportar" },
  { tipo: "remoto", etiqueta: "Acceso remoto" },
];

/** `agent-memory remote code` entra por `/#remoto`; lo demás arranca en Buscar. */
function vistaInicial(): Vista {
  return typeof location !== "undefined" && location.hash === "#remoto" ? { tipo: "remoto" } : { tipo: "buscar" };
}

export function App({ cliente }: { cliente: Cliente }) {
  const [vista, setVista] = useState<Vista>(vistaInicial);
  return (
    <div className="app">
      <header className="cabecera">
        <h1>agent-memory</h1>
        <nav aria-label="Secciones">
          {PESTANAS.map((p) => (
            <button
              key={p.tipo}
              type="button"
              className={vista.tipo === p.tipo ? "pestana activa" : "pestana"}
              aria-current={vista.tipo === p.tipo ? "page" : undefined}
              onClick={() => setVista({ tipo: p.tipo } as Vista)}
            >
              {p.etiqueta}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {vista.tipo === "buscar" && <Buscar cliente={cliente} navegar={setVista} />}
        {vista.tipo === "detalle" && <Detalle key={vista.id} id={vista.id} cliente={cliente} navegar={setVista} />}
        {vista.tipo === "bandeja" && <Bandeja cliente={cliente} navegar={setVista} />}
        {vista.tipo === "revision" && <Revision cliente={cliente} navegar={setVista} />}
        {vista.tipo === "exportar" && <Exportar cliente={cliente} />}
        {vista.tipo === "remoto" && <Remoto cliente={cliente} />}
        {vista.tipo === "fusionar" && <Fusionar ids={vista.ids} cliente={cliente} navegar={setVista} />}
      </main>
    </div>
  );
}
