import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { montarWeb } from "../web/ayuda";

// Spec 007, AC-12 a AC-15: «mostrada» (resultado de una búsqueda del agente) y «leída» (el agente pide el detalle)
// se cuentan aparte; el índice y lo que hace la persona no cuentan; los usos de antes quedan como histórico.

const ctx = { repo: null, proyecto: null };
let w: ReturnType<typeof montarWeb>;
beforeEach(() => {
  w = montarWeb();
});
afterEach(() => w.cerrar());

const contadores = (id: number) => {
  const e = w.t.store.obtener(id);
  return { mostrada: [e.mostradaVeces, e.mostradaEn], leida: [e.leidaVeces, e.leidaEn], historico: [e.usos, e.usadaEn] };
};

describe("contadores de mostrada y leída", () => {
  it("cuentan aparte la búsqueda y la lectura del agente; el índice y la persona no suman", async () => {
    const id = (await w.comoPersona<any>("crear", { tipo: "leccion", titulo: "Rango recíproco", contenido: "fusión por rango recíproco", ambito: "global" })).entrada.id;
    // Usos registrados antes del cambio: quedan como dato histórico.
    w.t.store.db.prepare("UPDATE entradas SET usos = 7, usada_en = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(id);
    const ahora = w.t.store.ahora().toISOString();
    const historico = [7, "2026-10-01T00:00:00.000Z"];

    await w.comoPersona("buscar", { consulta: "rango recíproco", contexto: ctx });
    await w.comoPersona("leer", { id });
    await w.comoAgente("indice", { contexto: ctx });
    expect(contadores(id)).toEqual({ mostrada: [0, null], leida: [0, null], historico });

    const r = await w.comoAgente<any>("buscar", { consulta: "rango recíproco", contexto: ctx });
    expect(r.resultados.map((x: { id: number }) => x.id)).toContain(id);
    expect(contadores(id)).toEqual({ mostrada: [1, ahora], leida: [0, null], historico });

    await w.comoAgente("leer", { id });
    await w.comoAgente("leer", { id });
    expect(contadores(id)).toEqual({ mostrada: [1, ahora], leida: [2, ahora], historico });
  });

  it("la vista de revisión trae cuándo y cuántas veces se mostró y se leyó", async () => {
    const id = (await w.comoPersona<any>("crear", { tipo: "leccion", titulo: "Quieta", contenido: "quieta", ambito: "global" })).entrada.id;
    w.t.avanzar(100 * 86_400_000);
    await w.comoAgente("buscar", { consulta: "quieta", contexto: ctx });
    const r = await w.comoPersona<any>("revision", {});
    expect(r.entradas).toEqual([
      expect.objectContaining({ id, motivos: ["sin_uso"], mostrada_veces: 1, mostrada_en: w.t.store.ahora().toISOString(), leida_veces: 0, leida_en: null }),
    ]);
  });
});
