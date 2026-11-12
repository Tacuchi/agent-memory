import type { Caducidad, Entrada, Instantanea } from "../domain/types.js";

export interface FilaEntrada {
  id: number;
  tipo: string;
  titulo: string;
  contenido: string;
  ambito: string;
  ambito_ref: string | null;
  vida: string;
  vigencia_hasta: string | null;
  reemplazada_por: number | null;
  reemplaza_a: number | null;
  validacion: string | null;
  validacion_via: string | null;
  motivo_rechazo: string | null;
  caducidad: string | null;
  creada_en: string;
  actualizada_en: string;
  validada_en: string | null;
  usada_en: string | null;
  usos: number;
  verificada_en: string | null;
  mostrada_en: string | null;
  mostrada_veces: number;
  leida_en: string | null;
  leida_veces: number;
}

export function desdeFila(f: FilaEntrada): Entrada {
  return {
    id: f.id,
    tipo: f.tipo as Entrada["tipo"],
    titulo: f.titulo,
    contenido: f.contenido,
    ambito: f.ambito as Entrada["ambito"],
    ambitoRef: f.ambito_ref,
    vida: f.vida as Entrada["vida"],
    vigenciaHasta: f.vigencia_hasta,
    reemplazadaPor: f.reemplazada_por,
    reemplazaA: f.reemplaza_a,
    validacion: f.validacion as Entrada["validacion"],
    validacionVia: f.validacion_via as Entrada["validacionVia"],
    motivoRechazo: f.motivo_rechazo,
    caducidad: f.caducidad ? (JSON.parse(f.caducidad) as Caducidad) : null,
    creadaEn: f.creada_en,
    actualizadaEn: f.actualizada_en,
    validadaEn: f.validada_en,
    usadaEn: f.usada_en,
    usos: f.usos,
    verificadaEn: f.verificada_en ?? null,
    mostradaEn: f.mostrada_en,
    mostradaVeces: f.mostrada_veces,
    leidaEn: f.leida_en,
    leidaVeces: f.leida_veces,
  };
}

/** Parámetros con nombre para INSERT/UPDATE de todas las columnas versionadas. */
export function aParametros(e: Instantanea): Record<string, string | number | null> {
  return {
    tipo: e.tipo,
    titulo: e.titulo,
    contenido: e.contenido,
    ambito: e.ambito,
    ambito_ref: e.ambitoRef,
    vida: e.vida,
    vigencia_hasta: e.vigenciaHasta,
    reemplazada_por: e.reemplazadaPor,
    reemplaza_a: e.reemplazaA,
    validacion: e.validacion,
    validacion_via: e.validacionVia,
    motivo_rechazo: e.motivoRechazo,
    caducidad: e.caducidad ? JSON.stringify(e.caducidad) : null,
    creada_en: e.creadaEn,
    actualizada_en: e.actualizadaEn,
    validada_en: e.validadaEn,
  };
}

export function instantanea(e: Entrada): Instantanea {
  const { id: _id, usadaEn: _u, usos: _n, verificadaEn: _v, mostradaEn: _me, mostradaVeces: _mv, leidaEn: _le, leidaVeces: _lv, ...resto } = e;
  return resto;
}

export const COLUMNAS_VERSIONADAS = Object.keys(
  aParametros({
    tipo: "leccion",
    titulo: "",
    contenido: "",
    ambito: "global",
    ambitoRef: null,
    vida: "activa",
    vigenciaHasta: null,
    reemplazadaPor: null,
    reemplazaA: null,
    validacion: null,
    validacionVia: null,
    motivoRechazo: null,
    caducidad: null,
    creadaEn: "",
    actualizadaEn: "",
    validadaEn: null,
  }),
);
