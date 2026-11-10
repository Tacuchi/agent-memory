import "./dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "./ayuda";

// AC-10: la web busca con filtros, ve el detalle con estados, relaciones y revisiones, edita
// conservando la validación (S-10), restaura una revisión y cambia el ámbito.

let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  w = montarWeb();
});
afterEach(() => w.cerrar());

async function sembrar() {
  const a = await w.comoPersona("crear", { tipo: "convencion", titulo: "Nombres de ramas sintéticas", contenido: "Usar prefijo feat/", ambito: "global" });
  const b = await w.comoPersona("crear", {
    tipo: "leccion",
    titulo: "Lección relacionada",
    contenido: "Algo aprendido",
    ambito: "global",
    relacionadas: [a.entrada.id],
  });
  const p = await w.comoAgente("crear", { tipo: "decision", titulo: "Decisión del agente", contenido: "Propuesta pendiente", ambito: "global" });
  return { a: a.entrada.id as number, b: b.entrada.id as number, p: p.entrada.id as number };
}

describe("búsqueda", () => {
  it("lista al abrir, busca por texto y filtra por tipo y por estado", async () => {
    const { a, b, p } = await sembrar();
    w.vista();
    const resultados = await screen.findByRole("list", { name: "Resultados" });
    expect(within(resultados).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "leccion" } });
    fireEvent.click(within(screen.getByRole("search")).getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Resultados" })).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByText(`#${b} · Lección relacionada`)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "validada" }));
    fireEvent.click(within(screen.getByRole("search")).getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Resultados" })).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByText(`#${p} · Decisión del agente`)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "validada" }));
    fireEvent.change(screen.getByLabelText("Consulta"), { target: { value: "ramas" } });
    fireEvent.click(within(screen.getByRole("search")).getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(screen.getByText(`#${a} · Nombres de ramas sintéticas`)).toBeTruthy());
    expect(w.llamadas).toContain("buscar");
  });
  it("sin ningún estado marcado salen todos, también las rechazadas", async () => {
    const { p } = await sembrar();
    await w.comoPersona("rechazar", { id: p, motivo: "no aplica" });
    w.vista();
    await screen.findByRole("list", { name: "Resultados" });
    expect(screen.queryByText(`#${p} · Decisión del agente`)).toBeNull();
    const busqueda = screen.getByRole("search");
    fireEvent.click(within(busqueda).getByRole("checkbox", { name: "validada" }));
    fireEvent.click(within(busqueda).getByRole("checkbox", { name: "pendiente" }));
    fireEvent.click(within(busqueda).getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Resultados" })).getAllByRole("listitem")).toHaveLength(3));
    expect(screen.getByText(`#${p} · Decisión del agente`)).toBeTruthy();
  });
});

describe("detalle", () => {
  it("muestra estados, relaciones en ambos sentidos y revisiones", async () => {
    const { a, b } = await sembrar();
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Nombres de ramas sintéticas`));
    await screen.findByRole("heading", { name: `#${a} · Nombres de ramas sintéticas` });
    expect(screen.getAllByText("validada").length).toBeGreaterThan(0);
    const relaciones = screen.getByRole("list", { name: "Relaciones" });
    expect(within(relaciones).getByText("← entrante")).toBeTruthy();
    expect(within(relaciones).getByText(`#${b} · Lección relacionada`)).toBeTruthy();
    fireEvent.click(within(relaciones).getByText(`#${b} · Lección relacionada`));
    const otra = await screen.findByRole("list", { name: "Relaciones" });
    await waitFor(() => expect(within(otra).getByText("→ saliente")).toBeTruthy());
    expect(within(screen.getByRole("list", { name: "Revisiones" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("editar conserva la validación, deja una revisión y se puede restaurar la anterior", async () => {
    const { a } = await sembrar();
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Nombres de ramas sintéticas`));
    const form = await screen.findByRole("form", { name: "Editar" });
    fireEvent.change(within(form).getByLabelText("Contenido"), { target: { value: "Usar prefijo feat/ o fix/" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));
    await screen.findByText(/el estado de validación se conserva/);
    expect(w.t.store.obtener(a).validacion).toBe("validada");
    expect(w.t.store.obtener(a).contenido).toBe("Usar prefijo feat/ o fix/");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Revisiones" })).getAllByRole("listitem")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Restaurar la revisión 1" }));
    await screen.findByText("revisión 1 restaurada");
    expect(w.t.store.obtener(a).contenido).toBe("Usar prefijo feat/");
    expect(w.t.store.obtener(a).validacion).toBe("validada");
    expect(w.t.store.revisiones(a)).toHaveLength(3);
  });

  it("si al editar se redacta un secreto, lo avisa sin mostrar el valor", async () => {
    const { a } = await sembrar();
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Nombres de ramas sintéticas`));
    const form = await screen.findByRole("form", { name: "Editar" });
    fireEvent.change(within(form).getByLabelText("Contenido"), { target: { value: "usar password=hunter2-sintetico" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));
    expect((await screen.findByText(/se redactó: asignacion_secreta/)).textContent).not.toContain("hunter2");
    expect(w.t.store.obtener(a).contenido).not.toContain("hunter2-sintetico");
  });

  it("cambia el ámbito de una entrada", async () => {
    const { a } = await sembrar();
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Nombres de ramas sintéticas`));
    const form = await screen.findByRole("form", { name: "Cambiar ámbito" });
    fireEvent.change(within(form).getByLabelText("Ámbito"), { target: { value: "repo" } });
    fireEvent.change(within(form).getByLabelText("Referencia del repo"), { target: { value: "example.org/acme/sintetico" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cambiar ámbito" }));
    await screen.findByText("ámbito cambiado a repo");
    const e = w.t.store.obtener(a);
    expect([e.ambito, e.ambitoRef]).toEqual(["repo", "example.org/acme/sintetico"]);
  });

  it("un error de la API se muestra, no se traga", async () => {
    const { a } = await sembrar();
    w.vista();
    fireEvent.click(await screen.findByText(`#${a} · Nombres de ramas sintéticas`));
    const form = await screen.findByRole("form", { name: "Editar" });
    fireEvent.change(within(form).getByLabelText("Título"), { target: { value: "   " } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no puede estar vacío/);
  });
});
