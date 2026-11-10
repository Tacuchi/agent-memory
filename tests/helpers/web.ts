import { crudo, type ServicioDePrueba } from "./servicio.js";

/** Canjea un enlace de un solo uso (pedido con el token) y devuelve la cookie de sesión del navegador. */
export async function sesionWeb(s: ServicioDePrueba): Promise<{ cookie: string; enlace: string }> {
  const { datos } = await s.api("enlace-web");
  const enlace = new URL(datos.url as string);
  const r = await crudo(s.app.port, { path: enlace.pathname, headers: { host: `127.0.0.1:${s.app.port}` } });
  if (r.status !== 303) throw new Error(`el enlace no se canjeó: ${r.status} ${r.body}`);
  const cookie = String(r.headers["set-cookie"]).split(";")[0] as string;
  return { cookie, enlace: enlace.pathname };
}

/** POST a la API como la persona desde la web: cookie de sesión, JSON y origen propio. */
export async function comoPersona(s: ServicioDePrueba, cookie: string, op: string, cuerpo: object = {}) {
  return s.api(op, cuerpo, { cookie, origin: s.app.url });
}
