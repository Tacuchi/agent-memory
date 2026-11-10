// TEMPORAL: diagnóstico de la búsqueda por vector según el sistema. Se borra antes de cerrar la rama.
// Imprime, para tres paráfrasis del conjunto, los primeros valores y la norma de los embeddings, el coseno en JS
// contra la distancia de sqlite-vec y el puesto de la entrada esperada por cada camino.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const raiz = pathToFileURL(`${process.cwd()}/`).href;
const { TransformersEmbedder } = await import(`${raiz}dist/search/embedder.js`);
const { modeloFijado } = await import(`${raiz}dist/search/models.js`);
const { openDatabase, vectorBlob } = await import(`${raiz}dist/db/driver.js`);

const conjunto = JSON.parse(readFileSync("tests/fixtures/consultas-es.json", "utf8"));
const consultas = ["problema de husos al calcular caducidades", "guardar todo en un fichero sin motor externo", "cómo nombrar una branch nueva"];
const embedder = new TransformersEmbedder(modeloFijado());
const f = (v) => Array.from(v.slice(0, 5), (x) => x.toFixed(6)).join(" ");
const norma = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const coseno = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (norma(a) * norma(b));

console.log(`plataforma ${process.platform} ${process.arch} · node ${process.version}`);
const corpus = [];
for (const e of conjunto.corpus) corpus.push({ clave: e.clave, v: await embedder.embedPassage(`${e.titulo}\n${e.contenido}`) });
const db = openDatabase(":memory:");
db.exec(`CREATE VIRTUAL TABLE t USING vec0(embedding float[${corpus[0].v.length}])`);
const insertar = db.prepare("INSERT INTO t(rowid, embedding) VALUES (?, ?)");
corpus.forEach((c, i) => insertar.run(BigInt(i + 1), vectorBlob(c.v)));
const distancia = db.prepare("SELECT vec_distance_cosine(?, ?) AS c, vec_distance_l2(?, ?) AS l");
const knn = db.prepare("SELECT rowid AS id, distance FROM t WHERE embedding MATCH ? AND k = ? ORDER BY distance");

for (const texto of consultas) {
  const c = conjunto.consultas.find((x) => x.consulta === texto);
  const esperada = corpus.find((x) => x.clave === c.esperada);
  const q = await embedder.embedQuery(texto);
  const d = distancia.get(vectorBlob(q), vectorBlob(esperada.v), vectorBlob(q), vectorBlob(esperada.v));
  const porJs = corpus.map((x) => ({ clave: x.clave, s: coseno(q, x.v) })).sort((a, b) => b.s - a.s);
  const porVec = knn.all(vectorBlob(q), corpus.length).map((r) => corpus[Number(r.id) - 1].clave);
  console.log(`\nconsulta «${texto}» → esperada ${c.esperada}`);
  console.log(`  q[0..4] ${f(q)} · norma ${norma(q).toFixed(6)}`);
  console.log(`  e[0..4] ${f(esperada.v)} · norma ${norma(esperada.v).toFixed(6)}`);
  console.log(`  coseno JS ${coseno(q, esperada.v).toFixed(6)} · sqlite-vec 1-cos ${(1 - d.c).toFixed(6)} · l2 ${d.l.toFixed(6)}`);
  console.log(`  puesto JS ${porJs.findIndex((x) => x.clave === c.esperada) + 1} · puesto vec0 ${porVec.indexOf(c.esperada) + 1}`);
  console.log(`  top3 JS ${porJs.slice(0, 3).map((x) => `${x.clave}=${x.s.toFixed(4)}`).join(", ")}`);
}
db.close();

// Segunda pasada: archivos del modelo, tokens, pooling y, en Windows, fp32 frente a q8.
const { createHash } = await import("node:crypto");
const { readdirSync, statSync, mkdtempSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const { cacheModelos } = await import(`${raiz}dist/search/models.js`);
const modelo = modeloFijado();
const carpeta = join(cacheModelos(), ...modelo.id.split("/"));
const listar = (dir, prefijo = "") =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listar(join(dir, n), `${prefijo}${n}/`) : [`${prefijo}${n}`]));
console.log("\narchivos del modelo:");
for (const archivo of listar(carpeta)) {
  const ruta = join(carpeta, archivo);
  console.log(`  ${archivo} ${statSync(ruta).size} B sha256 ${createHash("sha256").update(readFileSync(ruta)).digest("hex").slice(0, 16)}`);
}
const tf = await import("@huggingface/transformers");
tf.env.cacheDir = cacheModelos();
tf.env.localModelPath = cacheModelos();
tf.env.allowLocalModels = true;
tf.env.allowRemoteModels = false;
const frase = "cómo nombrar una branch nueva";
const tokenizer = await tf.AutoTokenizer.from_pretrained(modelo.id);
console.log(`tokens «${frase}»: ${JSON.stringify(Array.from(tokenizer(frase).input_ids.data, Number))}`);
const extractor = await tf.pipeline("feature-extraction", modelo.id, { dtype: modelo.dtype });
for (const pooling of ["cls", "mean"]) {
  const crudo = (await extractor(frase, { pooling, normalize: false })).data;
  const max = crudo.reduce((m, x, i) => (Math.abs(x) > Math.abs(m.v) ? { i, v: x } : m), { i: -1, v: 0 });
  console.log(`q8 ${pooling} sin normalizar: [0..4] ${f(crudo)} · norma ${norma(crudo).toFixed(4)} · máx |x| dim ${max.i} = ${max.v.toFixed(4)}`);
}
const todo = (await extractor(frase, { pooling: "none", normalize: false }));
console.log(`q8 sin pooling: dims ${JSON.stringify(todo.dims)} · token0[0..4] ${f(todo.data)} · token1[0..4] ${f(todo.data.slice(todo.dims[2]))}`);
if (process.platform === "win32") {
  const otra = mkdtempSync(join(tmpdir(), "diag-fp32-"));
  tf.env.cacheDir = otra;
  tf.env.localModelPath = otra;
  tf.env.allowRemoteModels = true;
  const fp32 = await tf.pipeline("feature-extraction", modelo.id, { dtype: "fp32" });
  const q = (await fp32(frase, { pooling: modelo.pooling, normalize: true })).data;
  console.log(`fp32 en Windows: q[0..4] ${f(q)}`);
}
