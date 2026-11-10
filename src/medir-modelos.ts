import { CANDIDATOS } from "./search/models.js";
import { leerConjunto, medir } from "./search/medir.js";

// `npm run model:measure [ruta-del-conjunto]`: mide los candidatos de T2.2 con la caché local.
const ruta = process.argv[2] ?? "tests/fixtures/consultas-es.json";
const conjunto = leerConjunto(ruta);
for (const modelo of CANDIDATOS) {
  const m = await medir(conjunto, modelo);
  process.stdout.write(`${JSON.stringify(m)}\n`);
}
