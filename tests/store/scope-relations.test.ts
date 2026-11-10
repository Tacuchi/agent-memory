import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARCADOR_PROYECTO, ambitoPorDefecto, normalizarRemoto, resolverContexto } from "../../src/context.js";
import { REPO, dirTemporal, storeTemporal } from "../helpers/temp.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("resolución de ámbito desde el contexto", () => {
  let base: string;
  let limpiar: () => void;
  beforeEach(() => {
    ({ dir: base, limpiar } = dirTemporal("agent-memory-ctx-"));
    base = realpathSync(base);
  });
  afterEach(() => limpiar());

  it("normaliza los remotos a un mismo id", () => {
    const id = "github.com/org/repo";
    expect(normalizarRemoto("git@github.com:Org/Repo.git")).toBe(id);
    expect(normalizarRemoto("https://user@github.com/Org/Repo")).toBe(id);
    expect(normalizarRemoto("ssh://git@github.com:22/Org/Repo.git/")).toBe(id);
  });

  it("un repo con remoto se identifica por el remoto; sin remoto, por la ruta", () => {
    const conRemoto = join(base, "con-remoto");
    mkdirSync(join(conRemoto, "src"), { recursive: true });
    git(conRemoto, "init", "-q");
    git(conRemoto, "remote", "add", "origin", "git@github.com:Ejemplo/Sintetico.git");
    expect(resolverContexto(join(conRemoto, "src"))).toEqual({ repo: "github.com/ejemplo/sintetico", proyecto: null });

    const sinRemoto = join(base, "sin-remoto");
    mkdirSync(sinRemoto);
    git(sinRemoto, "init", "-q");
    expect(resolverContexto(sinRemoto).repo).toBe(`ruta:${sinRemoto}`);
  });

  it("el proyecto lo declara el marcador más cercano o la config, y se identifica por su nombre", () => {
    const notas = join(base, "notas");
    const dentro = join(notas, "semana", "lunes");
    mkdirSync(dentro, { recursive: true });
    writeFileSync(join(notas, MARCADOR_PROYECTO), JSON.stringify({ proyecto: "tienda" }));
    expect(resolverContexto(dentro).proyecto).toBe("proyecto:tienda");

    // Un repo de código en otra carpeta, declarado en la config con el mismo nombre: mismo proyecto.
    const repo = join(base, "codigo", "api");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    expect(resolverContexto(join(repo, "src"), { proyectos: { tienda: [join(base, "codigo")] } })).toEqual({
      repo: `ruta:${repo}`,
      proyecto: "proyecto:tienda",
    });

    // Gana la declaración más cercana: un marcador anidado pisa al de arriba y a la config.
    const anidada = join(notas, "semana");
    writeFileSync(join(anidada, MARCADOR_PROYECTO), JSON.stringify({ proyecto: "otro" }));
    expect(resolverContexto(dentro, { proyectos: { tienda: [notas] } }).proyecto).toBe("proyecto:otro");
    expect(resolverContexto(dentro, { proyectos: { tercero: [dentro] } }).proyecto).toBe("proyecto:tercero");

    const suelta = join(base, "suelta");
    mkdirSync(suelta);
    expect(resolverContexto(suelta)).toEqual({ repo: null, proyecto: null });
  });

  it("un marcador sin nombre es un error que nombra el archivo", () => {
    writeFileSync(join(base, MARCADOR_PROYECTO), "{}");
    expect(() => resolverContexto(base)).toThrow(/marcador de proyecto inválido/);
  });

  it("una entrada nueva nace en el proyecto, si no en el repo, si no en global; la preferencia, en global", () => {
    expect(ambitoPorDefecto({ repo: "r", proyecto: "p" })).toEqual({ ambito: "proyecto", ambitoRef: "p" });
    expect(ambitoPorDefecto({ repo: "r", proyecto: null })).toEqual({ ambito: "repo", ambitoRef: "r" });
    expect(ambitoPorDefecto({ repo: null, proyecto: null })).toEqual({ ambito: "global", ambitoRef: null });
    expect(ambitoPorDefecto({ repo: "r", proyecto: "p" }, "preferencia")).toEqual({ ambito: "global", ambitoRef: null });
  });
});

describe("ámbitos en el almacén", () => {
  let t: ReturnType<typeof storeTemporal>;
  beforeEach(() => {
    t = storeTemporal();
  });
  afterEach(() => t.cerrar());

  it("filtra por contexto y por ámbito, y la persona cambia el ámbito", async () => {
    const persona = { actor: "persona" as const };
    const global = (await t.store.crear({ tipo: "preferencia", titulo: "g", contenido: "c", ambito: "global", ambitoRef: null }, persona)).entrada;
    const repo = (await t.store.crear({ tipo: "leccion", titulo: "r", contenido: "c", ambito: "repo", ambitoRef: REPO }, persona)).entrada;
    const otro = (await t.store.crear({ tipo: "leccion", titulo: "o", contenido: "c", ambito: "repo", ambitoRef: "github.com/otro/repo" }, persona))
      .entrada;
    const ctx = { repo: REPO, proyecto: null };

    expect(t.store.listar({ contexto: ctx }).map((e) => e.id).sort()).toEqual([global.id, repo.id]);
    expect(t.store.listar({ contexto: ctx, ambito: "repo" }).map((e) => e.id)).toEqual([repo.id]);
    expect(t.store.listar({ contexto: ctx, todosLosAmbitos: true }).map((e) => e.id).sort()).toEqual([global.id, repo.id, otro.id]);

    const movida = t.store.cambiarAmbito(otro.id, "global", null);
    expect(movida).toMatchObject({ ambito: "global", ambitoRef: null, validacion: "validada" });
    expect(t.store.listar({ contexto: ctx }).map((e) => e.id)).toContain(otro.id);
    expect(() => t.store.cambiarAmbito(otro.id, "repo", null)).toThrow(/referencia/);
    expect(() => t.store.cambiarAmbito(otro.id, "galaxia", null)).toThrow(/ámbito/);
    expect(t.store.revisiones(otro.id).at(-1)?.accion).toBe("cambiar_ambito");
  });
});

describe("relaciones por id", () => {
  let t: ReturnType<typeof storeTemporal>;
  beforeEach(() => {
    t = storeTemporal();
  });
  afterEach(() => t.cerrar());

  it("se leen en ambos sentidos con su estado y sobreviven a un cambio de título", async () => {
    const enRepo = { ambito: "repo" as const, ambitoRef: REPO };
    const a = (await t.store.crear({ tipo: "decision", titulo: "Usar SQLite", contenido: "c", ...enRepo }, { actor: "persona" })).entrada;
    const b = (await t.store.crear({ tipo: "leccion", titulo: "WAL en SQLite", contenido: "c", ...enRepo, relacionadas: [a.id] }, { actor: "agente" }))
      .entrada;
    const c = (await t.store.crear({ tipo: "referencia", titulo: "Doc de sqlite-vec", contenido: "c", ...enRepo }, { actor: "persona" })).entrada;
    t.store.relacionar(a.id, c.id);

    const deA = t.store.leer(a.id).relaciones;
    expect(deA).toEqual([
      expect.objectContaining({ id: b.id, sentido: "entrante", validacion: "pendiente", vida: "activa" }),
      expect.objectContaining({ id: c.id, sentido: "saliente", validacion: "validada" }),
    ]);
    expect(t.store.leer(b.id).relaciones).toEqual([expect.objectContaining({ id: a.id, sentido: "saliente", titulo: "Usar SQLite" })]);

    await t.store.editar(a.id, { titulo: "Usar SQLite como única base" }, { actor: "persona" });
    expect(t.store.leer(b.id).relaciones[0]).toMatchObject({ id: a.id, titulo: "Usar SQLite como única base" });
    expect(t.store.leer(a.id).relaciones).toHaveLength(2);

    expect(() => t.store.relacionar(a.id, a.id)).toThrow(/consigo misma/);
    expect(() => t.store.relacionar(a.id, 999)).toThrow(/no existe/);
  });
});
