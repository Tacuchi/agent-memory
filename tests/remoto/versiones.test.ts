import { afterEach, describe, expect, it } from "vitest";
import { enlazar, instalacion, releLocal } from "./instalaciones.js";

// Spec 007, AC-32: una PC actualizada y otra en la versión anterior siguen leyéndose. El protocolo no cambió y la
// dueña responde con los mismos campos que la 0.4.1: el recorte y la omisión viven solo en la PC que lee.

const CAMPOS_041 = [
  "id", "titulo", "tipo", "ambito", "ambito_ref", "vida", "vigencia_hasta", "validacion", "actualizada_en", "marca",
  "validacion_via", "motivo_rechazo", "reemplaza_a", "reemplazada_por", "caducidad", "contenido", "puntaje",
].sort();
const CONTEXTO = { repo: null, proyecto: null };
const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

describe("versiones cruzadas", () => {
  it("lo que la dueña manda por el relé tiene los mismos campos que en la 0.4.1, en búsqueda y en lectura", async () => {
    const rele = await releLocal();
    const duena = await instalacion();
    const lectora = await instalacion();
    abiertos.push(rele, duena, lectora);
    const id = await enlazar(duena, lectora, rele);
    await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
    const remota = (
      await duena.app.store.crear({ tipo: "leccion", titulo: "Compartida", contenido: "entre versiones", ambito: "global", ambitoRef: null }, { actor: "agente", confirmado: true })
    ).entrada.id;

    const { datos } = await lectora.agente("buscar", { consulta: "versiones", contexto: CONTEXTO });
    const resultado = datos.resultados.find((r: { origen?: string }) => r.origen === "trabajo");
    // La lectora solo agrega su marca de origen a lo que recibió.
    const { origen, dato_externo, ...recibido } = resultado;
    expect([origen, dato_externo]).toEqual(["trabajo", true]);
    expect(Object.keys(recibido).sort()).toEqual(CAMPOS_041);

    const leida = await lectora.agente("leer", { id: remota, origen: "trabajo" });
    const { origen: _o, dato_externo: _d, ...entrada } = leida.datos.entrada;
    expect(Object.keys(entrada).sort()).toEqual(CAMPOS_041.filter((c) => c !== "puntaje"));
  });
});
