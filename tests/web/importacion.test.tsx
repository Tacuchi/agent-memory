import "./dom";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bandeja } from "../../web/src/pantallas/Bandeja";
import { dirTemporal } from "../helpers/temp";
import { entradaMd, manifestPara, zipCrudo } from "../helpers/zip";
import { montarWeb } from "./ayuda";

// La bandeja muestra la importación de cada pendiente importada, filtra por importación y desde ahí aprueba o
// rechaza todas sus pendientes.

let w: ReturnType<typeof montarWeb>;
let tmp: ReturnType<typeof dirTemporal>;
beforeEach(() => {
  w = montarWeb();
  tmp = dirTemporal("agent-memory-web-importacion-");
});
afterEach(() => {
  w.cerrar();
  tmp.limpiar();
});

/** Importa un zip de dos entradas, crea las dos y una pendiente propia del agente. */
async function preparar() {
  const rutas = ["entradas/00001-e.md", "entradas/00002-e.md"];
  const ruta = join(tmp.dir, "equipo.zip");
  writeFileSync(
    ruta,
    zipCrudo([
      { nombre: "manifest.json", datos: manifestPara(rutas) },
      { nombre: rutas[0] as string, datos: entradaMd(1, "Importada uno", "uno") },
      { nombre: rutas[1] as string, datos: entradaMd(2, "Importada dos", "dos") },
    ]),
  );
  const imp = (await w.comoAgente<{ importacion: number }>("importar", { ruta, ambito: { ambito: "global", ref: null } })).importacion;
  const uno = (await w.comoAgente("resolver_importacion", { importacion: imp, entrada: 1, accion: "crear" })).creada.id as number;
  const dos = (await w.comoAgente("resolver_importacion", { importacion: imp, entrada: 2, accion: "crear" })).creada.id as number;
  const propia = (await w.comoAgente("crear", { tipo: "leccion", titulo: "Propia del agente", contenido: "p", ambito: "global" })).entrada.id as number;
  render(<Bandeja cliente={w.cliente} navegar={() => {}} />);
  await screen.findAllByRole("article");
  return { imp, uno, dos, propia };
}

describe("bandeja por importación", () => {
  it("la fila y la vista previa muestran la importación; el filtro deja solo las suyas y se aprueban juntas", async () => {
    const { imp, uno, dos, propia } = await preparar();
    const fila = screen.getByRole("article", { name: `Pendiente #${uno}` });
    expect(within(fila).getByText(new RegExp(`^Importación ${imp} · equipo\\.zip · \\d{4}-\\d{2}-\\d{2}$`))).toBeTruthy();
    expect(within(screen.getByRole("article", { name: `Pendiente #${propia}` })).queryByText(/Importación/)).toBeNull();
    fireEvent.click(within(fila).getByRole("button", { name: "Importada uno" }));
    expect(within(screen.getByRole("region", { name: "Vista previa" })).getByText(new RegExp(`^Importación ${imp} · equipo\\.zip`))).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Importación"), { target: { value: String(imp) } });
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label")).sort()).toEqual([`Pendiente #${uno}`, `Pendiente #${dos}`].sort());
    const grupo = within(screen.getByRole("group", { name: `Importación ${imp}` }));
    fireEvent.click(grupo.getByRole("button", { name: "Aprobar importación" }));
    await waitFor(() => expect(w.t.store.obtener(dos).validacion).toBe("validada"));
    expect(w.t.store.obtener(uno)).toMatchObject({ validacion: "validada", validacionVia: "web" });
    expect(w.t.store.obtener(propia).validacion).toBe("pendiente");
  });

  it("rechazar la importación exige motivo y rechaza todas sus pendientes de una vez", async () => {
    const { imp, uno, dos, propia } = await preparar();
    fireEvent.change(screen.getByLabelText("Importación"), { target: { value: String(imp) } });
    const grupo = within(screen.getByRole("group", { name: `Importación ${imp}` }));
    const rechazar = grupo.getByRole("button", { name: "Rechazar importación" }) as HTMLButtonElement;
    expect(rechazar.disabled).toBe(true);
    fireEvent.change(grupo.getByLabelText("Motivo del rechazo de la importación"), { target: { value: "   " } });
    expect(rechazar.disabled).toBe(true);
    expect(w.llamadas).not.toContain("rechazar_importacion");

    fireEvent.change(grupo.getByLabelText("Motivo del rechazo de la importación"), { target: { value: "no aplica" } });
    fireEvent.click(rechazar);
    expect(await screen.findByText(`Importación ${imp} rechazada: 2 pendientes rechazadas y 0 en espera descartadas.`)).toBeTruthy();
    for (const id of [uno, dos]) expect(w.t.store.obtener(id)).toMatchObject({ validacion: "rechazada", motivoRechazo: "no aplica" });
    expect(w.t.store.obtener(propia).validacion).toBe("pendiente");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([`Pendiente #${propia}`]);
  });
});
