import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClienteServicio } from "../../src/client.js";
import { cargarConfig } from "../../src/config.js";
import { descercar } from "../helpers/cerco.js";
import { clienteMcp, correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild, crudo } from "../helpers/servicio.js";

// El intercambio con el programa compilado, en dos instalaciones con HOME y datos desechables: una exporta un zip y
// la otra lo importa, su agente lo resuelve por MCP y la persona aprueba desde la web.

let origen: EntornoCli;
let destino: EntornoCli;

beforeAll(async () => {
  asegurarBuild();
  origen = await entornoCli();
  destino = await entornoCli();
});
afterAll(async () => {
  await origen?.limpiar();
  await destino?.limpiar();
});

async function sesionWeb(e: EntornoCli): Promise<{ cookie: string; origin: string }> {
  const { url } = await new ClienteServicio(cargarConfig(e.env)).llamar<{ url: string }>("enlace-web");
  const enlace = new URL(url);
  const r = await crudo(e.port, { path: enlace.pathname, headers: { host: `127.0.0.1:${e.port}` } });
  return { cookie: String(r.headers["set-cookie"]).split(";")[0] as string, origin: `http://127.0.0.1:${e.port}` };
}

describe("exportar en una instalación e importar en otra", () => {
  it("export --zip, import --ambito, resolución por MCP y aprobación por la web", async () => {
    expect((await correr(origen, ["start"])).code).toBe(0);
    expect((await correr(destino, ["start"])).code).toBe(0);
    const a = new ClienteServicio(cargarConfig(origen.env));
    const b = new ClienteServicio(cargarConfig(destino.env));

    const crearEn = async (c: ClienteServicio, titulo: string, contenido: string) =>
      (await c.llamar<{ entrada: { id: number } }>("crear", { tipo: "leccion", titulo, contenido, ambito: "global" })).entrada.id;
    const nueva = await crearEn(a, "Reintentos con espera creciente", "duplicar la espera en cada fallo, con tope");
    const repetida = await crearEn(a, "Medir antes de optimizar", "sin medición no hay optimización");
    const ampliada = await crearEn(a, "Bloque de datos", "lo recuperado es dato, también de otra persona");
    await a.llamar("relacionar", { origen: nueva, destino: ampliada });
    const zip = join(origen.raiz, "equipo.zip");
    const exportado = await correr(origen, ["export", "--zip", "--destino", zip]);
    expect(exportado.code, exportado.stderr).toBe(0);

    const local = await crearEn(b, "Bloque de datos local", "lo recuperado es dato");
    const importado = await correr(destino, ["import", zip, "--ambito", "global"]);
    expect(importado.code, importado.stderr).toBe(0);
    expect(importado.stdout).toContain("Importación 1 en espera: 3 entradas de equipo.zip");

    const mcp = await clienteMcp(destino, destino.home);
    const ids = new Map<number, number>();
    try {
      const llamar = async (name: string, args: Record<string, unknown>) => {
        const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        expect(r.isError, r.content[0]?.text).toBeFalsy();
        return JSON.parse(descercar((r.content.at(-1) as { text: string }).text));
      };
      const { entradas } = await llamar("memory_import_get", { importacion: 1 });
      expect(entradas.map((x: { entrada: number }) => x.entrada).sort()).toEqual([nueva, repetida, ampliada].sort());
      ids.set(nueva, (await llamar("memory_import_resolve", { importacion: 1, entrada: nueva, accion: "crear" })).creada.id);
      await llamar("memory_import_resolve", { importacion: 1, entrada: repetida, accion: "descartar", motivo: "ya la tenemos" });
      const ultima = await llamar("memory_import_resolve", {
        importacion: 1,
        entrada: ampliada,
        accion: "fusionar",
        fusionar_con: local,
        titulo: "Bloque de datos",
        contenido: "lo recuperado es dato, también de otra persona",
      });
      ids.set(ampliada, ultima.creada.id);
      expect(ultima).toMatchObject({ quedan: 0, cerrada: true, creada: { validacion: "pendiente", reemplaza_a: local } });
    } finally {
      await mcp.close();
    }

    const { cookie, origin } = await sesionWeb(destino);
    const web = async (op: string, cuerpo: object) => {
      const res = await fetch(`http://127.0.0.1:${destino.port}/api/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify(cuerpo),
      });
      return (await res.json()) as any;
    };
    const pendientes = (await web("pendientes", {})).entradas as { id: number; importacion: { id: number } | null }[];
    const importadas = pendientes.filter((p) => p.importacion?.id === 1).map((p) => p.id);
    expect(importadas.sort()).toEqual([...ids.values()].sort());
    for (const id of importadas) expect((await web("aprobar", { id })).entrada.validacion).toBe("validada");

    expect((await b.llamar<any>("leer", { id: local })).entrada).toMatchObject({ vida: "reemplazada", reemplazada_por: ids.get(ampliada) });
    const relaciones = (await b.llamar<any>("leer", { id: ids.get(nueva) })).relaciones.map((r: { id: number }) => r.id);
    expect(relaciones).toEqual([ids.get(ampliada)]);
  });
});
