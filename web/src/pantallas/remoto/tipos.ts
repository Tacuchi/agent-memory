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

export type CodigoNuevo = { codigo: string; vence_en: string };

export interface Estado {
  interruptor: boolean;
  /** Falta cuando responde un servicio de una versión anterior a esta web. */
  nombre_pc?: string;
  panel?: "conectado" | "conectando" | "inactivo";
  pendientes?: PedidoPanel[];
  rele: { url: string } | null;
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
