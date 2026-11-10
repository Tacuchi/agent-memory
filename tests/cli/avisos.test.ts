import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild, CLI, RAIZ } from "../helpers/servicio.js";

// `node:sqlite` avisa que es experimental al cargarse. La CLI lo carga sin ese aviso se la lance
// como se la lance (bin, `node dist/cli.js`, servicio, MCP o hook), sin flags de node y sin
// apagar los demás avisos.

/** Entorno del proceso de pruebas sin nada que silencie avisos por fuera de la CLI. */
function entornoSinSilenciar(): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _opciones, NODE_NO_WARNINGS: _sinAvisos, ...env } = process.env;
  return env;
}

beforeAll(() => asegurarBuild());

describe("aviso experimental de node:sqlite", () => {
  it("«node dist/cli.js --help» sin flags de node no lo imprime", () => {
    const r = spawnSync(process.execPath, [CLI, "--help"], { env: entornoSinSilenciar(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^uso: agent-memory/);
    expect(r.stderr).not.toContain("ExperimentalWarning");
  });

  it("los demás avisos, experimentales o no, se siguen mostrando", () => {
    const driver = pathToFileURL(`${RAIZ}dist/db/driver.js`).href;
    const codigo = [
      `await import(${JSON.stringify(driver)});`,
      `process.emitWarning("otra función en prueba", "ExperimentalWarning");`,
      `process.emitWarning("algo obsoleto", "DeprecationWarning");`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { env: entornoSinSilenciar(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("ExperimentalWarning: otra función en prueba");
    expect(r.stderr).toContain("DeprecationWarning: algo obsoleto");
    expect(r.stderr).not.toContain("SQLite");
  });

  describe("servicio, MCP y hook", () => {
    let e: EntornoCli;
    beforeAll(async () => {
      e = await entornoCli({ claude: false });
    });
    afterAll(async () => {
      await e.limpiar();
    });

    it("el hook, el servicio que arranca y el MCP no lo imprimen", async () => {
      const hook = await correr(e, ["hook", "session-start"], { input: JSON.stringify({ cwd: e.home }) });
      expect(hook.code, hook.stderr).toBe(0);
      expect(hook.stderr).not.toContain("ExperimentalWarning");
      // El hook deja el servicio arrancando; «start» espera a que responda.
      expect((await correr(e, ["start"])).code).toBe(0);
      expect(readFileSync(join(e.datos, "servicio.log"), "utf8")).not.toContain("ExperimentalWarning");

      const mcp = await correr(e, ["mcp"]);
      expect(mcp.code, mcp.stderr).toBe(0);
      expect(mcp.stderr).not.toContain("ExperimentalWarning");
    });
  });
});
