import {
  AMBITOS,
  ReglaError,
  TIPOS,
  esConocimiento,
  type Actor,
  type Ambito,
  type Entrada,
  type Tipo,
  type Validacion,
  type Via,
} from "./types.js";

// Reglas de estado de la memoria, sin E/S: reciben la entrada y el instante, y devuelven la
// entrada nueva o un ReglaError. El almacén las aplica dentro de su transacción.

export function validarTipo(valor: string): Tipo {
  if ((TIPOS as readonly string[]).includes(valor)) return valor as Tipo;
  throw new ReglaError("tipo_invalido", `tipo «${valor}» no admitido; los tipos son: ${TIPOS.join(", ")}`);
}

export function validarAmbito(valor: string): Ambito {
  if ((AMBITOS as readonly string[]).includes(valor)) return valor as Ambito;
  throw new ReglaError("ambito_invalido", `ámbito «${valor}» no admitido; los ámbitos son: ${AMBITOS.join(", ")}`);
}

export function validarTexto(campo: string, valor: string): string {
  const limpio = valor.trim();
  if (!limpio) throw new ReglaError("campo_vacio", `el campo ${campo} no puede estar vacío`);
  return limpio;
}

export interface OrigenCambio {
  actor: Actor;
  /** La persona confirmó en la conversación el borrador exacto (huella verificada, AC-16). */
  confirmado?: boolean;
}

export interface EstadoValidacion {
  validacion: Validacion | null;
  validacionVia: Via | null;
}

/**
 * Validación con la que nace una entrada (AC-07, AC-16, AC-24): proyecto sin validación; el
 * borrador confirmado nace validado por conversación; lo que crea la persona nace validado por la
 * web; lo que crea el agente por su cuenta nace pendiente.
 */
export function validacionInicial(tipo: Tipo, origen: OrigenCambio): EstadoValidacion {
  if (!esConocimiento(tipo)) return { validacion: null, validacionVia: null };
  if (origen.confirmado) return { validacion: "validada", validacionVia: "conversacion" };
  if (origen.actor === "persona") return { validacion: "validada", validacionVia: "web" };
  return { validacion: "pendiente", validacionVia: null };
}

export function hoy(ahora: Date): string {
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, "0");
  const d = String(ahora.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Vencida desde el día de su vigencia: caducar «hoy» la saca ese mismo día (AC-24). */
export function estaVencida(entrada: Pick<Entrada, "vigenciaHasta">, ahora: Date): boolean {
  return entrada.vigenciaHasta !== null && entrada.vigenciaHasta <= hoy(ahora);
}

export interface CambiosContenido {
  titulo?: string;
  contenido?: string;
}

/**
 * Edición en sitio (AC-23, AC-24, S-10): el proyecto no toca la validación; la persona conserva
 * el estado; el agente devuelve a pendiente lo validado o rechazado salvo borrador confirmado.
 */
export function aplicarEdicion(entrada: Entrada, cambios: CambiosContenido, origen: OrigenCambio, ahora: Date): Entrada {
  const titulo = cambios.titulo === undefined ? entrada.titulo : validarTexto("titulo", cambios.titulo);
  const contenido = cambios.contenido === undefined ? entrada.contenido : validarTexto("contenido", cambios.contenido);
  if (titulo === entrada.titulo && contenido === entrada.contenido) {
    throw new ReglaError("sin_cambios", "la edición no cambia el título ni el contenido");
  }
  return {
    ...entrada,
    titulo,
    contenido,
    ...validacionTrasCambio(entrada, origen, ahora),
    actualizadaEn: ahora.toISOString(),
  };
}

function validacionTrasCambio(entrada: Entrada, origen: OrigenCambio, ahora: Date): Partial<Entrada> {
  if (!esConocimiento(entrada.tipo) || origen.actor === "persona") return {};
  if (origen.confirmado) {
    return {
      validacion: "validada",
      validacionVia: "conversacion",
      motivoRechazo: null,
      validadaEn: ahora.toISOString(),
    };
  }
  return { validacion: "pendiente", validacionVia: null, motivoRechazo: null, validadaEn: null };
}

/** Aprobar es un acto explícito de la persona por una vía registrada (AC-07). */
export function aprobar(entrada: Entrada, via: Via, ahora: Date): Entrada {
  exigirConocimiento(entrada, "aprobar");
  exigirActiva(entrada, "aprobar");
  if (entrada.validacion === "validada") {
    throw new ReglaError("ya_validada", `la entrada ${entrada.id} ya está validada`);
  }
  return {
    ...entrada,
    validacion: "validada",
    validacionVia: via,
    motivoRechazo: null,
    validadaEn: ahora.toISOString(),
    actualizadaEn: ahora.toISOString(),
  };
}

/** Un rechazo sin motivo no se registra y la entrada sigue como estaba (AC-06). */
export function rechazar(entrada: Entrada, motivo: string | undefined, ahora: Date): Entrada {
  exigirConocimiento(entrada, "rechazar");
  const limpio = (motivo ?? "").trim();
  if (!limpio) throw new ReglaError("motivo_requerido", "un rechazo exige un motivo");
  if (entrada.validacion !== "pendiente") {
    throw new ReglaError("no_pendiente", `solo se rechaza una entrada pendiente; la ${entrada.id} está ${entrada.validacion}`);
  }
  return {
    ...entrada,
    validacion: "rechazada",
    validacionVia: null,
    motivoRechazo: limpio,
    actualizadaEn: ahora.toISOString(),
  };
}

export interface OpcionesCaducar {
  actor: Actor;
  /** Fecha elegida `YYYY-MM-DD`; por defecto, hoy. */
  fecha?: string;
  /** Declarar cerrado el trabajo de una entrada de proyecto: vence hoy (AC-24). */
  cerrarTrabajo?: boolean;
}

/** Caducar surte efecto de inmediato y queda registrado para poder revertirlo (AC-23). */
export function caducar(entrada: Entrada, opciones: OpcionesCaducar, ahora: Date): Entrada {
  exigirActiva(entrada, "caducar");
  if (opciones.cerrarTrabajo && entrada.tipo !== "proyecto") {
    throw new ReglaError("no_es_proyecto", "solo se declara cerrado el trabajo de una entrada de proyecto");
  }
  const fecha = opciones.cerrarTrabajo ? hoy(ahora) : validarFecha(opciones.fecha ?? hoy(ahora));
  return {
    ...entrada,
    vigenciaHasta: fecha,
    caducidad: {
      actor: opciones.actor,
      fecha,
      vigenciaAnterior: entrada.vigenciaHasta,
      trabajoCerrado: Boolean(opciones.cerrarTrabajo),
    },
    actualizadaEn: ahora.toISOString(),
  };
}

/** Revierte la última caducidad registrada, devolviendo la vigencia que tenía (AC-23). */
export function revertirCaducidad(entrada: Entrada, ahora: Date): Entrada {
  if (!entrada.caducidad) {
    throw new ReglaError("sin_caducidad", `la entrada ${entrada.id} no tiene una caducidad que revertir`);
  }
  return {
    ...entrada,
    vigenciaHasta: entrada.caducidad.vigenciaAnterior,
    caducidad: null,
    actualizadaEn: ahora.toISOString(),
  };
}

/** Cambiar de ámbito: el ámbito global no lleva referencia; los otros sí. */
export function cambiarAmbito(entrada: Entrada, ambito: string, ambitoRef: string | null, ahora: Date): Entrada {
  const valido = validarAmbito(ambito);
  const ref = valido === "global" ? null : (ambitoRef ?? "").trim();
  if (valido !== "global" && !ref) {
    throw new ReglaError("ambito_sin_ref", `el ámbito ${valido} necesita la referencia del ${valido}`);
  }
  if (valido === entrada.ambito && ref === entrada.ambitoRef) {
    throw new ReglaError("sin_cambios", "la entrada ya está en ese ámbito");
  }
  return { ...entrada, ambito: valido, ambitoRef: ref, actualizadaEn: ahora.toISOString() };
}

/** Un reemplazo surte efecto cuando la entrada nueva cuenta: validada, o de proyecto (AC-08, AC-23). */
export function reemplazoSurteEfecto(nueva: Entrada): boolean {
  if (nueva.reemplazaA === null || nueva.vida !== "activa") return false;
  return nueva.validacion === "validada" || !esConocimiento(nueva.tipo);
}

export function marcarReemplazada(original: Entrada, nuevaId: number, ahora: Date): Entrada {
  return { ...original, vida: "reemplazada", reemplazadaPor: nuevaId, actualizadaEn: ahora.toISOString() };
}

function validarFecha(fecha: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(fecha))) {
    throw new ReglaError("fecha_invalida", `fecha «${fecha}» inválida; se espera YYYY-MM-DD`);
  }
  return fecha;
}

function exigirConocimiento(entrada: Entrada, accion: string): void {
  if (!esConocimiento(entrada.tipo)) {
    throw new ReglaError("proyecto_sin_validacion", `no se puede ${accion} una entrada de proyecto: no pasa por la validación`);
  }
}

function exigirActiva(entrada: Entrada, accion: string): void {
  if (entrada.vida !== "activa") {
    throw new ReglaError("no_activa", `no se puede ${accion} la entrada ${entrada.id}: está ${entrada.vida}`);
  }
}
