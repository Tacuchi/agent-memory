import { aperturaCerco, cierreCerco } from "../../src/domain/cerco.js";

/** Saca el texto del bloque de datos, comprobando que abre y cierra con el mismo identificador. */
export function descercar(texto: string): string {
  const lineas = texto.split("\n");
  const id = /^<<<datos agent-memory ([0-9a-f]{8})>>>/.exec(lineas[0] ?? "")?.[1];
  if (!id || lineas[0] !== aperturaCerco(id) || lineas.at(-1) !== cierreCerco(id)) throw new Error(`no es un bloque de datos: ${texto.slice(0, 120)}`);
  return lineas.slice(1, -1).join("\n");
}
