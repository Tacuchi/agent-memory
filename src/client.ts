import type { Config } from "./config.js";
import { HOST } from "./service/server.js";
import { leerToken } from "./service/token.js";

/** Error del servicio con su código, o del transporte cuando el servicio no responde. */
export class ErrorServicio extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "ErrorServicio";
  }
}

/** Cliente de la API local: lo usan el MCP y la CLI. Lee el token del archivo 0600 en cada uso. */
export class ClienteServicio {
  constructor(private readonly config: Pick<Config, "port" | "tokenPath">) {}

  get url(): string {
    return `http://${HOST}:${this.config.port}`;
  }

  async llamar<T = unknown>(operacion: string, cuerpo: object = {}): Promise<T> {
    let token: string;
    try {
      token = leerToken(this.config.tokenPath);
    } catch {
      throw new ErrorServicio("sin_token", `no hay token en ${this.config.tokenPath}: el servicio nunca arrancó; arrancalo con «agent-memory serve»`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/${operacion}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ErrorServicio(
        "servicio_caido",
        `el servicio de agent-memory no responde en ${this.url} (${(error as Error).message}); arrancalo con «agent-memory serve»`,
      );
    }
    const datos = (await res.json().catch(() => null)) as { error?: { codigo: string; mensaje: string } } | null;
    if (!res.ok || !datos) {
      throw new ErrorServicio(datos?.error?.codigo ?? `http_${res.status}`, datos?.error?.mensaje ?? `respuesta ${res.status} sin cuerpo`);
    }
    return datos as T;
  }
}
