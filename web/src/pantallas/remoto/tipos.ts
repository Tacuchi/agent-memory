// Formas que devuelve el servicio para «Acceso remoto» (contrato del plan 008, F3).

export type TipoAmbito = "global" | "proyecto" | "repo";

export interface AmbitoAlcance {
  ambito: TipoAmbito;
  ref: string | null;
}

/** Un ámbito existente en esta memoria, con su cantidad de entradas (remoto_ambitos). */
export interface AmbitoExistente extends AmbitoAlcance {
  entradas: number;
}

export interface Alcance {
  ambitos: AmbitoAlcance[];
  no_validadas: boolean;
}

export interface Dispositivo {
  id: number;
  nombre: string;
  enlazado_en: string;
  usado_en: string | null;
  vence_en: string;
  revocado_en: string | null;
  estado: "vigente" | "revocado" | "credencial_vencida";
  alcance: Alcance;
}

/** Una memoria que esta PC lee. `nombre` y `usado_en` faltan en servicios anteriores a 0.4. */
export interface Enlace {
  origen: string;
  nombre?: string | null;
  enlazado_en?: string;
  vence_en: string;
  usado_en?: string | null;
  /** `host:puerto` si se canjeó una invitación directa; null = por relé. Falta en servicios anteriores. */
  direccion?: string | null;
}

/** Un pedido hecho desde el panel del relé que amplía el acceso: espera la decisión de la persona (D01). */
export interface PedidoPanel {
  id: number;
  accion: "renovar" | "alcance" | "codigo";
  dispositivo: { id: number; nombre: string } | null;
  datos: { ambitos: string[]; pendientes: boolean } | null;
  creado_en: string;
  estado: string;
}

/** `invitacion` (código + dirección de esta PC) llega solo con la conexión directa escuchando. */
export type CodigoNuevo = { codigo: string; vence_en: string; invitacion?: string | null };

/** Dónde escucha la conexión directa de esta PC y, si no escucha, por qué. */
export interface Directo {
  direccion: string | null;
  puerto: number;
  estado: "apagado" | "escuchando" | "no_disponible";
  motivo: string | null;
}

/** Una dirección de esta PC que sirve para la conexión directa (Tailscale primero). */
export interface DireccionPc {
  direccion: string;
  interfaz: string;
  tailscale: boolean;
}

/** Una PC conectada (0.4.1): los dos sentidos unidos por la huella de su clave. */
export interface Conexion {
  huella: string;
  nombre: string;
  /** Esta PC le comparte su memoria (la otra la lee). */
  comparto: {
    id: number;
    estado: "vigente" | "credencial_vencida" | "revocado";
    alcance: Alcance;
    usado_en: string | null;
    vence_en: string;
    revocado_en: string | null;
  } | null;
  /** La otra PC le comparte la suya a esta (esta la lee). */
  leo: { origen: string; enlazado_en: string; usado_en: string | null; vence_en: string; direccion?: string | null } | null;
  hoy: { leyo: number; lei: number; rechazos: number };
}

/** Una fila de actividad de una conexión: lo que leyó de esta memoria o lo que esta PC leyó de la suya. */
export interface FilaActividad {
  fecha: string;
  herramienta: string;
  pedido: string | null;
  ids: number[];
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

export interface Estado {
  interruptor: boolean;
  /** Faltan en servicios anteriores a 0.4.1. */
  conexiones?: Conexion[];
  desconocidas_hoy?: number;
  /** Falta cuando responde un servicio de una versión anterior a esta web. */
  nombre_pc?: string;
  panel?: "conectado" | "conectando" | "inactivo";
  pendientes?: PedidoPanel[];
  rele: { url: string } | null;
  /** Faltan en servicios sin conexión directa. */
  directo?: Directo;
  direcciones?: DireccionPc[];
  codigo: { vence_en: string; intentos_restantes: number } | null;
  dispositivos: Dispositivo[];
  enlaces: Enlace[];
}

export interface Registro {
  id: number;
  fecha: string;
  dispositivo_id: number | null;
  dispositivo: string | null;
  herramienta: string;
  pedido: string | null;
  ids: number[];
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

export type PruebaRele = "responde" | "clave_rechazada" | "no_responde" | "sin_rele";
