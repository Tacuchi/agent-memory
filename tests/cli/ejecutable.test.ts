import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escaparArgumentoCmd, invocacion } from "../../src/ejecutable.js";
import { dirTemporal } from "../helpers/temp.js";

// Cómo se lanza un programa externo. En macOS y Linux, tal cual. En Windows se busca con PATH y PATHEXT,
// y un `.cmd` (el `claude.cmd` que instala npm) se corre por cmd.exe con los argumentos escapados.

describe("lanzar un programa externo", () => {
  let dir: string;
  let limpiar: () => void;
  beforeEach(() => ({ dir, limpiar } = dirTemporal("agent-memory-ejecutable-")));
  afterEach(() => limpiar());

  it("en macOS y Linux el programa va tal cual y lo resuelve el sistema", () => {
    expect(invocacion("claude", ["--version"], { PATH: "" }, "linux")).toEqual({ archivo: "claude", args: ["--version"], windowsVerbatimArguments: false });
  });

  it("en Windows prefiere el .cmd de npm al script sin extensión y lo corre por cmd.exe", () => {
    const vacia = join(dir, "vacia");
    const npm = join(dir, "npm");
    mkdirSync(vacia);
    mkdirSync(npm);
    writeFileSync(join(npm, "claude"), "#!/bin/sh\n");
    writeFileSync(join(npm, "claude.cmd"), "@echo off\r\n");
    const env = { Path: [vacia, npm].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const r = invocacion("claude", ["mcp", "get", "agent-memory"], env, "win32");
    expect(r?.archivo).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(r?.windowsVerbatimArguments).toBe(true);
    expect(r?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r?.args[3]).toContain(join(npm, "claude.cmd"));
    expect(r?.args[3]).toContain(escaparArgumentoCmd("agent-memory"));
  });

  it("en Windows un .exe va directo y lo que no está en el PATH da null", () => {
    writeFileSync(join(dir, "claude.exe"), "");
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
    expect(invocacion("claude", ["--version"], env, "win32")).toEqual({ archivo: join(dir, "claude.exe"), args: ["--version"], windowsVerbatimArguments: false });
    expect(invocacion("otro", [], env, "win32")).toBeNull();
  });

  it("escapa para cmd.exe: comillas, espacios y metacaracteres no parten ni ejecutan nada", () => {
    expect(escaparArgumentoCmd("C:\\Program Files\\nodejs\\node.exe")).toBe('^^^"C:\\Program^^^ Files\\nodejs\\node.exe^^^"');
    expect(escaparArgumentoCmd('a"b & c')).toBe('^^^"a\\^^^"b^^^ ^^^&^^^ c^^^"');
  });
});
