import type { Transporte } from "../../src/remoto/canal.js";

/**
 * Dos transportes unidos por un "relé" en memoria que ve, guarda y puede tocar cada mensaje. `pasar` decide qué se
 * entrega: el mensaje tal cual, uno cambiado, varios (repetir) o ninguno (retener para reordenar después).
 */
export interface Tuberia {
  a: Transporte;
  b: Transporte;
  /** Todo lo que pasó por el relé, en los dos sentidos. */
  vistos: Buffer[];
  /** Hook de manipulación: recibe el mensaje y su sentido; devuelve lo que se entrega. */
  pasar: (datos: Buffer, sentido: "ab" | "ba", n: number) => Buffer[];
  /** Entrega a mano (para reordenar). */
  entregar(sentido: "ab" | "ba", datos: Buffer): void;
}

export function tuberia(): Tuberia {
  const receptores = { a: [] as ((d: Buffer) => void)[], b: [] as ((d: Buffer) => void)[] };
  const cierres = { a: [] as (() => void)[], b: [] as (() => void)[] };
  let cerrada = false;
  const cuenta = { ab: 0, ba: 0 };
  let cerrando = false;
  // Como un WebSocket que cierra con gracia: lo ya enviado se entrega antes del aviso de cierre.
  const cerrar = (): void => {
    if (cerrando) return;
    cerrando = true;
    queueMicrotask(() => {
      cerrada = true;
      for (const fn of [...cierres.a, ...cierres.b]) fn();
    });
  };
  const t: Tuberia = {
    vistos: [],
    pasar: (datos) => [datos],
    entregar(sentido, datos) {
      if (cerrada) return;
      const destino = sentido === "ab" ? receptores.b : receptores.a;
      queueMicrotask(() => {
        if (!cerrada) for (const fn of destino) fn(Buffer.from(datos));
      });
    },
    a: punta("ab"),
    b: punta("ba"),
  };
  function punta(sentido: "ab" | "ba"): Transporte {
    const yo = sentido === "ab" ? "a" : "b";
    return {
      enviar(datos) {
        if (cerrando) return;
        t.vistos.push(Buffer.from(datos));
        for (const d of t.pasar(Buffer.from(datos), sentido, cuenta[sentido]++)) t.entregar(sentido, d);
      },
      alRecibir: (fn) => receptores[yo].push(fn),
      alCerrar: (fn) => cierres[yo].push(fn),
      cerrar,
    };
  }
  return t;
}
