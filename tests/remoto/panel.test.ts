import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crearVerificador } from "../../src/remoto/acceso.js";
import { crearRele, type Rele } from "../../src/remoto/rele.js";
import { dirTemporal } from "../helpers/temp.js";
import { CLAVE_RELE } from "./instalaciones.js";

// Plan 007, F3: el panel /dashboard solo con un JWT válido de Cloudflare Access (AC-01) y sus acciones.

const EQUIPO = "equipo-prueba";
const AUD = "aud-de-la-aplicacion";
const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

function par(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privada: privateKey, jwk: { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" } };
}
const CLAVE = par("kid-1");
const OTRA = par("kid-otra");

function jwt(privada: KeyObject, kid: string, datos: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const cuerpo = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(datos)}`;
  return `${cuerpo}.${sign("RSA-SHA256", Buffer.from(cuerpo), privada).toString("base64url")}`;
}

const ahora = () => Math.floor(Date.now() / 1000);
const valido = () => jwt(CLAVE.privada, CLAVE.kid, { aud: [AUD], iss: `https://${EQUIPO}.cloudflareaccess.com`, exp: ahora() + 600, email: "persona@ejemplo.org" });

async function rele(conAcceso = true): Promise<{ r: Rele; http: string }> {
  const { dir, limpiar } = dirTemporal("agent-memory-panel-");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>panel</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('panel')");
  const r = await crearRele({
    clave: CLAVE_RELE,
    dirPanel: dir,
    ...(conAcceso ? { acceso: { equipo: EQUIPO, aud: AUD, obtenerCertificados: async () => ({ keys: [CLAVE.jwk] }) } } : {}),
  });
  abiertos.push(r, { cerrar: limpiar });
  return { r, http: r.url.replace(/^ws/, "http") };
}

const conJwt = (token: string, extra: Record<string, string> = {}) => ({ headers: { "cf-access-jwt-assertion": token, ...extra } });

describe("panel detrás de Cloudflare Access", () => {
  it("sin Access configurado, /dashboard no existe (404) y el resto sigue igual", async () => {
    const { http } = await rele(false);
    expect((await fetch(`${http}/dashboard`, conJwt(valido()))).status).toBe(404);
    expect((await fetch(`${http}/`)).status).toBe(401);
  });

  it("sin JWT, vencido, de otra aplicación, de otro emisor o firmado con otra clave: 401 sin contenido (AC-01)", async () => {
    const { http } = await rele();
    const base = { aud: [AUD], iss: `https://${EQUIPO}.cloudflareaccess.com`, exp: ahora() + 600 };
    const malos = [
      undefined,
      "no-es-un-jwt",
      jwt(CLAVE.privada, CLAVE.kid, { ...base, exp: ahora() - 3600 }),
      jwt(CLAVE.privada, CLAVE.kid, { ...base, aud: ["otra"] }),
      jwt(CLAVE.privada, CLAVE.kid, { ...base, iss: "https://otro.cloudflareaccess.com" }),
      jwt(OTRA.privada, CLAVE.kid, base),
      jwt(OTRA.privada, OTRA.kid, base),
    ];
    for (const token of malos) {
      for (const ruta of ["/dashboard", "/dashboard/api/estado"]) {
        const res = await fetch(`${http}${ruta}`, token ? conJwt(token) : {});
        expect(res.status, `${ruta} con ${String(token).slice(0, 20)}`).toBe(401);
        expect(await res.text()).toBe("");
      }
    }
  });

  it("con JWT válido sirve la página, sus estáticos y el estado (AC-01)", async () => {
    const { http } = await rele();
    const pagina = await fetch(`${http}/dashboard/`, conJwt(valido()));
    expect(pagina.status).toBe(200);
    expect(pagina.headers.get("content-type")).toContain("text/html");
    expect(await pagina.text()).toContain("panel");
    expect((await fetch(`${http}/dashboard/assets/app.js`, conJwt(valido()))).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${http}/dashboard/assets/..%2f..%2fpackage.json`, conJwt(valido()))).status).toBe(404);
    const estado = await (await fetch(`${http}/dashboard/api/estado`, conJwt(valido()))).json();
    expect(estado).toMatchObject({ rele: { tope: 256 }, pcs: [], desconocidas: [], bloqueos: [] });
  });

  it("las acciones exigen el origen del mismo host y validan el cuerpo", async () => {
    const { r, http } = await rele();
    const host = new URL(http).host;
    const post = (cuerpo: unknown, origen?: string) =>
      fetch(`${http}/dashboard/api/accion`, {
        method: "POST",
        body: JSON.stringify(cuerpo),
        ...conJwt(valido(), { "content-type": "application/json", ...(origen ? { origin: origen } : {}) }),
      });
    expect((await post({ accion: "cerrar_todo" })).status).toBe(403);
    expect((await post({ accion: "cerrar_todo" }, "https://otro.sitio")).status).toBe(403);
    expect((await post({ accion: "inventada" }, `http://${host}`)).status).toBe(400);
    const ok = await post({ accion: "bloquear", ip: "192.0.2.55", duracion: "24h" }, `http://${host}`);
    expect(await ok.json()).toMatchObject({ ok: true, estado: "hecho" });
    expect(r.estado.bloqueado(null, "192.0.2.55")).toBe(true);
    const orden = await post({ accion: "renovar", pc: "AAAAAAAAAAAAAAAAAAAAAA", objetivo: "x" }, `http://${host}`);
    expect(await orden.json()).toMatchObject({ ok: false, error: expect.stringContaining("no está conectada") });
  });

  it("una IP bloqueada no se conecta al relé aunque tenga la clave (AC-06)", async () => {
    const { r, http } = await rele();
    r.estado.bloquear({ ip: "127.0.0.1" }, "1h");
    const { conectarRele } = await import("../../src/remoto/transporte.js");
    await expect(conectarRele({ url: r.url, clave: CLAVE_RELE, buzon: "b".repeat(22) })).rejects.toMatchObject({ codigo: "bloqueado" });
    expect((await fetch(`${http}/`, { headers: { authorization: `Bearer ${CLAVE_RELE}` } })).status).toBe(204);
  });

  it("el verificador recarga las claves ante un kid nuevo (rotación de Cloudflare)", async () => {
    let claves = [CLAVE.jwk];
    const v = crearVerificador({ equipo: EQUIPO, aud: AUD, obtenerCertificados: async () => ({ keys: claves }) });
    expect(await v.verificar(valido())).toBe("persona@ejemplo.org");
    claves = [OTRA.jwk];
    const nuevo = jwt(OTRA.privada, OTRA.kid, { aud: AUD, iss: `https://${EQUIPO}.cloudflareaccess.com`, exp: ahora() + 600 });
    expect(await v.verificar(nuevo)).toBe("sesión de Access");
  });
});
