import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Rele } from "../../src/remoto/rele.js";
import { conectarRele } from "../../src/remoto/transporte.js";
import { CLAVE_RELE, enlazar, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// Plan 007, F1: cada PC informa al relé sus metadatos y el relé arma el estado por PC (AC-02, AC-03, AC-04, AC-08,
// AC-09, AC-12).

const MARCA = "cadena-marcada-informe-91af";
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
  return { rele, duena, lectora, id };
}

type Vista = ReturnType<Rele["estado"]["vista"]>;
const vista = (m: Mundo): Vista => m.rele.estado.vista("prueba", 256);
const pcDe = (m: Mundo, i: Instalacion) => vista(m).pcs.find((p) => p.huella === i.app.remoto.huella);

describe("informe de cada PC al relé", () => {
  it("las dos PCs aparecen con nombre, versión, quién las lee y qué leen, cruzadas por huella (AC-02, AC-03)", async () => {
    const m = await mundo();
    await m.duena.persona("remoto_alcance", { id: m.id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
    await esperar(() => Boolean(pcDe(m, m.duena)?.leen[0]?.alcance.ambitos.length) && Boolean(pcDe(m, m.lectora)?.lee.length));
    const duena = pcDe(m, m.duena);
    const lectora = pcDe(m, m.lectora);
    expect(duena).toMatchObject({ informe: true, en_linea: true, acceso: true });
    expect(duena?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(duena?.leen).toEqual([
      expect.objectContaining({ huella: m.lectora.app.remoto.huella, nombre: "casa", alcance: { ambitos: ["global"], pendientes: false }, revocado: false }),
    ]);
    expect(lectora?.lee).toEqual([expect.objectContaining({ origen: "trabajo", duena: m.duena.app.remoto.huella })]);
    expect(duena?.uso).toHaveLength(7);
  });

  it("el nombre de la PC es el del equipo y se cambia desde la web local (AC-12)", async () => {
    const m = await mundo();
    await esperar(() => Boolean(pcDe(m, m.duena)?.informe));
    expect(pcDe(m, m.duena)?.nombre).toBe(m.duena.app.remoto.datos.nombrePc());
    const r = await m.duena.persona("remoto_nombre", { nombre: "  Laptop   trabajo " });
    expect(r.status).toBe(200);
    expect(r.datos.nombre_pc).toBe("Laptop trabajo");
    await esperar(() => pcDe(m, m.duena)?.nombre === "Laptop trabajo");
    // Gobernar es de la persona: un agente con el token no renombra la PC.
    expect((await m.duena.agente("remoto_nombre", { nombre: "otra" })).status).toBe(403);
  });

  it("cuenta el uso por día sin llevar contenido al relé (AC-04, AC-08)", async () => {
    const m = await mundo();
    await m.duena.persona("remoto_alcance", { id: m.id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
    const { entrada } = await m.duena.app.store.crear(
      { tipo: "leccion", titulo: `Despliegue ${MARCA}`, contenido: `contenido ${MARCA}`, ambito: "global", ambitoRef: null },
      { actor: "agente", confirmado: true },
    );
    const r = await m.lectora.agente("leer", { id: entrada.id, origen: "trabajo" });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.datos)).toContain(MARCA);
    const hoy = (pc: ReturnType<typeof pcDe>) => pc?.uso.at(-1);
    await esperar(() => (hoy(pcDe(m, m.duena))?.recibidas ?? 0) >= 1 && (hoy(pcDe(m, m.lectora))?.hechas ?? 0) >= 1);
    expect(hoy(pcDe(m, m.duena))?.bytes).toBeGreaterThan(0);
    expect(pcDe(m, m.lectora)?.lee[0]?.usado).not.toBeNull();
    expect(JSON.stringify(vista(m))).not.toContain(MARCA);
  });

  it("una conexión sin huella (PC 0.2.0) figura como «sin informe», agrupada por IP (AC-09)", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const t = await conectarRele({ url: rele.url, clave: CLAVE_RELE, buzon: randomBytes(16).toString("base64url") });
    abiertos.push({ cerrar: () => t.cerrar() });
    await esperar(() => rele.estado.vista("prueba", 256).pcs.length === 1);
    const [pc] = rele.estado.vista("prueba", 256).pcs;
    expect(pc).toMatchObject({ informe: false, huella: expect.stringMatching(/^ip-/), conexiones: [expect.objectContaining({ estado: "esperando" })] });
  });

  it("una IP que falla la clave figura entre las desconocidas (AC-02)", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const http = rele.url.replace(/^ws/, "http");
    for (let i = 0; i < 3; i++) await fetch(`${http}/`, { headers: { authorization: "Bearer clave-mala-clave-mala-clave-mala" } });
    const [d] = rele.estado.vista("prueba", 256).desconocidas;
    expect(d).toMatchObject({ rechazos: 3 });
  });
});
