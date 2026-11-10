import "./dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bandeja } from "../../web/src/pantallas/Bandeja";
import type { Cliente } from "../../web/src/api";
import { montarWeb } from "./ayuda";

let w: ReturnType<typeof montarWeb>;
beforeEach(() => { w = montarWeb(); });
afterEach(() => w.cerrar());

async function crear(titulo: string, campos: object = {}) {
  const { entrada } = await w.comoAgente<{ entrada: { id: number } }>("crear", {
    tipo: "convencion", titulo, contenido: `Contenido de ${titulo}`, ambito: "global", ...campos,
  });
  return entrada.id;
}

async function abrir(cliente = w.cliente) {
  render(<Bandeja cliente={cliente} navegar={() => {}} />);
  await screen.findAllByRole("article");
}

function seleccionar(id: number) {
  fireEvent.click(screen.getByRole("checkbox", { name: `Seleccionar #${id}` }));
}

function seleccionarTodas() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todas las visibles" }));
}

async function esperarResultado(correctas: number, fallidas = 0) {
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain(
    `Procesadas ${correctas + fallidas} de ${correctas + fallidas} · ${correctas} correctas · ${fallidas} fallidas`,
  ));
  await waitFor(() => expect(screen.getByText(/^0 seleccionadas/)).toBeTruthy());
}

describe("acciones de la bandeja", () => {
  it("aprueba varias seleccionadas, refresca y conserva las no seleccionadas", async () => {
    const a = await crear("Primera convención");
    const b = await crear("Segunda convención");
    const c = await crear("Todavía pendiente");
    await abrir();
    seleccionar(a);
    seleccionar(b);
    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas" }));

    await esperarResultado(2);
    expect(w.t.store.obtener(a)).toMatchObject({ validacion: "validada", validacionVia: "web" });
    expect(w.t.store.obtener(b).validacion).toBe("validada");
    expect(w.t.store.obtener(c).validacion).toBe("pendiente");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect((screen.getByRole("checkbox", { name: `Seleccionar #${c}` }) as HTMLInputElement).checked).toBe(false);
    expect(within(screen.getByRole("list", { name: "Resultados por entrada" })).getAllByRole("listitem").map((e) => e.textContent))
      .toEqual([`#${b} aprobada · Segunda convención`, `#${a} aprobada · Primera convención`]);
    expect(w.llamadas.filter((op) => op === "pendientes")).toHaveLength(2);
  });

  it("exige un motivo no vacío y usa el mismo para rechazar todas las seleccionadas", async () => {
    const a = await crear("Primera propuesta");
    const b = await crear("Segunda propuesta");
    await abrir();
    seleccionarTodas();
    const rechazar = screen.getByRole("button", { name: "Rechazar seleccionadas" }) as HTMLButtonElement;
    const motivo = screen.getByLabelText("Motivo del rechazo de las seleccionadas");
    expect(rechazar.disabled).toBe(true);
    fireEvent.click(rechazar);
    fireEvent.change(motivo, { target: { value: "   " } });
    expect(rechazar.disabled).toBe(true);
    fireEvent.click(rechazar);
    expect(w.llamadas).not.toContain("rechazar");
    expect(w.t.store.obtener(a).validacion).toBe("pendiente");

    fireEvent.change(motivo, { target: { value: "  No aplica al proyecto  " } });
    fireEvent.click(rechazar);
    await esperarResultado(2);
    for (const id of [a, b]) {
      expect(w.t.store.obtener(id)).toMatchObject({ validacion: "rechazada", motivoRechazo: "No aplica al proyecto" });
    }
    expect(screen.getByText("No hay entradas pendientes.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Resultados por entrada" })).getAllByText(/rechazada/)).toHaveLength(2);
  });

  it.each(["aprobar", "rechazar"] as const)("al %s informa el fallo de una entrada que cambió de estado y sigue con las demás", async (op) => {
    const a = await crear("Última en procesarse");
    const b = await crear("Aprobada desde otra sesión");
    const c = await crear("Primera en procesarse");
    await abrir();
    seleccionarTodas();
    await w.comoPersona("aprobar", { id: b });
    fireEvent.change(screen.getByLabelText("Motivo del rechazo de las seleccionadas"), { target: { value: "No aplica" } });
    fireEvent.click(screen.getByRole("button", { name: op === "aprobar" ? "Aprobar seleccionadas" : "Rechazar seleccionadas" }));

    await esperarResultado(2, 1);
    const error = op === "aprobar" ? `la entrada ${b} ya está validada` : `solo se rechaza una entrada pendiente; la ${b} está validada`;
    expect(screen.getByRole("alert").textContent).toBe(`#${b} fallida · Aprobada desde otra sesión · ${error}`);
    expect(w.t.store.obtener(b).validacion).toBe("validada");
    for (const id of [a, c]) expect(w.t.store.obtener(id).validacion).toBe(op === "aprobar" ? "validada" : "rechazada");
    expect(screen.getByText("No hay entradas pendientes.")).toBeTruthy();
    expect(w.llamadas.filter((llamada) => llamada === op)).toHaveLength(3);
    expect(within(screen.getByRole("list", { name: "Resultados por entrada" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("mantiene el proyecto elegido visible en el filtro al aprobar su última pendiente", async () => {
    await crear("Única del proyecto", { ambito: "proyecto", contexto: { proyecto: "proyecto:uno", repo: null } });
    await crear("Pendiente global");
    await abrir();
    const proyecto = screen.getByRole("option", { name: "proyecto · proyecto:uno" }) as HTMLOptionElement;
    const clave = proyecto.value;
    fireEvent.change(screen.getByLabelText("Proyecto o repositorio"), { target: { value: clave } });
    seleccionarTodas();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas" }));
    await esperarResultado(1);
    expect((screen.getByLabelText("Proyecto o repositorio") as HTMLSelectElement).value).toBe(clave);
    expect(screen.getByText("No hay pendientes con estos filtros.")).toBeTruthy();
  });

  it("filtra por ámbito, proyecto o repo y tipo sin pedir otra lista ni actuar sobre entradas ocultas", async () => {
    const a = await crear("Convención del proyecto uno", { ambito: "proyecto", contexto: { proyecto: "proyecto:uno", repo: null } });
    const b = await crear("Lección del proyecto uno", { tipo: "leccion", ambito: "proyecto", contexto: { proyecto: "proyecto:uno", repo: null } });
    const c = await crear("Convención del proyecto dos", { ambito: "proyecto", contexto: { proyecto: "proyecto:dos", repo: null } });
    const d = await crear("Convención del repo", { ambito: "repo", contexto: { proyecto: null, repo: "example.org/acme/repo" } });
    const e = await crear("Convención global");
    await abrir();
    seleccionarTodas();
    fireEvent.change(screen.getByLabelText("Ámbito"), { target: { value: "proyecto" } });
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByText(/^0 seleccionadas/)).toBeTruthy();
    const proyecto = screen.getByRole("option", { name: "proyecto · proyecto:uno" }) as HTMLOptionElement;
    seleccionarTodas();
    fireEvent.change(screen.getByLabelText("Proyecto o repositorio"), { target: { value: proyecto.value } });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText(/^0 seleccionadas/)).toBeTruthy();
    seleccionarTodas();
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "leccion" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(/^0 seleccionadas/)).toBeTruthy();
    expect(w.llamadas.filter((op) => op === "pendientes")).toHaveLength(1);
    seleccionarTodas();
    seleccionarTodas();
    expect((screen.getByRole("button", { name: "Aprobar seleccionadas" }) as HTMLButtonElement).disabled).toBe(true);
    seleccionarTodas();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas" }));
    await esperarResultado(1);
    expect(w.t.store.obtener(b).validacion).toBe("validada");
    for (const id of [a, c, d, e]) expect(w.t.store.obtener(id).validacion).toBe("pendiente");
    expect(screen.getByText("No hay pendientes con estos filtros.")).toBeTruthy();
  });

  it("muestra progreso entre llamadas secuenciales y bloquea acciones simultáneas", async () => {
    await crear("Propuesta uno");
    await crear("Propuesta dos");
    const liberar: (() => void)[] = [];
    let iniciadas = 0;
    const cliente: Cliente = async <T,>(op: string, cuerpo?: object): Promise<T> => {
      if (op === "aprobar") {
        iniciadas++;
        await new Promise<void>((resolve) => liberar.push(resolve));
      }
      return w.cliente<T>(op, cuerpo);
    };
    await abrir(cliente);
    seleccionarTodas();
    const aprobar = screen.getByRole("button", { name: "Aprobar seleccionadas" }) as HTMLButtonElement;
    fireEvent.click(aprobar);
    await waitFor(() => expect(iniciadas).toBe(1));
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0");
    expect(aprobar.disabled).toBe(true);
    expect((screen.getByLabelText("Ámbito") as HTMLSelectElement).disabled).toBe(true);
    for (const casilla of screen.getAllByRole("checkbox")) expect((casilla as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(aprobar);
    expect(iniciadas).toBe(1);

    await act(async () => liberar.shift()!());
    await waitFor(() => expect(iniciadas).toBe(2));
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
    expect(screen.getByRole("status").textContent).toContain("Procesadas 1 de 2 · 1 correctas · 0 fallidas");
    await act(async () => liberar.shift()!());
    await esperarResultado(2);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("2");
  });

  it("conserva los resultados y limpia la selección aunque falle el refresco", async () => {
    const id = await crear("Propuesta aprobable");
    let cargas = 0;
    const cliente: Cliente = async <T,>(op: string, cuerpo?: object): Promise<T> => {
      if (op === "pendientes" && ++cargas === 2) throw new Error("conexión interrumpida");
      return w.cliente<T>(op, cuerpo);
    };
    await abrir(cliente);
    seleccionarTodas();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas" }));
    await esperarResultado(1);
    expect(screen.getByRole("alert").textContent).toContain("conexión interrumpida");
    expect(screen.getByText(`#${id} aprobada`)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: `Seleccionar #${id}` }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Recargar pendientes" }));
    await screen.findByText("No hay entradas pendientes.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(`#${id} aprobada`)).toBeTruthy();
  });

  it.each(["aprobar", "rechazar"] as const)("al %s varias propuestas, el reemplazo solo se hace efectivo con la aprobación", async (op) => {
    const { entrada: original } = await w.comoPersona<{ entrada: { id: number } }>("crear", {
      tipo: "convencion", titulo: "Convención vigente", contenido: "Versión anterior", ambito: "global",
    });
    const propuesta = await crear("Convención nueva", { reemplaza_a: original.id });
    await crear("Otra propuesta");
    await abrir();
    expect(w.t.store.obtener(original.id).vida).toBe("activa");
    expect(screen.getByText("Reemplazaría a")).toBeTruthy();
    seleccionarTodas();
    fireEvent.change(screen.getByLabelText("Motivo del rechazo de las seleccionadas"), { target: { value: "Conservar lo vigente" } });
    fireEvent.click(screen.getByRole("button", { name: op === "aprobar" ? "Aprobar seleccionadas" : "Rechazar seleccionadas" }));
    await esperarResultado(2);
    expect(w.t.store.obtener(propuesta).validacion).toBe(op === "aprobar" ? "validada" : "rechazada");
    expect(w.t.store.obtener(original.id).vida).toBe(op === "aprobar" ? "reemplazada" : "activa");
  });

  it("conserva la aprobación y el rechazo individual con motivo obligatorio, desde la vista previa", async () => {
    const a = await crear("Aprobar sola");
    const b = await crear("Rechazar sola");
    await abrir();
    const previa = () => within(screen.getByRole("region", { name: "Vista previa" }));
    fireEvent.click(within(screen.getByRole("article", { name: `Pendiente #${b}` })).getByRole("button", { name: "Rechazar sola" }));
    expect(previa().getByRole("heading", { name: "Rechazar sola" })).toBeTruthy();
    expect((previa().getByRole("button", { name: "Rechazar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(previa().getByLabelText("Motivo del rechazo"), { target: { value: "No aplica" } });
    fireEvent.click(previa().getByRole("button", { name: "Rechazar" }));
    await esperarResultado(1);
    expect(w.t.store.obtener(b)).toMatchObject({ validacion: "rechazada", motivoRechazo: "No aplica" });
    fireEvent.click(within(screen.getByRole("article", { name: `Pendiente #${a}` })).getByRole("button", { name: "Aprobar sola" }));
    fireEvent.click(previa().getByRole("button", { name: "Aprobar" }));
    await screen.findByText("No hay entradas pendientes.");
    expect(w.t.store.obtener(a).validacion).toBe("validada");
  });

  it("con el teclado recorre la cola, marca y aprueba la enfocada", async () => {
    await crear("Primera");
    await crear("Segunda");
    await crear("Tercera");
    await abrir();
    const filas = screen.getAllByRole("article");
    const id = (fila: HTMLElement) => Number(fila.getAttribute("aria-label")!.replace("Pendiente #", ""));
    expect(filas[0]!.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getAllByRole("article")[1]!.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "x" });
    expect((screen.getByRole("checkbox", { name: `Seleccionar #${id(filas[1]!)}` }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(document.body, { key: "a" });
    await esperarResultado(1);
    expect(w.t.store.obtener(id(filas[1]!)).validacion).toBe("validada");
    for (const f of [filas[0]!, filas[2]!]) expect(w.t.store.obtener(id(f)).validacion).toBe("pendiente");
  });
});
