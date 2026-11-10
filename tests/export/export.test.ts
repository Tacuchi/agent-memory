import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportar, nombreArchivo } from "../../src/export/export.js";
import { MemoryStore } from "../../src/store/store.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { leerExportado } from "../helpers/markdown.js";
import { asegurarBuild, servicioDePrueba } from "../helpers/servicio.js";
import { dirTemporal, storeTemporal } from "../helpers/temp.js";
import { comoPersona, sesionWeb } from "../helpers/web.js";

// AC-22: un .md por entrada, legible sin el servicio, con el contenido y sus estados en la
// cabecera. Por defecto las activas; con la opción completa, todas con su historia.

let t: ReturnType<typeof storeTemporal>;
let salida: ReturnType<typeof dirTemporal>;

async function sembrar(store: MemoryStore) {
  const persona = { actor: "persona" as const };
  const activa = (await store.crear({ tipo: "convencion", titulo: "Convención «activa»: sí", contenido: "línea 1\n---\nlínea: 3", ambito: "global", ambitoRef: null }, persona)).entrada;
  await store.editar(activa.id, { contenido: "línea 1\n---\nlínea: 3 editada" }, persona);
  const vieja = (await store.crear({ tipo: "leccion", titulo: "Vieja", contenido: "v1", ambito: "global", ambitoRef: null }, persona)).entrada;
  const nueva = (await store.crear({ tipo: "leccion", titulo: "Nueva", contenido: "v2", ambito: "global", ambitoRef: null, reemplazaA: vieja.id }, persona)).entrada;
  const rechazada = (await store.crear({ tipo: "decision", titulo: "Rechazada", contenido: "x", ambito: "global", ambitoRef: null }, { actor: "agente" })).entrada;
  store.rechazar(rechazada.id, "no aplica");
  const vencida = (await store.crear({ tipo: "referencia", titulo: "Vencida", contenido: "r", ambito: "global", ambitoRef: null }, persona)).entrada;
  store.caducar(vencida.id, { actor: "persona" });
  return { activa: activa.id, vieja: vieja.id, nueva: nueva.id, rechazada: rechazada.id, vencida: vencida.id };
}

beforeEach(() => {
  t = storeTemporal({ embedder: new EmbedderFalso() });
  salida = dirTemporal("agent-memory-export-");
});
afterEach(() => {
  t.cerrar();
  salida.limpiar();
});

describe("exportación", () => {
  it("por defecto exporta las activas, un .md por entrada con estados en la cabecera", async () => {
    const ids = await sembrar(t.store);
    const destino = join(salida.dir, "activas");
    const r = exportar(t.store, destino);
    expect(r.archivos).toBe(2);
    const archivos = readdirSync(destino).sort();
    expect(archivos).toEqual([nombreArchivo(t.store.obtener(ids.activa)), nombreArchivo(t.store.obtener(ids.nueva))].sort());

    t.store.close();
    // Se lee sin el servicio ni la base: solo el archivo.
    const { cabecera, cuerpo } = leerExportado(join(destino, nombreArchivo({ id: ids.activa, titulo: "Convención «activa»: sí" })));
    expect(cabecera).toMatchObject({
      id: ids.activa,
      titulo: "Convención «activa»: sí",
      tipo: "convencion",
      ambito: "global",
      vida: "activa",
      validacion: "validada",
      validacion_via: "web",
      vigencia_hasta: null,
    });
    expect(cuerpo).toContain("línea: 3 editada");
    expect(cuerpo).not.toContain("## Revisiones");
    t = storeTemporal();
  });

  it("la completa trae todas las entradas, con sus estados y su historia", async () => {
    const ids = await sembrar(t.store);
    const destino = join(salida.dir, "completa");
    expect(exportar(t.store, destino, { completa: true }).archivos).toBe(5);
    const leer = (id: number) => leerExportado(join(destino, nombreArchivo(t.store.obtener(id))));
    expect(leer(ids.vieja).cabecera).toMatchObject({ vida: "reemplazada", reemplazada_por: ids.nueva });
    expect(leer(ids.rechazada).cabecera).toMatchObject({ validacion: "rechazada", motivo_rechazo: "no aplica" });
    expect(leer(ids.vencida).cabecera).toMatchObject({ caducidad_por: "persona" });
    expect(leer(ids.vencida).cabecera.vigencia_hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { cuerpo } = leer(ids.activa);
    expect(cuerpo).toContain("## Revisiones");
    expect(cuerpo).toContain("### Revisión 1 · crear · persona");
    expect(cuerpo).toContain("### Revisión 2 · editar · persona");
    expect(cuerpo).toMatch(/Revisión 1[\s\S]*línea: 3\n```/);
  });

  it("el contenido de cada revisión va tal cual, aunque traiga bloques de código", async () => {
    const persona = { actor: "persona" as const };
    const contenido = "antes\n```ts\nconst x = 1;\n```\ny ````cuatro````";
    const e = (await t.store.crear({ tipo: "referencia", titulo: "Con código", contenido, ambito: "global", ambitoRef: null }, persona)).entrada;
    const destino = join(salida.dir, "codigo");
    exportar(t.store, destino, { completa: true });
    const { cuerpo } = leerExportado(join(destino, nombreArchivo(e)));
    expect(cuerpo).toContain(`\`\`\`\`\`text\n${contenido}\n\`\`\`\`\``);
  });

  it("nunca pisa archivos: una carpeta no vacía o un archivo se rechazan", async () => {
    await sembrar(t.store);
    const destino = join(salida.dir, "ocupada");
    mkdirSync(destino);
    writeFileSync(join(destino, "otro.txt"), "de la persona");
    expect(() => exportar(t.store, destino)).toThrow(/no está vacía/);
    expect(readdirSync(destino)).toEqual(["otro.txt"]);
    expect(() => exportar(t.store, join(destino, "otro.txt"))).toThrow(/no es una carpeta/);
  });
});

describe("exportar desde la web", () => {
  it("la persona exporta con su sesión a una carpeta nueva y no elige rutas", async () => {
    const s = await servicioDePrueba();
    try {
      const { cookie } = await sesionWeb(s);
      await comoPersona(s, cookie, "crear", { tipo: "leccion", titulo: "Desde la web", contenido: "c", ambito: "global" });
      const r = await comoPersona(s, cookie, "exportar", { completa: true });
      expect(r.status).toBe(200);
      expect(r.datos.archivos).toBe(1);
      expect(r.datos.destino.startsWith(join(s.home, "exportaciones"))).toBe(true);
      expect(leerExportado(join(r.datos.destino, readdirSync(r.datos.destino)[0] as string)).cabecera.titulo).toBe("Desde la web");
      const ruta = await comoPersona(s, cookie, "exportar", { destino: join(s.home, "otra") });
      expect(ruta.status).toBe(400);
      expect(ruta.datos.error.codigo).toBe("destino_no_permitido");
    } finally {
      await s.cerrar();
    }
  });
});

describe("agent-memory export", () => {
  let e: EntornoCli;
  beforeAll(() => asegurarBuild());
  afterEach(async () => e?.limpiar());

  it("exporta las activas y, con --completa, todo; con --destino, en esa carpeta", async () => {
    e = await entornoCli();
    expect((await correr(e, ["start"])).code).toBe(0);
    const destino = join(e.raiz, "mi-export");
    const r = await correr(e, ["export", "--destino", destino]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`0 entradas exportadas (activas) en ${destino}`);
    const completa = await correr(e, ["export", "--completa"]);
    expect(completa.code, completa.stderr).toBe(0);
    expect(completa.stdout).toMatch(/exportadas con su historia en .*exportaciones/);
    const ocupada = await correr(e, ["export", "--destino", destino]);
    expect(ocupada.code).toBe(0);
    writeFileSync(join(destino, "x.md"), "x");
    const rechazo = await correr(e, ["export", "--destino", destino]);
    expect(rechazo.code).toBe(1);
    expect(rechazo.stderr).toContain("destino_ocupado");
  });
});
