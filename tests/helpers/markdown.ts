import { readFileSync } from "node:fs";

/** Lee un .md exportado sin el servicio: cabecera YAML (escalares) y cuerpo. */
export function leerExportado(ruta: string): { cabecera: Record<string, unknown>; cuerpo: string } {
  const texto = readFileSync(ruta, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texto);
  if (!m) throw new Error(`${ruta} no tiene cabecera YAML`);
  const cabecera: Record<string, unknown> = {};
  for (const linea of (m[1] as string).split("\n")) {
    const i = linea.indexOf(": ");
    const clave = linea.slice(0, i);
    const valor = linea.slice(i + 2);
    cabecera[clave] = valor === "null" ? null : /^-?\d+$/.test(valor) ? Number(valor) : JSON.parse(valor);
  }
  return { cabecera, cuerpo: m[2] as string };
}
