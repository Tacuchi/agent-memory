import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClienteServicio } from "../../src/client.js";
import { cargarConfig } from "../../src/config.js";
import { HERRAMIENTAS } from "../../src/mcp/server.js";
import { procesoVivo } from "../../src/service/daemon.js";
import { clienteMcp, correr, entornoCli, llamarHerramienta, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// La CLI arranca, para, muestra el estado, busca y diagnostica, siempre
// sobre HOME, datos y puerto temporales. Con el servicio caído nada devuelve un vacío.

const ARGS_MINIMOS: Record<(typeof HERRAMIENTAS)[number], Record<string, unknown>> = {
  memory_search: { consulta: "algo" },
  memory_get: { id: 1 },
  memory_list: {},
  memory_create: { tipo: "leccion", titulo: "t", contenido: "c" },
  memory_edit: { id: 1, titulo: "nuevo" },
  memory_revisions: { id: 1 },
  memory_restore: { id: 1, numero: 1 },
  memory_expire: { id: 1 },
  memory_pending: {},
  memory_approve: { id: 1 },
  memory_reject: { id: 1, motivo: "no aplica" },
};

let e: EntornoCli;

beforeAll(async () => {
  asegurarBuild();
  e = await entornoCli();
});

afterAll(async () => {
  await e.limpiar();
});

describe("servicio caído", () => {
  it("status sale con 3 y nombra «agent-memory start»", async () => {
    const r = await correr(e, ["status"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/detenido.*agent-memory start/);
  });

  it("search sale con código distinto de cero y un error que nombra «agent-memory start»", async () => {
    const r = await correr(e, ["search", "algo"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/agent-memory start/);
  });

  it("cada una de las once herramientas MCP devuelve error explícito por el cliente del SDK", async () => {
    const cliente = await clienteMcp(e, e.home);
    try {
      const { tools } = await cliente.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...HERRAMIENTAS].sort());
      for (const nombre of HERRAMIENTAS) {
        const r = await llamarHerramienta(cliente, nombre, ARGS_MINIMOS[nombre]);
        expect(r.isError, nombre).toBe(true);
        expect(r.texto, nombre).toMatch(/agent-memory start/);
      }
    } finally {
      await cliente.close();
    }
  });

  it("doctor marca el servicio como falla con su arreglo y sale con 1", async () => {
    const r = await correr(e, ["doctor"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FALLA servicio: no responde/);
    expect(r.stdout).toMatch(/arreglo: «agent-memory start»/);
    expect(r.stdout).toMatch(/ok {4}sqlite-vec: carga v0\.1\.9/);
    expect(r.stdout).toMatch(/ok {4}node: Node 2\d/);
  });
});

describe("start, status, search y stop", () => {
  let pid: number;

  it("start deja el servicio respondiendo, con archivo de pid y token 0600", async () => {
    const r = await correr(e, ["start"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`arrancó en http://127\\.0\\.0\\.1:${e.port} \\(pid \\d+\\)`));
    const registro = JSON.parse(readFileSync(join(e.datos, "servicio.pid"), "utf8")) as { pid: number; port: number };
    expect(registro.port).toBe(e.port);
    pid = registro.pid;
    expect(procesoVivo(pid)).toBe(true);
    const otra = await correr(e, ["start"]);
    expect(otra.stdout).toMatch(/ya corre/);
  });

  it("status muestra puerto, pid y versión", async () => {
    const r = await correr(e, ["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`0\\.1\\.0 corriendo · puerto ${e.port} · pid ${pid}`));
  });

  it("search encuentra lo guardado en el contexto actual", async () => {
    const cliente = new ClienteServicio(cargarConfig(e.env));
    await cliente.llamar("crear", {
      tipo: "leccion",
      titulo: "Reintentos con espera exponencial",
      contenido: "Ante un 503, reintentar con pausas que se duplican.",
      ambito: "global",
    });
    const r = await correr(e, ["search", "reintentos", "--limite", "5"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^#1 · Reintentos con espera exponencial · leccion · global · pendiente · \d{4}-\d{2}-\d{2}$/m);
    expect(r.stderr).toMatch(/solo por texto/);
  });

  it("doctor con el servicio arriba: servicio y token en ok", async () => {
    const r = await correr(e, ["doctor"]);
    expect(r.stdout).toMatch(new RegExp(`ok {4}servicio: responde en 127\\.0\\.0\\.1:${e.port}`));
    expect(r.stdout).toMatch(/ok {4}token: .* con permisos 0600/);
    expect(r.stdout).toMatch(/aviso modelo: falta .*\n {6}arreglo: /);
  });

  it("stop lo apaga limpio y borra el archivo de pid", async () => {
    const r = await correr(e, ["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`detenido \\(pid ${pid}\\)`));
    expect(procesoVivo(pid)).toBe(false);
    expect(existsSync(join(e.datos, "servicio.pid"))).toBe(false);
    expect((await correr(e, ["status"])).code).toBe(3);
    expect((await correr(e, ["stop"])).stdout).toMatch(/no estaba corriendo/);
  });
});

describe("archivo de pid (relectura R1, R2)", () => {
  const serves = () =>
    execFileSync("ps", ["eww", "-ax", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes("cli.js serve") && l.includes(`AGENT_MEMORY_HOME=${e.datos}`));

  it("stop nunca mata un proceso ajeno que reusó el pid de un archivo viejo", async () => {
    const ajeno = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(join(e.datos, "servicio.pid"), JSON.stringify({ pid: ajeno.pid, port: e.port }));
      const r = await correr(e, ["stop"]);
      expect(r.stdout).toMatch(/no estaba corriendo/);
      expect(procesoVivo(ajeno.pid!)).toBe(true);
      expect(existsSync(join(e.datos, "servicio.pid"))).toBe(false);
    } finally {
      ajeno.kill();
    }
  });

  it("dos start a la vez dejan un solo servicio y stop lo alcanza", async () => {
    const [a, b] = await Promise.all([correr(e, ["start"]), correr(e, ["start"])]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(serves()).toHaveLength(1);
    expect((await correr(e, ["stop"])).code).toBe(0);
    expect(serves()).toHaveLength(0);
  });
});

describe("argumentos (parseArgs)", () => {
  it("un comando desconocido o argumentos de más salen con 2 y la ayuda", async () => {
    expect((await correr(e, ["volar"])).code).toBe(2);
    expect((await correr(e, ["start", "ya"])).code).toBe(2);
    expect((await correr(e, ["search"])).code).toBe(2);
    const ayuda = await correr(e, ["--help"]);
    for (const c of ["start", "stop", "status", "search", "doctor", "install claude-code", "uninstall claude-code", "hook session-start"]) {
      expect(ayuda.stdout).toContain(c);
    }
  });

  it("doctor marca el token con permisos abiertos y da el chmod", async () => {
    const { chmodSync } = await import("node:fs");
    const token = join(e.datos, "token");
    chmodSync(token, 0o644);
    const r = await correr(e, ["doctor"]);
    expect(r.stdout).toMatch(/FALLA token: .* permisos 0644\n {6}arreglo: chmod 600 /);
    chmodSync(token, 0o600);
  });
});
