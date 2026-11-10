/** Palabras vacías del español: no aportan a la coincidencia de texto y solo meten ruido en FTS. */
export const PALABRAS_VACIAS: ReadonlySet<string> = new Set(
  (
    "a al algo ante antes como con contra cual cuando de del desde donde durante e el ella ellos en entre era es esa ese eso esta este esto " +
    "fue ha hay hasta la las le les lo los mas me mi muy nada ni no nos o os otra otro para pero poco por porque que quien se sea segun ser " +
    "si sin sobre solo su sus tambien tan te tiene todo tras tu un una uno unos unas y ya yo cada vez mas menos como cual cuales"
  ).split(/\s+/),
);

export function normalizarTermino(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Términos con contenido de un texto, sin tildes ni palabras vacías. */
export function terminos(texto: string, opciones: { conVacias?: boolean } = {}): string[] {
  const crudos = texto.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unicos = [...new Set(crudos.map(normalizarTermino))];
  return opciones.conVacias ? unicos : unicos.filter((t) => !PALABRAS_VACIAS.has(t));
}
