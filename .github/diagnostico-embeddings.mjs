// TEMPORAL: diagnóstico de la búsqueda por vector según la CPU. Se borra antes de cerrar la rama.
// Mide el conjunto de consultas con cada variante del modelo publicado (q8, uint8, fp32) e imprime la CPU del runner.
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const raiz = pathToFileURL(`${process.cwd()}/`).href;
const { TransformersEmbedder } = await import(`${raiz}dist/search/embedder.js`);
const { modeloFijado } = await import(`${raiz}dist/search/models.js`);
const { leerConjunto, medir, PUESTO_MAXIMO_PARAFRASIS } = await import(`${raiz}dist/search/medir.js`);

let flags = "";
try {
  flags = readFileSync("/proc/cpuinfo", "utf8").match(/^flags\s*:(.*)$/m)?.[1] ?? "";
} catch {}
const tiene = (f) => (flags ? (` ${flags} `.includes(` ${f} `) ? "sí" : "no") : "?");
console.log(`plataforma ${process.platform} ${process.arch} · CPU ${cpus()[0]?.model} · avx2 ${tiene("avx2")} · avx512_vnni ${tiene("avx512_vnni")} · avx_vnni ${tiene("avx_vnni")}`);

const conjunto = leerConjunto("tests/fixtures/consultas-es.json");
const embeddings = conjunto.corpus.length + conjunto.consultas.length;
// Autochequeo candidato: un par de paráfrasis debe parecerse bastante más que un par sin relación.
const A = "reintentar con espera exponencial ante un error 503";
const B = "volver a intentar duplicando la pausa cuando el servidor no responde";
const C = "la receta del pan lleva harina, agua y sal";
const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
for (const dtype of ["q8", "uint8", "fp16", "fp32"]) {
  try {
    const modelo = { ...modeloFijado(), dtype };
    const cache = mkdtempSync(join(tmpdir(), `diag-${dtype}-`));
    await new TransformersEmbedder(modelo, { cache, permitirRed: true }).cargar();
    const onnx = join(cache, ...modelo.id.split("/"), "onnx");
    const mb = readdirSync(onnx).reduce((s, n) => s + statSync(join(onnx, n)).size, 0) / 1e6;
    const t = Date.now();
    const m = await medir(conjunto, modelo, cache);
    const ms = (Date.now() - t) / embeddings;
    const puestos = m.rangos.filter((r) => r.clase === "parafrasis").map((r) => r.rango ?? "-").join(" ");
    const nombres = m.rangos.filter((r) => r.clase === "nombre_exacto").map((r) => r.rango ?? "-").join(" ");
    const e = new TransformersEmbedder(modelo, { cache });
    const [a, b, c] = [await e.embedQuery(A), await e.embedPassage(B), await e.embedPassage(C)];
    const dominante = Math.max(...Array.from(a, Math.abs));
    console.log(
      `${dtype}: ${mb.toFixed(0)} MB · ${ms.toFixed(1)} ms/embedding (con carga e índice) · pasa top${PUESTO_MAXIMO_PARAFRASIS} ${m.pasa} · paráfrasis ${puestos} · nombres ${nombres} · autochequeo cos(par)=${cos(a, b).toFixed(4)} cos(ajeno)=${cos(a, c).toFixed(4)} margen=${(cos(a, b) - cos(a, c)).toFixed(4)} máx|x|=${dominante.toFixed(4)}`,
    );
  } catch (error) {
    console.log(`${dtype}: ERROR ${error.message}`);
  }
}
