/**
 * Código de enlace: 128 bits al azar, en base32 de Crockford y en grupos de cuatro, copiables a mano
 * (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`). De él salen, con HKDF y etiquetas distintas:
 * - el buzón de emparejamiento en el relé (el relé lo ve, pero no puede volver al secreto);
 * - el secreto que se mezcla en el handshake;
 * - la huella que guarda la dueña (nunca guarda el código ni el secreto).
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BYTES = 16;

export interface CodigoDerivado {
  /** El código tal cual se muestra. */
  texto: string;
  buzon: string;
  secreto: Buffer;
  huella: string;
}

export function generarCodigo(): CodigoDerivado {
  return derivar(randomBytes(BYTES));
}

/** Lee un código escrito a mano: ignora guiones, espacios y mayúsculas; acepta O→0 e I/L→1. */
export function leerCodigo(texto: string): CodigoDerivado {
  const limpio = texto.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (limpio.length !== Math.ceil((BYTES * 8) / 5) || [...limpio].some((c) => !ALFABETO.includes(c))) {
    throw new Error("código de enlace mal escrito: son 26 caracteres en grupos de cuatro");
  }
  let acumulado = 0n;
  for (const c of limpio) acumulado = (acumulado << 5n) | BigInt(ALFABETO.indexOf(c));
  acumulado >>= BigInt(limpio.length * 5 - BYTES * 8);
  const bytes = Buffer.alloc(BYTES);
  for (let i = BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(acumulado & 0xffn);
    acumulado >>= 8n;
  }
  return derivar(bytes);
}

function derivar(bytes: Buffer): CodigoDerivado {
  const clave = (etiqueta: string, largo: number) => Buffer.from(hkdfSync("sha256", bytes, Buffer.alloc(0), `agent-memory/codigo ${etiqueta}`, largo));
  return {
    texto: agrupar(base32(bytes)),
    buzon: clave("buzon", 16).toString("base64url"),
    secreto: clave("secreto", 32),
    huella: createHash("sha256").update(clave("huella", 32)).digest("hex"),
  };
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

function agrupar(texto: string): string {
  return texto.match(/.{1,4}/g)?.join("-") ?? texto;
}
