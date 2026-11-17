import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { citar, rutaEfimera, rutasHook } from "../../src/claude-code/install.js";
import { HERRAMIENTAS } from "../../src/mcp/server.js";
import { clienteMcp, correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild, RAIZ } from "../helpers/servicio.js";
import { descercar } from "../helpers/cerco.js";
import { dirTemporal } from "../helpers/temp.js";

// Instalar y desinstalar MCP, hook y skill con un `claude` falso y un HOME temporal.
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
const skillImportacionPath = () => join(e.home, ".claude", "skills", "agent-memory-import", "SKILL.md");
const llamadasClaude = () => (existsSync(e.logClaude) ? readFileSync(e.logClaude, "utf8").trim().split("\n") : []);

describe("comando del hook", () => {
  it("cita las rutas para el shell: ni $ ni comillas se expanden o parten", () => {
    const raro = "/tmp/a b/it's $HOME/`x`";
    // `sh` del PATH: en Windows es el de Git, el shell con el que Claude Code corre los hooks.
    expect(execFileSync("sh", ["-c", `printf %s ${citar(raro)}`], { encoding: "utf8" })).toBe(raro);
  });
});

describe("ubicaciones efímeras", () => {
  it.each([
    "/Users/ana/.npm/_npx/1a2b3c/node_modules/@tacuchi/agent-memory/dist/cli.js",
    "C:\\Users\\ana\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\@tacuchi\\agent-memory\\dist\\cli.js",
    "/private/var/folders/xy/T/bunx-501-@tacuchi/agent-memory@0.1.0/node_modules/@tacuchi/agent-memory/dist/cli.js",
  ])("%s es efímera", (ruta) => {
    expect(rutaEfimera(ruta)).toBe(true);
  });

  it.each([
    "/usr/local/lib/node_modules/@tacuchi/agent-memory/dist/cli.js",
    "/Users/ana/.nvm/versions/node/v22.16.0/lib/node_modules/@tacuchi/agent-memory/dist/cli.js",
    "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@tacuchi\\agent-memory\\dist\\cli.js",
    "/usr/local/bin/node",
  ])("%s es permanente", (ruta) => {
    expect(rutaEfimera(ruta)).toBe(false);
  });

  it("desde una copia bajo _npx, install se niega sin escribir nada ni llamar a «claude mcp add»", async () => {
    e = await entornoCli();
    mkdirSync(join(e.home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), SETTINGS_PREVIO);
    // Copia del paquete en una ruta con forma de caché de npx; las dependencias, por enlace.
    const paquete = join(e.raiz, "npm-cache", "_npx", "1a2b3c", "node_modules", "@tacuchi", "agent-memory");
    mkdirSync(paquete, { recursive: true });
    for (const parte of ["dist", "skills", "package.json"]) cpSync(join(RAIZ, parte), join(paquete, parte), { recursive: true });
    symlinkSync(join(RAIZ, "node_modules"), join(paquete, "node_modules"), "dir");

    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(paquete, "dist", "bin.js"), "install", "claude-code"], { env: e.env, cwd: e.home, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm install -g @tacuchi/agent-memory");
    expect(r.stderr).toContain("agent-memory install claude-code");
    expect(r.stderr).toContain("no se tocó nada");
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS_PREVIO);
    expect(llamadasClaude().filter((l) => l.startsWith("mcp add"))).toEqual([]);
    expect(existsSync(skillPath())).toBe(false);
    expect(existsSync(join(e.datos, "claude-code.json"))).toBe(false);
  });
});

describe("rutas del hook registrado", () => {
  it("lee node y cli.js del hook propio, también con comillas y espacios", () => {
    const { dir, limpiar } = dirTemporal();
    try {
      const raro = "/tmp/a b/it's $HOME/cli.js";
      const comando = `AGENT_MEMORY_HOOK=claude-code ${citar("/opt/node/bin/node")} ${citar(raro)} hook session-start`;
      mkdirSync(join(dir, "claude"));
      writeFileSync(join(dir, "claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hola" }] }, { hooks: [{ type: "command", command: comando }] }] } }));
      expect(rutasHook({ CLAUDE_CONFIG_DIR: join(dir, "claude") })).toEqual(["/opt/node/bin/node", raro]);
      expect(rutasHook({ CLAUDE_CONFIG_DIR: join(dir, "otra") })).toBeNull();
    } finally {
      limpiar();
    }
  });

  it("doctor da falla y pide repetir install cuando el cli.js registrado ya no existe", async () => {
    e = await entornoCli();
    expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const grupo = settings.hooks.SessionStart.at(-1);
    const borrado = join(e.raiz, "paquete-borrado", "dist", "cli.js");
    grupo.hooks[0].command = grupo.hooks[0].command.replace(/'[^']*cli\.js'/, citar(borrado));
    writeFileSync(settingsPath(), JSON.stringify(settings));

    const doctor = await correr(e, ["doctor"]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain(`FALLA claude-code: el hook y el MCP apuntan a rutas que ya no existen: ${borrado}`);
    expect(doctor.stdout).toContain("arreglo: repetí «agent-memory install claude-code»");
  });
});

describe("doctor y la skill de otra versión", () => {
  it("avisa si la skill instalada difiere de la del paquete y propone repetir install", async () => {
    e = await entornoCli();
    expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
    expect((await correr(e, ["doctor"])).stdout).not.toMatch(/skill instalada es de otra versión/);
    writeFileSync(skillPath(), readFileSync(skillPath(), "utf8").replace("## Después de compactar", "## Sección vieja"));
    const doctor = await correr(e, ["doctor"]);
    expect(doctor.stdout).toMatch(/claude-code: la skill instalada es de otra versión de agent-memory/);
    expect(doctor.stdout).toContain("arreglo: «agent-memory install claude-code»");
    expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
    expect((await correr(e, ["doctor"])).stdout).not.toMatch(/skill instalada es de otra versión/);
  });

  it("también avisa si la skill de importación es de otra versión", async () => {
    e = await entornoCli();
    expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
    writeFileSync(skillImportacionPath(), readFileSync(skillImportacionPath(), "utf8").replace("## Pasos", "## Pasos viejos"));
    const doctor = await correr(e, ["doctor"]);
    expect(doctor.stdout).toMatch(/claude-code: la skill instalada es de otra versión de agent-memory/);
    expect(doctor.stdout).toContain("arreglo: «agent-memory install claude-code»");
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
    expect(inicio[1]!.hooks[0]!.command).toMatch(/^AGENT_MEMORY_HOOK=claude-code '.*node.*' '.*cli\.js' hook session-start$/);

    expect(readdirSync(e.estadoClaude)).toEqual(["agent-memory"]);
    const adds = llamadasClaude().filter((l) => l.startsWith("mcp add"));
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatch(/^mcp add --scope user agent-memory -- .*node.* .*cli\.js mcp$/);
    expect(existsSync(skillPath())).toBe(true);
    expect(readFileSync(skillImportacionPath(), "utf8")).toMatch(/^name: agent-memory-import$/m);

    const doctor = await correr(e, ["doctor"]);
    expect(doctor.stdout).toMatch(/ok {4}claude-code: MCP, hook SessionStart y skill instalados/);

    const r = await correr(e, ["uninstall", "claude-code"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS_PREVIO);
    expect(readdirSync(e.estadoClaude)).toEqual([]);
    expect(existsSync(join(e.home, ".claude", "skills", "agent-memory"))).toBe(false);
    expect(existsSync(join(e.home, ".claude", "skills", "agent-memory-import"))).toBe(false);
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

  it("termina sin preguntar nada con la entrada estándar vacía y cerrada", async () => {
    e = await entornoCli();
    const r = await correr(e, ["install", "claude-code"], { input: "" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lineas = r.stdout.trimEnd().split("\n");
    // MCP, hook y las dos skills.
    expect(lineas).toHaveLength(4);
    for (const linea of lineas) expect(linea).toMatch(/^· /);
    expect(r.stdout).not.toMatch(/\?|: $/m);
  });

  it("una configuración con claves que ya no existen no impide instalar", async () => {
    e = await entornoCli();
    mkdirSync(e.datos, { recursive: true });
    const previa = `${JSON.stringify({ clave_retirada: { patrones: ["example.org/acme"] } }, null, 2)}\n`;
    writeFileSync(join(e.datos, "config.json"), previa);
    const r = await correr(e, ["install", "claude-code"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(e.datos, "config.json"), "utf8")).toBe(previa);
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
      expect(JSON.parse(descercar(r.content[0]!.text))).toEqual({ entradas: [] });
    } finally {
      await cliente.close();
    }
    expect(existsSync(join(e.home, ".claude"))).toBe(false);
  });
});
