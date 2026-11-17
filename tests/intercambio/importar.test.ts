import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClienteServicio } from "../../src/client.js";
import { cargarConfig } from "../../src/config.js";
import type { Database } from "../../src/db/driver.js";
import { exportarZip } from "../../src/intercambio/exportar.js";
import { Importaciones } from "../../src/intercambio/importaciones.js";
import { leerZip } from "../../src/intercambio/zip.js";
import { TOPES_IMPORTACION } from "../../src/intercambio/formato.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { asegurarBuild } from "../helpers/servicio.js";
import { dirTemporal, storeTemporal } from "../helpers/temp.js";
import { entradaMd, manifestPara, zipCrudo, type ArchivoCrudo } from "../helpers/zip.js";

// Importar valida el zip todo o nada y deja en espera lo que puede entrar, sin tocar la memoria. Un zip hostil se
// rechaza entero, nombrando la causa y lo esperado.

let t: ReturnType<typeof storeTemporal>;
let tmp: ReturnType<typeof dirTemporal>;
let imp: Importaciones;
const GLOBAL = { ambito: "global" as const, ref: null };

beforeEach(() => {
  t = storeTemporal({ embedder: new EmbedderFalso() });
  tmp = dirTemporal("agent-memory-importar-");
  imp = new Importaciones(t.store);
});
afterEach(() => {
  t.cerrar();
  tmp.limpiar();
});

const n = (db: Database, tabla: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get() as { n: number }).n);
const filas = () => ["entradas", "revisiones", "relaciones", "importaciones", "importacion_entradas", "importacion_relaciones"].map((x) => n(t.store.db, x));

function guardar(nombre: string, zip: Buffer): string {
  const ruta = join(tmp.dir, nombre);
  writeFileSync(ruta, zip);
  return ruta;
}

/** Un zip con el manifest correcto para las entradas dadas, más los archivos crudos extra. */
function zipCon(entradas: { id: number; titulo: string; tipo?: string; extra?: Record<string, unknown> }[], extra: ArchivoCrudo[] = []): Buffer {
  const rutas = entradas.map((e) => `entradas/${String(e.id).padStart(5, "0")}-e.md`);
  return zipCrudo([
    { nombre: "manifest.json", datos: manifestPara(rutas) },
    ...entradas.map((e, i) => ({ nombre: rutas[i] as string, datos: entradaMd(e.id, e.titulo, `contenido de ${e.titulo}`, e.tipo, e.extra) })),
    ...extra,
  ]);
}

const valida = (id = 1) => [{ id, titulo: `Entrada ${id}` }];
const md = (id: number) => entradaMd(id, `Entrada ${id}`, "c");

describe("zips hostiles: se rechazan enteros y nada cambia", () => {
  const casos: [string, () => Buffer, string, RegExp][] = [
    ["ruta con ..", () => zipCon(valida(), [{ nombre: "../../.ssh/authorized_keys", datos: Buffer.from("x") }]), "zip_ruta_insegura", /«\.\.\/\.\.\/\.ssh\/authorized_keys».*sin «\.\.»/],
    ["ruta absoluta", () => zipCon(valida(), [{ nombre: "/etc/passwd", datos: Buffer.from("x") }]), "zip_ruta_insegura", /«\/etc\/passwd».*rutas relativas/],
    ["enlace simbólico", () => zipCon(valida(), [{ nombre: "entradas/00009-e.md", datos: Buffer.from("/etc/passwd"), modo: 0o120777 }]), "zip_enlace", /enlace simbólico.*archivos comunes/],
    ["archivo ajeno", () => zipCon(valida(), [{ nombre: "__MACOSX/x", datos: Buffer.from("x") }]), "zip_archivo_ajeno", /«__MACOSX\/x».*solo manifest\.json/],
    [
      "nombres duplicados",
      () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara(["entradas/00001-e.md"]) }, { nombre: "entradas/00001-e.md", datos: md(1) }, { nombre: "entradas/00001-e.md", datos: md(2) }]),
      "zip_nombre_repetido",
      /dos veces «entradas\/00001-e\.md».*un nombre por archivo/,
    ],
    [
      "cabecera local distinta de la central",
      () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara(["entradas/00001-e.md"]) }, { nombre: "entradas/00001-e.md", nombreLocal: "entradas/00001-x.md", datos: md(1) }]),
      "zip_danado",
      /cabecera local de «entradas\/00001-e\.md» no coincide/,
    ],
    ["zip truncado", () => zipCon(valida()).subarray(0, -40), "zip_danado", /truncado.*zip completo/],
    ["manifest sin formato", () => zipCrudo([{ nombre: "manifest.json", datos: Buffer.from(JSON.stringify({ entradas: [] })) }]), "manifest_invalido", /no cumple el formato 1: formato:/],
    ["formato futuro", () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara([], { formato: 2 }) }]), "formato_futuro", /formato 2.*hasta el 1/],
    [
      "entrada que infla a 300 KB",
      () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara(["entradas/00001-e.md"]) }, { nombre: "entradas/00001-e.md", datos: Buffer.alloc(300 * 1024, 97) }]),
      "zip_entrada_grande",
      /máximo por archivo es 262144/,
    ],
    [
      "tamaño declarado menor que el real",
      () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara(["entradas/00001-e.md"]) }, { nombre: "entradas/00001-e.md", datos: md(1), declarado: 10 }]),
      "zip_danado",
      /declara 10 bytes/,
    ],
    [
      "bomba que declara 1 KB e infla a 60 MB",
      () => zipCrudo([{ nombre: "manifest.json", datos: manifestPara(["entradas/00001-e.md"]) }, { nombre: "entradas/00001-e.md", datos: Buffer.alloc(60 * 1024 * 1024), declarado: 1024 }]),
      "zip_entrada_grande",
      /máximo por archivo/,
    ],
    [
      "2 001 entradas",
      () => {
        const rutas = Array.from({ length: 2001 }, (_, i) => `entradas/${i + 1}.md`);
        return zipCrudo([{ nombre: "manifest.json", datos: Buffer.from("{}") }, ...rutas.map((r) => ({ nombre: r, datos: Buffer.from("x"), metodo: 0 }))]);
      },
      "zip_demasiadas_entradas",
      /el máximo es 2001/,
    ],
    [
      "más de 50 MB inflados en total",
      () => zipCrudo(Array.from({ length: 201 }, (_, i) => ({ nombre: `entradas/${i}.md`, datos: Buffer.alloc(255 * 1024, 97) }))),
      "zip_inflado_grande",
      /pasa de 52428800 bytes/,
    ],
  ];

  for (const [nombre, armar, codigo, mensaje] of casos) {
    it(nombre, () => {
      const ruta = guardar("hostil.zip", armar());
      const antes = filas();
      expect(() => imp.importar(ruta, GLOBAL, false)).toThrow(expect.objectContaining({ codigo, message: expect.stringMatching(mensaje) }));
      expect(filas()).toEqual(antes);
    });
  }

  it("un archivo de 21 MB se rechaza por su tamaño, antes de leerlo", () => {
    const ruta = guardar("grande.zip", Buffer.alloc(21 * 1024 * 1024));
    expect(() => imp.importar(ruta, GLOBAL, false)).toThrow(expect.objectContaining({ codigo: "zip_grande", message: expect.stringMatching(/el máximo es 20971520/) }));
    expect(() => leerZip(readFileSync(ruta), TOPES_IMPORTACION)).toThrow(expect.objectContaining({ codigo: "zip_grande" }));
    expect(filas().every((x) => x === 0)).toBe(true);
  });
});

describe("un zip válido queda en espera", () => {
  it("con las exclusiones contadas por causa y la memoria intacta", () => {
    const zip = zipCon([
      { id: 1, titulo: "Lección útil" },
      { id: 2, titulo: "Estado ajeno", tipo: "proyecto" },
      { id: 3, titulo: "Vencida", extra: { vigencia_hasta: "2020-01-01" } },
      { id: 4, titulo: "Hallazgo", tipo: "hallazgo" },
      { id: 5, titulo: "Preferencia ajena", tipo: "preferencia" },
    ]);
    const ruta = guardar("equipo.zip", zip);
    const r = imp.importar(ruta, { ambito: "proyecto", ref: "mi-proyecto" }, false);
    expect(r).toEqual({
      importacion: 1,
      archivo: "equipo.zip",
      ambito: { ambito: "proyecto", ref: "mi-proyecto" },
      en_espera: 1,
      fuera: { proyecto: 1, vencida: 1, tipo_desconocido: 1, preferencia: 1 },
    });
    expect(n(t.store.db, "entradas")).toBe(0);
    expect(imp.enEspera()).toMatchObject([{ id: 1, archivo: "equipo.zip", ambito: "proyecto", ambito_ref: "mi-proyecto", quedan: 1, resueltas: 0 }]);

    expect(() => imp.importar(ruta, GLOBAL, false)).toThrow(expect.objectContaining({ codigo: "importacion_en_espera", message: expect.stringMatching(/importación 1/) }));
    const otro = guardar("otro.zip", zipCon([{ id: 5, titulo: "Preferencia ajena", tipo: "preferencia" }]));
    expect(imp.importar(otro, GLOBAL, true)).toMatchObject({ importacion: 2, en_espera: 1, fuera: { preferencia: 0 } });
  });

  it("si nada puede entrar no queda importación", () => {
    const ruta = guardar("solo-pref.zip", zipCon([{ id: 1, titulo: "Pref", tipo: "preferencia" }]));
    expect(imp.importar(ruta, GLOBAL, false)).toMatchObject({ importacion: null, en_espera: 0, fuera: { preferencia: 1 } });
    expect(n(t.store.db, "importaciones")).toBe(0);
  });

  it.skipIf(process.platform === "win32")("acepta un zip rehecho con `zip -r` del sistema", async () => {
    const otro = storeTemporal({ embedder: new EmbedderFalso() });
    try {
      const a = (await otro.store.crear({ tipo: "leccion", titulo: "Una", contenido: "u", ambito: "global", ambitoRef: null }, { actor: "persona" })).entrada.id;
      const b = (await otro.store.crear({ tipo: "decision", titulo: "Dos", contenido: "d", ambito: "global", ambitoRef: null }, { actor: "persona" })).entrada.id;
      otro.store.relacionar(a, b);
      const original = join(tmp.dir, "original.zip");
      exportarZip(otro.store, original);
      const carpeta = join(tmp.dir, "descomprimido");
      mkdirSync(carpeta);
      execFileSync("unzip", ["-q", original, "-d", carpeta]);
      const rehecho = join(tmp.dir, "rehecho.zip");
      execFileSync("zip", ["-q", "-r", rehecho, "manifest.json", "entradas"], { cwd: carpeta });
      expect(imp.importar(rehecho, GLOBAL, false)).toMatchObject({ importacion: 1, en_espera: 2 });
      expect(n(t.store.db, "importacion_relaciones")).toBe(1);
    } finally {
      otro.cerrar();
    }
  });
});

describe("agent-memory import", () => {
  let e: EntornoCli;
  beforeAll(() => asegurarBuild());
  afterEach(async () => e?.limpiar());

  it("pide --ambito, deja la importación en espera con la frase para el agente y no repite un zip en espera", async () => {
    e = await entornoCli();
    expect((await correr(e, ["start"])).code).toBe(0);
    const cliente = new ClienteServicio(cargarConfig(e.env));
    await cliente.llamar("crear", { tipo: "leccion", titulo: "Compartible", contenido: "c", ambito: "global" });
    await cliente.llamar("crear", { tipo: "preferencia", titulo: "Mía", contenido: "p", ambito: "global" });
    const zip = join(e.raiz, "equipo.zip");
    expect((await correr(e, ["export", "--zip", "--destino", zip])).code).toBe(0);

    const sinAmbito = await correr(e, ["import", zip]);
    expect(sinAmbito.code).toBe(2);
    expect(sinAmbito.stderr).toMatch(/--ambito: global, proyecto:<nombre> o repo:<id>/);

    const r = await correr(e, ["import", zip, "--ambito", "global"], { cwd: e.raiz });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Importación 1 en espera: 1 entradas de equipo.zip, en el ámbito global.");
    expect(r.stdout).toContain("Quedaron fuera 1: 1 preferencias (sumalas con --con-preferencias).");
    expect(r.stdout).toContain("pedile a tu agente «procesá la importación 1 de agent-memory»");

    const otra = await correr(e, ["import", "equipo.zip", "--ambito", "proyecto:x"], { cwd: e.raiz });
    expect(otra.code).toBe(1);
    expect(otra.stderr).toMatch(/importacion_en_espera.*importación 1/);
  });
});
