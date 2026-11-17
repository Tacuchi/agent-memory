import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";
import { dirTemporal } from "../helpers/temp.js";
import { comoPersona, sesionWeb } from "../helpers/web.js";
import { entradaMd, manifestPara, zipCrudo } from "../helpers/zip.js";

// Rechazar una importación entera es de la persona: con un motivo, rechaza sus pendientes, descarta lo que siga en
// espera y no toca lo que ya estaba validado.

let s: ServicioDePrueba;
let tmp: ReturnType<typeof dirTemporal>;
let cookie: string;
const persona = (op: string, cuerpo: object = {}) => comoPersona(s, cookie, op, cuerpo);
const agente = (op: string, cuerpo: object = {}) => s.api(op, cuerpo);

beforeEach(async () => {
  s = await servicioDePrueba();
  tmp = dirTemporal("agent-memory-gob-importacion-");
  cookie = (await sesionWeb(s)).cookie;
});
afterEach(async () => {
  await s.cerrar();
  tmp.limpiar();
});

/** Una importación con tres entradas: una creada, una fusionada con una local validada y una todavía en espera. */
async function armar() {
  const local = (await persona("crear", { tipo: "leccion", titulo: "Local validada", contenido: "lo de antes", ambito: "global" })).datos.entrada;
  const rutas = [1, 2, 3].map((i) => `entradas/0000${i}-e.md`);
  const ruta = join(tmp.dir, "equipo.zip");
  writeFileSync(
    ruta,
    zipCrudo([{ nombre: "manifest.json", datos: manifestPara(rutas) }, ...rutas.map((r, i) => ({ nombre: r, datos: entradaMd(i + 1, `Entrada ${i + 1}`, "c") }))]),
  );
  const imp = (await agente("importar", { ruta, ambito: { ambito: "global", ref: null } })).datos.importacion as number;
  const creada = (await agente("resolver_importacion", { importacion: imp, entrada: 1, accion: "crear" })).datos.creada.id as number;
  const fusion = (await agente("resolver_importacion", { importacion: imp, entrada: 2, accion: "fusionar", fusionar_con: local.id, titulo: "Local ampliada", contenido: "lo de antes y más" }))
    .datos.creada.id as number;
  return { imp, local: local.id as number, creada, fusion };
}

describe("rechazar una importación", () => {
  it("sin motivo no cambia nada; el agente no puede; con motivo rechaza todo y deja la local como estaba", async () => {
    const { imp, local, creada, fusion } = await armar();
    for (const motivo of [undefined, "", "   "]) {
      const r = await persona("rechazar_importacion", motivo === undefined ? { importacion: imp } : { importacion: imp, motivo });
      expect(r.status).toBe(400);
      expect(r.datos.error.codigo).toBe("motivo_requerido");
    }
    expect((await persona("leer", { id: creada })).datos.entrada.validacion).toBe("pendiente");

    const delAgente = await agente("rechazar_importacion", { importacion: imp, motivo: "no" });
    expect(delAgente.status).toBe(403);
    expect(delAgente.datos.error.codigo).toBe("solo_persona");

    const r = await persona("rechazar_importacion", { importacion: imp, motivo: "no es para este equipo" });
    expect(r.status).toBe(200);
    expect(r.datos).toEqual({ importacion: imp, rechazadas: 2, descartadas: 1 });
    for (const id of [creada, fusion]) {
      expect((await persona("leer", { id })).datos.entrada).toMatchObject({ validacion: "rechazada", motivo_rechazo: "no es para este equipo" });
    }
    expect((await persona("leer", { id: local })).datos.entrada).toMatchObject({ validacion: "validada", vida: "activa", contenido: "lo de antes" });
    expect(s.app.store.db.prepare("SELECT estado FROM importaciones WHERE id = ?").get(imp)).toEqual({ estado: "rechazada" });
    expect(s.app.store.db.prepare("SELECT count(*) AS n FROM importacion_entradas WHERE titulo IS NOT NULL OR contenido IS NOT NULL").get()).toEqual({ n: 0 });
    expect((await agente("resolver_importacion", { importacion: imp, entrada: 3, accion: "crear" })).datos.error.codigo).toBe("importacion_no_en_espera");
    expect((await persona("rechazar_importacion", { importacion: imp, motivo: "otra vez" })).datos.error.codigo).toBe("importacion_rechazada");
  });

  it("la bandeja muestra de qué importación sale cada pendiente", async () => {
    const { imp, creada, fusion } = await armar();
    const { entradas } = (await persona("pendientes")).datos;
    for (const id of [creada, fusion]) {
      expect(entradas.find((e: { id: number }) => e.id === id).importacion).toEqual({ id: imp, archivo: "equipo.zip", importada_en: expect.any(String) });
    }
    const propia = (await agente("crear", { tipo: "leccion", titulo: "Del agente", contenido: "x", ambito: "global" })).datos.entrada.id;
    const todas = (await persona("pendientes")).datos.entradas;
    expect(todas.find((e: { id: number }) => e.id === propia).importacion).toBeNull();
  });
});
