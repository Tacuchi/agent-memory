import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatearEstadoRemoto } from "../../src/remoto/estado-cli.js";
import { correr, entornoCli, type EntornoCli } from "../helpers/cli.js";
import { asegurarBuild } from "../helpers/servicio.js";

// `agent-memory remote direct` y `remote status` con el modo directo, sobre HOME, datos y puerto temporales.

let e: EntornoCli;

beforeAll(async () => {
  asegurarBuild();
  e = await entornoCli();
});

afterAll(async () => {
  await e.limpiar();
});

describe("remote direct", () => {
  it("rechaza el comodín, se apaga con off y remote status lo muestra", async () => {
    const comodin = await correr(e, ["remote", "direct", "0.0.0.0"]);
    expect(comodin.code).toBe(1);
    expect(comodin.stderr).toContain("nunca en todas");
    const off = await correr(e, ["remote", "direct", "off"]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout).toContain("modo directo: apagado");
    const estado = await correr(e, ["remote", "status"]);
    expect(estado.code, estado.stderr).toBe(0);
    expect(estado.stdout).toContain("modo directo: apagado");
  });

  it("remote status dice dónde escucha, por qué no y por dónde va cada enlace", () => {
    const texto = formatearEstadoRemoto({
      interruptor: true,
      rele: null,
      directo: { direccion: "100.101.102.103", puerto: 47822, estado: "no_disponible", motivo: "esta PC no tiene ahora la dirección 100.101.102.103" },
      escuchando: 0,
      codigo_vigente: false,
      dispositivos: [],
      enlaces: [
        { origen: "casa", vence_en: "2026-12-17T00:00:00.000Z", direccion: "100.64.0.9:47822" },
        { origen: "trabajo", vence_en: "2026-12-17T00:00:00.000Z", direccion: null },
      ],
    });
    expect(texto).toContain("modo directo: 100.101.102.103:47822, sin escuchar (esta PC no tiene ahora la dirección 100.101.102.103)");
    expect(texto).toContain("  - casa: directo a 100.64.0.9:47822, vence 2026-12-17");
    expect(texto).toContain("  - trabajo: por relé, vence 2026-12-17");
  });
});
