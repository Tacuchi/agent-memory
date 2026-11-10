import "./dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "./ayuda";

// La web abre en Resumen: estado, cola de pendientes y la enfocada completa para decidir sin
// cambiar de pantalla. Las pantallas tienen dirección y se recorren con el teclado.

let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  w = montarWeb();
});
afterEach(() => w.cerrar());

async function pendiente(titulo: string) {
  const r = await w.comoAgente<{ entrada: { id: number } }>("crear", { tipo: "leccion", titulo, contenido: `Contenido completo de ${titulo}`, ambito: "global" });
  return r.entrada.id;
}

const previa = () => within(screen.getByRole("region", { name: "Vista previa" }));
const cola = () => within(screen.getByRole("list", { name: "Cola de pendientes" }));

describe("resumen", () => {
  it("sin dirección abre en Resumen con la cola y la primera pendiente completa", async () => {
    await pendiente("Lección uno");
    await pendiente("Lección dos");
    w.vista("");
    await waitFor(() => expect(cola().getAllByRole("listitem")).toHaveLength(2));
    const primera = cola().getAllByRole("listitem")[0]!.querySelector("button")!.textContent!;
    expect(previa().getByRole("heading", { name: primera })).toBeTruthy();
    expect(previa().getByText(`Contenido completo de ${primera}`)).toBeTruthy();
  });

  it("aprueba con la tecla a la enfocada tras bajar con j, y la cola se actualiza", async () => {
    await pendiente("Lección uno");
    await pendiente("Lección dos");
    w.vista("");
    await waitFor(() => expect(cola().getAllByRole("listitem")).toHaveLength(2));
    const segunda = cola().getAllByRole("listitem")[1]!.querySelector("button")!.textContent!;
    fireEvent.keyDown(document.body, { key: "j" });
    expect(previa().getByRole("heading", { name: segunda })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "a" });
    await screen.findByText(new RegExp(`aprobada · ${segunda}`));
    await waitFor(() => expect(cola().getAllByRole("listitem")).toHaveLength(1));
    expect(w.llamadas).toContain("aprobar");
  });

  it("rechazar desde la vista previa exige motivo", async () => {
    const id = await pendiente("Lección dudosa");
    w.vista("");
    await previa().findByRole("heading", { name: "Lección dudosa" });
    const rechazar = previa().getByRole("button", { name: "Rechazar" }) as HTMLButtonElement;
    expect(rechazar.disabled).toBe(true);
    fireEvent.change(previa().getByLabelText("Motivo del rechazo"), { target: { value: "No se verificó" } });
    fireEvent.click(rechazar);
    await screen.findByText("No hay pendientes.");
    expect(w.t.store.obtener(id)).toMatchObject({ validacion: "rechazada", motivoRechazo: "No se verificó" });
  });

  it("g seguido de p lleva a Pendientes y deja la dirección en la barra", async () => {
    await pendiente("Lección uno");
    w.vista("");
    await screen.findByRole("list", { name: "Cola de pendientes" });
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "p" });
    await screen.findByRole("heading", { name: "Pendientes" });
    expect(location.hash).toBe("#pendientes");
  });

  it("las letras dentro de un campo son texto, no atajos", async () => {
    await pendiente("Lección uno");
    w.vista("");
    await previa().findByRole("heading", { name: "Lección uno" });
    const motivo = previa().getByLabelText("Motivo del rechazo");
    fireEvent.keyDown(motivo, { key: "a" });
    expect(w.llamadas).not.toContain("aprobar");
  });
});
