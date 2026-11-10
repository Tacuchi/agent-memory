import { describe, expect, it } from "vitest";
import { leerConjunto, medir } from "../../src/search/medir.js";
import { modeloFijado } from "../../src/search/models.js";
import { terminos } from "../../src/search/stopwords.js";
import { modeloReal } from "../helpers/embedders.js";

const conjunto = leerConjunto("tests/fixtures/consultas-es.json");

describe("conjunto de consultas en español", () => {
  it("cada paráfrasis no comparte ninguna palabra con contenido con su entrada esperada", () => {
    for (const c of conjunto.consultas.filter((x) => x.clase === "parafrasis")) {
      const e = conjunto.corpus.find((x) => x.clave === c.esperada);
      expect(e, c.esperada).toBeDefined();
      const vocabulario = new Set(terminos(`${e!.titulo} ${e!.contenido}`));
      expect(terminos(c.consulta).filter((t) => vocabulario.has(t)), c.consulta).toEqual([]);
    }
  });

  it("trae paráfrasis y nombres exactos (símbolo, comando y sigla)", () => {
    const nombres = conjunto.consultas.filter((x) => x.clase === "nombre_exacto").map((x) => x.consulta);
    expect(nombres).toEqual(expect.arrayContaining(["calcularHuellaBorrador", "npm run model:fetch", "RRF"]));
    expect(conjunto.consultas.filter((x) => x.clase === "parafrasis").length).toBeGreaterThanOrEqual(10);
  });
});

describe("búsqueda híbrida con el modelo fijado", () => {
  it("cada paráfrasis sale entre las tres primeras y cada nombre exacto primero, sin red", async () => {
    modeloReal();
    const m = await medir(conjunto, modeloFijado());
    const fallas = m.rangos.filter((r) => (r.clase === "parafrasis" ? r.rango === null || r.rango > 3 : r.rango !== 1));
    expect(fallas).toEqual([]);
    expect(m.pasa).toBe(true);
  });
});
