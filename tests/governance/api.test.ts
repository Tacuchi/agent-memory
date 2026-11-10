import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";
import { comoPersona, sesionWeb } from "../helpers/web.js";

// Gobernanza por HTTP, con la cookie de la web: rechazo con motivo, fusión y caducidad.

let s: ServicioDePrueba;
let cookie: string;
const persona = (op: string, cuerpo: object = {}) => comoPersona(s, cookie, op, cuerpo);
const agente = (op: string, cuerpo: object = {}) => s.api(op, cuerpo);

beforeEach(async () => {
  s = await servicioDePrueba();
  cookie = (await sesionWeb(s)).cookie;
});
afterEach(async () => s.cerrar());

async function pendiente(titulo = "Propuesta del agente") {
  const r = await agente("crear", { tipo: "convencion", titulo, contenido: "contenido sintético", ambito: "global" });
  expect(r.datos.entrada.validacion).toBe("pendiente");
  return r.datos.entrada.id as number;
}

describe("bandeja: aprobar y rechazar", () => {
  it("escenario «rechazo sin motivo» desde la web: no se registra y la entrada sigue pendiente", async () => {
    const id = await pendiente();
    for (const motivo of [undefined, "", "   "]) {
      const r = await persona("rechazar", motivo === undefined ? { id } : { id, motivo });
      expect(r.status).toBe(400);
      expect(r.datos.error.codigo).toBe("motivo_requerido");
    }
    const leida = await persona("leer", { id });
    expect(leida.datos.entrada.validacion).toBe("pendiente");
    expect((await persona("revisiones", { id })).datos.revisiones).toHaveLength(1);
    expect((await persona("pendientes")).datos.entradas.map((e: { id: number }) => e.id)).toContain(id);
  });

  it("con motivo se rechaza; aprobar valida por la vía web", async () => {
    const a = await pendiente("A");
    const b = await pendiente("B");
    const rechazo = await persona("rechazar", { id: a, motivo: "duplica otra convención" });
    expect(rechazo.datos.entrada).toMatchObject({ validacion: "rechazada", motivo_rechazo: "duplica otra convención" });
    const aprobada = await persona("aprobar", { id: b });
    expect(aprobada.datos.entrada).toMatchObject({ validacion: "validada", validacion_via: "web" });
    expect((await persona("pendientes")).datos.entradas).toHaveLength(0);
  });

  it("la bandeja dice a cuál reemplazaría cada pendiente", async () => {
    const original = (await persona("crear", { tipo: "convencion", titulo: "Original", contenido: "v1", ambito: "global" })).datos.entrada.id;
    await agente("crear", { tipo: "convencion", titulo: "Reemplazo", contenido: "v2", ambito: "global", reemplaza_a: original });
    const bandeja = await persona("pendientes");
    expect(bandeja.datos.entradas[0].reemplazaria).toEqual({ id: original, titulo: "Original" });
  });
});

describe("fusión", () => {
  it("la resultante nace validada por la web y reemplaza a las originales, que conservan su historia", async () => {
    const a = (await persona("crear", { tipo: "leccion", titulo: "Lección A", contenido: "parte a", ambito: "global" })).datos.entrada.id;
    const b = await pendiente("Lección B");
    const c = (await persona("crear", { tipo: "leccion", titulo: "Lección C", contenido: "parte c", ambito: "global" })).datos.entrada.id;

    const r = await persona("fusionar", { ids: [a, b, c], titulo: "Lección unida", contenido: "parte a, b y c" });
    expect(r.status).toBe(200);
    const resultante = r.datos.entrada;
    expect(resultante).toMatchObject({ validacion: "validada", validacion_via: "web", vida: "activa", tipo: "leccion", ambito: "global" });

    for (const id of [a, b, c]) {
      const o = (await persona("leer", { id })).datos.entrada;
      expect(o).toMatchObject({ vida: "reemplazada", reemplazada_por: resultante.id });
      const revs = (await persona("revisiones", { id })).datos.revisiones;
      expect(revs.at(-1).accion).toBe(`fusionada_en:${resultante.id}`);
      expect(revs.length).toBeGreaterThanOrEqual(2);
    }

    const busqueda = await agente("buscar", { consulta: "Lección", filtros: { todos_los_ambitos: true } });
    expect(busqueda.datos.resultados.map((x: { id: number }) => x.id)).toEqual([resultante.id]);
    const conHistoria = await agente("listar", { filtros: { todos_los_ambitos: true, incluir_reemplazadas: true } });
    expect(conHistoria.datos.entradas.map((x: { id: number }) => x.id).sort()).toEqual([a, b, c, resultante.id].sort());

    const relaciones = (await persona("leer", { id: resultante.id })).datos.relaciones;
    expect(relaciones.map((x: { id: number }) => x.id).sort()).toEqual([a, b, c].sort());
  });

  it("el agente no fusiona; una fusión de menos de dos o con una entrada ya reemplazada no cambia nada", async () => {
    const a = (await persona("crear", { tipo: "leccion", titulo: "A", contenido: "a", ambito: "global" })).datos.entrada.id;
    const b = (await persona("crear", { tipo: "leccion", titulo: "B", contenido: "b", ambito: "global" })).datos.entrada.id;
    expect((await agente("fusionar", { ids: [a, b], titulo: "x", contenido: "y" })).status).toBe(403);
    expect((await persona("fusionar", { ids: [a], titulo: "x", contenido: "y" })).status).toBe(400);
    expect((await persona("fusionar", { ids: [a, a], titulo: "x", contenido: "y" })).status).toBe(400);
    await persona("fusionar", { ids: [a, b], titulo: "AB", contenido: "ab" });
    const c = (await persona("crear", { tipo: "leccion", titulo: "C", contenido: "c", ambito: "global" })).datos.entrada.id;
    const otra = await persona("fusionar", { ids: [a, c], titulo: "AC", contenido: "ac" });
    expect(otra.status).toBe(400);
    expect(otra.datos.error.codigo).toBe("no_activa");
    expect((await persona("leer", { id: c })).datos.entrada.vida).toBe("activa");
  });
});

describe("caducar y revertir", () => {
  it("caduca hoy o en la fecha elegida, sin perder historia", async () => {
    const a = (await persona("crear", { tipo: "referencia", titulo: "Ref A", contenido: "a", ambito: "global" })).datos.entrada.id;
    const b = (await persona("crear", { tipo: "referencia", titulo: "Ref B", contenido: "b", ambito: "global" })).datos.entrada.id;
    const hoy = (await persona("caducar", { id: a })).datos.entrada;
    expect(hoy.vigencia_hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hoy.caducidad.actor).toBe("persona");
    const elegida = (await persona("caducar", { id: b, fecha: "2099-01-31" })).datos.entrada;
    expect(elegida.vigencia_hasta).toBe("2099-01-31");

    const porDefecto = (await agente("listar", { filtros: { todos_los_ambitos: true } })).datos.entradas.map((x: { id: number }) => x.id);
    expect(porDefecto).not.toContain(a);
    expect(porDefecto).toContain(b);
    expect((await persona("revisiones", { id: a })).datos.revisiones.map((r: { accion: string }) => r.accion)).toEqual(["crear", "caducar"]);
  });

  it("la persona revierte desde la web la caducidad que hizo el agente; el agente no puede revertir", async () => {
    const a = (await persona("crear", { tipo: "referencia", titulo: "Ref", contenido: "r", ambito: "global" })).datos.entrada.id;
    const caducada = (await agente("caducar", { id: a })).datos.entrada;
    expect(caducada.caducidad.actor).toBe("agente");
    expect((await agente("revertir_caducidad", { id: a })).status).toBe(403);
    const revertida = (await persona("revertir_caducidad", { id: a })).datos.entrada;
    expect(revertida).toMatchObject({ vigencia_hasta: null, caducidad: null, validacion: "validada" });
  });
});
