/** Seis tipos de entrada (AC-17). `proyecto` es estado de trabajo vivo, fuera de la validación. */
export const TIPOS = ["leccion", "decision", "convencion", "referencia", "preferencia", "proyecto"] as const;
export type Tipo = (typeof TIPOS)[number];

export const AMBITOS = ["global", "proyecto", "repo"] as const;
export type Ambito = (typeof AMBITOS)[number];

export const VIDAS = ["activa", "reemplazada"] as const;
export type Vida = (typeof VIDAS)[number];

export const VALIDACIONES = ["pendiente", "validada", "rechazada"] as const;
export type Validacion = (typeof VALIDACIONES)[number];

/** Vía por la que la persona validó una entrada (AC-07). */
export const VIAS = ["web", "mcp", "conversacion"] as const;
export type Via = (typeof VIAS)[number];

/** Quién origina el cambio: el agente (por MCP) o la persona (web o CLI). */
export type Actor = "agente" | "persona";

/** Contexto de trabajo ya resuelto: ids de repo y de proyecto, o null. */
export interface Contexto {
  repo: string | null;
  proyecto: string | null;
}

export interface Entrada {
  id: number;
  tipo: Tipo;
  titulo: string;
  contenido: string;
  ambito: Ambito;
  ambitoRef: string | null;
  vida: Vida;
  /** Fecha `YYYY-MM-DD` desde la que la entrada está vencida; null = sin vencimiento. */
  vigenciaHasta: string | null;
  reemplazadaPor: number | null;
  /** Reemplazo propuesto: la entrada que esta reemplazará cuando quede validada. */
  reemplazaA: number | null;
  /** null en las entradas de proyecto (AC-24). */
  validacion: Validacion | null;
  validacionVia: Via | null;
  motivoRechazo: string | null;
  /** Vencimiento hecho por el agente que la persona puede revertir (AC-23). */
  caducidad: Caducidad | null;
  creadaEn: string;
  actualizadaEn: string;
  validadaEn: string | null;
  usadaEn: string | null;
  usos: number;
}

export interface Caducidad {
  actor: Actor;
  fecha: string;
  vigenciaAnterior: string | null;
  trabajoCerrado: boolean;
}

/** Campos de una entrada que se versionan en cada revisión. */
export type Instantanea = Omit<Entrada, "id" | "usadaEn" | "usos">;

export interface Revision {
  entradaId: number;
  numero: number;
  accion: string;
  actor: Actor;
  instantanea: Instantanea;
  creadaEn: string;
}

export interface Relacion {
  id: number;
  titulo: string;
  tipo: Tipo;
  vida: Vida;
  vigenciaHasta: string | null;
  validacion: Validacion | null;
  sentido: "saliente" | "entrante";
}

/** Error de una regla del dominio: se devuelve como error explícito, nunca como vacío. */
export class ReglaError extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "ReglaError";
  }
}

export function esConocimiento(tipo: Tipo): boolean {
  return tipo !== "proyecto";
}
