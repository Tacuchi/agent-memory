import { cleanup, render } from "@testing-library/react";
import { App } from "../../web/src/App";
import { ErrorApi, type Cliente } from "../../web/src/api";
import { Api, type OpcionesApi, type Operacion } from "../../src/service/api";
import { Buscador } from "../../src/search/search";
import { ReglaError } from "../../src/domain/types";
import { EmbedderFalso } from "../helpers/embedders";
import { storeTemporal } from "../helpers/temp";

/**
 * La web montada en jsdom sobre la API real y un almacén temporal: el cliente pasa cada llamada
 * por JSON, como el HTTP, y llama como la persona (la cookie de sesión). Las pruebas por HTTP de
 * la cookie y el enlace están en acceso.test.ts.
 */
export function montarWeb(opciones: OpcionesApi = {}) {
  const embedder = new EmbedderFalso();
  const t = storeTemporal({ embedder });
  const api = new Api(t.store, new Buscador(t.store, embedder), "0.0.0-prueba", opciones);
  const llamadas: string[] = [];
  const cliente: Cliente = async <T,>(op: string, cuerpo: object = {}): Promise<T> => {
    llamadas.push(op);
    try {
      const r = await api.ejecutar(op as Operacion, JSON.parse(JSON.stringify(cuerpo)), "persona");
      return JSON.parse(JSON.stringify(r)) as T;
    } catch (e) {
      throw new ErrorApi(e instanceof ReglaError ? e.codigo : "peticion_invalida", (e as Error).message);
    }
  };
  /** Lo que hace el agente por MCP: con su actor, no el de la persona. */
  const comoAgente = async <T = any,>(op: Operacion, cuerpo: object): Promise<T> => (await api.ejecutar(op, cuerpo, "agente")) as T;
  const comoPersona = async <T = any,>(op: Operacion, cuerpo: object): Promise<T> => (await api.ejecutar(op, cuerpo, "persona")) as T;
  const vista = () => render(<App cliente={cliente} />);
  return {
    t,
    api,
    cliente,
    llamadas,
    comoAgente,
    comoPersona,
    vista,
    cerrar() {
      cleanup();
      t.cerrar();
    },
  };
}
