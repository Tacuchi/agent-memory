import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { abrirComoIniciador, abrirComoRespondedor, cargarIdentidad, generarIdentidad } from "../../src/remoto/canal.js";
import { crearRele, leerCabeceraIp, leerClaveRele, type Rele } from "../../src/remoto/rele.js";
import { conectarRele, ErrorRele, proxyPara } from "../../src/remoto/transporte.js";
import { CLI, puertoLibre } from "../helpers/servicio.js";
import { dirTemporal } from "../helpers/temp.js";

const CLAVE = "clave-de-prueba-del-rele-0123456789";
const MARCA = "cadena-marcada-rele-5c2e";
const abiertos: { cerrar(): Promise<void> | void }[] = [];

afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

async function rele(op: { inactividadMs?: number } = {}): Promise<Rele> {
  const r = await crearRele({ clave: CLAVE, ...op });
  abiertos.push(r);
  return r;
}

function buzon(): string {
  return randomBytes(16).toString("base64url");
}

async function codigoRele(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
    return "ok";
  } catch (error) {
    return error instanceof ErrorRele ? error.codigo : String(error);
  }
}

describe("relé ciego", () => {
  it("responde 401 sin clave o con clave mala, en / y en el buzón; con la clave, 204", async () => {
    const r = await rele();
    const http = r.url.replace(/^ws/, "http");
    const b = buzon();
    for (const ruta of ["/", `/buzon/${b}`, "/cualquier/otra"]) {
      expect((await fetch(`${http}${ruta}`)).status).toBe(401);
      expect((await fetch(`${http}${ruta}`, { headers: { authorization: "Bearer clave-mala-clave-mala-clave-mala" } })).status).toBe(401);
    }
    expect((await fetch(`${http}/`, { headers: { authorization: `Bearer ${CLAVE}` } })).status).toBe(204);
    expect(await codigoRele(conectarRele({ url: r.url, clave: "otra-clave-otra-clave-otra-clave", buzon: b }))).toBe("clave_rele");
    expect(await codigoRele(conectarRele({ url: r.url, clave: "", buzon: b }))).toBe("clave_rele");
    expect(r.aceptadas()).toBe(0);
  });

  it("junta dos extremos por buzón y rechaza un tercero", async () => {
    const r = await rele();
    const b = buzon();
    const uno = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    const dos = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    abiertos.push({ cerrar: () => uno.cerrar() }, { cerrar: () => dos.cerrar() });
    expect(r.extremos(b)).toBe(2);
    expect(await codigoRele(conectarRele({ url: r.url, clave: CLAVE, buzon: b }))).toBe("buzon_ocupado");
  });

  it("dos instalaciones se hablan cifrado a través del relé, y lo que llega antes que el otro espera en la cola", async () => {
    const r = await rele();
    const b = buzon();
    const lectora = cargarIdentidad(generarIdentidad());
    const duena = cargarIdentidad(generarIdentidad());
    // La lectora llega primero y manda su handshake antes de que la dueña esté conectada.
    const tLectora = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    const pi = abrirComoIniciador(tLectora, { yo: lectora, otro: duena.publica });
    await new Promise((ok) => setTimeout(ok, 50));
    const tDuena = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    const [i, d] = await Promise.all([pi, abrirComoRespondedor(tDuena, { yo: duena, aceptar: (s) => s === lectora.publica || "desconocido" })]);
    i.enviar({ consulta: MARCA });
    expect(await d.recibir()).toEqual({ consulta: MARCA });
    d.enviar({ cuerpo: MARCA });
    expect(await i.recibir()).toEqual({ cuerpo: MARCA });
    i.cerrar();
    await esperar(() => r.extremos(b) === 0);
  });

  it("cierra un extremo inactivo", async () => {
    const r = await rele({ inactividadMs: 150 });
    const b = buzon();
    const t = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    let cerrado = false;
    t.alCerrar(() => {
      cerrado = true;
    });
    await esperar(() => cerrado);
    expect(r.extremos(b)).toBe(0);
  });

  it("sale por un proxy CONNECT cuando se le indica, y el canal funciona por el túnel", async () => {
    const r = await rele();
    const pedidos: string[] = [];
    const proxy = proxyConnect(pedidos);
    await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
    abiertos.push({ cerrar: () => new Promise<void>((ok) => { proxy.closeAllConnections(); proxy.close(() => ok()); }) });
    const urlProxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const b = buzon();
    const lectora = cargarIdentidad(generarIdentidad());
    const duena = cargarIdentidad(generarIdentidad());
    const tLectora = await conectarRele({ url: r.url, clave: CLAVE, buzon: b, proxy: urlProxy });
    const tDuena = await conectarRele({ url: r.url, clave: CLAVE, buzon: b });
    const [i, d] = await Promise.all([
      abrirComoIniciador(tLectora, { yo: lectora, otro: duena.publica }),
      abrirComoRespondedor(tDuena, { yo: duena, aceptar: () => true }),
    ]);
    i.enviar({ hola: 1 });
    expect(await d.recibir()).toEqual({ hola: 1 });
    expect(pedidos).toEqual([`CONNECT 127.0.0.1:${r.port}`]);
    i.cerrar();
  });

  it("una ruta de upgrade malformada no tira el relé", async () => {
    const r = await rele();
    const crudo = (ruta: string): Promise<string> =>
      new Promise((ok) => {
        const s = connect(r.port, "127.0.0.1", () => {
          s.write(`GET ${ruta} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${CLAVE}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        });
        let datos = "";
        s.on("data", (d: Buffer) => {
          datos += d.toString();
        });
        s.on("close", () => ok(datos.split("\r\n")[0] ?? ""));
        s.on("error", () => ok(datos));
      });
    expect(await crudo("//[")).toMatch(/404/);
    expect((await fetch(`${r.url.replace(/^ws/, "http")}/`)).status).toBe(401);
  });

  it("no manda la clave del relé sin TLS fuera de loopback, ni a un proxy https", async () => {
    expect(await codigoRele(conectarRele({ url: "ws://rele.ejemplo", clave: CLAVE, buzon: buzon() }))).toBe("sin_conexion");
    expect(await codigoRele(conectarRele({ url: "wss://rele.ejemplo", clave: CLAVE, buzon: "corto" }))).toBe("sin_conexion");
    expect(await codigoRele(conectarRele({ url: "wss://rele.ejemplo", clave: CLAVE, buzon: buzon(), proxy: "https://proxy.ejemplo:3128" }))).toBe("proxy");
  });

  it("toma HTTPS_PROXY del entorno salvo para loopback y NO_PROXY", () => {
    const env = { HTTPS_PROXY: "http://proxy.ejemplo:3128", NO_PROXY: "interno.ejemplo,.corp.ejemplo" };
    expect(proxyPara(new URL("wss://rele.ejemplo/buzon/x"), env)).toBe("http://proxy.ejemplo:3128");
    expect(proxyPara(new URL("wss://rele.ejemplo/buzon/x"), {})).toBeNull();
    expect(proxyPara(new URL("ws://127.0.0.1:9/buzon/x"), env)).toBeNull();
    expect(proxyPara(new URL("wss://interno.ejemplo/buzon/x"), env)).toBeNull();
    expect(proxyPara(new URL("wss://a.corp.ejemplo/buzon/x"), env)).toBeNull();
  });

  it("la clave sale del entorno o de un archivo 0600, nunca corta ni de un archivo legible por otros", () => {
    const { dir, limpiar } = dirTemporal("agent-memory-rele-");
    abiertos.push({ cerrar: limpiar });
    expect(leerClaveRele({ AGENT_MEMORY_RELAY_KEY: CLAVE })).toBe(CLAVE);
    expect(() => leerClaveRele({})).toThrow(/AGENT_MEMORY_RELAY_KEY/);
    expect(() => leerClaveRele({ AGENT_MEMORY_RELAY_KEY: "corta" })).toThrow(/al menos/);
    const archivo = join(dir, "clave");
    writeFileSync(archivo, `${CLAVE}\n`);
    chmodSync(archivo, 0o600);
    expect(leerClaveRele({}, archivo)).toBe(CLAVE);
    if (process.platform !== "win32") {
      chmodSync(archivo, 0o644);
      expect(() => leerClaveRele({}, archivo)).toThrow(/chmod 600/);
    }
  });

  it("agent-memory relay levanta el relé con la clave del entorno y rechaza la clave por argumento", async () => {
    const puerto = await puertoLibre();
    const sinEntorno = await correr(["relay", "--clave", CLAVE], {});
    expect(sinEntorno.codigo).toBe(2);
    expect(sinEntorno.err).toMatch(/no se pasa por argumento/);

    const hijo = spawn(process.execPath, [CLI, "relay", "--puerto", String(puerto)], {
      env: { PATH: process.env.PATH, AGENT_MEMORY_RELAY_KEY: CLAVE },
      stdio: ["ignore", "ignore", "pipe"],
    });
    abiertos.push({ cerrar: () => new Promise<void>((ok) => { hijo.once("exit", () => ok()); hijo.kill("SIGTERM"); }) });
    let err = "";
    hijo.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    await esperar(() => err.includes("escuchando"));
    expect(err).not.toContain(CLAVE);
    expect((await fetch(`http://127.0.0.1:${puerto}/`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${puerto}/`, { headers: { authorization: `Bearer ${CLAVE}` } })).status).toBe(204);
  });
});

function proxyConnect(pedidos: string[]): Server {
  const servidor = createServer((_req, res) => res.writeHead(405).end());
  servidor.on("connect", (req, cliente: Socket, cabeza: Buffer) => {
    pedidos.push(`CONNECT ${req.url}`);
    const [host, puerto] = String(req.url).split(":");
    const destino = connect(Number(puerto), host as string, () => {
      cliente.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (cabeza.length) destino.write(cabeza);
      destino.pipe(cliente);
      cliente.pipe(destino);
    });
    destino.on("error", () => cliente.destroy());
    cliente.on("error", () => destino.destroy());
  });
  return servidor;
}

function correr(args: string[], env: NodeJS.ProcessEnv): Promise<{ codigo: number | null; err: string }> {
  return new Promise((ok) => {
    const hijo = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    hijo.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    hijo.on("exit", (codigo) => ok({ codigo, err }));
  });
}

async function esperar(condicion: () => boolean, tope = 5000): Promise<void> {
  const inicio = Date.now();
  while (!condicion()) {
    if (Date.now() - inicio > tope) throw new Error("tiempo agotado esperando la condición");
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

describe("límite de intentos del relé", () => {
  const MALA = "Bearer clave-mala-clave-mala-clave-mala";
  const BUENA = `Bearer ${CLAVE}`;

  async function limitado(op: { cabeceraIp?: string | null } = {}) {
    const r = await crearRele({ clave: CLAVE, limite: { fallos: 3 }, ...op });
    abiertos.push(r);
    const http = r.url.replace(/^ws/, "http");
    const pedir = async (authorization: string | null, cabeceras: Record<string, string> = {}) =>
      (await fetch(`${http}/`, { headers: { ...(authorization ? { authorization } : {}), ...cabeceras } })).status;
    return { r, pedir };
  }

  it("tras varias claves equivocadas desde una IP responde 429, también con la buena; sin clave sigue el 401 y no cuenta", async () => {
    const { r, pedir } = await limitado();
    for (let n = 0; n < 5; n++) expect(await pedir(null)).toBe(401);
    expect(await pedir(BUENA)).toBe(204);
    for (let n = 0; n < 3; n++) expect(await pedir(MALA)).toBe(401);
    expect(await pedir(MALA)).toBe(429);
    expect(await pedir(BUENA)).toBe(429);
    // Un monitor que consulta sin clave sigue viendo 401: prueba que el relé y el proxy responden.
    expect(await pedir(null)).toBe(401);
    expect(await codigoRele(conectarRele({ url: r.url, clave: CLAVE, buzon: buzon() }))).toBe("bloqueado");
  });

  it("por defecto la IP sale de CF-Connecting-IP: otra IP sigue entrando (el relé detrás de Cloudflare no cambia)", async () => {
    const { pedir } = await limitado();
    for (let n = 0; n < 3; n++) await pedir(MALA, { "cf-connecting-ip": "203.0.113.5" });
    expect(await pedir(BUENA, { "cf-connecting-ip": "203.0.113.5" })).toBe(429);
    expect(await pedir(BUENA, { "cf-connecting-ip": "203.0.113.6" })).toBe(204);
  });

  it("con la cabecera de su plataforma declarada, cambiar CF-Connecting-IP no esquiva el límite", async () => {
    const { pedir } = await limitado({ cabeceraIp: "fly-client-ip" });
    for (let n = 0; n < 3; n++) await pedir(MALA, { "fly-client-ip": "198.51.100.7", "cf-connecting-ip": `203.0.113.${n}` });
    expect(await pedir(BUENA, { "fly-client-ip": "198.51.100.7", "cf-connecting-ip": "203.0.113.99" })).toBe(429);
    expect(await pedir(BUENA, { "fly-client-ip": "198.51.100.8" })).toBe(204);
  });

  it("con «ninguna» cuenta la IP del socket, y en X-Forwarded-For vale la última entrada", async () => {
    const socket = await limitado({ cabeceraIp: null });
    for (let n = 0; n < 3; n++) await socket.pedir(MALA, { "cf-connecting-ip": `203.0.113.${n}` });
    expect(await socket.pedir(BUENA, { "cf-connecting-ip": "203.0.113.99" })).toBe(429);

    const xff = await limitado({ cabeceraIp: "x-forwarded-for" });
    for (let n = 0; n < 3; n++) await xff.pedir(MALA, { "x-forwarded-for": `10.9.9.${n}, 198.51.100.7` });
    expect(await xff.pedir(BUENA, { "x-forwarded-for": "10.9.9.99, 198.51.100.7" })).toBe(429);
    expect(await xff.pedir(BUENA, { "x-forwarded-for": "198.51.100.7, 198.51.100.8" })).toBe(204);
  });

  it("la cabecera se pide por nombre o «ninguna»; otra cosa se rechaza diciendo la forma", () => {
    expect(leerCabeceraIp(undefined)).toBeUndefined();
    expect(leerCabeceraIp(" Fly-Client-IP ")).toBe("fly-client-ip");
    expect(leerCabeceraIp("ninguna")).toBeNull();
    expect(() => leerCabeceraIp("x forwarded")).toThrowError(/fly-client-ip, o «ninguna»; llegó «x forwarded»/);
  });
});
