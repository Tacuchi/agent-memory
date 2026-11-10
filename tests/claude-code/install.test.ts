import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { citar } from "../../src/claude-code/install.js";
import { HERRAMIENTAS } from "../../src/mcp/server.js";
import { clienteMcp, correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// T2.5 (AC-13): instalar y desinstalar MCP, hook y skill con un `claude` falso y un HOME temporal.
// Repetir no duplica nada y desinstalar deja settings.json byte a byte como estaba.

let e: EntornoCli;
beforeAll(() => asegurarBuild());
afterEach(async () => {
  // La prueba del comando del hook no crea entorno.
  await (e as EntornoCli | undefined)?.limpiar();
  e = undefined as never;
});

// Formato propio de la persona (tabs, sin salto final) y un hook ajeno que debe sobrevivir.
const SETTINGS_PREVIO = `{\n\t"model": "opus",\n\t"hooks": {\n\t\t"SessionStart": [\n\t\t\t{ "matcher": "startup", "hooks": [ { "type": "command", "command": "echo hola" } ] }\n\t\t],\n\t\t"Stop": [ { "hooks": [ { "type": "command", "command": "echo chau" } ] } ]\n\t}\n}`;

const settingsPath = () => join(e.home, ".claude", "settings.json");
const skillPath = () => join(e.home, ".claude", "skills", "agent-memory", "SKILL.md");
const llamadasClaude = () => (existsSync(e.logClaude) ? readFileSync(e.logClaude, "utf8").trim().split("\n") : []);

describe("comando del hook", () => {
  it("cita las rutas para el shell: ni $ ni comillas se expanden o parten", () => {
    const raro = "/tmp/a b/it's $HOME/`x`";
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${citar(raro)}`], { encoding: "utf8" })).toBe(raro);
  });
});

describe("install / uninstall claude-code", () => {
  it("instalar dos veces y desinstalar deja settings.json byte a byte como antes", async () => {
    e = await entornoCli();
    mkdirSync(join(e.home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), SETTINGS_PREVIO);

    for (let i = 0; i < 2; i++) {
      const r = await correr(e, ["install", "claude-code"]);
      expect(r.code, r.stderr).toBe(0);
    }
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo chau" }] }]);
    const inicio = settings.hooks.SessionStart as { hooks: { command: string }[] }[];
    expect(inicio).toHaveLength(2);
    expect(inicio[0]!.hooks[0]!.command).toBe("echo hola");
    expect(inicio[1]!.hooks[0]!.command).toMatch(/^AGENT_MEMORY_HOOK=claude-code '.*node.*' --disable-warning=ExperimentalWarning '.*cli\.js' hook session-start$/);

    expect(readdirSync(e.estadoClaude)).toEqual(["agent-memory"]);
    const adds = llamadasClaude().filter((l) => l.startsWith("mcp add"));
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatch(/^mcp add --scope user agent-memory -- .*node.* --disable-warning=ExperimentalWarning .*cli\.js mcp$/);
    expect(existsSync(skillPath())).toBe(true);

    const doctor = await correr(e, ["doctor"]);
    expect(doctor.stdout).toMatch(/ok {4}claude-code: MCP, hook SessionStart y skill instalados/);

    const r = await correr(e, ["uninstall", "claude-code"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS_PREVIO);
    expect(readdirSync(e.estadoClaude)).toEqual([]);
    expect(existsSync(join(e.home, ".claude", "skills", "agent-memory"))).toBe(false);
    expect(existsSync(join(e.datos, "claude-code.json"))).toBe(false);
    expect((await correr(e, ["doctor"])).stdout).toMatch(/FALLA claude-code: falta: MCP, hook SessionStart, skill/);
  });

  it("sin settings.json previo, desinstalar lo vuelve a dejar ausente", async () => {
    e = await entornoCli();
    expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
    expect(existsSync(settingsPath())).toBe(true);
    expect((await correr(e, ["uninstall", "claude-code"])).code).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("--excluir guarda los patrones en la configuración local; sin flag ni terminal deja la lista vacía y lo dice", async () => {
    e = await entornoCli();
    const sinFlag = await correr(e, ["install", "claude-code"]);
    expect(sinFlag.stdout).toMatch(/exclusión: lista vacía, ningún repo queda excluido/);
    expect(existsSync(join(e.datos, "config.json"))).toBe(false);

    const conFlag = await correr(e, ["install", "claude-code", "--excluir", "example.org/acme", "--excluir", "/tmp/acme"]);
    expect(conFlag.code, conFlag.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(e.datos, "config.json"), "utf8"));
    expect(config.exclusion.patrones).toEqual(["example.org/acme", "/tmp/acme"]);

    const otraVez = await correr(e, ["install", "claude-code"]);
    expect(otraVez.stdout).toMatch(/se conservan los 2 patrón/);
    await correr(e, ["uninstall", "claude-code"]);
    expect(JSON.parse(readFileSync(join(e.datos, "config.json"), "utf8")).exclusion.patrones).toHaveLength(2);
  });

  it("sin «claude» en el PATH, install falla sin tocar nada", async () => {
    e = await entornoCli({ claude: false });
    const r = await correr(e, ["install", "claude-code"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/«claude» no está en el PATH.*no se tocó nada/);
    expect(existsSync(join(e.home, ".claude"))).toBe(false);
    expect(existsSync(e.datos)).toBe(false);
  });

  it("un cliente MCP del SDK usa las herramientas sin nada de Claude Code", async () => {
    e = await entornoCli({ claude: false });
    expect((await correr(e, ["start"])).code).toBe(0);
    const cliente = await clienteMcp(e, e.home);
    try {
      const { tools } = await cliente.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...HERRAMIENTAS].sort());
      const r = (await cliente.callTool({ name: "memory_list", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.content[0]!.text)).toEqual({ entradas: [] });
    } finally {
      await cliente.close();
    }
    expect(existsSync(join(e.home, ".claude"))).toBe(false);
  });
});
