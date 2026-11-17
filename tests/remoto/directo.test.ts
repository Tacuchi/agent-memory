import { connect } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { direccionesDeLaPc, esTailscale, leerInvitacion, type DireccionPc } from "../../src/remoto/directo.js";
import { LimiteIntentos } from "../../src/remoto/limite.js";
import { puertoLibre } from "../helpers/servicio.js";
import { enlazar, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// Modo directo: dos instalaciones se enlazan y leen sin relé, por una dirección elegida de la dueña. Las pruebas
// inyectan las direcciones de la PC para poder ligarse a loopback; el sistema real nunca ofrece loopback.

const LOOPBACK: DireccionPc[] = [{ direccion: "127.0.0.1", interfaz: "lo0", tailscale: false }];
const MARCA = "cadena-marcada-directo-8c1a";
const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

async function nueva(opciones: Parameters<typeof instalacion>[0] = {}): Promise<Instalacion> {
  const i = await instalacion(opciones);
  abiertos.push(i);
  return i;
}

/** Una dueña con el acceso remoto encendido y el modo directo escuchando en loopback. */
async function duenaDirecta(): Promise<{ duena: Instalacion; puerto: number }> {
  const duena = await nueva({ direcciones: () => LOOPBACK });
  const puerto = await puertoLibre();
  await duena.persona("remoto_interruptor", { encendido: true });
  const r = await duena.persona("remoto_directo", { direccion: "127.0.0.1", puerto });
  expect(r.status, JSON.stringify(r.datos)).toBe(200);
  expect(r.datos.directo).toEqual({ direccion: "127.0.0.1", puerto, estado: "escuchando", motivo: null });
  return { duena, puerto };
}

async function validada(i: Instalacion, titulo: string): Promise<number> {
  return (await i.app.store.crear({ tipo: "leccion", titulo, contenido: `${titulo} ${MARCA}`, ambito: "global", ambitoRef: null }, { actor: "agente", confirmado: true })).entrada.id;
}

/** ¿Acepta conexiones TCP ese puerto en loopback? */
function escucha(puerto: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect(puerto, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      ok(true);
    });
    s.once("error", () => ok(false));
  });
}

/** Estado HTTP de un upgrade a WebSocket en esa ruta del modo directo. */
function upgrade(puerto: number, ruta: string): Promise<number> {
  return new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${puerto}${ruta}`);
    ws.once("open", () => {
      ws.terminate();
      ok(101);
    });
    ws.on("unexpected-response", (_req, res) => {
      ws.terminate();
      ok(res.statusCode ?? 0);
    });
    ws.once("error", () => ok(0));
  });
}

describe("modo directo", () => {
  it("dos PCs sin relé canjean una invitación y leen", async () => {
    const { duena, puerto } = await duenaDirecta();
    const lectora = await nueva();
    const id = await validada(duena, "Despliegue del trabajo");

    const { datos: codigo } = await duena.persona("remoto_codigo", { ambitos: [{ ambito: "global", ref: null }] });
    expect(codigo.invitacion).toBe(`${codigo.codigo}@127.0.0.1:${puerto}`);
    const canje = await lectora.persona("remoto_canjear", { codigo: codigo.invitacion });
    expect(canje.status, JSON.stringify(canje.datos)).toBe(200);
    const origen = canje.datos.origen as string;

    const { datos: estado } = await lectora.persona("remoto_estado");
    expect(estado.rele).toBeNull();
    expect(estado.enlaces.map((e: { origen: string; direccion: string | null }) => [e.origen, e.direccion])).toEqual([[origen, `127.0.0.1:${puerto}`]]);
    expect(estado.conexiones[0].leo.direccion).toBe(`127.0.0.1:${puerto}`);

    const leida = await lectora.agente("leer", { id, origen });
    expect(leida.status, JSON.stringify(leida.datos)).toBe(200);
    expect(leida.datos.entrada.titulo).toBe("Despliegue del trabajo");
    expect(leida.datos.dato_externo).toBe(true);
    const busqueda = await lectora.agente("buscar", { consulta: MARCA });
    expect(busqueda.datos.enlaces).toEqual([{ origen, estado: "ok", motivo: null }]);
    expect((busqueda.datos.resultados as { titulo: string; origen?: string }[]).map((r) => [r.titulo, r.origen])).toContainEqual(["Despliegue del trabajo", origen]);
  });

  it("un código pelado sigue yendo por el relé y su enlace queda por relé", async () => {
    const rele = await releLocal();
    abiertos.push(rele);
    const duena = await nueva({ direcciones: () => LOOPBACK });
    const lectora = await nueva();
    await enlazar(duena, lectora, rele);
    const { datos } = await lectora.persona("remoto_estado");
    expect(datos.enlaces.map((e: { direccion: string | null }) => e.direccion)).toEqual([null]);
    expect((await lectora.agente("enlace_estado")).datos.directo.estado).toBe("apagado");
  });

  it("sin dirección elegida o con el acceso apagado no escucha nada", async () => {
    const duena = await nueva({ direcciones: () => LOOPBACK });
    const puerto = await puertoLibre();
    expect((await duena.persona("remoto_estado")).datos.directo).toEqual({ direccion: null, puerto: 47822, estado: "apagado", motivo: null });

    // Con dirección pero con el acceso apagado: no escucha y dice por qué.
    const r = await duena.persona("remoto_directo", { direccion: "127.0.0.1", puerto });
    expect(r.datos.directo).toEqual({ direccion: "127.0.0.1", puerto, estado: "apagado", motivo: "el acceso remoto está apagado" });
    expect(await escucha(puerto)).toBe(false);

    await duena.persona("remoto_interruptor", { encendido: true });
    await esperar(async () => (await duena.persona("remoto_estado")).datos.directo.estado === "escuchando");
    expect(await escucha(puerto)).toBe(true);
    await duena.persona("remoto_interruptor", { encendido: false });
    await esperar(async () => !(await escucha(puerto)));
    await duena.persona("remoto_interruptor", { encendido: true });
    await esperar(async () => await escucha(puerto));
    await duena.persona("remoto_directo", { direccion: null });
    expect(await escucha(puerto)).toBe(false);
    // Sin modo directo escuchando, el código no trae invitación.
    expect((await duena.persona("remoto_codigo")).datos.invitacion).toBeNull();
  });

  it("una dirección que la PC no tiene queda no_disponible, no escucha en otra y retoma al aparecer", async () => {
    let direcciones: DireccionPc[] = LOOPBACK;
    const duena = await nueva({ direcciones: () => direcciones });
    const puerto = await puertoLibre();
    await duena.persona("remoto_directo", { direccion: "127.0.0.1", puerto });
    direcciones = [];
    await duena.persona("remoto_interruptor", { encendido: true });
    await esperar(async () => (await duena.persona("remoto_estado")).datos.directo.estado === "no_disponible");
    const { datos } = await duena.persona("remoto_estado");
    expect(datos.directo.motivo).toBe("esta PC no tiene ahora la dirección 127.0.0.1");
    expect(await escucha(puerto)).toBe(false);
    expect((await duena.agente("enlace_estado")).datos.directo.estado).toBe("no_disponible");

    direcciones = LOOPBACK;
    await esperar(async () => (await duena.persona("remoto_estado")).datos.directo.estado === "escuchando", 10_000);
    expect(await escucha(puerto)).toBe(true);
  });

  it("en la dirección del modo directo solo está el canal remoto: la API local responde 404", async () => {
    const { puerto } = await duenaDirecta();
    for (const ruta of ["/", "/api/estado", "/api/buscar"]) {
      expect((await fetch(`http://127.0.0.1:${puerto}${ruta}`, { method: ruta === "/" ? "GET" : "POST" })).status, ruta).toBe(404);
    }
    expect(await upgrade(puerto, "/api/estado")).toBe(404);
    expect(await upgrade(puerto, `/buzon/${"a".repeat(22)}`)).toBe(404);
  });

  it("loopback, comodín y lo que no es una IP se rechazan; un puerto fuera de rango también", async () => {
    const duena = await nueva({ direcciones: () => [{ direccion: "10.0.0.5", interfaz: "en0", tailscale: false }] });
    for (const direccion of ["127.0.0.1", "::1", "0.0.0.0", "::", "mi-pc.local", "169.254.1.2"]) {
      const r = await duena.persona("remoto_directo", { direccion });
      expect(r.status, direccion).not.toBe(200);
      expect(JSON.stringify(r.datos), direccion).toContain("direccion_invalida");
    }
    const r = await duena.persona("remoto_directo", { direccion: "10.0.0.5", puerto: 80 });
    expect(JSON.stringify(r.datos)).toContain("puerto_invalido");
    expect((await duena.agente("remoto_directo", { direccion: null })).status).toBe(403);
  });

  it("un puerto ocupado no se guarda y se dice", async () => {
    const { duena, puerto } = await duenaDirecta();
    const otra = await nueva({ direcciones: () => LOOPBACK });
    await otra.persona("remoto_interruptor", { encendido: true });
    const r = await otra.persona("remoto_directo", { direccion: "127.0.0.1", puerto });
    expect(JSON.stringify(r.datos)).toContain("puerto_ocupado");
    expect((await otra.persona("remoto_estado")).datos.directo.direccion).toBeNull();
    expect((await duena.persona("remoto_estado")).datos.directo.estado).toBe("escuchando");
  });

  it("los fallos repetidos desde una IP terminan en 429 para esa IP", async () => {
    const { duena, puerto } = await duenaDirecta();
    for (let n = 0; n < 10; n++) expect((await fetch(`http://127.0.0.1:${puerto}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${puerto}/`)).status).toBe(429);
    // Hasta una invitación buena desde esa IP queda limitada mientras dure el bloqueo.
    const lectora = await nueva();
    const { datos: codigo } = await duena.persona("remoto_codigo");
    const canje = await lectora.persona("remoto_canjear", { codigo: codigo.invitacion });
    expect(JSON.stringify(canje.datos)).toContain("429");
  });

  it("el límite cuenta por IP, olvida fuera de la ventana y libera al terminar el bloqueo", () => {
    let ahora = 0;
    const limite = new LimiteIntentos({ fallos: 3, ventanaMs: 1000, bloqueoMs: 5000, reloj: () => ahora });
    limite.fallo("10.0.0.9");
    limite.fallo("10.0.0.9");
    ahora = 1500; // los dos primeros ya salieron de la ventana
    limite.fallo("10.0.0.9");
    expect(limite.limitada("10.0.0.9")).toBe(false);
    limite.fallo("10.0.0.9");
    limite.fallo("10.0.0.9");
    expect(limite.limitada("10.0.0.9")).toBe(true);
    expect(limite.limitada("10.0.0.8")).toBe(false);
    expect(limite.limitada(null)).toBe(false);
    ahora += 5001;
    expect(limite.limitada("10.0.0.9")).toBe(false);
  });

  it("una invitación mal escrita dice la forma esperada sin repetir el código", () => {
    const codigo = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23";
    expect(leerInvitacion(codigo)).toBeNull();
    expect(leerInvitacion(`${codigo}@100.101.102.103:47822`)).toEqual({ codigo, host: "100.101.102.103", puerto: 47822 });
    expect(leerInvitacion(` ${codigo}@[fd7a:115c:a1e0::1]:47822 `)).toEqual({ codigo, host: "fd7a:115c:a1e0::1", puerto: 47822 });
    for (const mala of [`${codigo}@mi-pc:47822`, `${codigo}@100.101.102.103`, `${codigo}@100.101.102.103:99999`]) {
      expect(() => leerInvitacion(mala)).toThrowError(/@<IP>:<puerto>/);
      try {
        leerInvitacion(mala);
      } catch (error) {
        expect((error as Error).message).not.toContain("ABCD");
      }
    }
  });

  it("ofrece las direcciones de la PC con Tailscale primero, sin loopback ni enlace local", () => {
    const lista = direccionesDeLaPc({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "", cidr: null }],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false, netmask: "ffff::", mac: "", cidr: null, scopeid: 4 },
        { address: "fd00::5", family: "IPv6", internal: false, netmask: "ffff::", mac: "", cidr: null, scopeid: 0 },
        { address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null },
      ],
      utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false, netmask: "255.192.0.0", mac: "", cidr: null }],
    });
    expect(lista).toEqual([
      { direccion: "100.101.102.103", interfaz: "utun4", tailscale: true },
      { direccion: "192.168.1.20", interfaz: "en0", tailscale: false },
      { direccion: "fd00::5", interfaz: "en0", tailscale: false },
    ]);
    expect(esTailscale("100.63.0.1")).toBe(false);
    expect(esTailscale("100.127.255.254")).toBe(true);
    expect(esTailscale("fd7a:115c:a1e0:ab12::1")).toBe(true);
  });
});
