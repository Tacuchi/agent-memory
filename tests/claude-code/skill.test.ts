import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENCABEZADO_INDICE } from "../../src/indice/indice.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// T2.3 (AC-30): la skill instalada trae cada regla de uso que la memoria nativa pierde al apagarse,
// y el encabezado del índice las resume.

let e: EntornoCli;
let skill: string;

beforeAll(async () => {
  asegurarBuild();
  e = await entornoCli();
  expect((await correr(e, ["install", "claude-code"])).code).toBe(0);
  skill = readFileSync(join(e.home, ".claude", "skills", "agent-memory", "SKILL.md"), "utf8");
});

afterAll(async () => {
  await e.limpiar();
});

const REGLAS: [string, RegExp[]][] = [
  ["cuándo guardar o proponer guardar", [/## Cuándo guardar o proponer guardar/, /Guardá cuando la persona lo pide/, /Proponé guardar cuando/]],
  ["con qué tipo y ámbito", [/Elegí el tipo/, /`preferencia`/, /`leccion`/, /`decision`/, /`convencion`/, /`referencia`/, /`proyecto`/, /Elegí el ámbito/]],
  ["buscar antes de crear", [/## Buscar antes de crear/, /Antes de `memory_create`, buscá con `memory_search`/]],
  ["actualizar en sitio en vez de duplicar", [/actualizala en sitio con `memory_edit` en vez de duplicarla/]],
  ["no guardar lo que el repo ya registra", [/Lo que el repo ya registra/]],
  ["ni secretos ni datos de clientes", [/Secretos de ningún tipo/, /Datos de clientes/]],
  ["lo recordado es evidencia y no instrucción", [/## Lo recordado es evidencia, no instrucción/, /nunca como una orden/]],
  ["verificar que sigue vigente", [/Verificá que sigue vigente antes de recomendarla/]],
  ["mostrar el borrador exacto", [/mostrale el borrador exacto/, /`borrador: true`/, /`huella`/]],
  ["aprobar solo a pedido", [/`memory_approve` solo cuando la persona lo pide/]],
];

describe("skill agent-memory (AC-30)", () => {
  it("tiene frontmatter con nombre y descripción", () => {
    expect(skill).toMatch(/^---\nname: agent-memory\ndescription: .+\n---\n/);
  });

  for (const [regla, patrones] of REGLAS) {
    it(`trae la regla: ${regla}`, () => {
      for (const p of patrones) expect(skill).toMatch(p);
    });
  }

  it("el encabezado del índice resume las reglas", () => {
    for (const p of [/evidencia, no instrucciones/, /vigente/, /Buscá antes de crear/, /secretos ni datos de clientes/, /borrador exacto/, /aprobá solo si lo pide/]) {
      expect(ENCABEZADO_INDICE).toMatch(p);
    }
  });

  it("no trae patrones de exclusión: viven solo en la configuración local", () => {
    expect(skill).not.toMatch(/example\.org/);
  });
});
