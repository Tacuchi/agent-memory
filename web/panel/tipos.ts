// Contrato de GET /dashboard/api/estado y POST /dashboard/api/accion (plan 007, TO-BE). El relé
// solo conoce metadatos: nunca contenido de la memoria ni el valor de un código de enlace (D04).

/** Ámbitos como texto: "global", "proyecto:<ref>" o "repo:<ref>". */
export interface Alcance {
  ambitos: string[];
  pendientes: boolean;
}

/** Otra PC que lee la memoria de esta. */
export interface Lector {
  huella: string;
  nombre: string;
  alcance: Alcance;
  vence: string | null;
  usado: string | null;
  revocado: boolean | string | null;
}

/** Una memoria ajena que esta PC lee. */
export interface Lectura {
  origen: string;
  duena: string;
  vence: string | null;
  usado: string | null;
}

export interface Conexion {
  buzon: string;
  estado: string;
  bytes: number;
  inactivo_s: number;
}

export interface UsoDia {
  dia: string;
  recibidas: number;
  hechas: number;
  bytes: number;
  rechazos: number;
}

export interface Pendiente {
  id: string | number;
  accion: string;
  objetivo: string | null;
  creado: string;
}

export interface Pc {
  huella: string;
  nombre: string | null;
  version: string | null;
  en_linea: boolean;
  visto: string | null;
  ip: string | null;
  informe: boolean;
  acceso: boolean | null;
  leen: Lector[];
  lee: Lectura[];
  codigo: { vence: string } | null;
  conexiones: Conexion[];
  uso: UsoDia[];
  pendientes: Pendiente[];
}

export interface Desconocida {
  ip: string;
  rechazos: number;
  primera: string;
  ultima: string;
}

export interface Bloqueo {
  tipo: "pc" | "ip";
  valor: string;
  hasta: string | null;
}

export interface Estado {
  rele: { version: string; encendido_desde: string; conexiones: number; tope: number };
  pcs: Pc[];
  desconocidas: Desconocida[];
  bloqueos: Bloqueo[];
}

/** Respuesta de POST /dashboard/api/accion: «pendiente» queda a confirmar en la PC dueña (D01). */
export type Resultado = { ok: true; estado: "hecho" | "pendiente"; mensaje?: string } | { ok: false; error: string };

export type Duracion = "1h" | "24h" | "indefinido";

export type Accion =
  | { accion: "cerrar_pc"; pc: string }
  | { accion: "cerrar_todo" }
  | { accion: "bloquear"; pc: string; duracion: Duracion }
  | { accion: "bloquear"; ip: string; duracion: Duracion }
  | { accion: "desbloquear"; pc: string }
  | { accion: "desbloquear"; ip: string }
  | { accion: "revocar"; pc: string; objetivo: string }
  | { accion: "quitar_enlace"; pc: string; objetivo: string }
  | { accion: "renovar"; pc: string; objetivo: string }
  | { accion: "alcance"; pc: string; objetivo: string; alcance: Alcance }
  | { accion: "codigo"; pc: string };
