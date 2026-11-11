/**
 * Verificación del JWT de Cloudflare Access para el panel del relé (plan 007, AC-01).
 *
 * Cloudflare Access pone en cada petición autorizada la cabecera `Cf-Access-Jwt-Assertion`: un JWT RS256 firmado
 * con las claves del equipo (`https://<equipo>.cloudflareaccess.com/cdn-cgi/access/certs`). El relé lo verifica
 * aunque Cloudflare ya filtre: firma, `aud` de la aplicación, emisor, `exp` y `nbf`. Sin librerías: `node:crypto`.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const CABECERA_ACCESS = "cf-access-jwt-assertion";
const CACHE_CLAVES_MS = 3600_000;
const TOLERANCIA_S = 30;

export interface OpcionesAcceso {
  /** Nombre del equipo de Cloudflare Zero Trust (`<equipo>.cloudflareaccess.com`). */
  equipo: string;
  /** Audience tag de la aplicación de Access. */
  aud: string;
  /** Para pruebas: devuelve el JSON de certificados. Por defecto, `fetch` a la URL del equipo. */
  obtenerCertificados?: () => Promise<unknown>;
  ahora?: () => number;
}

export interface Verificador {
  /** El correo de la sesión si el JWT es válido; null si no. Nunca lanza. */
  verificar(jwt: string | undefined): Promise<string | null>;
}

export function crearVerificador(op: OpcionesAcceso): Verificador {
  const emisor = `https://${op.equipo}.cloudflareaccess.com`;
  const obtener = op.obtenerCertificados ?? (async () => (await fetch(`${emisor}/cdn-cgi/access/certs`)).json());
  const ahora = op.ahora ?? Date.now;
  let claves: Map<string, KeyObject> | null = null;
  let cargadas = 0;

  const cargar = async (forzar: boolean): Promise<Map<string, KeyObject>> => {
    if (claves && !forzar && ahora() - cargadas < CACHE_CLAVES_MS) return claves;
    const datos = (await obtener()) as { keys?: { kid?: string; kty?: string }[] };
    const nuevas = new Map<string, KeyObject>();
    for (const jwk of datos.keys ?? []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      try {
        nuevas.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch {
        // clave ilegible: se ignora
      }
    }
    claves = nuevas;
    cargadas = ahora();
    return nuevas;
  };

  return {
    async verificar(jwt) {
      try {
        if (!jwt) return null;
        const partes = jwt.split(".");
        if (partes.length !== 3) return null;
        const [h, p, firma] = partes as [string, string, string];
        const cabecera = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
        if (cabecera.alg !== "RS256" || typeof cabecera.kid !== "string") return null;
        let clave = (await cargar(false)).get(cabecera.kid);
        // Cloudflare rota las claves: un kid desconocido fuerza una recarga, una sola vez.
        if (!clave) clave = (await cargar(true)).get(cabecera.kid);
        if (!clave) return null;
        if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), clave, Buffer.from(firma, "base64url"))) return null;
        const datos = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
          aud?: string | string[];
          iss?: string;
          exp?: number;
          nbf?: number;
          email?: string;
        };
        const s = ahora() / 1000;
        const auds = Array.isArray(datos.aud) ? datos.aud : [datos.aud];
        if (!auds.includes(op.aud)) return null;
        if (datos.iss !== emisor) return null;
        if (typeof datos.exp !== "number" || datos.exp + TOLERANCIA_S < s) return null;
        if (typeof datos.nbf === "number" && datos.nbf - TOLERANCIA_S > s) return null;
        return typeof datos.email === "string" ? datos.email : "sesión de Access";
      } catch {
        return null;
      }
    },
  };
}
