import { existsSync, statSync } from "node:fs";
import type { Config } from "./config.js";
import { claudeDisponible, hookInstalado, mcpRegistrado, skillInstalada } from "./claude-code/install.js";
import { openDatabase } from "./db/driver.js";
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

export async function diagnosticar(config: Config, env: NodeJS.ProcessEnv): Promise<Hallazgo[]> {
  const h: Hallazgo[] = [];
  const mayor = Number(process.versions.node.split(".")[0]);
  h.push(
    mayor >= 22
      ? { nombre: "node", nivel: "ok", detalle: `Node ${process.versions.node}` }
      : { nombre: "node", nivel: "falla", detalle: `Node ${process.versions.node}`, arreglo: "instalá Node 22 o más nuevo" },
  );

  if (!existsSync(config.tokenPath)) {
    h.push({ nombre: "token", nivel: "aviso", detalle: `no existe ${config.tokenPath}`, arreglo: "se crea al arrancar: «agent-memory start»" });
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

  const modelo = modeloFijado();
  h.push(
    TransformersEmbedder.enCache(modelo, cacheModelos(env))
      ? { nombre: "modelo", nivel: "ok", detalle: `${modelo.id} en ${cacheModelos(env)}` }
      : {
          nombre: "modelo",
          nivel: "aviso",
          detalle: `falta ${modelo.id} en ${cacheModelos(env)}: la búsqueda queda solo por texto`,
          arreglo: "traelo una vez con «npm run model:fetch» en el paquete",
        },
  );

  if (!claudeDisponible(env)) {
    h.push({ nombre: "claude-code", nivel: "aviso", detalle: "«claude» no está en el PATH", arreglo: "instalá Claude Code y corré «agent-memory install claude-code»" });
  } else {
    const faltan = [
      mcpRegistrado(env) ? null : "MCP",
      hookInstalado(env) ? null : "hook SessionStart",
      skillInstalada(env) ? null : "skill",
    ].filter((x): x is string => x !== null);
    h.push(
      faltan.length === 0
        ? { nombre: "claude-code", nivel: "ok", detalle: "MCP, hook SessionStart y skill instalados" }
        : { nombre: "claude-code", nivel: "falla", detalle: `falta: ${faltan.join(", ")}`, arreglo: "«agent-memory install claude-code»" },
    );
  }
  return h;
}

export function formatearHallazgos(hallazgos: readonly Hallazgo[]): string {
  const marca: Record<Nivel, string> = { ok: "ok   ", aviso: "aviso", falla: "FALLA" };
  return hallazgos
    .map((x) => `${marca[x.nivel]} ${x.nombre}: ${x.detalle}${x.arreglo ? `\n      arreglo: ${x.arreglo}` : ""}`)
    .join("\n");
}
