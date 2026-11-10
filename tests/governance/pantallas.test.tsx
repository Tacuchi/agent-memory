import "../web/dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "../web/ayuda";

// AC-11 y AC-12 en la interfaz: la bandeja exige el motivo, la fusión y la caducidad cambian la
// base por la API y la historia queda.

let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  w = montarWeb();
});
afterEach(() => w.cerrar());

const irA = (nombre: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: nombre }));

describe("bandeja", () => {
  it("rechazar está deshabilitado sin motivo y la entrada sigue pendiente; con motivo se rechaza", async () => {
    const { entrada } = await w.comoAgente<any>("crear", { tipo: "decision", titulo: "Propuesta", contenido: "texto", ambito: "global" });
    w.vista();
    irA("Pendientes");
    const tarjeta = await screen.findByRole("article", { name: `Pendiente #${entrada.id}` });
    const rechazar = within(tarjeta).getByRole("button", { name: "Rechazar" }) as HTMLButtonElement;
    expect(rechazar.disabled).toBe(true);
    fireEvent.change(within(tarjeta).getByLabelText("Motivo del rechazo"), { target: { value: "   " } });
    expect(rechazar.disabled).toBe(true);
    fireEvent.click(rechazar);
    expect(w.llamadas).not.toContain("rechazar");
    expect(w.t.store.obtener(entrada.id).validacion).toBe("pendiente");

    fireEvent.change(within(tarjeta).getByLabelText("Motivo del rechazo"), { target: { value: "no aplica a este repo" } });
    expect(rechazar.disabled).toBe(false);
    fireEvent.click(rechazar);
    await screen.findByText(`#${entrada.id} rechazada`);
    expect(w.t.store.obtener(entrada.id)).toMatchObject({ validacion: "rechazada", motivoRechazo: "no aplica a este repo" });
    expect(await screen.findByText("No hay entradas pendientes.")).toBeTruthy();
  });

  it("muestra a cuál reemplazaría y aprobar la valida por la web, aplicando el reemplazo", async () => {
    const original = (await w.comoPersona<any>("crear", { tipo: "convencion", titulo: "Convención vieja", contenido: "v1", ambito: "global" })).entrada.id;
    const nueva = (await w.comoAgente<any>("crear", { tipo: "convencion", titulo: "Convención nueva", contenido: "v2", ambito: "global", reemplaza_a: original })).entrada.id;
    w.vista();
    irA("Pendientes");
    const tarjeta = await screen.findByRole("article", { name: `Pendiente #${nueva}` });
    expect(within(tarjeta).getByText(/Reemplazaría a/)).toBeTruthy();
    expect(within(tarjeta).getByText(`#${original} · Convención vieja`)).toBeTruthy();
    fireEvent.click(within(tarjeta).getByRole("button", { name: "Aprobar" }));
    await screen.findByText(`#${nueva} aprobada`);
    expect(w.t.store.obtener(nueva)).toMatchObject({ validacion: "validada", validacionVia: "web" });
    expect(w.t.store.obtener(original)).toMatchObject({ vida: "reemplazada", reemplazadaPor: nueva });
  });
});

describe("fusión desde la búsqueda", () => {
  it("elige dos, fusiona y queda en el detalle de la resultante validada", async () => {
    const a = (await w.comoPersona<any>("crear", { tipo: "leccion", titulo: "Primera mitad", contenido: "uno", ambito: "global" })).entrada.id;
    const b = (await w.comoPersona<any>("crear", { tipo: "leccion", titulo: "Segunda mitad", contenido: "dos", ambito: "global" })).entrada.id;
    w.vista();
    fireEvent.click(await screen.findByRole("checkbox", { name: `Elegir #${a} para fusionar` }));
    fireEvent.click(screen.getByRole("checkbox", { name: `Elegir #${b} para fusionar` }));
    fireEvent.click(screen.getByRole("button", { name: "Fusionar 2 seleccionadas" }));
    const form = await screen.findByRole("form", { name: "Entrada resultante" });
    await waitFor(() => expect((within(form).getByLabelText("Contenido") as HTMLTextAreaElement).value).toBe("uno\n\ndos"));
    fireEvent.change(within(form).getByLabelText("Título"), { target: { value: "Lección completa" } });
    fireEvent.click(within(form).getByRole("button", { name: "Fusionar" }));
    const titulo = await screen.findByRole("heading", { name: /· Lección completa$/ });
    const id = Number(/#(\d+)/.exec(titulo.textContent ?? "")?.[1]);
    expect(w.t.store.obtener(id)).toMatchObject({ validacion: "validada", validacionVia: "web" });
    expect(w.t.store.obtener(a).reemplazadaPor).toBe(id);
    expect(w.t.store.obtener(b).reemplazadaPor).toBe(id);
  });
});

describe("caducar y revertir desde el detalle", () => {
  it("caduca con fecha elegida y revierte la caducidad hecha por el agente", async () => {
    const a = (await w.comoPersona<any>("crear", { tipo: "referencia", titulo: "Referencia sintética", contenido: "r", ambito: "global" })).entrada.id;
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Referencia sintética`));
    const form = await screen.findByRole("form", { name: "Caducar" });
    fireEvent.change(within(form).getByLabelText("Fecha (vacía = hoy)"), { target: { value: "2099-12-31" } });
    fireEvent.click(within(form).getByRole("button", { name: "Caducar en esa fecha" }));
    await screen.findByText("vence el 2099-12-31");
    expect(w.t.store.obtener(a).vigenciaHasta).toBe("2099-12-31");

    fireEvent.click(screen.getByRole("button", { name: "Revertir caducidad" }));
    await screen.findByText("caducidad revertida");
    expect(w.t.store.obtener(a).vigenciaHasta).toBeNull();

    await w.comoAgente("caducar", { id: a });
    irA("Buscar");
    fireEvent.click(within(screen.getByRole("search")).getByRole("checkbox", { name: "vencidas" }));
    fireEvent.click(within(screen.getByRole("search")).getByRole("button", { name: "Buscar" }));
    fireEvent.click(await screen.findByText(`#${a} · Referencia sintética`));
    expect(await screen.findByText(/la caducó el agente/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revertir caducidad" }));
    await screen.findByText("caducidad revertida");
    expect(w.t.store.obtener(a)).toMatchObject({ vigenciaHasta: null, caducidad: null });
    expect(w.t.store.revisiones(a).map((r) => r.accion)).toEqual(["crear", "caducar", "revertir_caducidad", "caducar", "revertir_caducidad"]);
  });

  it("caducar sin fecha vence hoy", async () => {
    const a = (await w.comoPersona<any>("crear", { tipo: "referencia", titulo: "Otra referencia", contenido: "r", ambito: "global" })).entrada.id;
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Otra referencia`));
    fireEvent.click(within(await screen.findByRole("form", { name: "Caducar" })).getByRole("button", { name: "Caducar hoy" }));
    await screen.findByText("vence hoy");
    expect(w.t.store.obtener(a).vigenciaHasta).toBe("2026-11-09");
  });
});
