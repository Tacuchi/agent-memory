import type { Entrada, Relacion, Revision } from "../domain/types.js";
import { marcar, type Resultado } from "../search/search.js";

/**
 * Vista pública de una entrada. Siempre trae los campos de AC-03: id, título, tipo, ámbito,
 * estado de vida, vigencia, estado de validación y fecha de la última actualización.
 */
export function vistaEntrada(e: Entrada, conContenido = true) {
  return {
    id: e.id,
    titulo: e.titulo,
    tipo: e.tipo,
    ambito: e.ambito,
    ambito_ref: e.ambitoRef,
    vida: e.vida,
    vigencia_hasta: e.vigenciaHasta,
    validacion: e.validacion,
    actualizada_en: e.actualizadaEn,
    marca: marcar(e),
    validacion_via: e.validacionVia,
    motivo_rechazo: e.motivoRechazo,
    reemplaza_a: e.reemplazaA,
    reemplazada_por: e.reemplazadaPor,
    caducidad: e.caducidad,
    ...(conContenido ? { contenido: e.contenido } : {}),
  };
}

export function vistaResultado(r: Resultado) {
  return { ...vistaEntrada(r.entrada), puntaje: Number(r.puntaje.toFixed(6)) };
}

export function vistaRelacion(r: Relacion) {
  return {
    id: r.id,
    titulo: r.titulo,
    tipo: r.tipo,
    sentido: r.sentido,
    vida: r.vida,
    vigencia_hasta: r.vigenciaHasta,
    validacion: r.validacion,
  };
}

export function vistaRevision(r: Revision) {
  return {
    numero: r.numero,
    accion: r.accion,
    actor: r.actor,
    creada_en: r.creadaEn,
    titulo: r.instantanea.titulo,
    contenido: r.instantanea.contenido,
    vida: r.instantanea.vida,
    vigencia_hasta: r.instantanea.vigenciaHasta,
    validacion: r.instantanea.validacion,
  };
}
