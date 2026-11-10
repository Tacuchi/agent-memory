// La web usa solo la API del servicio (plan 003): ninguna otra copia de los datos. La cookie de
// sesión HttpOnly la manda el navegador; la web nunca ve el token.

export type Cliente = <T = unknown>(operacion: string, cuerpo?: object) => Promise<T>;

export class ErrorApi extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "ErrorApi";
  }
}

export const clienteHttp: Cliente = async <T,>(operacion: string, cuerpo: object = {}): Promise<T> => {
  const res = await fetch(`/api/${operacion}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const datos = (await res.json().catch(() => null)) as ({ error?: { codigo: string; mensaje: string } } & T) | null;
  if (!res.ok || !datos) {
    if (res.status === 401) throw new ErrorApi("sin_sesion", "la sesión no es válida: volvé a abrir la web con «agent-memory open»");
    throw new ErrorApi(datos?.error?.codigo ?? `http_${res.status}`, datos?.error?.mensaje ?? `respuesta ${res.status}`);
  }
  return datos;
};

export const TIPOS = ["leccion", "decision", "convencion", "referencia", "preferencia", "proyecto"] as const;
export const AMBITOS = ["global", "proyecto", "repo"] as const;
export const VALIDACIONES = ["pendiente", "validada", "rechazada"] as const;

export interface Caducidad {
  actor: "agente" | "persona";
  fecha: string;
  vigenciaAnterior: string | null;
  trabajoCerrado: boolean;
}

export interface Entrada {
  id: number;
  titulo: string;
  tipo: string;
  ambito: string;
  ambito_ref: string | null;
  vida: "activa" | "reemplazada";
  vigencia_hasta: string | null;
  validacion: "pendiente" | "validada" | "rechazada" | null;
  actualizada_en: string;
  marca: string;
  validacion_via: string | null;
  motivo_rechazo: string | null;
  reemplaza_a: number | null;
  reemplazada_por: number | null;
  caducidad: Caducidad | null;
  contenido?: string;
  usada_en?: string | null;
  verificada_en?: string | null;
}

export interface Relacion {
  id: number;
  titulo: string;
  tipo: string;
  sentido: "saliente" | "entrante";
  vida: string;
  vigencia_hasta: string | null;
  validacion: string | null;
}

export interface Revision {
  numero: number;
  accion: string;
  actor: string;
  creada_en: string;
  titulo: string;
  contenido: string;
  vida: string;
  vigencia_hasta: string | null;
  validacion: string | null;
}

export type Pendiente = Entrada & { reemplazaria: { id: number; titulo: string } | null };

export function mensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
