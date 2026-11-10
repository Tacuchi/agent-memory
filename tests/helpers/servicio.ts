import { existsSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { cargarConfig, type Config } from "../../src/config.js";
import { arrancarServicio, type App } from "../../src/service/app.js";
import { leerToken } from "../../src/service/token.js";
import { EmbedderFalso } from "./embedders.js";
import { dirTemporal } from "./temp.js";

export const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = `${RAIZ}dist/cli.js`;

/** Las pruebas que lanzan el bin necesitan `dist/`: lo compila una vez `tests/setup/build.ts`. */
export function asegurarBuild(): void {
  if (!existsSync(CLI)) throw new Error(`falta ${CLI}: el globalSetup de vitest no compiló dist/`);
}

export interface ServicioDePrueba {
  app: App;
  config: Config;
  token: string;
  home: string;
  /** POST a la API con el token. */
  api(op: string, cuerpo?: object, cabeceras?: Record<string, string>): Promise<{ status: number; datos: any }>;
  cerrar(): Promise<void>;
}

/** Servicio en proceso sobre un directorio de datos temporal y un puerto libre. */
export async function servicioDePrueba(port = 0): Promise<ServicioDePrueba> {
  const { dir, limpiar } = dirTemporal("agent-memory-home-");
  const config = { ...cargarConfig({ AGENT_MEMORY_HOME: dir }), port };
  const app = await arrancarServicio(config, { embedder: new EmbedderFalso() });
  const token = leerToken(config.tokenPath);
  return {
    app,
    config: { ...config, port: app.port },
    token,
    home: dir,
    async api(op, cuerpo = {}, cabeceras = { authorization: `Bearer ${token}` }) {
      const res = await fetch(`${app.url}/api/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...cabeceras },
        body: JSON.stringify(cuerpo),
      });
      return { status: res.status, datos: await res.json() };
    },
    async cerrar() {
      await app.cerrar();
      limpiar();
    },
  };
}

/** Petición HTTP cruda (permite fijar un `Host` arbitrario, que fetch no deja). */
export function crudo(
  port: number,
  opciones: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opciones.method ?? "GET", path: opciones.path, headers: opciones.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opciones.body);
  });
}

export function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}
