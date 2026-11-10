import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambitoPorDefecto, normalizarRemoto, resolverContexto } from "../../src/context.js";
import { REPO, dirTemporal, storeTemporal } from "../helpers/temp.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("resolución de ámbito desde el contexto (AC-19)", () => {
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

  it("el proyecto es el hub de Workline más cercano o la carpeta declarada más cercana", () => {
    const hub = join(base, "hub");
    mkdirSync(join(hub, ".workflow"), { recursive: true });
    writeFileSync(join(hub, ".workflow", "workline.json"), "{}");
    const dentro = join(hub, "docs", "plans");
    mkdirSync(dentro, { recursive: true });
    expect(resolverContexto(dentro).proyecto).toBe(`proyecto:${hub}`);

    const declarada = join(hub, "docs");
    expect(resolverContexto(dentro, { proyectos: [declarada] }).proyecto).toBe(`proyecto:${declarada}`);

    const suelta = join(base, "suelta");
    mkdirSync(suelta);
    expect(resolverContexto(suelta)).toEqual({ repo: null, proyecto: null });
  });

  it("una entrada nueva nace en el proyecto, si no en el repo, si no en global (S-12)", () => {
    expect(ambitoPorDefecto({ repo: "r", proyecto: "p" })).toEqual({ ambito: "proyecto", ambitoRef: "p" });
    expect(ambitoPorDefecto({ repo: "r", proyecto: null })).toEqual({ ambito: "repo", ambitoRef: "r" });
    expect(ambitoPorDefecto({ repo: null, proyecto: null })).toEqual({ ambito: "global", ambitoRef: null });
  });
});

describe("ámbitos en el almacén (AC-19)", () => {
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

describe("relaciones por id (AC-31)", () => {
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
