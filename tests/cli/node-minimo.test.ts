import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mensajeNodeViejo, NODE_MINIMO, nodeSuficiente } from "../../src/node-minimo.js";
import { asegurarBuild, RAIZ } from "../helpers/servicio.js";

// La entrada del bin rechaza un Node anterior a 22.16.0 antes de cargar la CLI.

describe("versión mínima de Node", () => {
  it("es 22.16.0", () => {
    expect(NODE_MINIMO).toBe("22.16.0");
  });

  it.each(["22.15.1", "21.7.3", "20.19.0", "v22.15.0"])("%s no alcanza y el mensaje nombra las dos versiones", (v) => {
    expect(nodeSuficiente(v)).toBe(false);
    const mensaje = mensajeNodeViejo(v);
    expect(mensaje).toContain("22.16.0");
    expect(mensaje).toContain(v.replace(/^v/, ""));
  });

  it.each(["22.16.0", "22.20.0", "23.0.0", "24.1.0"])("%s alcanza", (v) => {
    expect(nodeSuficiente(v)).toBe(true);
  });

  it("el bin compilado arranca la CLI con el Node actual", () => {
    asegurarBuild();
    const r = spawnSync(process.execPath, [`${RAIZ}dist/bin.js`, "--version"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
