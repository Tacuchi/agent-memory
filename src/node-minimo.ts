// Versión mínima de Node. Este módulo no importa nada: la entrada del bin lo carga antes que el
// resto de la CLI, que usa APIs que un Node anterior no tiene.

export const NODE_MINIMO = "22.16.0";

function partes(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/** true si `version` (como `process.versions.node`) alcanza `minimo`. */
export function nodeSuficiente(version: string, minimo: string = NODE_MINIMO): boolean {
  const a = partes(version);
  const b = partes(minimo);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function mensajeNodeViejo(version: string): string {
  return `agent-memory necesita Node ${NODE_MINIMO} o más nuevo y encontró Node ${version.replace(/^v/, "")}; actualizá Node y repetí el comando`;
}
