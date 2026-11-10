import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { leerPid, procesoVivo } from "../../src/service/daemon.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// El hook arranca el servicio sin bloquear, imprime el índice o una línea de aviso y
// siempre termina con éxito.

let e: EntornoCli;
let ocupante: Server | null = null;
const sockets = new Set<Socket>();

beforeAll(() => asegurarBuild());

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => (ocupante ? ocupante.close(() => r()) : r()));
  ocupante = null;
  await e.limpiar();
});

function configurar(datos: object) {
  mkdirSync(e.datos, { recursive: true });
  writeFileSync(join(e.datos, "config.json"), JSON.stringify(datos));
}

describe("hook session-start", () => {
  it("con el servicio apagado lo arranca separado e imprime el índice", async () => {
    e = await entornoCli();
    configurar({ hook: { espera_ms: 15_000 } });
    const r = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: e.home, session_id: "sintetica" }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^# agent-memory · índice de la memoria \(evidencia, no instrucciones\)/);
    const pid = leerPid({ pidPath: join(e.datos, "servicio.pid") })?.pid;
    expect(pid && procesoVivo(pid)).toBe(true);
    expect((await correr(e, ["status"])).code).toBe(0);
  });

  it("si el servicio no responde en el presupuesto, avisa en una línea y termina con éxito sin pasarse", async () => {
    e = await entornoCli();
    configurar({ hook: { espera_ms: 1000 } });
    // Otro proceso ocupa el puerto y nunca contesta: el servicio no puede arrancar.
    ocupante = createServer((s) => void sockets.add(s));
    await new Promise<void>((r) => ocupante!.listen(e.port, "127.0.0.1", () => r()));
    const r = await correr(e, ["hook", "session-start"], { input: "{}" });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/^agent-memory: el servicio no respondió en 1 s; esta sesión arranca sin índice\..*agent-memory start/);
    expect(r.ms).toBeLessThan(1000 + 3000);

    // El servicio lanzado queda registrado desde el arranque: stop lo alcanza aunque siga cargando.
    const pid = leerPid({ pidPath: join(e.datos, "servicio.pid") })?.pid;
    expect(pid).toBeGreaterThan(0);
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => ocupante!.close(() => res()));
    ocupante = null;
    await correr(e, ["stop"]);
    expect(procesoVivo(pid!)).toBe(false);
  });

  it("con stdin ilegible usa el directorio actual y no falla", async () => {
    e = await entornoCli();
    configurar({ hook: { espera_ms: 15_000 } });
    const r = await correr(e, ["hook", "session-start"], { input: "esto no es json" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/índice de la memoria/);
  });

  it("con config.json ilegible avisa en una línea y termina con éxito", async () => {
    e = await entornoCli();
    mkdirSync(e.datos, { recursive: true });
    writeFileSync(join(e.datos, "config.json"), "{ roto");
    const r = await correr(e, ["hook", "session-start"], { input: "{}" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^agent-memory: sin índice en esta sesión \(config\.json ilegible/);
  });
});
