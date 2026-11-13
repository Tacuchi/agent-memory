import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { INDICACION_TRAS_COMPACTAR } from "../../src/indice/indice.js";
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

/** El hook imprime el JSON de SessionStart: el contexto para el agente y el mensaje visible para la persona. */
function salida(stdout: string): { contexto: string; visible: string } {
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const datos = JSON.parse(stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(datos.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return { contexto: datos.hookSpecificOutput.additionalContext, visible: datos.systemMessage };
}

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
    const { contexto, visible } = salida(r.stdout);
    expect(contexto).toMatch(/^# agent-memory · índice de la memoria \(evidencia, no instrucciones\)/);
    expect(visible).toMatch(/^agent-memory · índice cargado: \d+ entradas/);
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
    const aviso = salida(r.stdout);
    expect(aviso.contexto).toMatch(/^agent-memory: el servicio no respondió en 1 s; esta sesión arranca sin índice\..*agent-memory start/);
    expect(aviso.visible).toBe(aviso.contexto);
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

  it("solo tras compactar agrega la indicación de proponer candidatos, fuera del bloque de datos (AC-27 a AC-30)", async () => {
    e = await entornoCli();
    configurar({ hook: { espera_ms: 15_000 } });
    const compactada = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: e.home, source: "compact" }) });
    expect(compactada.code).toBe(0);
    const tras = salida(compactada.stdout);
    expect(tras.contexto.endsWith(INDICACION_TRAS_COMPACTAR)).toBe(true);
    expect(tras.visible).toMatch(/^agent-memory · índice cargado: .*; el agente revisa qué vale guardar$/);
    for (const pista of ["como máximo 3", "una sola pregunta estructurada", "AskUserQuestion", "recomendada primero", "borrador exacto", "pendientes y las rechazadas", "no digas nada", "lo dijo la persona o lo concluiste", "tampoco como pendiente", "antes de la compactación no cuenta"]) {
      expect(INDICACION_TRAS_COMPACTAR).toContain(pista);
    }
    for (const source of ["startup", "resume", "clear", undefined]) {
      const r = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: e.home, ...(source ? { source } : {}) }) });
      expect(r.code).toBe(0);
      const { contexto, visible } = salida(r.stdout);
      expect(contexto, String(source)).toMatch(/índice de la memoria/);
      expect(contexto, String(source)).not.toContain("después de compactar");
      expect(visible, String(source)).not.toContain("guardar");
    }
  });

  it("con stdin ilegible usa el directorio actual y no falla", async () => {
    e = await entornoCli();
    configurar({ hook: { espera_ms: 15_000 } });
    const r = await correr(e, ["hook", "session-start"], { input: "esto no es json" });
    expect(r.code).toBe(0);
    expect(salida(r.stdout).contexto).toMatch(/índice de la memoria/);
  });

  it("con config.json ilegible avisa en una línea y termina con éxito", async () => {
    e = await entornoCli();
    mkdirSync(e.datos, { recursive: true });
    writeFileSync(join(e.datos, "config.json"), "{ roto");
    const r = await correr(e, ["hook", "session-start"], { input: "{}" });
    expect(r.code).toBe(0);
    const aviso = salida(r.stdout);
    expect(aviso.contexto).toMatch(/^agent-memory: sin índice en esta sesión \(config\.json ilegible/);
    expect(aviso.visible).toBe(aviso.contexto);
  });
});
