import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cargarConfig } from "../../src/config.js";
import { arrancarServicio } from "../../src/service/app.js";
import { leerToken } from "../../src/service/token.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { dirTemporal, storeTemporal } from "../helpers/temp.js";

// La vista de revisión lista lo que lleva tiempo sin uso o sin verificar; confirmar que
// sigue vigente deja la fecha; nada vence por antigüedad.

const DIA = 86_400_000;
const UMBRALES = { diasSinUso: 90, diasSinVerificar: 180 };
let t: ReturnType<typeof storeTemporal>;
beforeEach(() => {
  t = storeTemporal();
});
afterEach(() => t.cerrar());

const crear = async (titulo: string, actor: "persona" | "agente" = "persona", tipo = "leccion") =>
  (await t.store.crear({ tipo, titulo, contenido: titulo, ambito: "global", ambitoRef: null }, { actor })).entrada.id;
const listado = () => t.store.paraRevisar(UMBRALES).map((r) => [r.entrada.id, r.motivos]);

describe("vista de revisión", () => {
  it("lista por umbral de uso (90 d) y de verificación (180 d)", async () => {
    const usada = await crear("Usada");
    const quieta = await crear("Quieta");
    const proyecto = await crear("Estado de trabajo", "agente", "proyecto");
    expect(listado()).toEqual([]);

    t.avanzar(91 * DIA);
    t.store.registrarLeida(usada);
    expect(listado()).toEqual([
      [quieta, ["sin_uso"]],
      [proyecto, ["sin_uso"]],
    ]);

    t.avanzar(90 * DIA);
    for (const id of [usada, quieta, proyecto]) t.store.registrarLeida(id);
    // Usadas, pero sin verificar hace más de 180 días; el proyecto no se verifica.
    expect(listado()).toEqual([
      [usada, ["sin_verificar"]],
      [quieta, ["sin_verificar"]],
    ]);
  });

  it("«sin uso» depende de la lectura: aparecer en búsquedas no la saca de la lista", async () => {
    const id = await crear("Solo mostrada");
    t.avanzar(100 * DIA);
    t.store.registrarMostradas([id]);
    expect(listado()).toEqual([[id, ["sin_uso"]]]);
    t.store.registrarLeida(id);
    expect(listado()).toEqual([]);
  });

  it("confirmar que sigue vigente deja la fecha y una revisión, y la saca de la lista", async () => {
    const id = await crear("Vigente");
    t.avanzar(200 * DIA);
    expect(listado()).toEqual([[id, ["sin_uso", "sin_verificar"]]]);
    const confirmada = t.store.confirmarVigencia(id);
    expect(confirmada.verificadaEn).toBe(t.store.ahora().toISOString());
    expect(confirmada.titulo).toBe("Vigente");
    expect(confirmada.validacion).toBe("validada");
    expect(t.store.revisiones(id).map((r) => r.accion)).toEqual(["crear", "confirmar_vigencia"]);
    expect(listado()).toEqual([]);
  });

  it("ninguna entrada vence sola por antigüedad", async () => {
    const id = await crear("Antigua");
    const pendiente = await crear("Pendiente antigua", "agente");
    t.avanzar(5000 * DIA);
    t.store.paraRevisar(UMBRALES);
    for (const x of [id, pendiente]) {
      const e = t.store.obtener(x);
      expect([e.vida, e.vigenciaHasta, e.caducidad]).toEqual(["activa", null, null]);
    }
    expect(t.store.listar().map((e) => e.id).sort()).toEqual([id, pendiente].sort());
    expect(t.store.revisiones(id)).toHaveLength(1);
  });

  it("las caducadas y reemplazadas no se revisan; confirmar una vencida se rechaza", async () => {
    const id = await crear("Caducada");
    t.store.caducar(id, { actor: "persona" });
    t.avanzar(400 * DIA);
    expect(listado()).toEqual([]);
    expect(() => t.store.confirmarVigencia(id)).toThrow(/no está activa y vigente/);
  });
});

describe("umbrales configurables", () => {
  let home: ReturnType<typeof dirTemporal>;
  beforeEach(() => {
    home = dirTemporal("agent-memory-home-");
  });
  afterEach(() => home.limpiar());

  it("config.json cambia los umbrales y el servicio los usa", async () => {
    writeFileSync(join(home.dir, "config.json"), JSON.stringify({ revision: { dias_sin_uso: 7, dias_sin_verificar: 30 } }));
    const config = { ...cargarConfig({ AGENT_MEMORY_HOME: home.dir }), port: 0 };
    expect(config.revision).toEqual({ diasSinUso: 7, diasSinVerificar: 30 });
    const app = await arrancarServicio(config, { embedder: new EmbedderFalso(), dirWeb: null });
    try {
      const r = await fetch(`${app.url}/api/revision`, {
        method: "POST",
        headers: { authorization: `Bearer ${leerToken(config.tokenPath)}`, "content-type": "application/json" },
        body: "{}",
      });
      expect((await r.json()).umbrales).toEqual({ dias_sin_uso: 7, dias_sin_verificar: 30 });
    } finally {
      await app.cerrar();
    }
  });

  it("un umbral inválido se rechaza con un error explícito", () => {
    writeFileSync(join(home.dir, "config.json"), JSON.stringify({ revision: { dias_sin_uso: 0 } }));
    expect(() => cargarConfig({ AGENT_MEMORY_HOME: home.dir })).toThrow(/revision.dias_sin_uso/);
  });
});
