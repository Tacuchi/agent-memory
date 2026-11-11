import { afterEach, describe, expect, it } from "vitest";
import type { Rele } from "../../src/remoto/rele.js";
import { EstadoRele } from "../../src/remoto/rele-estado.js";
import { conectarControl, ErrorRele } from "../../src/remoto/transporte.js";
import { CLAVE_RELE, enlazar, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// Plan 007, F2: las órdenes del panel según D01. Restringir se cumple directo; ampliar queda pendiente en la web
// local de la dueña (AC-05, AC-06, AC-07, AC-10, AC-11, AC-13).

const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

interface Mundo {
  rele: Rele;
  duena: Instalacion;
  lectora: Instalacion;
  id: number;
}

async function mundo(): Promise<Mundo> {
  const rele = await releLocal();
  const duena = await instalacion();
  const lectora = await instalacion();
  abiertos.push(rele, duena, lectora);
  const id = await enlazar(duena, lectora, rele);
  await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
  await esperar(() => rele.estado.conectada(duena.app.remoto.huella) && rele.estado.conectada(lectora.app.remoto.huella));
  return { rele, duena, lectora, id };
}

const huella = (i: Instalacion) => i.app.remoto.huella;

describe("órdenes que restringen: se cumplen directo", () => {
  it("revocar desde el panel corta la siguiente lectura y queda en el registro de la dueña (AC-07)", async () => {
    const m = await mundo();
    const { entrada } = await m.duena.app.store.crear(
      { tipo: "leccion", titulo: "Compartida", contenido: "visible", ambito: "global", ambitoRef: null },
      { actor: "agente", confirmado: true },
    );
    expect((await m.lectora.agente("leer", { id: entrada.id, origen: "trabajo" })).status).toBe(200);
    const r = await m.rele.estado.ordenar(huella(m.duena), { accion: "revocar", objetivo: huella(m.lectora) });
    expect(r.estado).toBe("hecho");
    const despues = await m.lectora.agente("leer", { id: entrada.id, origen: "trabajo" });
    expect(despues.status).not.toBe(200);
    const { datos } = await m.duena.persona("remoto_registro", {});
    expect(datos.registro).toContainEqual(expect.objectContaining({ herramienta: "panel", motivo: "revocado_desde_panel" }));
  });

  it("quitar enlace desde el panel borra el enlace de la lectora (AC-07)", async () => {
    const m = await mundo();
    const r = await m.rele.estado.ordenar(huella(m.lectora), { accion: "quitar_enlace", objetivo: "trabajo" });
    expect(r.estado).toBe("hecho");
    expect(m.lectora.app.remoto.datos.enlaces()).toEqual([]);
  });

  it("cerrar las conexiones de una PC la desconecta y vuelve sola (AC-05)", async () => {
    const m = await mundo();
    expect(m.rele.estado.cerrarPc(huella(m.duena))).toBeGreaterThan(0);
    expect(m.rele.estado.conectada(huella(m.duena))).toBe(false);
    await esperar(() => m.rele.estado.conectada(huella(m.duena)));
  });

  it("una PC bloqueada no puede volver a conectarse hasta desbloquearla (AC-06)", async () => {
    const m = await mundo();
    m.rele.estado.bloquear({ pc: huella(m.duena) }, "1h");
    await esperar(() => !m.rele.estado.conectada(huella(m.duena)));
    const rele = m.duena.app.remoto.datos.rele() as { url: string; clave: string };
    const intento = conectarControl({ url: rele.url, clave: CLAVE_RELE, pc: huella(m.duena) });
    await expect(intento).rejects.toBeInstanceOf(ErrorRele);
    await expect(intento).rejects.toMatchObject({ codigo: "bloqueado" });
    expect(m.rele.estado.vista("prueba", 256).bloqueos).toEqual([expect.objectContaining({ tipo: "pc", valor: huella(m.duena) })]);
    m.rele.estado.desbloquear({ pc: huella(m.duena) });
    const canal = await conectarControl({ url: rele.url, clave: CLAVE_RELE, pc: huella(m.duena) });
    canal.cerrar();
  });

  it("un bloqueo de 1 h vence solo y uno indefinido no (AC-13)", () => {
    let ahora = 1_000_000;
    const e = new EstadoRele(() => ahora);
    e.bloquear({ ip: "192.0.2.55" }, "1h");
    e.bloquear({ ip: "192.0.2.88" }, "indefinido");
    expect(e.bloqueado(null, "192.0.2.55")).toBe(true);
    ahora += 3600_001;
    expect(e.bloqueado(null, "192.0.2.55")).toBe(false);
    expect(e.bloqueado(null, "192.0.2.88")).toBe(true);
    expect(e.vista("prueba", 256).bloqueos).toEqual([{ tipo: "ip", valor: "192.0.2.88", hasta: null }]);
  });
});

describe("órdenes que amplían: quedan pendientes en la dueña (D01)", () => {
  it("renovar queda pendiente hasta que la persona lo acepta en la web local (AC-10)", async () => {
    const m = await mundo();
    const antes = m.duena.app.remoto.datos.dispositivo(m.id).venceEn;
    m.duena.avanzar(24 * 3600_000);
    const r = await m.rele.estado.ordenar(huella(m.duena), { accion: "renovar", objetivo: huella(m.lectora) });
    expect(r.estado).toBe("pendiente");
    expect(m.duena.app.remoto.datos.dispositivo(m.id).venceEn).toBe(antes);
    const { datos } = await m.duena.persona("remoto_estado");
    expect(datos.pendientes).toEqual([expect.objectContaining({ accion: "renovar", dispositivo: { id: m.id, nombre: "casa" } })]);
    // Un agente no acepta pedidos del panel.
    expect((await m.duena.agente("remoto_pendiente", { id: datos.pendientes[0].id, aceptar: true })).status).toBe(403);
    const ok = await m.duena.persona("remoto_pendiente", { id: datos.pendientes[0].id, aceptar: true });
    expect(ok.status).toBe(200);
    expect(m.duena.app.remoto.datos.dispositivo(m.id).venceEn > antes).toBe(true);
    await esperar(() => m.rele.estado.vista("prueba", 256).pcs.find((p) => p.huella === huella(m.duena))?.pendientes.length === 0);
  });

  it("cambiar el alcance queda pendiente y rechazarlo no cambia nada (AC-10)", async () => {
    const m = await mundo();
    const r = await m.rele.estado.ordenar(huella(m.duena), {
      accion: "alcance",
      objetivo: huella(m.lectora),
      datos: { ambitos: ["global", "proyecto:sintetico"], pendientes: true },
    });
    expect(r.estado).toBe("pendiente");
    const { datos } = await m.duena.persona("remoto_estado");
    await m.duena.persona("remoto_pendiente", { id: datos.pendientes[0].id, aceptar: false });
    expect(m.duena.app.remoto.datos.dispositivo(m.id).alcance).toEqual({ ambitos: [{ ambito: "global", ref: null }], noValidadas: false });
  });

  it("un código pedido desde el panel se ve solo en la web local, nunca en el relé (AC-11)", async () => {
    const m = await mundo();
    expect((await m.rele.estado.ordenar(huella(m.duena), { accion: "codigo" })).estado).toBe("pendiente");
    const { datos } = await m.duena.persona("remoto_estado");
    const aceptado = await m.duena.persona("remoto_pendiente", { id: datos.pendientes[0].id, aceptar: true });
    const codigo = aceptado.datos.codigo.codigo as string;
    expect(codigo.length).toBeGreaterThan(10);
    await esperar(() => Boolean(m.rele.estado.vista("prueba", 256).pcs.find((p) => p.huella === huella(m.duena))?.codigo));
    const texto = JSON.stringify(m.rele.estado.vista("prueba", 256));
    expect(texto).not.toContain(codigo);
    expect(texto).not.toContain(codigo.replace(/-/g, ""));
  });

  it("una orden a una PC desconectada responde error sin colgarse", async () => {
    const e = new EstadoRele();
    expect(await e.ordenar("AAAAAAAAAAAAAAAAAAAAAA", { accion: "renovar", objetivo: "x" })).toMatchObject({ estado: "error" });
  });
});
