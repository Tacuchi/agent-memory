import { afterEach, describe, expect, it } from "vitest";
import { OMISION_INICIAL_MS, OMISION_MAXIMA_MS } from "../../src/remoto/remoto.js";
import { enlazar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

// Spec 007, AC-09 a AC-11: tras un enlace que no respondió, las búsquedas no lo esperan durante un plazo que crece
// con cada fallo; una lectura que lo nombra lo intenta igual y, si responde, las búsquedas vuelven a consultarlo.

const ESPERA = 500;
const CONTEXTO = { repo: null, proyecto: null };
const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

async function mundo() {
  const rele = await releLocal();
  const duena = await instalacion();
  const lectora = await instalacion({ esperaMs: ESPERA });
  abiertos.push(rele, duena, lectora);
  const id = await enlazar(duena, lectora, rele);
  await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
  const remota = (
    await duena.app.store.crear({ tipo: "leccion", titulo: "Nota remota", contenido: "nota sobre la laptop", ambito: "global", ambitoRef: null }, { actor: "agente", confirmado: true })
  ).entrada.id;
  return { duena, lectora, remota };
}

async function buscar(lectora: Instalacion) {
  const inicio = Date.now();
  const { datos } = await lectora.agente("buscar", { consulta: "laptop", contexto: CONTEXTO });
  return { ms: Date.now() - inicio, enlace: datos.enlaces[0], resultados: datos.resultados as { titulo: string }[] };
}

describe("enlace omitido", () => {
  it("tras no responder, la búsqueda no lo espera, lo informa como omitido y el plazo crece hasta 5 min", async () => {
    const { duena, lectora } = await mundo();
    await duena.persona("remoto_interruptor", { encendido: false });

    const primera = await buscar(lectora);
    expect(primera.enlace).toEqual({ origen: "trabajo", estado: "sin_respuesta", motivo: null });

    const segunda = await buscar(lectora);
    expect(segunda.ms).toBeLessThan(ESPERA);
    expect(segunda.enlace).toMatchObject({ origen: "trabajo", estado: "omitido" });
    expect(segunda.enlace.motivo).toMatch(/no respondió/);
    const ahora = lectora.app.store.ahora().getTime();
    expect(Date.parse(segunda.enlace.reintento_en) - ahora).toBeGreaterThan(OMISION_INICIAL_MS - 5000);
    expect(Date.parse(segunda.enlace.reintento_en) - ahora).toBeLessThanOrEqual(OMISION_INICIAL_MS);
    // Omitido nunca es «ok sin resultados».
    expect(segunda.resultados).toEqual([]);

    // Pasado el plazo se vuelve a consultar; cada fallo seguido duplica el plazo, con tope.
    const plazos: number[] = [];
    let plazo = OMISION_INICIAL_MS;
    for (let i = 0; i < 5; i++) {
      lectora.avanzar(plazo + 1000);
      expect((await buscar(lectora)).enlace.estado).toBe("sin_respuesta");
      const omitido = (await buscar(lectora)).enlace;
      expect(omitido.estado).toBe("omitido");
      plazo = Date.parse(omitido.reintento_en) - lectora.app.store.ahora().getTime();
      plazos.push(Math.round(plazo / 10_000) * 10);
    }
    expect(plazos).toEqual([60, 120, 240, 300, 300]);
    expect(Math.max(...plazos) * 1000).toBe(OMISION_MAXIMA_MS);
  });

  it("una lectura que nombra el enlace lo intenta igual y, si responde, las búsquedas vuelven a consultarlo", async () => {
    const { duena, lectora, remota } = await mundo();
    await duena.persona("remoto_interruptor", { encendido: false });
    await buscar(lectora);
    expect((await buscar(lectora)).enlace.estado).toBe("omitido");

    await duena.persona("remoto_interruptor", { encendido: true });
    expect((await buscar(lectora)).enlace.estado).toBe("omitido");
    const leida = await lectora.agente("leer", { id: remota, origen: "trabajo" });
    expect(leida.status).toBe(200);
    expect(leida.datos.entrada).toMatchObject({ titulo: "Nota remota", origen: "trabajo" });

    const despues = await buscar(lectora);
    expect(despues.enlace).toEqual({ origen: "trabajo", estado: "ok", motivo: null });
    expect(despues.resultados.map((r) => r.titulo)).toContain("Nota remota");
  });
});
