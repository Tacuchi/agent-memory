import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Buscador } from "../../src/search/search.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { PROYECTO, REPO, storeTemporal } from "../helpers/temp.js";

const ctx = { repo: REPO, proyecto: PROYECTO };
const enRepo = { ambito: "repo" as const, ambitoRef: REPO };
const enProyecto = { ambito: "proyecto" as const, ambitoRef: PROYECTO };

describe("filtros por defecto, marcas y filtros explícitos (AC-08, AC-09)", () => {
  let t: ReturnType<typeof storeTemporal>;
  let buscador: Buscador;
  const ids: Record<string, number> = {};

  beforeEach(async () => {
    const embedder = new EmbedderFalso();
    t = storeTemporal({ embedder });
    buscador = new Buscador(t.store, embedder);
    const crear = async (clave: string, tipo: string, extra: object, origen: { actor: "agente" | "persona" }) => {
      ids[clave] = (await t.store.crear({ tipo, titulo: `sqlite ${clave}`, contenido: `nota sobre sqlite ${clave}`, ...enRepo, ...extra }, origen)).entrada.id;
    };
    await crear("validada", "leccion", {}, { actor: "persona" });
    await crear("pendiente", "leccion", {}, { actor: "agente" });
    await crear("proyecto", "proyecto", enProyecto, { actor: "agente" });
    await crear("rechazada", "decision", {}, { actor: "agente" });
    t.store.rechazar(ids.rechazada!, "no aplica");
    await crear("vencida", "referencia", {}, { actor: "persona" });
    t.store.caducar(ids.vencida!, { actor: "persona" });
    await crear("original", "convencion", {}, { actor: "persona" });
    await crear("reemplazo", "convencion", { reemplazaA: ids.original }, { actor: "persona" });
    await crear("global", "preferencia", { ambito: "global", ambitoRef: null }, { actor: "persona" });
    await crear("ajena", "leccion", { ambitoRef: "github.com/otro/repo" }, { actor: "persona" });
  });
  afterEach(() => t.cerrar());

  const claves = (r: Awaited<ReturnType<Buscador["buscar"]>>) =>
    r.resultados.map((x) => Object.keys(ids).find((k) => ids[k] === x.entrada.id)).sort();

  it("por defecto: validadas, pendientes marcadas y proyecto como estado de trabajo; nada retirado ni ajeno", async () => {
    const r = await buscador.buscar("sqlite", { filtros: { contexto: ctx }, limite: 50 });
    expect(r.modo).toBe("hibrido");
    expect(claves(r)).toEqual(["global", "pendiente", "proyecto", "reemplazo", "validada"]);
    const marca = (k: string) => r.resultados.find((x) => x.entrada.id === ids[k])?.marca;
    expect(marca("validada")).toBe("validada");
    expect(marca("pendiente")).toBe("pendiente");
    expect(marca("proyecto")).toBe("estado de trabajo");
  });

  it("lo reemplazado y lo vencido salen con su filtro y siguen en su historia", async () => {
    const r = await buscador.buscar("sqlite", {
      filtros: { contexto: ctx, incluirReemplazadas: true, incluirVencidas: true, validacion: ["validada", "pendiente", "rechazada"] },
      limite: 50,
    });
    expect(claves(r)).toEqual(expect.arrayContaining(["original", "vencida", "rechazada"]));
    expect(r.resultados.find((x) => x.entrada.id === ids.rechazada)?.marca).toBe("rechazada");
    expect(t.store.obtener(ids.original!).vida).toBe("reemplazada");
    expect(t.store.revisiones(ids.original!).map((x) => x.instantanea.vida)).toEqual(["activa", "reemplazada"]);
  });

  it("filtra por ámbito, tipo y estado de validación, y abre todos los ámbitos a pedido", async () => {
    expect(claves(await buscador.buscar("sqlite", { filtros: { contexto: ctx, ambito: "global" } }))).toEqual(["global"]);
    expect(claves(await buscador.buscar("sqlite", { filtros: { contexto: ctx, tipos: ["proyecto"] } }))).toEqual(["proyecto"]);
    expect(claves(await buscador.buscar("sqlite", { filtros: { contexto: ctx, validacion: ["pendiente"] } }))).toEqual(["pendiente", "proyecto"]);
    expect(claves(await buscador.buscar("sqlite", { filtros: { contexto: ctx, todosLosAmbitos: true }, limite: 50 }))).toContain("ajena");
  });
});
