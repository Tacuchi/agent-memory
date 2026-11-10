import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { HOST } from "./server.js";
import { leerToken } from "./token.js";

// Ciclo de vida del servicio fuera del terminal: `start` y el hook lo lanzan
// separado, con archivo de pid, y esperan a que responda; `stop` lo apaga limpio.

export interface Pid {
  pid: number;
  port: number;
}

export interface Salud {
  version: string;
}

/** Ruta del bin compilado (`dist/cli.js`), que se relanza como `serve`. */
export function rutaCli(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/** Argumentos de node para relanzar la CLI sin el aviso experimental de `node:sqlite`. */
export function argumentosNode(...args: string[]): string[] {
  return ["--disable-warning=ExperimentalWarning", rutaCli(), ...args];
}

export function escribirPid(config: Pick<Config, "pidPath">, datos: Pid): void {
  writeFileSync(config.pidPath, `${JSON.stringify(datos)}\n`, { mode: 0o600 });
}

export function leerPid(config: Pick<Config, "pidPath">): Pid | null {
  if (!existsSync(config.pidPath)) return null;
  try {
    const datos = JSON.parse(readFileSync(config.pidPath, "utf8")) as Partial<Pid>;
    return Number.isInteger(datos.pid) && Number.isInteger(datos.port) ? (datos as Pid) : null;
  } catch {
    return null;
  }
}

/** Borra el archivo de pid solo si sigue siendo de este proceso. */
export function borrarPid(config: Pick<Config, "pidPath">, pid: number): void {
  if (leerPid(config)?.pid === pid) rmSync(config.pidPath, { force: true });
}

export function procesoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * El pid sigue siendo un `agent-memory serve`: un archivo de pid viejo puede apuntar a un pid que
 * el sistema ya reusó para otro proceso, y ese nunca se toca.
 */
export function esServicio(pid: number): boolean {
  if (!procesoVivo(pid)) return false;
  try {
    const comando = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return comando.includes(rutaCli()) && /\bserve\b/.test(comando);
  } catch {
    return false;
  }
}

/** Salud del servicio con el token; null si no hay token o no responde a tiempo. */
export async function salud(config: Pick<Config, "port" | "tokenPath">, timeoutMs = 1000): Promise<Salud | null> {
  let token: string;
  try {
    token = leerToken(config.tokenPath);
  } catch {
    return null;
  }
  try {
    const res = await fetch(`http://${HOST}:${config.port}/api/salud`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const datos = (await res.json()) as { ok?: boolean; version?: string };
    return datos.ok ? { version: datos.version ?? "?" } : null;
  } catch {
    return null;
  }
}

/** Espera a que el servicio responda, como mucho `esperaMs`. */
export async function esperarSalud(config: Pick<Config, "port" | "tokenPath">, esperaMs: number): Promise<Salud | null> {
  const limite = Date.now() + esperaMs;
  for (;;) {
    const restante = limite - Date.now();
    const s = await salud(config, Math.max(100, Math.min(1000, restante)));
    if (s) return s;
    if (Date.now() + 100 >= limite) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Lanza `agent-memory serve` separado del terminal, con su salida en `servicio.log`. */
export function lanzarSeparado(config: Pick<Config, "home" | "logPath" | "pidPath" | "port">): number {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const log = openSync(config.logPath, "a", 0o600);
  try {
    const hijo = spawn(process.execPath, argumentosNode("serve"), {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    hijo.unref();
    if (hijo.pid === undefined) throw new Error("no se pudo lanzar el servicio");
    // Se registra ya al lanzar: `stop` alcanza también a un servicio que todavía está arrancando.
    escribirPid(config, { pid: hijo.pid, port: config.port });
    return hijo.pid;
  } finally {
    closeSync(log);
  }
}

export interface Arranque {
  yaCorria: boolean;
  salud: Salud | null;
  pid: number | null;
}

/** Arranca el servicio si no responde y espera su salud hasta `esperaMs`. */
export async function arrancarSeparado(config: Config, esperaMs: number): Promise<Arranque> {
  const actual = await salud(config, 500);
  if (actual) return { yaCorria: true, salud: actual, pid: leerPid(config)?.pid ?? null };
  // Otro `start` o el hook ya lo lanzó y todavía está arrancando: se espera a ese, no se lanza otro.
  const registrado = leerPid(config);
  if (registrado && esServicio(registrado.pid)) {
    return { yaCorria: false, salud: await esperarSalud(config, esperaMs), pid: registrado.pid };
  }
  const pid = lanzarSeparado(config);
  return { yaCorria: false, salud: await esperarSalud(config, esperaMs), pid };
}

export interface Parada {
  pid: number | null;
  detenido: boolean;
}

/** Envía SIGTERM al pid registrado y espera a que termine; SIGKILL si no termina a tiempo. */
export async function detener(config: Config, esperaMs = 5000): Promise<Parada> {
  const registro = leerPid(config);
  if (!registro || !esServicio(registro.pid)) {
    rmSync(config.pidPath, { force: true });
    return { pid: null, detenido: false };
  }
  process.kill(registro.pid, "SIGTERM");
  const limite = Date.now() + esperaMs;
  while (procesoVivo(registro.pid) && Date.now() < limite) await new Promise((r) => setTimeout(r, 50));
  if (esServicio(registro.pid)) process.kill(registro.pid, "SIGKILL");
  rmSync(config.pidPath, { force: true });
  return { pid: registro.pid, detenido: true };
}
