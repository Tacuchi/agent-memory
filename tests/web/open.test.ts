import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild, crudo } from "../helpers/servicio.js";

// `agent-memory open` arranca el servicio si hace falta y abre un enlace de un solo uso.
// El navegador es un script falso que anota la URL: nunca se abre un navegador real.

let e: EntornoCli | null = null;
beforeAll(() => asegurarBuild());
afterEach(async () => {
  await e?.limpiar();
  e = null;
});

describe("agent-memory open", () => {
  it("con --imprimir muestra un enlace que sirve una sola vez", async () => {
    e = await entornoCli();
    const r = await correr(e, ["open", "--imprimir"]);
    expect(r.code, r.stderr).toBe(0);
    const url = new URL(r.stdout.trim());
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBe(e.port);
    const host = { host: `127.0.0.1:${e.port}` };
    expect((await crudo(e.port, { path: url.pathname, headers: host })).status).toBe(303);
    expect((await crudo(e.port, { path: url.pathname, headers: host })).status).toBe(401);
  });

  it("abre el enlace con el navegador configurado", async () => {
    e = await entornoCli();
    const anotado = join(e.raiz, "navegador.txt");
    const falso = join(e.raiz, "navegador.sh");
    writeFileSync(falso, `#!/bin/sh\necho "$1" > "${anotado}"\n`);
    chmodSync(falso, 0o755);
    const r = await correr({ env: { ...e.env, AGENT_MEMORY_NAVEGADOR: falso } }, ["open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("una sola vez");
    expect(r.stdout).not.toContain("/sesion/");
    for (let i = 0; i < 50 && !existsSync(anotado); i++) await new Promise((x) => setTimeout(x, 50));
    const url = new URL(readFileSync(anotado, "utf8").trim());
    expect(url.pathname).toMatch(/^\/sesion\/[0-9a-f]{64}$/);
    const canje = await crudo(e.port, { path: url.pathname, headers: { host: `127.0.0.1:${e.port}` } });
    expect(canje.status).toBe(303);
  });

  it("si el navegador no se puede lanzar, sale con 1 y deja el enlace para abrirlo a mano", async () => {
    e = await entornoCli();
    const r = await correr({ env: { ...e.env, AGENT_MEMORY_NAVEGADOR: join(e.raiz, "no-existe") } }, ["open"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/http:\/\/127\.0\.0\.1:\d+\/sesion\//);
  });
});
