import { ClienteServicio } from "../client.js";
import { cargarConfig } from "../config.js";
import { resolverContexto } from "../context.js";
import { INDICACION_TRAS_COMPACTAR, type Indice } from "../indice/indice.js";
import { arrancarSeparado } from "../service/daemon.js";

// Hook `SessionStart` de Claude Code: entrega el índice del contexto de la sesión, o una línea de
// aviso, y una línea visible para la persona. Nunca bloquea ni falla: termina con éxito pase lo que pase.

export interface EntradaHook {
  cwd?: string;
  /** Por qué arranca la sesión, según Claude Code: startup, resume, clear o compact. */
  source?: string;
}

/** Lo que el hook entrega: el contexto para el agente y la línea que la persona ve en pantalla. */
export interface SalidaHook {
  contexto: string;
  visible: string;
}

export async function hookSessionStart(entrada: EntradaHook, env: NodeJS.ProcessEnv = process.env): Promise<SalidaHook> {
  let esperaMs = 2000;
  try {
    const config = cargarConfig(env);
    esperaMs = config.esperaHookMs;
    const contexto = resolverContexto(entrada.cwd ?? process.cwd(), { proyectos: config.proyectos });
    const trabajo = (async () => {
      const arranque = await arrancarSeparado(config, esperaMs);
      if (!arranque.salud) return avisoSinServicio(esperaMs);
      const indice = await new ClienteServicio(config).llamar<Indice>("indice", { contexto, tope: config.topeIndice });
      // Solo tras compactar: al iniciar, reanudar, limpiar o bifurcar no hay nada nuevo que proponer guardar.
      const compactada = entrada.source === "compact";
      return {
        contexto: compactada ? `${indice.texto}\n\n${INDICACION_TRAS_COMPACTAR}` : indice.texto,
        visible: lineaVisible(indice, compactada),
      };
    })();
    // Tope duro: aunque algo se cuelgue, la sesión arranca.
    return await Promise.race([trabajo, demora(esperaMs + 2000).then(() => avisoSinServicio(esperaMs))]);
  } catch (error) {
    return aviso(`agent-memory: sin índice en esta sesión (${(error as Error).message}); revisá con «agent-memory doctor».`);
  }
}

/** El JSON que Claude Code espera de un hook SessionStart: `systemMessage` se ve, `additionalContext` lo recibe el agente. */
export function jsonHook(salida: SalidaHook): string {
  return JSON.stringify({
    systemMessage: salida.visible,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: salida.contexto },
  });
}

function lineaVisible(indice: Indice, compactada: boolean): string {
  const fuera = indice.fuera > 0 ? ` (${indice.fuera} fuera, con memory_search)` : "";
  return `agent-memory · índice cargado: ${indice.incluidas} entradas${fuera}${compactada ? "; el agente revisa qué vale guardar" : ""}`;
}

/** Un aviso lo ven los dos: el agente para no inventar, la persona para saber que la memoria no está. */
function aviso(texto: string): SalidaHook {
  return { contexto: texto, visible: texto };
}

function avisoSinServicio(esperaMs: number): SalidaHook {
  const segundos = (esperaMs / 1000).toLocaleString("es");
  return aviso(`agent-memory: el servicio no respondió en ${segundos} s; esta sesión arranca sin índice. Las herramientas memory_* responden cuando el servicio esté arriba («agent-memory start»).`);
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
    const datos = JSON.parse(texto) as { cwd?: unknown; source?: unknown };
    return {
      ...(typeof datos.cwd === "string" ? { cwd: datos.cwd } : {}),
      ...(typeof datos.source === "string" ? { source: datos.source } : {}),
    };
  } catch {
    return {};
  }
}
