import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Crea el token al primer arranque (archivo 0600) y lo devuelve; si existe, corrige sus permisos. */
export function asegurarToken(ruta: string): string {
  mkdirSync(dirname(ruta), { recursive: true, mode: 0o700 });
  if (!existsSync(ruta)) {
    writeFileSync(ruta, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  }
  if ((statSync(ruta).mode & 0o077) !== 0) chmodSync(ruta, 0o600);
  return leerToken(ruta);
}

export function leerToken(ruta: string): string {
  const token = readFileSync(ruta, "utf8").trim();
  if (token.length < 32) throw new Error(`token inválido en ${ruta}`);
  return token;
}

export function mismoSecreto(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
