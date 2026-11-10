import { spawn } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUERTO_POR_DEFECTO, cargarConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/store/store.js";
import { leerToken } from "../../src/service/token.js";
import { dirTemporal } from "../helpers/temp.js";
import { CLI, asegurarBuild, crudo, puertoLibre, servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";

const ctx = { repo: "github.com/ejemplo/sintetico", proyecto: null };

describe("acceso al servicio local", () => {
  let s: ServicioDePrueba;
  beforeEach(async () => {
    s = await servicioDePrueba();
    await s.api("crear", { tipo: "referencia", titulo: "Dato reservado", contenido: "contenido reservado", contexto: ctx });
  });
  afterEach(() => s.cerrar());

  it("escucha solo en 127.0.0.1 y el token vive en un archivo 0600", () => {
    expect(s.app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((s.app.server.address() as { address: string }).address).toBe("127.0.0.1");
    expect(statSync(s.config.tokenPath).mode & 0o777).toBe(0o600);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("escenario «proceso local sin token»: se rechaza y la respuesta no contiene ninguna entrada", async () => {
    const sinCredencial: Record<string, string>[] = [{}, { authorization: "Bearer otro-token-cualquiera-de-64-caracteres-0000000000000000000000" }];
    for (const cabeceras of sinCredencial) {
      const r = await s.api("buscar", { consulta: "reservado", contexto: ctx }, cabeceras);
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.datos)).not.toContain("reservado");
      expect(r.datos.error.codigo).toBe("sin_token");
    }
    const conToken = await s.api("buscar", { consulta: "reservado", contexto: ctx });
    expect(conToken.status).toBe(200);
    expect(conToken.datos.resultados).toHaveLength(1);
  });

  it("rechaza un Host ajeno aun con token, sin devolver datos", async () => {
    const r = await crudo(s.app.port, {
      method: "POST",
      path: "/api/buscar",
      headers: { host: "evil.example:80", authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ consulta: "reservado", contexto: ctx }),
    });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain("reservado");
    const parecido = await crudo(s.app.port, {
      method: "POST",
      path: "/api/salud",
      headers: { host: `127.0.0.1.evil.example:${s.app.port}`, authorization: `Bearer ${s.token}` },
    });
    expect(parecido.status).toBe(421);
  });

  it("el enlace de un solo uso deja una cookie HttpOnly y Strict, y falla en su segundo uso", async () => {
    const sinToken = await crudo(s.app.port, { method: "POST", path: "/api/enlace-web", headers: { host: `127.0.0.1:${s.app.port}` } });
    expect(sinToken.status).toBe(401);

    const { datos } = await s.api("enlace-web");
    const enlace = new URL(datos.url as string);
    expect(enlace.host).toBe(`127.0.0.1:${s.app.port}`);

    const primero = await crudo(s.app.port, { path: enlace.pathname, headers: { host: enlace.host } });
    expect(primero.status).toBe(303);
    const cookie = String(primero.headers["set-cookie"]);
    expect(cookie).toMatch(/am_sesion=[0-9a-f]{64}/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const segundo = await crudo(s.app.port, { path: enlace.pathname, headers: { host: enlace.host } });
    expect(segundo.status).toBe(401);
    expect(segundo.headers["set-cookie"]).toBeUndefined();

    const sesion = cookie.split(";")[0]!;
    const conCookie = await s.api("buscar", { consulta: "reservado", contexto: ctx }, { cookie: sesion });
    expect(conCookie.status).toBe(200);
    const cookieFalsa = await s.api("buscar", { consulta: "reservado", contexto: ctx }, { cookie: "am_sesion=falsa" });
    expect(cookieFalsa.status).toBe(401);
  });

  it("el puerto es configurable y tiene un valor fijo por defecto", async () => {
    const { dir, limpiar } = dirTemporal();
    try {
      expect(cargarConfig({ AGENT_MEMORY_HOME: dir }).port).toBe(PUERTO_POR_DEFECTO);
      expect(PUERTO_POR_DEFECTO).toBe(47821);
      expect(cargarConfig({ AGENT_MEMORY_HOME: dir, AGENT_MEMORY_PORT: "50123" }).port).toBe(50123);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 50124 }));
      expect(cargarConfig({ AGENT_MEMORY_HOME: dir }).port).toBe(50124);
      expect(() => cargarConfig({ AGENT_MEMORY_HOME: dir, AGENT_MEMORY_PORT: "no" })).toThrow(/inválido/);
    } finally {
      limpiar();
    }
    const port = await puertoLibre();
    const fijo = await servicioDePrueba(port);
    try {
      expect(fijo.app.port).toBe(port);
    } finally {
      await fijo.cerrar();
    }
  });
});

describe("API de la memoria", () => {
  let s: ServicioDePrueba;
  beforeEach(async () => {
    s = await servicioDePrueba();
  });
  afterEach(() => s.cerrar());

  async function sesionPersona(): Promise<Record<string, string>> {
    const { datos } = await s.api("enlace-web");
    const enlace = new URL(datos.url as string);
    const r = await crudo(s.app.port, { path: enlace.pathname, headers: { host: enlace.host } });
    return { cookie: String(r.headers["set-cookie"]).split(";")[0]! };
  }

  it("cambia el ámbito por la API (solo la persona) y la búsqueda filtra por ámbito", async () => {
    const { datos } = await s.api("crear", { tipo: "leccion", titulo: "Lección de repo", contenido: "texto sobre índices", contexto: ctx });
    expect(datos.entrada).toMatchObject({ ambito: "repo", ambito_ref: ctx.repo, validacion: "pendiente" });
    const id = datos.entrada.id as number;

    const comoAgente = await s.api("cambiar_ambito", { id, ambito: "global" });
    expect(comoAgente).toMatchObject({ status: 403, datos: { error: { codigo: "solo_persona" } } });

    const persona = await sesionPersona();
    const movida = await s.api("cambiar_ambito", { id, ambito: "global" }, persona);
    expect(movida.datos.entrada).toMatchObject({ ambito: "global", ambito_ref: null });

    const soloRepo = await s.api("buscar", { consulta: "índices", contexto: ctx, filtros: { ambito: "repo" } });
    expect(soloRepo.datos.resultados).toHaveLength(0);
    const soloGlobal = await s.api("buscar", { consulta: "índices", contexto: ctx, filtros: { ambito: "global" } });
    expect(soloGlobal.datos.resultados.map((r: { id: number }) => r.id)).toEqual([id]);
  });

  it("el agente caduca de inmediato y la persona lo revierte por la API", async () => {
    const persona = await sesionPersona();
    const { datos } = await s.api("crear", { tipo: "convencion", titulo: "Convención", contenido: "usar comillas dobles", contexto: ctx }, persona);
    const id = datos.entrada.id as number;
    expect(datos.entrada.validacion).toBe("validada");

    await s.api("caducar", { id });
    expect((await s.api("buscar", { consulta: "comillas", contexto: ctx })).datos.resultados).toHaveLength(0);

    expect((await s.api("revertir_caducidad", { id })).status).toBe(403);
    const revertida = await s.api("revertir_caducidad", { id }, persona);
    expect(revertida.datos.entrada).toMatchObject({ vigencia_hasta: null, validacion: "validada" });
    expect((await s.api("buscar", { consulta: "comillas", contexto: ctx })).datos.resultados).toHaveLength(1);
  });

  it("registra el uso cuando el agente lee o recibe una entrada en una búsqueda", async () => {
    const { datos } = await s.api("crear", { tipo: "leccion", titulo: "Uso", contenido: "contador de uso", contexto: ctx });
    const id = datos.entrada.id as number;
    await s.api("buscar", { consulta: "contador", contexto: ctx });
    await s.api("leer", { id });
    expect(s.app.store.obtener(id)).toMatchObject({ usos: 2, usadaEn: expect.any(String) });
  });

  it("cada fallo llega como error explícito con código", async () => {
    expect(await s.api("leer", { id: 999 })).toMatchObject({ status: 404, datos: { error: { codigo: "no_encontrada" } } });
    expect(await s.api("leer", { id: "uno" })).toMatchObject({ status: 400, datos: { error: { codigo: "peticion_invalida" } } });
    expect(await s.api("no-existe", {})).toMatchObject({ status: 404, datos: { error: { codigo: "ruta_desconocida" } } });
    expect(await s.api("crear", { tipo: "user", titulo: "x", contenido: "y" })).toMatchObject({ status: 400, datos: { error: { codigo: "tipo_invalido" } } });
    expect(await s.api("crear", { tipo: "leccion", titulo: "x", contenido: "y", ambito: "repo" })).toMatchObject({
      status: 400,
      datos: { error: { codigo: "ambito_sin_contexto" } },
    });
    const salud = await s.api("salud");
    expect(salud.datos).toMatchObject({ ok: true, modelo: { modelId: "falso/bolsa-de-palabras", dims: 384 } });
  });

  it("API y almacén comparten el único memoria.db del directorio de datos", async () => {
    const { datos } = await s.api("crear", { tipo: "preferencia", titulo: "Compartida", contenido: "una sola base", ambito: "global" });
    const otro = MemoryStore.abrir(s.config.dbPath);
    try {
      expect(otro.obtener(datos.entrada.id).titulo).toBe("Compartida");
    } finally {
      otro.close();
    }
    expect(readdirSync(s.home).filter((f) => f.endsWith(".db"))).toEqual(["memoria.db"]);
  });
});

describe("agent-memory serve", () => {
  it("crea el token 0600 al primer arranque, responde con token y se detiene con SIGTERM", async () => {
    asegurarBuild();
    const { dir, limpiar } = dirTemporal("agent-memory-serve-");
    const port = await puertoLibre();
    const hijo = spawn(process.execPath, [CLI, "serve"], {
      env: { ...process.env, AGENT_MEMORY_HOME: dir, AGENT_MEMORY_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      let salida = "";
      hijo.stderr.on("data", (c: Buffer) => (salida += c.toString()));
      const limite = Date.now() + 15_000;
      while (!salida.includes("escuchando") && Date.now() < limite) await new Promise((r) => setTimeout(r, 50));
      expect(salida).toContain(`http://127.0.0.1:${port}`);
      const tokenPath = join(dir, "token");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      const res = await fetch(`http://127.0.0.1:${port}/api/salud`, { method: "POST", headers: { authorization: `Bearer ${leerToken(tokenPath)}` } });
      expect(res.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/api/salud`, { method: "POST" })).status).toBe(401);
    } finally {
      const fin = new Promise<number | null>((r) => hijo.once("exit", r));
      hijo.kill("SIGTERM");
      expect(await fin).toBe(0);
      limpiar();
    }
  });
});

describe("vencimiento del enlace de un solo uso", () => {
  it("un enlace vencido no abre sesión y se descarta al acuñar otro", async () => {
    const { iniciarServicio } = await import("../../src/service/server.js");
    const { Api } = await import("../../src/service/api.js");
    const { Buscador } = await import("../../src/search/search.js");
    const { storeTemporal } = await import("../helpers/temp.js");
    const t = storeTemporal();
    let ahora = 1_000_000;
    const token = "a".repeat(64);
    const svc = await iniciarServicio({ api: new Api(t.store, new Buscador(t.store, null), "0.0.0"), token, port: 0, reloj: () => ahora });
    try {
      const pedir = async () => {
        const r = await fetch(`${svc.url}/api/enlace-web`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        return new URL(((await r.json()) as { url: string }).url);
      };
      const viejo = await pedir();
      ahora += 61_000;
      const nuevo = await pedir();
      expect((await crudo(svc.port, { path: viejo.pathname, headers: { host: viejo.host } })).status).toBe(401);
      expect((await crudo(svc.port, { path: nuevo.pathname, headers: { host: nuevo.host } })).status).toBe(303);
    } finally {
      await svc.cerrar();
      t.cerrar();
    }
  });
});
