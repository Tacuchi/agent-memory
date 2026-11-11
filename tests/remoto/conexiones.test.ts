import { afterEach, describe, expect, it } from "vitest";
import type { Rele } from "../../src/remoto/rele.js";
import { CLAVE_RELE, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// 0.4.1: una conexión por PC, unida por la huella de su clave, con los dos sentidos y su actividad.

const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

const GLOBAL = { ambitos: [{ ambito: "global", ref: null }], no_validadas: false };

async function pc(rele: Rele, nombre: string): Promise<Instalacion> {
  const i = await instalacion();
  abiertos.push(i);
  await i.persona("remoto_rele", { url: rele.url, clave: CLAVE_RELE });
  await i.persona("remoto_nombre", { nombre });
  await i.persona("remoto_interruptor", { encendido: true });
  return i;
}

/** `duena` le comparte a `lectora` (alcance global) y devuelve el identificador del enlace en la lectora. */
async function compartir(duena: Instalacion, lectora: Instalacion): Promise<string> {
  const { datos: c } = await duena.persona("remoto_codigo", GLOBAL);
  const r = await lectora.persona("remoto_canjear", { codigo: c.codigo });
  expect(r.status).toBe(200);
  return r.datos.origen as string;
}

describe("una conexión por PC", () => {
  it("quien me lee y a quien leo son la misma conexión, con los dos sentidos y la actividad de cada uno", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const mac = await pc(rele, "tacuchi-mac");
    const win = await pc(rele, "laptop-qtc");
    const enWin = await compartir(mac, win);
    const enMac = await compartir(win, mac);
    for (const i of [mac, win]) {
      await i.app.store.crear(
        { tipo: "leccion", titulo: "Una global", contenido: "contenido global", ambito: "global", ambitoRef: null },
        { actor: "agente", confirmado: true },
      );
    }

    expect((await win.agente("listar", { origen: enWin })).status).toBe(200);
    expect((await mac.agente("buscar", { consulta: "global" })).status).toBe(200);
    expect((await mac.agente("leer", { id: 999, origen: enMac })).status).not.toBe(200);

    const { datos } = await mac.persona("remoto_estado");
    expect(datos.conexiones).toHaveLength(1);
    const [c] = datos.conexiones;
    expect(c).toMatchObject({
      nombre: "laptop-qtc",
      huella: win.app.remoto.huella,
      comparto: { estado: "vigente", alcance: GLOBAL },
      leo: { origen: enMac },
    });
    await esperar(async () => (await mac.persona("remoto_estado")).datos.conexiones[0].hoy.leyo === 1);
    expect((await mac.persona("remoto_estado")).datos.conexiones[0].hoy).toEqual({ leyo: 1, lei: 1, rechazos: 1 });

    const { datos: act } = await mac.persona("remoto_actividad", { huella: c.huella });
    expect(act.leyo.map((f: { herramienta: string }) => f.herramienta)).toContain("listar");
    expect(act.lei.map((f: { herramienta: string; resultado: string }) => [f.herramienta, f.resultado])).toEqual([
      ["leer", "rechazo"],
      ["buscar", "lectura"],
    ]);
    // La lectora no guarda el texto de la búsqueda (P9); la dueña sí, en su registro.
    expect(act.lei[1].pedido).toBeNull();
    expect(act.lei[1].ids.length).toBeGreaterThan(0);
    // Gobernar y mirar la actividad es de la persona.
    expect((await mac.agente("remoto_actividad", { huella: c.huella })).status).toBe(403);
  });

  it("una conexión sin ningún sentido activo queda al final como terminada", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const mac = await pc(rele, "tacuchi-mac");
    const vieja = await pc(rele, "laptop-vieja");
    const otra = await pc(rele, "desktop-casa");
    await compartir(mac, vieja);
    await compartir(mac, otra);
    const { datos: antes } = await mac.persona("remoto_estado");
    const id = antes.conexiones.find((c: { nombre: string }) => c.nombre === "laptop-vieja").comparto.id;
    await mac.persona("remoto_revocar", { id });
    const { datos } = await mac.persona("remoto_estado");
    expect(datos.conexiones.map((c: { nombre: string; comparto: { estado: string } }) => [c.nombre, c.comparto.estado])).toEqual([
      ["desktop-casa", "vigente"],
      ["laptop-vieja", "revocado"],
    ]);
  });

  it("los intentos de PCs desconocidas se cuentan aparte y se listan solos", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const mac = await pc(rele, "tacuchi-mac");
    mac.app.remoto.datos.registrar({ dispositivoId: null, dispositivo: null, herramienta: "conexion", pedido: null, ids: [], resultado: "rechazo", motivo: "desconocido" });
    const { datos } = await mac.persona("remoto_estado");
    expect(datos.desconocidas_hoy).toBe(1);
    const { datos: r } = await mac.persona("remoto_registro", { solo_desconocidas: true });
    expect(r.registro).toEqual([expect.objectContaining({ dispositivo_id: null, motivo: "desconocido" })]);
  });
});
