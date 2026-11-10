import { afterEach, describe, expect, it } from "vitest";
import { abrirComoIniciador, cargarIdentidad, generarIdentidad, ErrorCanal } from "../../src/remoto/canal.js";
import { leerCodigo } from "../../src/remoto/codigo.js";
import type { Rele } from "../../src/remoto/rele.js";
import { conectarRele } from "../../src/remoto/transporte.js";
import { correr, entornoCli } from "../helpers/cli.js";
import { crudo } from "../helpers/servicio.js";
import { CLAVE_RELE, enlazar, esperar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

const abiertos: { cerrar(): Promise<void> }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

async function preparar(): Promise<{ rele: Rele; duena: Instalacion; lectora: Instalacion }> {
  const rele = await releLocal();
  const duena = await instalacion();
  const lectora = await instalacion();
  abiertos.push(rele, duena, lectora);
  return { rele, duena, lectora };
}

async function configurarRele(...instalaciones: Instalacion[]) {
  for (const i of instalaciones) expect((await i.agente("enlace_rele", { url: (abiertos[0] as Rele).url, clave: CLAVE_RELE })).status).toBe(200);
}

/** Un intento de canje con el buzón bueno y otro secreto (como haría quien conoce el buzón pero no el código). */
async function intentoConSecretoMalo(rele: Rele, buzon: string): Promise<string> {
  // Espera a que la dueña vuelva a escuchar el buzón tras el intento anterior.
  await esperar(() => rele.extremos(buzon) === 1);
  const t = await conectarRele({ url: rele.url, clave: CLAVE_RELE, buzon });
  try {
    await abrirComoIniciador(t, { yo: cargarIdentidad(generarIdentidad()), secreto: Buffer.alloc(32, 7), esperaMs: 3000 });
    return "ok";
  } catch (error) {
    return error instanceof ErrorCanal ? error.codigo : String(error);
  } finally {
    t.cerrar();
  }
}

describe("emparejamiento con un código de un solo uso", () => {
  it("un canje válido entrega una credencial de 30 días y el código deja de servir (registro del segundo intento)", async () => {
    const { rele, duena, lectora } = await preparar();
    await configurarRele(duena, lectora);
    await duena.persona("remoto_interruptor", { encendido: true });
    const { datos: codigo } = await duena.persona("remoto_codigo");
    expect(codigo.codigo).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/);
    expect(new Date(codigo.vence_en).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(new Date(codigo.vence_en).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    const r = await lectora.agente("enlace_canjear", { codigo: codigo.codigo.toLowerCase(), origen: "trabajo", dispositivo: "casa" });
    expect(r.status).toBe(200);
    const dias = (new Date(r.datos.vence_en).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(29.9);
    expect(dias).toBeLessThanOrEqual(30);
    const { datos: estado } = await duena.persona("remoto_estado");
    expect(estado.dispositivos).toHaveLength(1);
    expect(estado.dispositivos[0]).toMatchObject({ nombre: "casa", estado: "vigente", alcance: { ambitos: [], no_validadas: false } });
    expect(estado.codigo).toBeNull();

    // El mismo código, otra vez: se rechaza sin credencial y queda en el registro.
    const otra = await instalacion();
    abiertos.push(otra);
    await configurarRele(otra);
    const segundo = await otra.agente("enlace_canjear", { codigo: codigo.codigo, origen: "trabajo" });
    expect(segundo.status).toBe(400);
    expect(segundo.datos.error.codigo).toBe("codigo_usado");
    const { datos: reg } = await duena.persona("remoto_registro", { solo_rechazos: true });
    expect(reg.registro.map((x: { motivo: string }) => x.motivo)).toContain("codigo_usado");
    expect((await duena.persona("remoto_estado")).datos.dispositivos).toHaveLength(1);
    expect(rele.extremos).toBeTypeOf("function");
  });

  it("un código vencido se rechaza (reloj inyectado) y el sexto intento se rechaza aunque traiga el secreto bueno", async () => {
    const { rele, duena, lectora } = await preparar();
    await configurarRele(duena, lectora);
    await duena.persona("remoto_interruptor", { encendido: true });

    const { datos: viejo } = await duena.persona("remoto_codigo");
    duena.avanzar(10 * 60_000 + 1000);
    const vencido = await lectora.agente("enlace_canjear", { codigo: viejo.codigo, origen: "trabajo" });
    expect(vencido.datos.error.codigo).toBe("codigo_vencido");

    const { datos: codigo } = await duena.persona("remoto_codigo");
    const { buzon } = leerCodigo(codigo.codigo);
    await esperar(() => duena.app.remoto.escuchando().includes(buzon));
    for (let n = 0; n < 5; n++) expect(await intentoConSecretoMalo(rele, buzon)).toBe("prueba_invalida");
    const sexto = await lectora.agente("enlace_canjear", { codigo: codigo.codigo, origen: "trabajo" });
    expect(sexto.datos.error.codigo).toBe("intentos_agotados");
    const { datos: reg } = await duena.persona("remoto_registro", { solo_rechazos: true });
    const motivos = reg.registro.map((x: { motivo: string }) => x.motivo);
    expect(motivos).toContain("codigo_vencido");
    expect(motivos.filter((m: string) => m === "secreto_malo")).toHaveLength(5);
    expect(motivos).toContain("intentos_agotados");
  });

  it("revocar rechaza la siguiente petición; vencer corta solo; renovar extiende 30 días desde hoy", async () => {
    const { rele, duena, lectora } = await preparar();
    const id = await enlazar(duena, lectora, rele);
    await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: true });
    expect((await lectora.agente("listar", { origen: "trabajo" })).status).toBe(200);

    duena.avanzar(31 * 86_400_000);
    const vencida = await lectora.agente("listar", { origen: "trabajo" });
    expect(vencida.datos.error).toMatchObject({ codigo: "rechazado" });
    expect(vencida.datos.error.mensaje).toContain("credencial_vencida");

    const { datos: renovada } = await duena.persona("remoto_renovar", { id });
    const dias = (new Date(renovada.dispositivo.vence_en).getTime() - (Date.now() + 31 * 86_400_000)) / 86_400_000;
    expect(dias).toBeGreaterThan(29.9);
    expect((await lectora.agente("listar", { origen: "trabajo" })).status).toBe(200);

    await duena.persona("remoto_revocar", { id });
    const revocada = await lectora.agente("listar", { origen: "trabajo" });
    expect(revocada.datos.error.mensaje).toContain("revocado");
    const { datos: reg } = await duena.persona("remoto_registro", { solo_rechazos: true });
    const motivos = reg.registro.map((x: { motivo: string }) => x.motivo);
    expect(motivos).toEqual(expect.arrayContaining(["credencial_vencida", "revocado"]));
  });

  it("con el interruptor apagado la dueña no se conecta al relé", async () => {
    const { rele, duena, lectora } = await preparar();
    await enlazar(duena, lectora, rele);
    await esperar(() => rele.aceptadas() > 0);
    await duena.persona("remoto_interruptor", { encendido: false });
    expect(duena.app.remoto.escuchando()).toEqual([]);
    const antes = rele.aceptadas();
    await new Promise((ok) => setTimeout(ok, 300));
    expect(rele.aceptadas()).toBe(antes);
    const apagada = await lectora.agente("listar", { origen: "trabajo" });
    expect(apagada.datos.error.codigo).toBe("sin_respuesta");

    // Una dueña nueva con el relé configurado y el interruptor apagado (como viene) no abre ninguna conexión.
    const otra = await instalacion();
    abiertos.push(otra);
    const aceptadas = rele.aceptadas();
    await configurarRele(otra);
    expect((await otra.persona("remoto_estado")).datos.interruptor).toBe(false);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(rele.aceptadas()).toBe(aceptadas);
  });

  it("un agente con el token recibe solo_persona en cada operación remoto_*", async () => {
    const { duena } = await preparar();
    const operaciones: [string, object][] = [
      ["remoto_estado", {}],
      ["remoto_interruptor", { encendido: true }],
      ["remoto_codigo", {}],
      ["remoto_revocar", { id: 1 }],
      ["remoto_renovar", { id: 1 }],
      ["remoto_alcance", { id: 1, ambitos: [], no_validadas: false }],
      ["remoto_registro", {}],
    ];
    for (const [op, cuerpo] of operaciones) {
      const r = await duena.agente(op, cuerpo);
      expect(r.status, op).toBe(403);
      expect(r.datos.error.codigo, op).toBe("solo_persona");
    }
    expect((await duena.persona("remoto_estado")).datos.interruptor).toBe(false);
  });

  it("una instalación es dueña en un enlace y lectora en otro al mismo tiempo (A lee a B y B lee a A)", async () => {
    const { rele, duena: a, lectora: b } = await preparar();
    const idEnA = await enlazar(a, b, rele, "a");
    const idEnB = await enlazar(b, a, rele, "b");
    await a.persona("remoto_alcance", { id: idEnA, ambitos: [{ ambito: "global", ref: null }], no_validadas: true });
    await b.persona("remoto_alcance", { id: idEnB, ambitos: [{ ambito: "global", ref: null }], no_validadas: true });
    await a.agente("crear", { tipo: "leccion", titulo: "Solo en A", contenido: "contenido de la instalación A", ambito: "global" });
    await b.agente("crear", { tipo: "leccion", titulo: "Solo en B", contenido: "contenido de la instalación B", ambito: "global" });
    const [desdeB, desdeA] = await Promise.all([b.agente("listar", { origen: "a" }), a.agente("listar", { origen: "b" })]);
    expect(desdeB.datos.entradas.map((e: { titulo: string }) => e.titulo)).toEqual(["Solo en A"]);
    expect(desdeA.datos.entradas.map((e: { titulo: string }) => e.titulo)).toEqual(["Solo en B"]);
    expect((await b.agente("enlace_estado")).datos).toMatchObject({ interruptor: true, enlaces: [{ origen: "a" }] });
  });

  it("remote status no muestra secretos: ni la clave del relé ni el código", async () => {
    const { rele, duena, lectora } = await preparar();
    await enlazar(duena, lectora, rele);
    const { datos: codigo } = await duena.persona("remoto_codigo");
    const texto = JSON.stringify((await duena.agente("enlace_estado")).datos);
    expect(texto).not.toContain(CLAVE_RELE);
    expect(texto).not.toContain(codigo.codigo);
    expect(texto).toContain('"codigo_vigente":true');
  });

  it("la CLI: remote code abre la web en Acceso remoto, remote relay lee la clave por stdin y remote status no muestra secretos", async () => {
    const rele = await releLocal();
    const e = await entornoCli({ claude: false });
    abiertos.push(rele, { cerrar: () => e.limpiar() });
    const code = await correr(e, ["remote", "code", "--imprimir"]);
    expect(code.code, code.stderr).toBe(0);
    const url = new URL(code.stdout.trim());
    expect(url.searchParams.get("ir")).toBe("remoto");
    const r = await crudo(Number(url.port), { path: `${url.pathname}${url.search}`, headers: { host: url.host } });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/#remoto");

    const sinClave = await correr(e, ["remote", "relay", rele.url]);
    expect(sinClave.code).toBe(2);
    const relay = await correr(e, ["remote", "relay", rele.url], { input: `${CLAVE_RELE}\n` });
    expect(relay.code, relay.stderr).toBe(0);
    expect(relay.stdout).toContain(`relé configurado: ${rele.url}`);
    const status = await correr(e, ["remote", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("acceso remoto: apagado");
    expect(status.stdout).toContain(rele.url);
    expect(status.stdout).not.toContain(CLAVE_RELE);
    const link = await correr(e, ["remote", "link", "XXXX-XXXX", "--nombre", "trabajo"]);
    expect(link.code).toBe(1);
    expect(link.stderr).toMatch(/código de enlace mal escrito/);
  });
});
