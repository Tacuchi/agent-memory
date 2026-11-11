import type { Accion, Estado, Resultado } from "./tipos";

/** Lo que la página necesita del relé; las pruebas lo reemplazan o le pasan un fetch falso. */
export interface ApiPanel {
  estado(): Promise<Estado>;
  accion(cuerpo: Accion): Promise<Resultado & { ok: true }>;
}

export class ErrorPanel extends Error {}

type Fetch = (entrada: string, init?: RequestInit) => Promise<Response>;

/** Cliente HTTP del panel: misma origen, la sesión la pone Cloudflare Access (cookie). */
export function apiHttp(base = "/dashboard/api", f: Fetch = (entrada, init) => fetch(entrada, init)): ApiPanel {
  async function pedir(ruta: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${base}/${ruta}`, { credentials: "same-origin", cache: "no-store", ...init });
    } catch {
      throw new ErrorPanel("No se pudo contactar al relé.");
    }
    const cuerpo: unknown = await res.json().catch(() => null);
    const fallo = cuerpo && typeof cuerpo === "object" && (cuerpo as { ok?: unknown }).ok === false;
    if (res.ok && !fallo) return cuerpo;
    const error = textoDe(cuerpo, "error");
    if (error) throw new ErrorPanel(error);
    // 401 sin cuerpo: Cloudflare Access ya no reconoce la sesión.
    if (res.status === 401) throw new ErrorPanel("La sesión de Access venció: hay que recargar la página.");
    throw new ErrorPanel(`El relé respondió ${res.status}.`);
  }
  return {
    estado: () => pedir("estado") as Promise<Estado>,
    accion: (cuerpo) =>
      pedir("accion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) }) as Promise<
        Resultado & { ok: true }
      >,
  };
}

/** Un campo de texto no vacío de la respuesta del relé, si lo trae. */
export function textoDe(cuerpo: unknown, clave: "mensaje" | "error"): string | null {
  if (!cuerpo || typeof cuerpo !== "object") return null;
  const v = (cuerpo as Record<string, unknown>)[clave];
  return typeof v === "string" && v ? v : null;
}

export function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
