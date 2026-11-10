import { ClienteServicio } from "../client.js";
import { cargarConfig } from "../config.js";
import { resolverContexto } from "../context.js";
import type { Indice } from "../indice/indice.js";
import { arrancarSeparado } from "../service/daemon.js";

// Hook `SessionStart` de Claude Code: imprime el índice del contexto de la
// sesión, o una línea de aviso. Nunca bloquea ni falla: termina con éxito pase lo que pase.

export interface EntradaHook {
  cwd?: string;
}

export async function hookSessionStart(entrada: EntradaHook, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let esperaMs = 2000;
  try {
    const config = cargarConfig(env);
    esperaMs = config.esperaHookMs;
    const contexto = resolverContexto(entrada.cwd ?? process.cwd(), { proyectos: config.proyectos });
    const trabajo = (async () => {
      const arranque = await arrancarSeparado(config, esperaMs);
      if (!arranque.salud) return avisoSinServicio(esperaMs);
      const indice = await new ClienteServicio(config).llamar<Indice>("indice", { contexto, tope: config.topeIndice });
      return indice.texto;
    })();
    // Tope duro: aunque algo se cuelgue, la sesión arranca.
    return await Promise.race([trabajo, demora(esperaMs + 2000).then(() => avisoSinServicio(esperaMs))]);
  } catch (error) {
    return `agent-memory: sin índice en esta sesión (${(error as Error).message}); revisá con «agent-memory doctor».`;
  }
}

function avisoSinServicio(esperaMs: number): string {
  const segundos = (esperaMs / 1000).toLocaleString("es");
  return `agent-memory: el servicio no respondió en ${segundos} s; esta sesión arranca sin índice. Las herramientas memory_* responden cuando el servicio esté arriba («agent-memory start»).`;
}

function demora(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/** Lee el JSON que Claude Code manda por stdin; sin entrada o ilegible, sigue con el cwd. */
export async function leerEntradaHook(stdin: NodeJS.ReadStream = process.stdin, esperaMs = 500): Promise<EntradaHook> {
  if (stdin.isTTY) return {};
  const texto = await new Promise<string>((resolve) => {
    let datos = "";
    const fin = () => resolve(datos);
    const t = setTimeout(fin, esperaMs);
    t.unref();
    stdin.setEncoding("utf8");
    stdin.on("data", (c: string) => (datos += c));
    stdin.on("end", () => {
      clearTimeout(t);
      fin();
    });
    stdin.on("error", fin);
  });
  try {
    const datos = JSON.parse(texto) as { cwd?: unknown };
    return typeof datos.cwd === "string" ? { cwd: datos.cwd } : {};
  } catch {
    return {};
  }
}
