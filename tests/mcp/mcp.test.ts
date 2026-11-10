import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HERRAMIENTAS } from "../../src/mcp/server.js";
import { dirTemporal } from "../helpers/temp.js";
import { CLI, asegurarBuild, crudo, servicioDePrueba, type ServicioDePrueba } from "../helpers/servicio.js";

// Punta a punta (T3.4): el cliente MCP genérico del SDK habla por stdio con `agent-memory mcp`,
// que traduce a un servicio real sobre un directorio de datos temporal.

const CAMPOS_AC03 = ["id", "titulo", "tipo", "ambito", "vida", "vigencia_hasta", "validacion", "actualizada_en"];

let s: ServicioDePrueba;
let cliente: Client;
let hub: string;
let limpiarHub: () => void;

async function herramienta(nombre: string, args: Record<string, unknown> = {}) {
  const r = (await cliente.callTool({ name: nombre, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const texto = r.content[0]?.text ?? "";
  if (r.isError) return { error: texto, datos: null as any };
  return { error: null, datos: JSON.parse(texto) };
}

async function ok(nombre: string, args: Record<string, unknown> = {}) {
  const r = await herramienta(nombre, args);
  if (r.error) throw new Error(`${nombre}: ${r.error}`);
  return r.datos;
}

async function sesionPersona(): Promise<Record<string, string>> {
  const { datos } = await s.api("enlace-web");
  const enlace = new URL(datos.url as string);
  const r = await crudo(s.app.port, { path: enlace.pathname, headers: { host: enlace.host } });
  return { cookie: String(r.headers["set-cookie"]).split(";")[0]! };
}

/** Guarda una entrada validada por la vía de la conversación: borrador → huella → confirmar. */
async function crearConfirmada(args: Record<string, unknown>) {
  const { huella } = await ok("memory_create", { ...args, borrador: true });
  return (await ok("memory_create", { ...args, huella })).entrada;
}

function ids(resultados: { id: number }[]) {
  return resultados.map((r) => r.id);
}

beforeAll(async () => {
  asegurarBuild();
  s = await servicioDePrueba();
  // Un repo git sin remoto que además es un hub de Workline: da contexto de repo y de proyecto.
  const tmp = dirTemporal("agent-memory-hub-");
  limpiarHub = tmp.limpiar;
  hub = realpathSync(tmp.dir);
  execFileSync("git", ["init", "-q"], { cwd: hub });
  mkdirSync(join(hub, ".workflow"));
  writeFileSync(join(hub, ".workflow", "workline.json"), "{}");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", CLI, "mcp"],
    cwd: hub,
    env: { ...(process.env as Record<string, string>), AGENT_MEMORY_HOME: s.home, AGENT_MEMORY_PORT: String(s.app.port) },
    stderr: "pipe",
  });
  cliente = new Client({ name: "cliente-generico-de-prueba", version: "1.0.0" });
  await cliente.connect(transport);
});

afterAll(async () => {
  await cliente?.close();
  await s?.cerrar();
  limpiarHub?.();
});

describe("agent-memory mcp con un cliente MCP genérico", () => {
  it("AC-02: lista exactamente las once herramientas memory_*", async () => {
    const { tools } = await cliente.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...HERRAMIENTAS].sort());
    expect(tools).toHaveLength(11);
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
  });

  it("AC-03 + AC-19: el contexto sale del directorio de trabajo y cada resultado trae los ocho campos", async () => {
    const { entrada } = await ok("memory_create", { tipo: "leccion", titulo: "Índices parciales", contenido: "Un índice parcial acelera filtros frecuentes" });
    expect(entrada).toMatchObject({ ambito: "proyecto", ambito_ref: `proyecto:${hub}`, validacion: "pendiente" });

    const busqueda = await ok("memory_search", { consulta: "índice parcial" });
    expect(busqueda.modo).toBe("hibrido");
    expect(busqueda.resultados.length).toBeGreaterThan(0);
    for (const r of busqueda.resultados) for (const campo of CAMPOS_AC03) expect(r, campo).toHaveProperty(campo);

    const leida = await ok("memory_get", { id: entrada.id });
    for (const campo of CAMPOS_AC03) expect(leida.entrada, campo).toHaveProperty(campo);

    const global = await ok("memory_create", { tipo: "preferencia", titulo: "Idioma", contenido: "Responder en español", ambito: "global" });
    expect(global.entrada).toMatchObject({ ambito: "global", ambito_ref: null });
    const repo = await ok("memory_create", { tipo: "referencia", titulo: "Repo", contenido: "dato del repo", ambito: "repo" });
    expect(repo.entrada).toMatchObject({ ambito: "repo", ambito_ref: `ruta:${hub}` });
  });

  it("AC-07: lo que crea el agente nace pendiente y memory_approve registra la vía mcp", async () => {
    const { entrada } = await ok("memory_create", { tipo: "decision", titulo: "Decisión a aprobar", contenido: "Usar WAL" });
    expect(ids((await ok("memory_pending")).entradas)).toContain(entrada.id);
    const aprobada = await ok("memory_approve", { id: entrada.id });
    expect(aprobada.entrada).toMatchObject({ validacion: "validada", validacion_via: "mcp" });
    expect(ids((await ok("memory_pending")).entradas)).not.toContain(entrada.id);
  });

  it("escenario «rechazo sin motivo»: no se registra y la entrada sigue pendiente", async () => {
    const { entrada } = await ok("memory_create", { tipo: "leccion", titulo: "Pendiente de rechazo", contenido: "texto" });
    const sinMotivo = await herramienta("memory_reject", { id: entrada.id, motivo: "  " });
    expect(sinMotivo.error).toMatch(/motivo/);
    expect((await ok("memory_get", { id: entrada.id })).entrada.validacion).toBe("pendiente");
    const conMotivo = await ok("memory_reject", { id: entrada.id, motivo: "repite otra lección" });
    expect(conMotivo.entrada).toMatchObject({ validacion: "rechazada", motivo_rechazo: "repite otra lección" });
  });

  it("escenario «borrador cambiado antes de guardar»", async () => {
    const original = { tipo: "convencion", titulo: "Nombres de ramas", contenido: "Prefijo feature/ y kebab-case" };
    const borrador = await ok("memory_create", { ...original, borrador: true });
    expect(borrador.borrador).toMatchObject({ titulo: original.titulo, contenido: original.contenido });
    expect(borrador.huella).toMatch(/^[0-9a-f]{64}$/);
    const antes = (await ok("memory_list", { todos_los_ambitos: true, limite: 100 })).entradas.length;

    const cambiado = await herramienta("memory_create", { ...original, contenido: "Prefijo feat/ y kebab-case", huella: borrador.huella });
    expect(cambiado.error).toMatch(/huella_distinta/);
    expect((await ok("memory_list", { todos_los_ambitos: true, limite: 100 })).entradas.length).toBe(antes);

    const sinConfirmar = await ok("memory_create", { ...original, contenido: "Prefijo feat/ y kebab-case" });
    expect(sinConfirmar.entrada.validacion).toBe("pendiente");
    const confirmado = await ok("memory_create", { ...original, huella: borrador.huella });
    expect(confirmado.entrada).toMatchObject({ validacion: "validada", validacion_via: "conversacion" });

    // AC-23: editar lo validado con el borrador confirmado lo mantiene validado; sin él, vuelve a pendiente.
    const edicion = { id: confirmado.entrada.id, contenido: "Prefijo feature/ y kebab-case en minúsculas" };
    const { huella } = await ok("memory_edit", { ...edicion, borrador: true });
    expect((await ok("memory_edit", { ...edicion, huella })).entrada.validacion).toBe("validada");
    expect((await ok("memory_edit", { id: confirmado.entrada.id, contenido: "Otra regla" })).entrada.validacion).toBe("pendiente");
    const revisiones = (await ok("memory_revisions", { id: confirmado.entrada.id })).revisiones;
    expect(revisiones.map((r: { validacion: string }) => r.validacion)).toEqual(["validada", "validada", "pendiente"]);
    const restaurada = await ok("memory_restore", { id: confirmado.entrada.id, numero: 2 });
    expect(restaurada.entrada.contenido).toBe(edicion.contenido);
    expect((await ok("memory_revisions", { id: confirmado.entrada.id })).revisiones).toHaveLength(4);
  });

  it("escenario «reemplazo propuesto por el agente»", async () => {
    const original = await crearConfirmada({ tipo: "convencion", titulo: "Comillas en TypeScript", contenido: "Usar comillas simples", ambito: "repo" });
    const { entrada: nueva } = await ok("memory_create", {
      tipo: "convencion",
      titulo: "Comillas en TypeScript v2",
      contenido: "Usar comillas dobles",
      ambito: "repo",
      reemplaza_a: original.id,
    });

    const antes = await ok("memory_search", { consulta: "comillas TypeScript" });
    expect(antes.resultados.find((r: { id: number }) => r.id === original.id)).toMatchObject({ validacion: "validada", vida: "activa" });
    const bandeja = (await ok("memory_pending")).entradas.find((e: { id: number }) => e.id === nueva.id);
    expect(bandeja).toMatchObject({ validacion: "pendiente", reemplaza_a: original.id, reemplazaria: { id: original.id, titulo: "Comillas en TypeScript" } });

    const persona = await sesionPersona();
    expect((await s.api("aprobar", { id: nueva.id }, persona)).datos.entrada).toMatchObject({ validacion_via: "web" });

    const despues = await ok("memory_search", { consulta: "comillas TypeScript" });
    expect(ids(despues.resultados)).toContain(nueva.id);
    expect(ids(despues.resultados)).not.toContain(original.id);
    const historia = await ok("memory_get", { id: original.id });
    expect(historia.entrada).toMatchObject({ vida: "reemplazada", reemplazada_por: nueva.id });
    expect((await ok("memory_revisions", { id: original.id })).revisiones.at(-1).vida).toBe("reemplazada");
  });

  it("escenario «trabajo de proyecto cerrado»", async () => {
    const { entrada: estado } = await ok("memory_create", { tipo: "proyecto", titulo: "Estado de la migración", contenido: "Migración de esquema en curso" });
    expect(estado.validacion).toBeNull();
    expect(ids((await ok("memory_pending")).entradas)).not.toContain(estado.id);
    const leccion = await crearConfirmada({ tipo: "leccion", titulo: "Lección de la migración", contenido: "Migrar el esquema dentro de una transacción" });

    await ok("memory_edit", { id: estado.id, contenido: "Migración de esquema casi lista" });
    expect((await ok("memory_get", { id: estado.id })).entrada.validacion).toBeNull();

    const cerrada = await ok("memory_expire", { id: estado.id, cerrar_trabajo: true });
    expect(cerrada.entrada.vigencia_hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const busqueda = await ok("memory_search", { consulta: "migración esquema" });
    expect(ids(busqueda.resultados)).toContain(leccion.id);
    expect(ids(busqueda.resultados)).not.toContain(estado.id);
    expect((await ok("memory_revisions", { id: estado.id })).revisiones).toHaveLength(3);
  });

  it("AC-31: relaciones por id en ambos sentidos con su estado; cambiar el título no rompe nada", async () => {
    const a = (await ok("memory_create", { tipo: "decision", titulo: "Usar SQLite", contenido: "una sola base" })).entrada;
    const b = (await ok("memory_create", { tipo: "leccion", titulo: "WAL", contenido: "lectores sin bloqueo", relacionadas: [a.id] })).entrada;
    const c = (await ok("memory_create", { tipo: "referencia", titulo: "Doc", contenido: "sqlite-vec" })).entrada;
    await ok("memory_edit", { id: a.id, relacionar_con: [c.id] });
    await ok("memory_edit", { id: a.id, titulo: "Usar SQLite como base única" });

    const deA = await ok("memory_get", { id: a.id });
    expect(deA.relaciones).toEqual([
      expect.objectContaining({ id: b.id, sentido: "entrante", validacion: "pendiente", vida: "activa" }),
      expect.objectContaining({ id: c.id, sentido: "saliente" }),
    ]);
    expect((await herramienta("memory_edit", { id: a.id })).error).toMatch(/necesita/);
    expect((await herramienta("memory_edit", { id: a.id, borrador: true })).error).toMatch(/no cambia/);

    const deB = await ok("memory_get", { id: b.id });
    expect(deB.relaciones).toEqual([expect.objectContaining({ id: a.id, titulo: "Usar SQLite como base única", sentido: "saliente" })]);
  });

  it("AC-26: un secreto se redacta antes de guardar y el aviso no trae el valor", async () => {
    const secreto = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = await ok("memory_create", { tipo: "referencia", titulo: "Acceso", contenido: `token del bot: ${secreto}` });
    expect(r.redactados).toEqual(["github_token"]);
    expect(JSON.stringify(r)).not.toContain(secreto);
  });

  it("con el servicio caído, cada herramienta devuelve un error explícito y nunca un vacío", async () => {
    const otro = await servicioDePrueba();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", CLI, "mcp"],
      cwd: hub,
      env: { ...(process.env as Record<string, string>), AGENT_MEMORY_HOME: otro.home, AGENT_MEMORY_PORT: String(otro.app.port) },
      stderr: "pipe",
    });
    const c2 = new Client({ name: "cliente-servicio-caido", version: "1.0.0" });
    await c2.connect(transport);
    try {
      await otro.app.cerrar();
      const r = (await c2.callTool({ name: "memory_search", arguments: { consulta: "algo" } })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/no responde.*agent-memory serve/);
    } finally {
      await c2.close();
      rmSync(otro.home, { recursive: true, force: true });
    }
  });
});
