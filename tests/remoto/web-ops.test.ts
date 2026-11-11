import { afterEach, describe, expect, it } from "vitest";
import { CLAVE_RELE, enlazar, instalacion, releLocal } from "./instalaciones.js";

// Plan 008, F2: lo que antes era solo de la CLI, ahora desde la web y solo para la persona (spec 006: AC-07, AC-09,
// AC-10, AC-12).

const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

const NUEVAS = [
  ["remoto_canjear", { codigo: "X" }],
  ["remoto_enlace_quitar", { origen: "trabajo" }],
  ["remoto_enlace_renombrar", { origen: "trabajo", nuevo: "otro" }],
  ["remoto_rele", { url: "wss://relay.example.net", clave: "x".repeat(30) }],
  ["remoto_rele_probar", {}],
  ["remoto_ambitos", {}],
] as const;

describe("operaciones remotas de la web", () => {
  it("un agente con el token no puede usarlas (AC-12)", async () => {
    const i = await instalacion();
    abiertos.push(i);
    for (const [op, cuerpo] of NUEVAS) expect((await i.agente(op, cuerpo)).status, op).toBe(403);
  });

  it("configurar el relé guarda la clave sin devolverla nunca; probar distingue responde y clave rechazada (AC-09, AC-10)", async () => {
    const rele = await releLocal();
    const i = await instalacion();
    abiertos.push(rele, i);
    expect((await i.persona("remoto_rele_probar")).datos).toEqual({ estado: "sin_rele" });

    const mala = "clave-equivocada-clave-equivocada";
    const r = await i.persona("remoto_rele", { url: rele.url, clave: mala });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.datos)).not.toContain(mala);
    expect(JSON.stringify((await i.persona("remoto_estado")).datos)).not.toContain(mala);
    expect((await i.persona("remoto_rele_probar")).datos).toEqual({ estado: "clave_rechazada" });

    await i.persona("remoto_rele", { url: rele.url, clave: CLAVE_RELE });
    expect((await i.persona("remoto_rele_probar")).datos).toEqual({ estado: "responde" });
    expect(JSON.stringify((await i.persona("remoto_estado")).datos)).not.toContain(CLAVE_RELE);

    await rele.cerrar();
    expect((await i.persona("remoto_rele_probar")).datos).toEqual({ estado: "no_responde" });
  });

  it("una URL que no es wss:// se rechaza con un mensaje", async () => {
    const i = await instalacion();
    abiertos.push(i);
    const r = await i.persona("remoto_rele", { url: "https://relay.example.net", clave: "x".repeat(30) });
    expect(r.status).not.toBe(200);
  });

  it("renombrar y quitar un enlace propio (AC-07)", async () => {
    const rele = await releLocal();
    const duena = await instalacion();
    const lectora = await instalacion();
    abiertos.push(rele, duena, lectora);
    await enlazar(duena, lectora, rele);

    expect((await lectora.persona("remoto_enlace_renombrar", { origen: "trabajo", nuevo: "Mal Nombre" })).status).not.toBe(200);
    expect((await lectora.persona("remoto_enlace_renombrar", { origen: "nada", nuevo: "otro" })).status).not.toBe(200);
    const r = await lectora.persona("remoto_enlace_renombrar", { origen: "trabajo", nuevo: "oficina" });
    expect(r.datos).toEqual({ origen: "oficina" });
    expect((await lectora.agente("listar", { origen: "oficina" })).status).toBe(200);

    expect((await lectora.persona("remoto_enlace_quitar", { origen: "oficina" })).status).toBe(200);
    expect((await lectora.persona("remoto_estado")).datos.enlaces).toEqual([]);
    expect((await lectora.persona("remoto_enlace_quitar", { origen: "oficina" })).status).not.toBe(200);
  });

  it("lista global, proyectos y repos con su cantidad de entradas, sin contar las rechazadas (D04)", async () => {
    const i = await instalacion();
    abiertos.push(i);
    const crear = (titulo: string, ambito: "global" | "proyecto" | "repo", ambitoRef: string | null) =>
      i.app.store.crear({ tipo: "leccion", titulo, contenido: `contenido de ${titulo}`, ambito, ambitoRef }, { actor: "agente", confirmado: true });
    await crear("Una global", "global", null);
    await crear("Del proyecto b", "proyecto", "proyecto:beta");
    await crear("Del proyecto a", "proyecto", "proyecto:alfa");
    await crear("Otra del a", "proyecto", "proyecto:alfa");
    await crear("Del repo", "repo", "repo:github.com/x/y");
    const { datos } = await i.persona("remoto_ambitos");
    expect(datos.ambitos).toEqual([
      { ambito: "global", ref: null, entradas: 1 },
      { ambito: "proyecto", ref: "proyecto:alfa", entradas: 2 },
      { ambito: "proyecto", ref: "proyecto:beta", entradas: 1 },
      { ambito: "repo", ref: "repo:github.com/x/y", entradas: 1 },
    ]);
  });
});
