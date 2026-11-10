import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, puertoLibre } from "./servicio.js";
import { dirTemporal } from "./temp.js";

// Entorno aislado para lanzar el bin: HOME, datos y puerto temporales y un `claude` falso que
// registra sus argumentos. El PATH no incluye el del sistema salvo git y node: nunca se ejecuta el
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

const CLAUDE_FALSO = `#!/bin/sh
echo "$*" >> "$FAKE_CLAUDE_LOG"
mkdir -p "$FAKE_CLAUDE_STATE"
case "$1" in
  --version) echo "9.9.9 (Claude Code falso)"; exit 0 ;;
  mcp)
    case "$2" in
      add) n="$5"; [ -e "$FAKE_CLAUDE_STATE/$n" ] && { echo "ya existe $n" >&2; exit 1; }; shift 6; echo "$*" > "$FAKE_CLAUDE_STATE/$n"; exit 0 ;;
      remove) [ -e "$FAKE_CLAUDE_STATE/$3" ] || { echo "no existe $3" >&2; exit 1; }; rm "$FAKE_CLAUDE_STATE/$3"; exit 0 ;;
      get) [ -e "$FAKE_CLAUDE_STATE/$3" ] || { echo "no existe $3" >&2; exit 1; }; cat "$FAKE_CLAUDE_STATE/$3"; exit 0 ;;
    esac ;;
esac
echo "claude falso: comando no soportado: $*" >&2
exit 2
`;

export async function entornoCli(opciones: { claude?: boolean } = {}): Promise<EntornoCli> {
  const { dir, limpiar } = dirTemporal("agent-memory-cli-");
  const home = join(dir, "home");
  const datos = join(home, ".agent-memory");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  if (opciones.claude !== false) {
    writeFileSync(join(bin, "claude"), CLAUDE_FALSO);
    chmodSync(join(bin, "claude"), 0o755);
  }
  const port = await puertoLibre();
  const logClaude = join(dir, "claude.log");
  const estadoClaude = join(dir, "claude-estado");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    AGENT_MEMORY_HOME: datos,
    AGENT_MEMORY_PORT: String(port),
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    FAKE_CLAUDE_LOG: logClaude,
    FAKE_CLAUDE_STATE: estadoClaude,
    LANG: "C.UTF-8",
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
    hijo.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - inicio }));
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
