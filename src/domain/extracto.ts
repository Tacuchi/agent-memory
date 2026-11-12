// Extracto de una entrada para la búsqueda del agente: el comienzo del contenido (las entradas ponen la conclusión
// arriba y la búsqueda vectorial no tiene posición de coincidencia), cortado en un espacio.

export const LARGO_EXTRACTO = 300;

export interface Extracto {
  extracto: string;
  largo: number;
  recortado: boolean;
}

export function extraer(contenido: string, maximo = LARGO_EXTRACTO): Extracto {
  if (contenido.length <= maximo) return { extracto: contenido, largo: contenido.length, recortado: false };
  const cabe = contenido.slice(0, maximo - 1);
  const espacio = cabe.search(/\s\S*$/);
  const corte = espacio > maximo / 2 ? cabe.slice(0, espacio) : cabe;
  return { extracto: `${corte.trimEnd()}…`, largo: contenido.length, recortado: true };
}
