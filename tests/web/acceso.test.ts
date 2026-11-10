import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crudo, servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";
import { comoPersona, sesionWeb } from "../helpers/web.js";

// Acceso a la web: enlace de un solo uso, sesión por cookie, y sin sesión ni token no hay datos.

let s: ServicioDePrueba;
const host = () => ({ host: `127.0.0.1:${s.app.port}` });

beforeEach(async () => {
  s = await servicioDePrueba();
  await s.api("crear", { tipo: "convencion", titulo: "Dato sintético secreto-de-prueba", contenido: "contenido sintético", ambito: "global" });
});
afterEach(async () => s.cerrar());

describe("web sin sesión", () => {
  it("la página, sus archivos y la API rechazan sin cookie ni token y no devuelven datos", async () => {
    const pagina = await crudo(s.app.port, { path: "/", headers: host() });
    expect(pagina.status).toBe(401);
    expect(pagina.body).toContain("agent-memory open");
    expect(pagina.body).not.toContain("<script");

    const asset = await crudo(s.app.port, { path: "/assets/cualquiera.js", headers: host() });
    expect(asset.status).toBe(401);

    for (const op of ["listar", "buscar", "leer", "pendientes"]) {
      const r = await s.api(op, op === "buscar" ? { consulta: "sintético" } : op === "leer" ? { id: 1 } : {}, {});
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.datos)).not.toContain("secreto-de-prueba");
    }
  });

  it("una cookie inventada no abre sesión", async () => {
    const r = await s.api("listar", {}, { cookie: `am_sesion=${"0".repeat(64)}`, origin: s.app.url });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.datos)).not.toContain("secreto-de-prueba");
  });

  it("el enlace solo lo acuña el token, no una sesión del navegador", async () => {
    const { cookie } = await sesionWeb(s);
    const r = await comoPersona(s, cookie, "enlace-web");
    expect(r.status).toBe(403);
  });
});

describe("enlace de un solo uso", () => {
  it("el primer uso deja la sesión y el segundo uso del mismo enlace falla", async () => {
    const { datos } = await s.api("enlace-web");
    const ruta = new URL(datos.url as string).pathname;

    const primero = await crudo(s.app.port, { path: ruta, headers: host() });
    expect(primero.status).toBe(303);
    expect(primero.headers.location).toBe("/");
    expect(String(primero.headers["set-cookie"])).toMatch(/am_sesion=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\//);

    const segundo = await crudo(s.app.port, { path: ruta, headers: host() });
    expect(segundo.status).toBe(401);
    expect(segundo.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(segundo.body).error.codigo).toBe("enlace_invalido");
  });

  it("con la sesión, el servicio sirve la web compilada con una CSP sin orígenes externos", async () => {
    const { cookie } = await sesionWeb(s);
    const pagina = await crudo(s.app.port, { path: "/", headers: { ...host(), cookie } });
    expect(pagina.status).toBe(200);
    expect(pagina.headers["content-type"]).toContain("text/html");
    const csp = String(pagina.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(pagina.body)?.[1];
    expect(script).toBeTruthy();
    expect(pagina.body).not.toMatch(/(src|href)="https?:/);

    const js = await crudo(s.app.port, { path: script as string, headers: { ...host(), cookie } });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");

    // Una ruta de la app vuelve al índice; un archivo inexistente o fuera de la carpeta, no.
    expect((await crudo(s.app.port, { path: "/bandeja", headers: { ...host(), cookie } })).status).toBe(200);
    expect((await crudo(s.app.port, { path: "/assets/no-existe.js", headers: { ...host(), cookie } })).status).toBe(404);
    expect((await crudo(s.app.port, { path: "/%2e%2e/%2e%2e/package.json", headers: { ...host(), cookie } })).status).toBe(404);
  });

  it("la sesión del navegador exige JSON y su propio origen (CSRF)", async () => {
    const { cookie } = await sesionWeb(s);
    expect((await comoPersona(s, cookie, "listar")).status).toBe(200);
    const ajeno = await s.api("listar", {}, { cookie, origin: "http://ejemplo.invalid" });
    expect(ajeno.status).toBe(403);
    const formulario = await crudo(s.app.port, {
      method: "POST",
      path: "/api/listar",
      headers: { ...host(), cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(formulario.status).toBe(403);
  });
});

describe("la persona desde la web: buscar, ver, editar y restaurar", () => {
  it("todo pasa por la API con la cookie y la edición conserva la validación", async () => {
    const { cookie } = await sesionWeb(s);
    const creada = await comoPersona(s, cookie, "crear", { tipo: "leccion", titulo: "Lección de prueba", contenido: "versión uno", ambito: "global" });
    const id = creada.datos.entrada.id as number;
    expect(creada.datos.entrada.validacion).toBe("validada");

    const busqueda = await comoPersona(s, cookie, "buscar", { consulta: "Lección de prueba", filtros: { todos_los_ambitos: true } });
    expect(busqueda.datos.resultados.map((r: { id: number }) => r.id)).toContain(id);

    const editada = await comoPersona(s, cookie, "editar", { id, contenido: "versión dos" });
    expect(editada.status).toBe(200);
    expect(editada.datos.entrada.validacion).toBe("validada");

    const revs = await comoPersona(s, cookie, "revisiones", { id });
    expect(revs.datos.revisiones.map((r: { numero: number }) => r.numero)).toEqual([1, 2]);

    const restaurada = await comoPersona(s, cookie, "restaurar", { id, numero: 1 });
    expect(restaurada.datos.entrada.contenido).toBe("versión uno");
    expect(restaurada.datos.entrada.validacion).toBe("validada");
    const despues = await comoPersona(s, cookie, "revisiones", { id });
    expect(despues.datos.revisiones).toHaveLength(3);

    const leida = await comoPersona(s, cookie, "leer", { id });
    expect(leida.datos.entrada.contenido).toBe("versión uno");
  });
});
