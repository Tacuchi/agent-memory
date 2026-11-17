/** Cómo muestra `agent-memory remote status` y `remote direct` el estado del enlace remoto, sin secretos. */

export interface EstadoEnlaceCli {
  interruptor: boolean;
  rele: { url: string } | null;
  directo: { direccion: string | null; puerto: number; estado: "apagado" | "escuchando" | "no_disponible"; motivo: string | null };
  escuchando: number;
  codigo_vigente: boolean;
  dispositivos: { nombre: string; estado: string; vence_en: string }[];
  enlaces: { origen: string; vence_en: string; direccion: string | null }[];
}

export function formatearDirecto(d: EstadoEnlaceCli["directo"]): string {
  if (!d.direccion) return "modo directo: apagado («agent-memory remote direct <dirección>»)";
  const donde = `${d.direccion.includes(":") ? `[${d.direccion}]` : d.direccion}:${d.puerto}`;
  if (d.estado === "escuchando") return `modo directo: escuchando en ${donde}`;
  return `modo directo: ${donde}, sin escuchar${d.motivo ? ` (${d.motivo})` : ""}`;
}

export function formatearEstadoRemoto(e: EstadoEnlaceCli): string {
  const lineas = [
    `acceso remoto: ${e.interruptor ? "encendido" : "apagado"}${e.interruptor ? ` (escuchando ${e.escuchando} buzón/es)` : ""}`,
    `relé: ${e.rele ? e.rele.url : "sin configurar («agent-memory remote relay <url>»)"}`,
    formatearDirecto(e.directo),
    `código vigente: ${e.codigo_vigente ? "sí" : "no"}`,
    `dispositivos que leen esta memoria: ${e.dispositivos.length || "ninguno"}`,
    ...e.dispositivos.map((d) => `  - ${d.nombre}: ${d.estado}, vence ${d.vence_en.slice(0, 10)}`),
    `enlaces para leer otras memorias: ${e.enlaces.length || "ninguno"}`,
    ...e.enlaces.map((x) => `  - ${x.origen}: ${x.direccion ? `directo a ${x.direccion}` : "por relé"}, vence ${x.vence_en.slice(0, 10)}`),
  ];
  return lineas.join("\n");
}
