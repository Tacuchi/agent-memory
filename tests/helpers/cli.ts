import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, puertoLibre } from "./servicio.js";
import { dirTemporal } from "./temp.js";

// Entorno aislado para lanzar el bin: HOME, datos y puerto temporales y un `claude` falso que
// registra sus argumentos. El PATH solo trae node, git y las carpetas base del sistema: nunca se ejecuta el
// `claude` real ni se toca la configuración real de Claude Code.

export interface EntornoCli {
  raiz: string;
  home: string;
  datos: string;
  port: number;
  env: NodeJS.ProcessEnv;
  /** Llamadas al `claude` falso, una por línea. */
  logClaude: string;
  estadoClaude: string;
  limpiar(): Promise<void>;
}

// El `claude` falso, en JS para que sea el mismo en los tres sistemas. Lo envuelve un script de shell
// (`claude`) o, en Windows, un `claude.cmd` como el que instala npm.
const CLAUDE_FALSO = `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, args.join(" ") + "\\n");
const estado = process.env.FAKE_CLAUDE_STATE;
fs.mkdirSync(estado, { recursive: true });
const salir = (codigo, error) => { if (error) process.stderr.write(error + "\\n"); process.exit(codigo); };
const [comando, sub, nombre] = args;
if (comando === "--version") { process.stdout.write("9.9.9 (Claude Code falso)\\n"); salir(0); }
if (comando === "mcp" && sub === "add") {
  const archivo = path.join(estado, args[4]);
  if (fs.existsSync(archivo)) salir(1, "ya existe " + args[4]);
  fs.writeFileSync(archivo, args.slice(6).join(" ") + "\\n");
  salir(0);
}
if (comando === "mcp" && (sub === "remove" || sub === "get")) {
  const archivo = path.join(estado, nombre);
  if (!fs.existsSync(archivo)) salir(1, "no existe " + nombre);
  if (sub === "remove") fs.rmSync(archivo); else process.stdout.write(fs.readFileSync(archivo, "utf8"));
  salir(0);
}
salir(2, "claude falso: comando no soportado: " + args.join(" "));
`;

const WINDOWS = process.platform === "win32";

/** Ejecutable de prueba que corre `script` con node: `<nombre>` con shebang, o `<nombre>.cmd` en Windows. */
export function ejecutableNode(carpeta: string, nombre: string, script: string): string {
  const js = join(carpeta, `${nombre}.cjs`);
  writeFileSync(js, script);
  if (WINDOWS) {
    const cmd = join(carpeta, `${nombre}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = join(carpeta, nombre);
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** Windows no tiene git en System32: la carpeta del `git.exe` del PATH de las pruebas, para resolver repos. */
function carpetaGitWindows(): string[] {
  const dir = (process.env.PATH ?? "").split(delimiter).find((d) => d && existsSync(join(d, "git.exe")));
  return dir ? [dir] : [];
}

export async function entornoCli(opciones: { claude?: boolean } = {}): Promise<EntornoCli> {
  const { dir, limpiar } = dirTemporal("agent-memory-cli-");
  const home = join(dir, "home");
  const datos = join(home, ".agent-memory");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  if (opciones.claude !== false) ejecutableNode(bin, "claude", CLAUDE_FALSO);
  const port = await puertoLibre();
  const logClaude = join(dir, "claude.log");
  const estadoClaude = join(dir, "claude-estado");
  const sistema = WINDOWS ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), ...carpetaGitWindows()] : ["/usr/bin", "/bin"];
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    AGENT_MEMORY_HOME: datos,
    AGENT_MEMORY_PORT: String(port),
    PATH: [...new Set([bin, dirname(process.execPath), ...sistema])].join(delimiter),
    FAKE_CLAUDE_LOG: logClaude,
    FAKE_CLAUDE_STATE: estadoClaude,
    LANG: "C.UTF-8",
    // Windows: su HOME es USERPROFILE (lo lee os.homedir()) y sin SystemRoot ni ComSpec no corren ni la red ni cmd.exe.
    ...(WINDOWS
      ? {
          USERPROFILE: home,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        }
      : {}),
  };
  const e: EntornoCli = {
    raiz: dir,
    home,
    datos,
    port,
    env,
    logClaude,
    estadoClaude,
    async limpiar() {
      await correr(e, ["stop"]);
      limpiar();
    },
  };
  return e;
}

export interface Corrida {
  /** Pid del proceso `agent-memory` que corrió. */
  pid: number;
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Lanza `agent-memory` sin bloquear el proceso de pruebas (puede haber un servicio en proceso). */
export function correr(e: Pick<EntornoCli, "env">, args: string[], opciones: { input?: string; cwd?: string } = {}): Promise<Corrida> {
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, [CLI, ...args], {
      env: e.env,
      cwd: opciones.cwd ?? (e.env.HOME as string),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    hijo.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    hijo.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    hijo.on("error", reject);
    hijo.on("close", (code) => resolve({ pid: hijo.pid ?? -1, code: code ?? -1, stdout, stderr, ms: Date.now() - inicio }));
    hijo.stdin.end(opciones.input ?? "");
  });
}

/** Cliente MCP genérico del SDK contra `agent-memory mcp` en el entorno dado. */
export async function clienteMcp(e: Pick<EntornoCli, "env">, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    cwd,
    env: e.env as Record<string, string>,
    stderr: "pipe",
  });
  const cliente = new Client({ name: "prueba-sin-claude-code", version: "1.0.0" });
  await cliente.connect(transport);
  return cliente;
}

export async function llamarHerramienta(cliente: Client, nombre: string, args: Record<string, unknown> = {}) {
  const r = (await cliente.callTool({ name: nombre, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const texto = r.content[0]?.text ?? "";
  return { isError: Boolean(r.isError), texto };
}
