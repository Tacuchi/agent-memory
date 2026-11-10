import { existsSync, statSync } from "node:fs";
import type { Config } from "./config.js";
import { claudeDisponible, hookInstalado, mcpRegistrado, rutasHook, skillInstalada } from "./claude-code/install.js";
import { openDatabase } from "./db/driver.js";
import { NODE_MINIMO, nodeSuficiente } from "./node-minimo.js";
import { autochequear, explicarFallo, type EmbedderAutochequeo } from "./search/autochequeo.js";
import { TransformersEmbedder } from "./search/embedder.js";
import { cacheModelos, modeloFijado } from "./search/models.js";
import { leerPid, salud } from "./service/daemon.js";

// `agent-memory doctor`: cada revisión da un hallazgo y, si falla, su arreglo.

export type Nivel = "ok" | "aviso" | "falla";

export interface Hallazgo {
  nombre: string;
  nivel: Nivel;
  detalle: string;
  arreglo?: string;
}

export async function diagnosticar(config: Config, env: NodeJS.ProcessEnv, opciones: { embedder?: EmbedderAutochequeo } = {}): Promise<Hallazgo[]> {
  const h: Hallazgo[] = [];
  h.push(
    nodeSuficiente(process.versions.node)
      ? { nombre: "node", nivel: "ok", detalle: `Node ${process.versions.node}` }
      : { nombre: "node", nivel: "falla", detalle: `Node ${process.versions.node}`, arreglo: `instalá Node ${NODE_MINIMO} o más nuevo` },
  );

  if (!existsSync(config.tokenPath)) {
    h.push({ nombre: "token", nivel: "aviso", detalle: `no existe ${config.tokenPath}`, arreglo: "se crea al arrancar: «agent-memory start»" });
  } else if (process.platform === "win32") {
    // Windows no tiene permisos POSIX (stat siempre da 0666 o 0444): el acceso lo dan los de la carpeta.
    h.push({ nombre: "token", nivel: "ok", detalle: `${config.tokenPath} (en Windows sin permisos 0600: el acceso lo dan los permisos de su carpeta)` });
  } else {
    const modo = statSync(config.tokenPath).mode & 0o777;
    h.push(
      modo === 0o600
        ? { nombre: "token", nivel: "ok", detalle: `${config.tokenPath} con permisos 0600` }
        : {
            nombre: "token",
            nivel: "falla",
            detalle: `${config.tokenPath} con permisos ${modo.toString(8).padStart(4, "0")}`,
            arreglo: `chmod 600 ${config.tokenPath}`,
          },
    );
  }

  const s = await salud(config, 1500);
  h.push(
    s
      ? { nombre: "servicio", nivel: "ok", detalle: `responde en 127.0.0.1:${config.port} (versión ${s.version}, pid ${leerPid(config)?.pid ?? "?"})` }
      : { nombre: "servicio", nivel: "falla", detalle: `no responde en 127.0.0.1:${config.port}`, arreglo: `«agent-memory start»; si falla, mirá ${config.logPath}` },
  );

  try {
    const db = openDatabase(":memory:");
    const fila = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    db.close();
    h.push({ nombre: "sqlite-vec", nivel: "ok", detalle: `carga ${fila.v}` });
  } catch (error) {
    h.push({ nombre: "sqlite-vec", nivel: "falla", detalle: (error as Error).message, arreglo: "reinstalá las dependencias: «npm ci» en el paquete" });
  }

  h.push(await revisarModelo(env, opciones.embedder));

  if (!claudeDisponible(env)) {
    h.push({ nombre: "claude-code", nivel: "aviso", detalle: "«claude» no está en el PATH", arreglo: "instalá Claude Code y corré «agent-memory install claude-code»" });
  } else {
    const faltan = [
      mcpRegistrado(env) ? null : "MCP",
      hookInstalado(env) ? null : "hook SessionStart",
      skillInstalada(env) ? null : "skill",
    ].filter((x): x is string => x !== null);
    const rotas = (rutasHook(env) ?? []).filter((ruta) => !existsSync(ruta));
    h.push(
      faltan.length > 0
        ? { nombre: "claude-code", nivel: "falla", detalle: `falta: ${faltan.join(", ")}`, arreglo: "«agent-memory install claude-code»" }
        : rotas.length > 0
          ? {
              nombre: "claude-code",
              nivel: "falla",
              detalle: `el hook y el MCP apuntan a rutas que ya no existen: ${rotas.join(", ")}`,
              arreglo: "repetí «agent-memory install claude-code»",
            }
          : { nombre: "claude-code", nivel: "ok", detalle: "MCP, hook SessionStart y skill instalados" },
    );
  }
  return h;
}

/** Que el modelo esté en la caché y que sus vectores pasen el autochequeo en esta máquina. */
async function revisarModelo(env: NodeJS.ProcessEnv, inyectado?: EmbedderAutochequeo): Promise<Hallazgo> {
  const modelo = modeloFijado();
  const cache = cacheModelos(env);
  if (!inyectado && !TransformersEmbedder.enCache(modelo, cache)) {
    return {
      nombre: "modelo",
      nivel: "aviso",
      detalle: `falta ${modelo.id} (${modelo.dtype}) en ${cache}: la búsqueda queda solo por texto`,
      arreglo: "traelo una vez con «agent-memory model fetch»",
    };
  }
  try {
    const r = await autochequear(inyectado ?? new TransformersEmbedder(modelo, { cache }));
    return r.ok
      ? { nombre: "modelo", nivel: "ok", detalle: `${modelo.id} (${modelo.dtype}) en ${cache}; autochequeo de embeddings ok (margen ${r.margen.toFixed(3)})` }
      : { nombre: "modelo", nivel: "falla", detalle: explicarFallo(r.margen), arreglo: "actualizá agent-memory; si sigue, reportalo con esta salida" };
  } catch (error) {
    return {
      nombre: "modelo",
      nivel: "aviso",
      detalle: `${modelo.id} no carga (${(error as Error).message}): la búsqueda queda solo por texto`,
      arreglo: "volvé a traerlo con «agent-memory model fetch»",
    };
  }
}

export function formatearHallazgos(hallazgos: readonly Hallazgo[]): string {
  const marca: Record<Nivel, string> = { ok: "ok   ", aviso: "aviso", falla: "FALLA" };
  return hallazgos
    .map((x) => `${marca[x.nivel]} ${x.nombre}: ${x.detalle}${x.arreglo ? `\n      arreglo: ${x.arreglo}` : ""}`)
    .join("\n");
}
