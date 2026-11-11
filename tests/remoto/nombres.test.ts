import { afterEach, describe, expect, it } from "vitest";
import type { Rele } from "../../src/remoto/rele.js";
import { CLAVE_RELE, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// Plan 008, F1: el canje intercambia los nombres de las PCs y lleva el alcance elegido al generar el código
// (spec 006: AC-03, AC-05, AC-06, AC-13, AC-14).

const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

async function pc(rele: Rele, nombre: string): Promise<Instalacion> {
  const i = await instalacion();
  abiertos.push(i);
  expect((await i.persona("remoto_rele", { url: rele.url, clave: CLAVE_RELE })).status).toBe(200);
  expect((await i.persona("remoto_nombre", { nombre })).status).toBe(200);
  return i;
}

async function codigo(duena: Instalacion, cuerpo: object = {}): Promise<string> {
  await duena.persona("remoto_interruptor", { encendido: true });
  const r = await duena.persona("remoto_codigo", cuerpo);
  expect(r.status).toBe(200);
  return r.datos.codigo as string;
}

async function relé(): Promise<Rele> {
  const r = await releLocal();
  abiertos.push(r);
  return r;
}

describe("canje sin escribir nombres", () => {
  it("la lectora queda con el nombre de la dueña y un identificador derivado; la dueña, con el de la lectora y el alcance del código", async () => {
    const rele = await relé();
    const duena = await pc(rele, "Mac Personal (Jesús)");
    const lectora = await pc(rele, "Laptop trabajo");
    const texto = await codigo(duena, { ambitos: [{ ambito: "global", ref: null }], no_validadas: false });

    const r = await lectora.persona("remoto_canjear", { codigo: texto });
    expect(r.status).toBe(200);
    expect(r.datos).toMatchObject({ origen: "mac-personal-jesus", nombre: "Mac Personal (Jesús)" });

    const { datos: estadoLectora } = await lectora.persona("remoto_estado");
    expect(estadoLectora.enlaces).toEqual([expect.objectContaining({ origen: "mac-personal-jesus", nombre: "Mac Personal (Jesús)", usado_en: null })]);
    const { datos: estadoDuena } = await duena.persona("remoto_estado");
    expect(estadoDuena.dispositivos).toEqual([
      expect.objectContaining({ nombre: "Laptop trabajo", estado: "vigente", alcance: { ambitos: [{ ambito: "global", ref: null }], no_validadas: false } }),
    ]);

    // Con el alcance del código ya lee, sin otro paso (AC-03).
    await duena.app.store.crear(
      { tipo: "leccion", titulo: "Lección global de prueba", contenido: "algo global", ambito: "global", ambitoRef: null },
      { actor: "agente", confirmado: true },
    );
    const lista = await lectora.agente("listar", { origen: "mac-personal-jesus" });
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.datos)).toContain("Lección global de prueba");
  });

  it("un identificador repetido toma -2 (AC-05)", async () => {
    const rele = await relé();
    const lectora = await pc(rele, "Laptop trabajo");
    const una = await pc(rele, "Mac personal");
    const otra = await pc(rele, "Mac personal");
    expect((await lectora.persona("remoto_canjear", { codigo: await codigo(una) })).datos.origen).toBe("mac-personal");
    expect((await lectora.persona("remoto_canjear", { codigo: await codigo(otra) })).datos.origen).toBe("mac-personal-2");
  });

  it("un código sin alcance deja la PC sin alcance, como antes (D02)", async () => {
    const rele = await relé();
    const duena = await pc(rele, "Mac");
    const lectora = await pc(rele, "Laptop");
    await lectora.persona("remoto_canjear", { codigo: await codigo(duena) });
    const { datos } = await duena.persona("remoto_estado");
    expect(datos.dispositivos[0].alcance).toEqual({ ambitos: [], no_validadas: false });
  });

  it("si una PC cambia su nombre, la otra lo ve tras la siguiente lectura; el identificador no cambia (AC-06)", async () => {
    const rele = await relé();
    const duena = await pc(rele, "Mac");
    const lectora = await pc(rele, "Laptop");
    await lectora.persona("remoto_canjear", { codigo: await codigo(duena, { ambitos: [{ ambito: "global", ref: null }] }) });

    await duena.persona("remoto_nombre", { nombre: "Mac de casa" });
    await lectora.persona("remoto_nombre", { nombre: "Laptop del trabajo" });
    expect((await lectora.agente("listar", { origen: "mac" })).status).toBe(200);

    await esperar(async () => (await lectora.persona("remoto_estado")).datos.enlaces[0]?.nombre === "Mac de casa");
    const { datos: l } = await lectora.persona("remoto_estado");
    expect(l.enlaces[0]).toMatchObject({ origen: "mac", nombre: "Mac de casa" });
    const { datos: d } = await duena.persona("remoto_estado");
    expect(d.dispositivos[0].nombre).toBe("Laptop del trabajo");
  });

  it("con una dueña que no comunica su nombre (0.3.x) el identificador es pc-1 y la lectura funciona (AC-13)", async () => {
    const rele = await relé();
    const duena = await pc(rele, "Mac");
    const lectora = await pc(rele, "Laptop");
    // Una 0.3.x no manda `nombre` en el canje ni en las respuestas: equivale a un nombre vacío.
    duena.app.remoto.datos.nombrePc = () => "";
    const r = await lectora.persona("remoto_canjear", { codigo: await codigo(duena, { ambitos: [{ ambito: "global", ref: null }] }) });
    expect(r.datos).toMatchObject({ origen: "pc-1", nombre: null });
    expect((await lectora.agente("listar", { origen: "pc-1" })).status).toBe(200);
  });

  it("la CLI canjea sin --nombre (identificador automático) o con él (AC-14)", async () => {
    const rele = await relé();
    const duena = await pc(rele, "Desktop casa");
    const lectora = await pc(rele, "Laptop");
    const auto = await lectora.agente("enlace_canjear", { codigo: await codigo(duena) });
    expect(auto.datos).toMatchObject({ origen: "desktop-casa", nombre: "Desktop casa" });

    const otra = await pc(rele, "Otra");
    const elegido = await lectora.agente("enlace_canjear", { codigo: await codigo(otra), origen: "elegido" });
    expect(elegido.datos).toMatchObject({ origen: "elegido", nombre: "Otra" });
  });
});
