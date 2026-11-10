import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  abrirComoIniciador,
  abrirComoRespondedor,
  cargarIdentidad,
  ErrorCanal,
  generarIdentidad,
  type Identidad,
  type Sesion,
} from "../../src/remoto/canal.js";
import { tuberia, type Tuberia } from "./tuberia.js";

const MARCA = "cadena-marcada-7f3a91-no-debe-verse";

function identidad(): Identidad {
  return cargarIdentidad(generarIdentidad());
}

async function abrirPar(t: Tuberia, lectora = identidad(), duena = identidad()): Promise<{ i: Sesion; r: Sesion }> {
  const [i, r] = await Promise.all([
    abrirComoIniciador(t.a, { yo: lectora, otro: duena.publica }),
    abrirComoRespondedor(t.b, { yo: duena, aceptar: (s) => s === lectora.publica || "desconocido" }),
  ]);
  return { i, r };
}

async function codigoDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
    return "ok";
  } catch (error) {
    return error instanceof ErrorCanal ? error.codigo : String(error);
  }
}

describe("canal cifrado de extremo a extremo", () => {
  it("dos extremos con claves fijadas intercambian mensajes en los dos sentidos", async () => {
    const t = tuberia();
    const lectora = identidad();
    const duena = identidad();
    const { i, r } = await abrirPar(t, lectora, duena);
    expect(i.otro).toBe(duena.publica);
    expect(r.otro).toBe(lectora.publica);
    i.enviar({ op: "buscar", consulta: MARCA });
    expect(await r.recibir()).toEqual({ op: "buscar", consulta: MARCA });
    r.enviar({ ok: true, entradas: [{ id: 5, cuerpo: MARCA }] });
    r.enviar({ fin: true });
    expect(await i.recibir()).toEqual({ ok: true, entradas: [{ id: 5, cuerpo: MARCA }] });
    expect(await i.recibir()).toEqual({ fin: true });
  });

  it("un relé espía que guarda los bytes no contiene la cadena marcada", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    i.enviar({ consulta: MARCA });
    await r.recibir();
    r.enviar({ cuerpo: `${MARCA} ${MARCA}` });
    await i.recibir();
    const todo = Buffer.concat(t.vistos);
    expect(t.vistos.length).toBeGreaterThanOrEqual(5);
    expect(todo.includes(Buffer.from(MARCA))).toBe(false);
    expect(todo.includes(Buffer.from(MARCA.slice(0, 12)))).toBe(false);
  });

  it("un byte alterado en tránsito corta la sesión", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    t.pasar = (datos, sentido) => {
      if (sentido === "ab") datos[datos.length - 20] = (datos[datos.length - 20] ?? 0) ^ 0x01;
      return [datos];
    };
    i.enviar({ consulta: "hola" });
    expect(await codigoDe(r.recibir())).toBe("manipulado");
    expect(await codigoDe(r.recibir())).toBe("manipulado");
    expect(() => i.enviar({ otra: 1 })).toThrow(ErrorCanal);
  });

  it("un mensaje repetido corta la sesión", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    t.pasar = (datos, sentido) => (sentido === "ab" ? [datos, datos] : [datos]);
    i.enviar({ n: 1 });
    expect(await r.recibir()).toEqual({ n: 1 });
    expect(await codigoDe(r.recibir())).toBe("manipulado");
  });

  it("dos mensajes reordenados cortan la sesión", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    const retenidos: Buffer[] = [];
    t.pasar = (datos, sentido) => {
      if (sentido !== "ab") return [datos];
      retenidos.push(datos);
      return [];
    };
    i.enviar({ n: 1 });
    i.enviar({ n: 2 });
    t.entregar("ab", retenidos[1] as Buffer);
    t.entregar("ab", retenidos[0] as Buffer);
    expect(await codigoDe(r.recibir())).toBe("manipulado");
  });

  it("un relé en el medio con sus propias claves no completa el handshake", async () => {
    const lectora = identidad();
    const duena = identidad();
    const intruso = identidad();
    // La lectora habla con el intruso creyendo que es la dueña; el intruso habla con la dueña.
    const lado1 = tuberia();
    const lado2 = tuberia();
    const resultados = await Promise.all([
      codigoDe(abrirComoIniciador(lado1.a, { yo: lectora, otro: duena.publica, esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(lado1.b, { yo: intruso, aceptar: () => true, esperaMs: 2000 })),
      codigoDe(abrirComoIniciador(lado2.a, { yo: intruso, otro: duena.publica, esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(lado2.b, { yo: duena, aceptar: (s) => s === lectora.publica || "desconocido", esperaMs: 2000 })),
    ]);
    expect(resultados[0]).toBe("clave_distinta");
    expect(resultados[3]).toBe("rechazado");
  });

  it("un relé que cambia solo la clave efímera no completa el handshake", async () => {
    const t = tuberia();
    const falsa = generarIdentidad().publica;
    t.pasar = (datos, sentido, n) => {
      if (sentido === "ba" && n === 0) {
        const m = JSON.parse(datos.toString()) as Record<string, unknown>;
        return [Buffer.from(JSON.stringify({ ...m, e: falsa }))];
      }
      return [datos];
    };
    const lectora = identidad();
    const duena = identidad();
    const [i, r] = await Promise.all([
      codigoDe(abrirComoIniciador(t.a, { yo: lectora, otro: duena.publica, esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(t.b, { yo: duena, aceptar: () => true, esperaMs: 2000 })),
    ]);
    expect(i).toBe("prueba_invalida");
    expect(["cerrado", "tiempo"]).toContain(r);
  });

  it("una versión distinta da version_incompatible en las dos puntas", async () => {
    const t = tuberia();
    const lectora = identidad();
    const duena = identidad();
    const [i, r] = await Promise.all([
      codigoDe(abrirComoIniciador(t.a, { yo: lectora, otro: duena.publica, version: 2 })),
      codigoDe(abrirComoRespondedor(t.b, { yo: duena, aceptar: () => true })),
    ]);
    expect(i).toBe("version_incompatible");
    expect(r).toBe("version_incompatible");
  });

  it("emparejar con el secreto fija la clave de la dueña; con otro secreto falla", async () => {
    const secreto = randomBytes(16);
    const lectora = identidad();
    const duena = identidad();
    const t = tuberia();
    const [i, r] = await Promise.all([
      abrirComoIniciador(t.a, { yo: lectora, secreto }),
      abrirComoRespondedor(t.b, { yo: duena, secreto }),
    ]);
    expect(i.otro).toBe(duena.publica);
    expect(r.otro).toBe(lectora.publica);

    const t2 = tuberia();
    const [i2, r2] = await Promise.all([
      codigoDe(abrirComoIniciador(t2.a, { yo: lectora, secreto: randomBytes(16), esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(t2.b, { yo: duena, secreto, esperaMs: 2000 })),
    ]);
    expect(i2).toBe("prueba_invalida");
    expect(["cerrado", "tiempo"]).toContain(r2);
  });

  it("al emparejar, un relé en el medio sin el secreto no completa el handshake", async () => {
    const secreto = randomBytes(16);
    const lectora = identidad();
    const duena = identidad();
    const intruso = identidad();
    const lado1 = tuberia();
    const lado2 = tuberia();
    const adivinado = randomBytes(16);
    const r = await Promise.all([
      codigoDe(abrirComoIniciador(lado1.a, { yo: lectora, secreto, esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(lado1.b, { yo: intruso, secreto: adivinado, esperaMs: 2000 })),
      codigoDe(abrirComoIniciador(lado2.a, { yo: intruso, secreto: adivinado, esperaMs: 2000 })),
      codigoDe(abrirComoRespondedor(lado2.b, { yo: duena, secreto, esperaMs: 2000 })),
    ]);
    expect(r[0]).toBe("prueba_invalida");
    expect(r[2]).toBe("prueba_invalida");
  });

  it("la dueña rechaza una lectora que no está registrada", async () => {
    const t = tuberia();
    const duena = identidad();
    const [i, r] = await Promise.all([
      codigoDe(abrirComoIniciador(t.a, { yo: identidad(), otro: duena.publica })),
      codigoDe(abrirComoRespondedor(t.b, { yo: duena, aceptar: () => "revocado" })),
    ]);
    expect(i).toBe("rechazado");
    expect(r).toBe("rechazado");
  });

  it("el motivo de rechazo solo pasa si es de la lista cerrada", async () => {
    const t = tuberia();
    const duena = identidad();
    let motivo: string | undefined;
    await Promise.all([
      abrirComoIniciador(t.a, { yo: identidad(), otro: duena.publica }).catch((e: ErrorCanal) => {
        motivo = e.motivo;
      }),
      abrirComoRespondedor(t.b, { yo: duena, rechazo: "codigo_usado" }).catch(() => undefined),
    ]);
    expect(motivo).toBe("codigo_usado");
    const t2 = tuberia();
    t2.pasar = (datos, sentido) => (sentido === "ba" ? [Buffer.from(JSON.stringify({ p: "agent-memory/enlace", v: 1, error: "rechazado", motivo: "\u001b[31mrojo" }))] : [datos]);
    const e = await abrirComoIniciador(t2.a, { yo: identidad(), otro: duena.publica }).catch((x: ErrorCanal) => x);
    expect((e as ErrorCanal).motivo).toBeUndefined();
    expect((e as ErrorCanal).message).not.toContain("rojo");
  });

  it("una inundación de mensajes sin leer corta la sesión en vez de agotar la memoria", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    for (let n = 0; n < 70; n++) i.enviar({ n });
    await new Promise((ok) => setTimeout(ok, 20));
    for (let n = 0; n < 64; n++) await r.recibir();
    expect(await codigoDe(r.recibir())).toBe("formato");
  });

  it("una respuesta que el relé corta (no entrega y cierra) es un error, nunca un vacío", async () => {
    const t = tuberia();
    const { i, r } = await abrirPar(t);
    t.pasar = (datos, sentido) => {
      if (sentido === "ba") {
        t.a.cerrar();
        return [];
      }
      return [datos];
    };
    i.enviar({ op: "buscar", datos: { consulta: "x" } });
    await r.recibir();
    r.enviar({ ok: true, datos: { resultados: [{ id: 1 }] } });
    expect(await codigoDe(i.recibir(1000))).toBe("cerrado");
  });
});

