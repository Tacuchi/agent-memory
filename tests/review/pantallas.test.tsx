import "../web/dom";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "../web/ayuda";

// Vista de revisión en la web: lista con su motivo y permite confirmar, caducar o ir a editar.

const DIA = 86_400_000;
let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  w = montarWeb();
});
afterEach(() => w.cerrar());

const irA = (nombre: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: nombre }));

describe("vista de revisión", () => {
  it("confirma vigencia, caduca o lleva a editar", async () => {
    const ids: number[] = [];
    for (const titulo of ["Uno", "Dos", "Tres"]) {
      ids.push((await w.comoPersona<any>("crear", { tipo: "leccion", titulo, contenido: titulo, ambito: "global" })).entrada.id);
    }
    w.t.avanzar(200 * DIA);
    w.vista();
    irA("Revisión");
    expect(await screen.findByText(/sin uso hace 90 días o sin verificar hace 180/)).toBeTruthy();
    const [uno, dos, tres] = ids as [number, number, number];
    const t1 = await screen.findByRole("article", { name: `Revisar #${uno}` });
    expect(within(t1).getByText(/sin uso · sin verificar/)).toBeTruthy();

    fireEvent.click(within(t1).getByRole("button", { name: "Sigue vigente" }));
    await screen.findByText(`#${uno} confirmada como vigente`);
    expect(w.t.store.obtener(uno).verificadaEn).toBe(w.t.store.ahora().toISOString());
    expect(screen.queryByRole("article", { name: `Revisar #${uno}` })).toBeNull();

    fireEvent.click(within(screen.getByRole("article", { name: `Revisar #${dos}` })).getByRole("button", { name: "Caducar hoy" }));
    await screen.findByText(`#${dos} caducada hoy`);
    expect(w.t.store.obtener(dos).vigenciaHasta).toBe("2027-05-28");

    fireEvent.click(within(screen.getByRole("article", { name: `Revisar #${tres}` })).getByRole("button", { name: "Editar" }));
    expect(await screen.findByRole("form", { name: "Editar" })).toBeTruthy();
    expect(w.t.store.obtener(tres).vida).toBe("activa");
  });
});

describe("exportar desde la web", () => {
  it("exporta las activas o la completa y muestra dónde quedaron", async () => {
    w.cerrar();
    const { dirTemporal } = await import("../helpers/temp");
    const destino = dirTemporal("agent-memory-export-");
    w = montarWeb({ dirExportaciones: destino.dir });
    try {
      await w.comoPersona("crear", { tipo: "leccion", titulo: "Para exportar", contenido: "c", ambito: "global" });
      w.vista();
      irA("Exportar");
      fireEvent.click(screen.getByRole("checkbox", { name: /completa/ }));
      fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Exportar" }));
      expect((await screen.findByText(/1 entradas exportadas en /)).textContent).toContain(destino.dir);
    } finally {
      destino.limpiar();
    }
  });
});
