import "./dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "./ayuda";

// En el celular la cola ocupa el ancho: tocar una pendiente abre una hoja inferior para decidir,
// «Rechazar…» cambia la misma hoja al motivo y mantener presionada una fila elige varias.

let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  // Ancho de celular: la web consulta matchMedia, que jsdom no trae.
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  w = montarWeb();
});
afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  w.cerrar();
});

async function pendiente(titulo: string) {
  const r = await w.comoAgente<{ entrada: { id: number } }>("crear", { tipo: "leccion", titulo, contenido: `Contenido de ${titulo}`, ambito: "global" });
  return r.entrada.id;
}

const cola = () => within(screen.getByRole("list", { name: "Cola de pendientes" }));
const hoja = (nombre: string | RegExp) => within(screen.getByRole("dialog", { name: nombre }));

describe("celular", () => {
  it("abre en Resumen con las cifras y la cola; tocar una pendiente abre la hoja y Aprobar la valida", async () => {
    const id = await pendiente("Lección del celular");
    w.vista("");
    fireEvent.click(await cola().findByRole("button", { name: /Lección del celular/ }));
    expect(hoja(`Pendiente #${id}`).getByText("Contenido de Lección del celular")).toBeTruthy();
    fireEvent.click(hoja(`Pendiente #${id}`).getByRole("button", { name: "Aprobar" }));
    await waitFor(() => expect(w.t.store.obtener(id).validacion).toBe("validada"));
    expect(screen.getByRole("navigation", { name: "Secciones" })).toBeTruthy();
  });

  it("Rechazar… pasa al motivo: un motivo rápido llena el texto, editable, y sin motivo no rechaza", async () => {
    const id = await pendiente("Lección dudosa");
    w.vista("#pendientes");
    fireEvent.click(await cola().findByRole("button", { name: /Lección dudosa/ }));
    fireEvent.click(hoja(`Pendiente #${id}`).getByRole("button", { name: "Rechazar…" }));
    const rechazar = hoja(`Pendiente #${id}`).getByRole("button", { name: "Rechazar" }) as HTMLButtonElement;
    expect(rechazar.disabled).toBe(true);
    fireEvent.click(hoja(`Pendiente #${id}`).getByRole("button", { name: "No está verificado" }));
    const motivo = hoja(`Pendiente #${id}`).getByLabelText("Motivo del rechazo") as HTMLTextAreaElement;
    expect(motivo.value).toBe("No está verificado: ");
    fireEvent.change(motivo, { target: { value: "No está verificado: falta correrlo" } });
    fireEvent.click(rechazar);
    await waitFor(() => expect(w.t.store.obtener(id)).toMatchObject({ validacion: "rechazada", motivoRechazo: "No está verificado: falta correrlo" }));
  });

  it("Elegir permite aprobar varias juntas y deja las demás pendientes", async () => {
    const a = await pendiente("Primera");
    const b = await pendiente("Segunda");
    const c = await pendiente("Tercera");
    w.vista("#pendientes");
    await cola().findByRole("button", { name: /Primera/ });
    fireEvent.click(screen.getByRole("button", { name: "Elegir" }));
    fireEvent.click(cola().getByRole("button", { name: /Primera/ }));
    fireEvent.click(cola().getByRole("button", { name: /Tercera/ }));
    expect(screen.getByText("seleccionadas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar 2" }));
    await waitFor(() => expect(w.t.store.obtener(a).validacion).toBe("validada"));
    expect(w.t.store.obtener(c).validacion).toBe("validada");
    expect(w.t.store.obtener(b).validacion).toBe("pendiente");
  });

  it("mantener presionada una fila entra en selección sin abrir la hoja", async () => {
    await pendiente("Para elegir");
    w.vista("#pendientes");
    const fila = await cola().findByRole("button", { name: /Para elegir/ });
    fireEvent.pointerDown(fila);
    await waitFor(() => expect(screen.getByRole("button", { name: "Salir de la selección" })).toBeTruthy(), { timeout: 2000 });
    fireEvent.pointerUp(fila);
    fireEvent.click(fila);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fila.getAttribute("aria-pressed")).toBe("true");
  });

  it("el rechazo en lote pide motivo en la hoja", async () => {
    const a = await pendiente("Uno");
    const b = await pendiente("Dos");
    w.vista("#pendientes");
    await cola().findByRole("button", { name: /Uno/ });
    fireEvent.click(screen.getByRole("button", { name: "Elegir" }));
    fireEvent.click(screen.getByRole("button", { name: "Todas (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Rechazar 2…" }));
    const lote = hoja("Rechazar seleccionadas");
    fireEvent.change(lote.getByLabelText("Motivo del rechazo"), { target: { value: "Duplicadas" } });
    fireEvent.click(lote.getByRole("button", { name: "Rechazar" }));
    await waitFor(() => expect(w.t.store.obtener(a).validacion).toBe("rechazada"));
    expect(w.t.store.obtener(b)).toMatchObject({ validacion: "rechazada", motivoRechazo: "Duplicadas" });
  });

  it("Más abre Revisión, Exportar y Acceso remoto", async () => {
    w.vista("");
    fireEvent.click(await screen.findByRole("button", { name: "Más" }));
    fireEvent.click(hoja("Más secciones").getByRole("button", { name: "Exportar" }));
    await screen.findByRole("heading", { name: "Exportar" });
    expect(location.hash).toBe("#exportar");
  });
});
