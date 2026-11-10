import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cargarConfig } from "../../src/config.js";
import { coincidePatron, contextoExcluido } from "../../src/exclusion.js";
import { clienteMcp, correr, entornoCli, llamarHerramienta, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// T2.4 (AC-20): exclusión por patrones de la configuración local. El paquete trae la lista vacía
// y las pruebas usan solo el patrón sintético example.org/acme.

const PATRON = "example.org/acme";
const sin = { patrones: [], excepciones: [] };

describe("patrones de exclusión", () => {
  const ctx = (repo: string | null, ruta: string | null = null, proyecto: string | null = null) => ({ repo, proyecto, ruta });

  it("el paquete trae la lista vacía: nada queda excluido por defecto", () => {
    const config = cargarConfig({ AGENT_MEMORY_HOME: "/nonexistent/agent-memory-sin-config" });
    expect(config.exclusion).toEqual(sin);
    expect(contextoExcluido(ctx("example.org/acme/servicio"), config.exclusion)).toBe(false);
  });

  it("remoto u organización con host: el repo es ese o cuelga de él", () => {
    expect(coincidePatron(PATRON, ctx("example.org/acme/servicio"), "")).toBe(true);
    expect(coincidePatron("git@example.org:acme/servicio.git", ctx("example.org/acme/servicio"), "")).toBe(true);
    expect(coincidePatron(PATRON, ctx("example.org/acmex/servicio"), "")).toBe(false);
    expect(coincidePatron(PATRON, ctx("github.com/otra/acme"), "")).toBe(false);
  });

  it("organización suelta y prefijo de ruta (absoluto o con ~)", () => {
    expect(coincidePatron("acme", ctx("example.org/acme/servicio"), "")).toBe(true);
    expect(coincidePatron("acme", ctx("example.org/otra/acme"), "")).toBe(false);
    expect(coincidePatron("/tmp/acme", ctx(null, "/tmp/acme/repo"), "")).toBe(true);
    expect(coincidePatron("/tmp/acme", ctx(null, "/tmp/acme-otro"), "")).toBe(false);
    expect(coincidePatron("~/trabajo/acme", ctx("ruta:/u/p/trabajo/acme/x"), "/u/p")).toBe(true);
    expect(coincidePatron("/tmp/acme", ctx(null, null, "proyecto:/tmp/acme/hub"), "")).toBe(true);
  });

  it("una excepción gana sobre los patrones", () => {
    const exclusion = { patrones: [PATRON], excepciones: ["example.org/acme/permitido"] };
    expect(contextoExcluido(ctx("example.org/acme/servicio"), exclusion)).toBe(true);
    expect(contextoExcluido(ctx("example.org/acme/permitido"), exclusion)).toBe(false);
  });
});

describe("escenario «sesión en un repo excluido» (AC-20)", () => {
  let e: EntornoCli;
  let repo: string;

  const configurar = (exclusion: object) =>
    writeFileSync(join(e.datos, "config.json"), JSON.stringify({ exclusion, hook: { espera_ms: 15_000 } }));

  beforeAll(async () => {
    asegurarBuild();
    e = await entornoCli();
    repo = join(e.home, "repos", "servicio");
    mkdirSync(repo, { recursive: true });
    repo = realpathSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@example.org:acme/servicio.git"], { cwd: repo });
    mkdirSync(e.datos, { recursive: true });
  });

  afterAll(async () => {
    await e.limpiar();
  });

  it("sin excepción: no se inyecta índice y guardar o buscar se rechaza con «repo excluido»", async () => {
    configurar({ patrones: [PATRON] });
    const hook = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: repo }) });
    expect(hook.code).toBe(0);
    expect(hook.stdout).toMatch(/repo excluido/);
    expect(hook.stdout).not.toMatch(/índice de la memoria/);

    expect((await correr(e, ["start"])).code).toBe(0);
    const cliente = await clienteMcp(e, repo);
    try {
      const crear = await llamarHerramienta(cliente, "memory_create", { tipo: "leccion", titulo: "Algo del repo", contenido: "Detalle sintético." });
      expect(crear.isError).toBe(true);
      expect(crear.texto).toMatch(/repo excluido/);
      for (const [nombre, args] of [
        ["memory_search", { consulta: "algo" }],
        ["memory_list", {}],
        ["memory_get", { id: 1 }],
        ["memory_pending", {}],
      ] as const) {
        const r = await llamarHerramienta(cliente, nombre, args);
        expect(r.isError, nombre).toBe(true);
        expect(r.texto, nombre).toMatch(/repo excluido/);
      }
    } finally {
      await cliente.close();
    }
    const busqueda = await correr(e, ["search", "algo"], { cwd: repo });
    expect(busqueda.code).not.toBe(0);
    expect(busqueda.stderr).toMatch(/repo excluido/);
    await correr(e, ["stop"]);
  });

  it("excluir un repo con el servicio corriendo surte efecto sin reiniciarlo", async () => {
    configurar({});
    expect((await correr(e, ["start"])).code).toBe(0);
    const cliente = await clienteMcp(e, repo);
    try {
      const antes = await llamarHerramienta(cliente, "memory_list", {});
      expect(antes.isError, antes.texto).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      configurar({ patrones: [PATRON] });
      const despues = await llamarHerramienta(cliente, "memory_list", {});
      expect(despues.isError).toBe(true);
      expect(despues.texto).toMatch(/repo excluido/);
    } finally {
      await cliente.close();
    }
    await correr(e, ["stop"]);
  });

  it("con la excepción habilitada en la configuración: hay índice y guardar funciona", async () => {
    configurar({ patrones: [PATRON], excepciones: ["example.org/acme/servicio"] });
    const hook = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: repo }) });
    expect(hook.code).toBe(0);
    expect(hook.stdout).toMatch(/índice de la memoria/);
    const cliente = await clienteMcp(e, repo);
    try {
      const crear = await llamarHerramienta(cliente, "memory_create", { tipo: "leccion", titulo: "Algo del repo", contenido: "Detalle sintético." });
      expect(crear.isError, crear.texto).toBe(false);
      expect(JSON.parse(crear.texto).entrada.ambito).toBe("repo");
    } finally {
      await cliente.close();
    }
    await correr(e, ["stop"]);
  });
});
