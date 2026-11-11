import type { ApiPanel } from "./api";
import type { Accion, Estado } from "./tipos";

// Estado de muestra con la forma del contrato. Datos ilustrativos: IPs de documentación
// (192.0.2.x, 198.51.100.x, 203.0.113.x) y huellas inventadas. Sirve para las pruebas y para
// ver la página en desarrollo sin relé (`npx vite --config web/panel/vite.config.ts`, con ?muestra).

export const HUELLA_MAC = "mAcPeRsOnAl0123456789A";
export const HUELLA_LAPTOP = "LaPtOpTrAbAjO987654321";
export const HUELLA_VIEJA = "pCvIeJa020000000000000";

export function estadoDeMuestra(ahora: number): Estado {
  const antes = (s: number) => new Date(ahora - s * 1000).toISOString();
  const despues = (s: number) => new Date(ahora + s * 1000).toISOString();
  const dia = (atras: number) => new Date(ahora - atras * 86_400_000).toISOString().slice(0, 10);
  const semana = (cifras: number[]) =>
    cifras.map((recibidas, i) => ({ dia: dia(6 - i), recibidas, hechas: Math.round(recibidas / 3), bytes: recibidas * 48_000, rechazos: i === 4 ? 1 : 0 }));
  return {
    rele: { version: "0.3.0", encendido_desde: antes(3 * 86_400), conexiones: 3, tope: 64 },
    pcs: [
      {
        huella: HUELLA_MAC,
        nombre: "Mac personal",
        version: "0.3.0",
        en_linea: true,
        visto: antes(4),
        ip: "198.51.100.24",
        informe: true,
        acceso: true,
        leen: [
          {
            huella: HUELLA_LAPTOP,
            nombre: "Laptop trabajo",
            alcance: { ambitos: ["global", "proyecto:agent-memory", "repo:workline"], pendientes: false },
            vence: despues(30 * 86_400),
            usado: antes(300),
            revocado: false,
          },
        ],
        lee: [{ origen: "trabajo", duena: HUELLA_LAPTOP, vence: despues(30 * 86_400), usado: antes(7200) }],
        codigo: null,
        conexiones: [
          { buzon: "bz-01", estado: "abierta", bytes: 812_000, inactivo_s: 4 },
          { buzon: "bz-02", estado: "abierta", bytes: 96_000, inactivo_s: 210 },
        ],
        uso: semana([4, 9, 7, 12, 15, 5, 12]),
        pendientes: [],
      },
      {
        huella: HUELLA_LAPTOP,
        nombre: "Laptop trabajo",
        version: "0.3.0",
        en_linea: true,
        visto: antes(12),
        ip: "203.0.113.7",
        informe: true,
        acceso: true,
        leen: [
          {
            huella: HUELLA_MAC,
            nombre: "Mac personal",
            alcance: { ambitos: ["proyecto:agent-memory"], pendientes: true },
            vence: despues(30 * 86_400),
            usado: antes(7200),
            revocado: false,
          },
        ],
        lee: [{ origen: "personal", duena: HUELLA_MAC, vence: despues(30 * 86_400), usado: antes(300) }],
        codigo: { vence: despues(462) },
        conexiones: [{ buzon: "bz-03", estado: "abierta", bytes: 41_000, inactivo_s: 30 }],
        uso: semana([1, 0, 3, 2, 4, 1, 3]),
        pendientes: [{ id: 1, accion: "renovar", objetivo: HUELLA_MAC, creado: antes(60) }],
      },
      {
        huella: HUELLA_VIEJA,
        nombre: "PC vieja",
        version: null,
        en_linea: false,
        visto: antes(3 * 3600),
        ip: "192.0.2.40",
        informe: false,
        acceso: null,
        leen: [],
        lee: [],
        codigo: null,
        conexiones: [],
        uso: [],
        pendientes: [],
      },
    ],
    desconocidas: [{ ip: "192.0.2.55", rechazos: 31, primera: antes(3000), ultima: antes(20) }],
    bloqueos: [{ tipo: "ip", valor: "192.0.2.88", hasta: despues(3 * 3600) }],
  };
}

/** API de muestra en memoria: responde el estado de muestra y acepta cualquier acción. */
export function apiDeMuestra(ahora: () => number = Date.now): ApiPanel & { acciones: Accion[] } {
  const acciones: Accion[] = [];
  return {
    acciones,
    estado: async () => estadoDeMuestra(ahora()),
    accion: async (cuerpo) => {
      acciones.push(cuerpo);
      const pendiente = ["renovar", "alcance", "codigo"].includes(cuerpo.accion);
      return { ok: true as const, estado: pendiente ? ("pendiente" as const) : ("hecho" as const) };
    },
  };
}
