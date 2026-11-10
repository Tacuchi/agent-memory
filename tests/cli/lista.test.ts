import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// La ayuda lista arrancar, parar y estado; abrir la web y buscar; exportar; instalar y
// desinstalar; diagnosticar; purgar. Y cada comando responde, en un HOME temporal.

const AC28 = ["start", "stop", "status", "open", "search", "export", "install claude-code", "uninstall claude-code", "doctor", "purge"];

let e: EntornoCli;
beforeAll(async () => {
  asegurarBuild();
  e = await entornoCli();
});
afterAll(async () => e.limpiar());

describe("lista de comandos", () => {
  it("la ayuda lista todos los comandos del producto", async () => {
    const ayuda = await correr(e, ["--help"]);
    expect(ayuda.code).toBe(0);
    for (const c of AC28) expect(ayuda.stdout).toMatch(new RegExp(`^\\s+${c}\\b`, "m"));
  });

  it("cada comando responde", async () => {
    const pasos: [string[], number, RegExp][] = [
      [["start"], 0, /arrancó|ya corre/],
      [["status"], 0, /corriendo/],
      [["open", "--imprimir"], 0, /\/sesion\/[0-9a-f]{64}/],
      [["search", "algo"], 0, /sin resultados/],
      [["export", "--destino", join(e.raiz, "exportado")], 0, /0 entradas exportadas/],
      [["install", "claude-code", "--excluir", "example.org/acme"], 0, /exclusión: 1 patrón/],
      [["doctor"], -1, /servicio/],
      [["uninstall", "claude-code"], 0, /./],
      [["purge", "1", "--confirmar", "1"], 1, /no existe la entrada 1/],
      [["stop"], 0, /detenido/],
      [["status"], 3, /detenido/],
    ];
    for (const [args, codigo, texto] of pasos) {
      const r = await correr(e, args);
      if (codigo >= 0) expect(r.code, `${args.join(" ")}: ${r.stderr}`).toBe(codigo);
      else expect([0, 1], `${args.join(" ")}: ${r.stderr}`).toContain(r.code);
      expect(`${r.stdout}${r.stderr}`, args.join(" ")).toMatch(texto);
    }
  });
});
