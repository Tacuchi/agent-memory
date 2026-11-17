import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClienteServicio } from "../../src/client.js";
import { cargarConfig } from "../../src/config.js";
import { VERSION_ESQUEMA } from "../../src/db/schema.js";
import { exportarZip } from "../../src/intercambio/exportar.js";
import { leerPaquete, MANIFEST, TOPES_IMPORTACION } from "../../src/intercambio/formato.js";
import { escribirZip, leerZip } from "../../src/intercambio/zip.js";
import type { MemoryStore } from "../../src/store/store.js";
import { version } from "../../src/version.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { asegurarBuild } from "../helpers/servicio.js";
import { dirTemporal, storeTemporal } from "../helpers/temp.js";

// Exportar para compartir: un zip con manifest, un markdown por entrada activa sin estado de trabajo y las relaciones
// entre ellas; avisa de posibles secretos sin mostrarlos y nunca pisa un archivo.

let t: ReturnType<typeof storeTemporal>;
let salida: ReturnType<typeof dirTemporal>;
const persona = { actor: "persona" as const };

async function sembrar(store: MemoryStore) {
  const crear = async (tipo: string, titulo: string, ambito: "global" | "proyecto" | "repo", ambitoRef: string | null, contenido = "contenido sintético") =>
    (await store.crear({ tipo, titulo, contenido, ambito, ambitoRef }, persona)).entrada.id;
  const global = await crear("leccion", "Lección global", "global", null);
  const delProyecto = await crear("decision", "Decisión del proyecto", "proyecto", "proyecto-x");
  const delRepo = await crear("convencion", "Convención del repo", "repo", "github.com/ejemplo/repo");
  const preferencia = await crear("preferencia", "Preferencia de la persona", "global", null);
  const trabajo = await crear("proyecto", "Estado de trabajo", "proyecto", "proyecto-x");
  store.relacionar(global, delProyecto);
  store.relacionar(global, trabajo);
  return { global, delProyecto, delRepo, preferencia, trabajo };
}

beforeEach(() => {
  t = storeTemporal({ embedder: new EmbedderFalso() });
  salida = dirTemporal("agent-memory-zip-");
});
afterEach(() => {
  t.cerrar();
  salida.limpiar();
});

describe("exportar en zip", () => {
  it("manifest, un markdown por entrada activa sin `proyecto` y solo las relaciones entre exportadas", async () => {
    const ids = await sembrar(t.store);
    const destino = join(salida.dir, "memoria.zip");
    const r = exportarZip(t.store, destino);
    expect(r).toMatchObject({ destino, archivos: 4, relaciones: 1, avisos: [] });
    expect(statSync(destino).mode & 0o777).toBe(process.platform === "win32" ? statSync(destino).mode & 0o777 : 0o600);

    const archivos = leerZip(readFileSync(destino), TOPES_IMPORTACION);
    const paquete = leerPaquete(archivos);
    expect(paquete.manifest).toMatchObject({
      formato: 1,
      agent_memory: version(),
      esquema: VERSION_ESQUEMA,
      cantidades: { total: 4, por_tipo: { leccion: 1, decision: 1, convencion: 1, preferencia: 1 } },
      filtros: { ambitos: [] },
      relaciones: [[ids.global, ids.delProyecto]],
    });
    expect(paquete.manifest.exportado_en).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(archivos.map((a) => a.nombre)).toEqual([MANIFEST, ...paquete.manifest.entradas]);
    expect(paquete.entradas.map((e) => e.id).sort((a, b) => a - b)).toEqual([ids.global, ids.delProyecto, ids.delRepo, ids.preferencia]);
    expect(paquete.entradas.find((e) => e.id === ids.global)).toMatchObject({ titulo: "Lección global", tipo: "leccion", contenido: "contenido sintético" });
    // Sin vectores ni historia: solo el manifest y el markdown de siempre.
    expect(archivos.every((a) => a.nombre === MANIFEST || a.nombre.endsWith(".md"))).toBe(true);
    expect(archivos.some((a) => a.datos.toString("utf8").includes("## Revisiones"))).toBe(false);
  });

  it("los ámbitos se suman y limitan el zip; un filtro sin entradas no escribe nada", async () => {
    const ids = await sembrar(t.store);
    const leer = (destino: string) => leerPaquete(leerZip(readFileSync(destino), TOPES_IMPORTACION));
    const soloGlobal = join(salida.dir, "global.zip");
    exportarZip(t.store, soloGlobal, [{ ambito: "global", ref: null }]);
    expect(leer(soloGlobal).entradas.map((e) => e.id).sort()).toEqual([ids.global, ids.preferencia].sort());
    expect(leer(soloGlobal).manifest.filtros.ambitos).toEqual(["global"]);

    const dos = join(salida.dir, "dos.zip");
    exportarZip(t.store, dos, [{ ambito: "proyecto", ref: "proyecto-x" }, { ambito: "repo", ref: "github.com/ejemplo/repo" }]);
    expect(leer(dos).entradas.map((e) => e.id).sort()).toEqual([ids.delProyecto, ids.delRepo].sort());

    const vacio = join(salida.dir, "vacio.zip");
    expect(() => exportarZip(t.store, vacio, [{ ambito: "proyecto", ref: "otro" }])).toThrow(expect.objectContaining({ codigo: "nada_que_exportar" }));
    expect(existsSync(vacio)).toBe(false);
  });

  it("nunca pisa un archivo existente", async () => {
    await sembrar(t.store);
    const destino = join(salida.dir, "ya.zip");
    writeFileSync(destino, "de la persona");
    expect(() => exportarZip(t.store, destino)).toThrow(expect.objectContaining({ codigo: "destino_ocupado" }));
    expect(readFileSync(destino, "utf8")).toBe("de la persona");
  });

  it("avisa de posibles secretos con id, título y clase, sin el valor; un SHA y una URL larga no avisan", async () => {
    const crear = async (titulo: string, contenido: string) =>
      (await t.store.crear({ tipo: "referencia", titulo, contenido, ambito: "global", ambitoRef: null }, persona)).entrada.id;
    const token = "q8Zr2LkP0xVb7NwT4yHc9MdJ3sFa6GtE1uRi";
    const conToken = await crear("Credencial del servicio", `la clave es ${token}`);
    await crear("Commit de referencia", "ver 9a60443b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f en main");
    await crear("Enlace largo", "https://github.com/ejemplo/agent-memory/blob/main/docs/guias/2026-11-compartir-memoria-entre-equipos.md");
    const r = exportarZip(t.store, join(salida.dir, "secretos.zip"));
    expect(r.avisos).toEqual([{ id: conToken, titulo: "Credencial del servicio", clases: ["cadena_aleatoria"] }]);
    expect(JSON.stringify(r.avisos)).not.toContain(token);
  });

  it("el zip que escribe lo lee `unzip -t` y el lector propio", () => {
    const archivos = [
      { nombre: MANIFEST, datos: Buffer.from("{}") },
      { nombre: "entradas/00001-ñandú-y-acentos.md", datos: Buffer.from("x".repeat(10_000)) },
    ];
    const ruta = join(salida.dir, "propio.zip");
    writeFileSync(ruta, escribirZip(archivos, new Date("2026-11-17T10:20:30")));
    expect(leerZip(readFileSync(ruta), TOPES_IMPORTACION)).toEqual(archivos);
    if (process.platform !== "win32") expect(execFileSync("unzip", ["-t", ruta], { encoding: "utf8" })).toMatch(/No errors detected/);
  });
});

describe("agent-memory export --zip", () => {
  let e: EntornoCli;
  beforeAll(() => asegurarBuild());
  afterEach(async () => e?.limpiar());

  it("escribe el zip, filtra con --ambito y --proyecto, y rechaza --completa y un filtro vacío", async () => {
    e = await entornoCli();
    expect((await correr(e, ["start"])).code).toBe(0);
    const vacio = await correr(e, ["export", "--zip", "--destino", join(e.raiz, "nada.zip")]);
    expect(vacio.code).toBe(1);
    expect(vacio.stderr).toContain("nada_que_exportar");
    expect(existsSync(join(e.raiz, "nada.zip"))).toBe(false);

    const completa = await correr(e, ["export", "--zip", "--completa"]);
    expect(completa.code).toBe(1);
    expect(completa.stderr).toMatch(/zip_sin_completa.*historia/);

    const sinZip = await correr(e, ["export", "--ambito", "global"]);
    expect(sinZip.code).toBe(2);
    expect(sinZip.stderr).toContain("agregá --zip");

    const malo = await correr(e, ["export", "--zip", "--ambito", "proyecto"]);
    expect(malo.code).toBe(2);
    expect(malo.stderr).toContain("«global», «proyecto:<nombre>» o «repo:<id>»");

    const cliente = new ClienteServicio(cargarConfig(e.env));
    await cliente.llamar("crear", { tipo: "leccion", titulo: "Global", contenido: "g", ambito: "global" });
    await cliente.llamar("crear", { tipo: "referencia", titulo: "Token suelto", contenido: "q8Zr2LkP0xVb7NwT4yHc9MdJ3sFa6GtE1uRi", ambito: "global" });
    const destino = join(e.raiz, "compartir", "memoria.zip");
    const r = await correr(e, ["export", "--zip", "--ambito", "global", "--destino", destino]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`2 entradas y 0 relaciones exportadas en ${destino} (zip para compartir)`);
    expect(r.stderr).toMatch(/aviso: #\d+ «Token suelto» parece traer un secreto \(cadena_aleatoria\)/);
    expect(r.stderr).not.toContain("q8Zr2LkP0xVb7NwT4yHc9MdJ3sFa6GtE1uRi");
    const proyecto = await correr(e, ["export", "--zip", "--proyecto", "sin-entradas"]);
    expect(proyecto.code).toBe(1);
    expect(proyecto.stderr).toContain("nada_que_exportar");
  });
});
