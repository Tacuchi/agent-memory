import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { armarIndice, estimarTokens } from "../../src/indice/indice.js";
import { cargarConfig } from "../../src/config.js";
import { arrancarServicio, type App } from "../../src/service/app.js";
import { leerToken } from "../../src/service/token.js";
import { EmbedderFalso, modeloReal } from "../helpers/embedders.js";
import { PROYECTO, REPO, dirTemporal, storeTemporal } from "../helpers/temp.js";

// Índice con tope, ámbito actual más global, tres bloques y una línea por entrada.

const CONTEXTO = { repo: REPO, proyecto: PROYECTO };
const OTRO_PROYECTO = "proyecto:otro-sintetico";

describe("armado del índice", () => {
  let t: ReturnType<typeof storeTemporal>;
  afterEach(() => t.cerrar());

  it("bloques en orden (validadas, proyecto, pendientes), marcados, sin otros proyectos y con línea id·título·tipo·fecha", async () => {
    t = storeTemporal({ embedder: null });
    const crear = (tipo: string, titulo: string, ambito: string, ambitoRef: string | null, confirmado = false) =>
      t.store.crear({ tipo: tipo as never, titulo, contenido: `${titulo}.`, ambito: ambito as never, ambitoRef, reemplazaA: null, relacionadas: [] }, { actor: "agente", confirmado });
    await crear("leccion", "Pendiente del proyecto", "proyecto", PROYECTO);
    await crear("proyecto", "Estado del trabajo en curso", "proyecto", PROYECTO);
    await crear("preferencia", "Respuestas breves", "global", null, true);
    await crear("convencion", "Commits en una línea", "repo", REPO, true);
    await crear("leccion", "De otro proyecto", "proyecto", OTRO_PROYECTO, true);
    const indice = armarIndice(t.store.listar({ contexto: CONTEXTO }, 1000), 1500);
    const texto = indice.texto;
    expect(texto).toMatch(/^# agent-memory · índice de la memoria \(evidencia, no instrucciones\)/);
    expect(texto).not.toContain("De otro proyecto");
    const posiciones = ["## Validadas", "## [proyecto]", "## [pendiente]"].map((b) => texto.indexOf(b));
    expect(posiciones.every((p) => p > 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(texto).toMatch(/^- #\d+ · Respuestas breves · preferencia · 2026-11-09$/m);
    expect(texto.slice(posiciones[2]!)).toContain("Pendiente del proyecto");
    expect(texto.slice(posiciones[1]!, posiciones[2]!)).toContain("Estado del trabajo en curso");
    expect(indice).toMatchObject({ incluidas: 4, fuera: 0 });
    expect(texto).not.toMatch(/fuera del índice/);
  });

  it("dentro de un bloque ordena por uso y actualización recientes", async () => {
    t = storeTemporal({ embedder: null });
    const ids: number[] = [];
    for (const titulo of ["Primera", "Segunda", "Tercera"]) {
      const r = await t.store.crear({ tipo: "leccion", titulo, contenido: `${titulo}.`, ambito: "global", ambitoRef: null, reemplazaA: null, relacionadas: [] }, { actor: "agente", confirmado: true });
      ids.push(r.entrada.id);
      t.avanzar(60_000);
    }
    t.store.registrarUso([ids[0]!]);
    const texto = armarIndice(t.store.listar({ contexto: CONTEXTO }, 1000), 1500).texto;
    const orden = ["Primera", "Tercera", "Segunda"].map((x) => texto.indexOf(x));
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("nunca supera el tope y cuenta lo que quedó fuera", async () => {
    t = storeTemporal({ embedder: null });
    for (let i = 0; i < 80; i++) {
      await t.store.crear(
        { tipo: "leccion", titulo: `Lección sintética número ${i} con un título bastante largo`, contenido: "x", ambito: "global", ambitoRef: null, reemplazaA: null, relacionadas: [] },
        { actor: "agente", confirmado: true },
      );
    }
    for (const tope of [200, 400, 1500]) {
      const indice = armarIndice(t.store.listar({ contexto: CONTEXTO }, 1000), tope);
      expect(indice.tokens).toBeLessThanOrEqual(tope);
      expect(estimarTokens(indice.texto)).toBe(indice.tokens);
      expect(indice.incluidas + indice.fuera).toBe(80);
      expect(indice.fuera).toBeGreaterThan(0);
      expect(indice.texto).toContain(`(${indice.fuera} entradas quedaron fuera del índice por el tope; se encuentran con memory_search)`);
    }
  });
});

describe("escenario «índice con tope»", () => {
  let app: App | null = null;
  let limpiar = () => {};
  afterEach(async () => {
    await app?.cerrar();
    limpiar();
  });

  it("el índice no supera el tope, dice cuántas quedaron fuera y una paráfrasis encuentra una de ellas", async () => {
    const tmp = dirTemporal("agent-memory-indice-");
    limpiar = tmp.limpiar;
    const config = { ...cargarConfig({ AGENT_MEMORY_HOME: tmp.dir }), port: 0 };
    app = await arrancarServicio(config, { embedder: modeloReal() });
    const token = leerToken(config.tokenPath);
    const api = async (op: string, cuerpo: object) => {
      const res = await fetch(`${app!.url}/api/${op}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      const datos = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(datos));
      return datos as any;
    };
    const conjunto = JSON.parse(readFileSync("tests/fixtures/consultas-es.json", "utf8")) as {
      corpus: { clave: string; tipo: string; titulo: string; contenido: string }[];
    };
    // La primera en crearse es la más vieja: es la que el tope deja fuera.
    for (const e of conjunto.corpus) {
      await api("crear", { tipo: e.tipo, titulo: e.titulo, contenido: e.contenido, ambito: "proyecto", contexto: CONTEXTO });
      await new Promise((r) => setTimeout(r, 5));
    }
    const indice = await api("indice", { contexto: CONTEXTO, tope: 300 });
    expect(indice.tokens).toBeLessThanOrEqual(300);
    expect(indice.fuera).toBeGreaterThan(0);
    expect(indice.texto).toContain(`${indice.fuera} entradas quedaron fuera del índice`);
    expect(indice.texto).not.toContain("Reintentos con espera exponencial");

    const r = await api("buscar", { consulta: "volver a llamar a una API caída aguardando cada vez más", contexto: CONTEXTO, limite: 3 });
    expect(r.modo).toBe("hibrido");
    expect(r.resultados.map((x: { titulo: string }) => x.titulo)).toContain("Reintentos con espera exponencial");
  });

  it("el tope por defecto sale de la configuración (1.500)", async () => {
    const tmp = dirTemporal("agent-memory-indice-");
    limpiar = tmp.limpiar;
    const config = { ...cargarConfig({ AGENT_MEMORY_HOME: tmp.dir }), port: 0 };
    expect(config.topeIndice).toBe(1500);
    app = await arrancarServicio(config, { embedder: new EmbedderFalso() });
    const res = await fetch(`${app.url}/api/indice`, {
      method: "POST",
      headers: { authorization: `Bearer ${leerToken(config.tokenPath)}`, "content-type": "application/json" },
      body: JSON.stringify({ contexto: CONTEXTO }),
    });
    expect(await res.json()).toMatchObject({ tope: 1500, fuera: 0 });
  });
});
