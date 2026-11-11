import { cargarConfig, type Config } from "../../src/config.js";
import { crearRele, type Rele } from "../../src/remoto/rele.js";
import { arrancarServicio, type App } from "../../src/service/app.js";
import { leerToken } from "../../src/service/token.js";
import { EmbedderFalso } from "../helpers/embedders.js";
import { crudo } from "../helpers/servicio.js";
import { dirTemporal } from "../helpers/temp.js";

export const CLAVE_RELE = "clave-de-prueba-del-rele-0123456789";

/** Una instalación completa en proceso: servicio en un puerto libre, home temporal y reloj controlable. */
export interface Instalacion {
  app: App;
  config: Config;
  home: string;
  /** Como un agente: con el token. */
  agente(op: string, cuerpo?: object): Promise<{ status: number; datos: any }>;
  /** Como la persona: con la cookie de la web. */
  persona(op: string, cuerpo?: object): Promise<{ status: number; datos: any }>;
  avanzar(ms: number): void;
  cerrar(): Promise<void>;
}

export async function instalacion(opciones: { esperaMs?: number } = {}): Promise<Instalacion> {
  const { dir, limpiar } = dirTemporal("agent-memory-remoto-");
  let desfase = 0;
  const base = cargarConfig({ AGENT_MEMORY_HOME: dir });
  const config: Config = { ...base, port: 0, remoto: { esperaMs: opciones.esperaMs ?? 2000 } };
  const app = await arrancarServicio(config, { embedder: new EmbedderFalso(), dirWeb: null, reloj: () => new Date(Date.now() + desfase) });
  const token = leerToken(config.tokenPath);
  const llamar = async (op: string, cuerpo: object, cabeceras: Record<string, string>) => {
    const res = await fetch(`${app.url}/api/${op}`, { method: "POST", headers: { "content-type": "application/json", ...cabeceras }, body: JSON.stringify(cuerpo) });
    return { status: res.status, datos: await res.json() };
  };
  let cookie: string | null = null;
  const sesion = async () => {
    if (cookie) return cookie;
    const { datos } = await llamar("enlace-web", {}, { authorization: `Bearer ${token}` });
    const enlace = new URL(datos.url as string);
    const r = await crudo(app.port, { path: enlace.pathname, headers: { host: enlace.host } });
    cookie = String(r.headers["set-cookie"]).split(";")[0] as string;
    return cookie;
  };
  return {
    app,
    config: { ...config, port: app.port },
    home: dir,
    agente: (op, cuerpo = {}) => llamar(op, cuerpo, { authorization: `Bearer ${token}` }),
    persona: async (op, cuerpo = {}) => llamar(op, cuerpo, { cookie: await sesion() }),
    avanzar(ms) {
      desfase += ms;
    },
    async cerrar() {
      await app.cerrar();
      limpiar();
    },
  };
}

export async function releLocal(): Promise<Rele> {
  return crearRele({ clave: CLAVE_RELE });
}

/** Configura el relé, enciende la dueña y enlaza la lectora con un código nuevo. Devuelve el id del dispositivo. */
export async function enlazar(duena: Instalacion, lectora: Instalacion, rele: Rele, origen = "trabajo"): Promise<number> {
  for (const i of [duena, lectora]) {
    const r = await i.agente("enlace_rele", { url: rele.url, clave: CLAVE_RELE });
    if (r.status !== 200) throw new Error(`enlace_rele: ${JSON.stringify(r.datos)}`);
  }
  await duena.persona("remoto_interruptor", { encendido: true });
  // La lectora se presenta con el nombre configurado de su PC, que también viaja en cada pedido (plan 008).
  await lectora.persona("remoto_nombre", { nombre: "casa" });
  const { datos: codigo } = await duena.persona("remoto_codigo");
  const r = await lectora.agente("enlace_canjear", { codigo: codigo.codigo, origen });
  if (r.status !== 200) throw new Error(`enlace_canjear: ${JSON.stringify(r.datos)}`);
  const { datos } = await duena.persona("remoto_estado");
  return (datos.dispositivos as { id: number; nombre: string }[]).at(-1)?.id as number;
}

export async function esperar(condicion: () => boolean | Promise<boolean>, tope = 8000): Promise<void> {
  const inicio = Date.now();
  while (!(await condicion())) {
    if (Date.now() - inicio > tope) throw new Error("tiempo agotado esperando la condición");
    await new Promise((ok) => setTimeout(ok, 25));
  }
}
