import { afterEach, describe, expect, it } from "vitest";
import { enlazar, instalacion, releLocal } from "./instalaciones.js";

// Volver a enlazar después de revocar (0.3.2): la lectora quita su enlace viejo y la dueña reactiva a la PC revocada.

const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

describe("volver a enlazar una PC revocada", () => {
  it("tras revocar, la lectora quita su enlace y canjea un código nuevo con el mismo nombre; empieza sin alcance", async () => {
    const rele = await releLocal();
    const duena = await instalacion();
    const lectora = await instalacion();
    abiertos.push(rele, duena, lectora);
    const id = await enlazar(duena, lectora, rele);
    await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
    await duena.persona("remoto_revocar", { id });

    // El nombre sigue ocupado hasta quitar el enlace viejo.
    const { datos: codigo } = await duena.persona("remoto_codigo");
    const repetido = await lectora.agente("enlace_canjear", { codigo: codigo.codigo, origen: "trabajo", dispositivo: "casa" });
    expect(repetido.datos.error?.codigo ?? repetido.datos.codigo).toBe("origen_repetido");
    expect((await lectora.agente("enlace_quitar", { origen: "trabajo" })).status).toBe(200);
    expect((await lectora.agente("enlace_quitar", { origen: "trabajo" })).status).not.toBe(200);

    const { datos: nuevo } = await duena.persona("remoto_codigo");
    const r = await lectora.agente("enlace_canjear", { codigo: nuevo.codigo, origen: "trabajo", dispositivo: "casa" });
    expect(r.status).toBe(200);
    const { datos } = await duena.persona("remoto_estado");
    expect(datos.dispositivos).toEqual([expect.objectContaining({ id, estado: "vigente", alcance: { ambitos: [], no_validadas: false } })]);
  });
});
