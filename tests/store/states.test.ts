import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIPOS } from "../../src/domain/types.js";
import { PROYECTO, REPO, storeTemporal } from "../helpers/temp.js";

type Ctx = ReturnType<typeof storeTemporal>;
const agente = { actor: "agente" as const };
const persona = { actor: "persona" as const };
const enRepo = { ambito: "repo" as const, ambitoRef: REPO };

describe("estados de vida y validación", () => {
  let t: Ctx;
  beforeEach(() => {
    t = storeTemporal();
  });
  afterEach(() => t.cerrar());

  it("acepta los seis tipos y rechaza cualquier otro", async () => {
    for (const tipo of TIPOS) {
      const { entrada } = await t.store.crear({ tipo, titulo: `t ${tipo}`, contenido: "c", ...enRepo }, agente);
      expect(entrada.tipo).toBe(tipo);
    }
    await expect(t.store.crear({ tipo: "user", titulo: "x", contenido: "c", ...enRepo }, agente)).rejects.toMatchObject({
      codigo: "tipo_invalido",
    });
    expect(t.store.listar({ todosLosAmbitos: true }, 100)).toHaveLength(TIPOS.length);
  });

  it("lo que crea el agente nace activo y pendiente; proyecto no tiene validación", async () => {
    const { entrada: leccion } = await t.store.crear({ tipo: "leccion", titulo: "l", contenido: "c", ...enRepo }, agente);
    expect(leccion).toMatchObject({ vida: "activa", vigenciaHasta: null, validacion: "pendiente", validacionVia: null });
    const { entrada: proyecto } = await t.store.crear({ tipo: "proyecto", titulo: "p", contenido: "c", ...enRepo }, agente);
    expect(proyecto.validacion).toBeNull();
    expect(t.store.pendientes().map((e) => e.id)).toEqual([leccion.id]);
  });

  it("escenario «rechazo sin motivo»: no se registra y la entrada sigue pendiente", async () => {
    const { entrada } = await t.store.crear({ tipo: "decision", titulo: "d", contenido: "c", ...enRepo }, agente);
    expect(() => t.store.rechazar(entrada.id, "   ")).toThrow(/motivo/);
    expect(() => t.store.rechazar(entrada.id, undefined)).toThrow(/motivo/);
    expect(t.store.obtener(entrada.id).validacion).toBe("pendiente");
    expect(t.store.revisiones(entrada.id)).toHaveLength(1);

    const rechazada = t.store.rechazar(entrada.id, "duplica otra decisión");
    expect(rechazada).toMatchObject({ validacion: "rechazada", motivoRechazo: "duplica otra decisión" });
    expect(t.store.listar({ todosLosAmbitos: true }).map((e) => e.id)).not.toContain(entrada.id);
    expect(t.store.listar({ todosLosAmbitos: true, validacion: ["rechazada"] }).map((e) => e.id)).toEqual([entrada.id]);
  });

  it("las tres vías de validación quedan registradas", async () => {
    const a = (await t.store.crear({ tipo: "convencion", titulo: "a", contenido: "c", ...enRepo }, agente)).entrada;
    const b = (await t.store.crear({ tipo: "convencion", titulo: "b", contenido: "c", ...enRepo }, agente)).entrada;
    const c = (await t.store.crear({ tipo: "convencion", titulo: "c", contenido: "c", ...enRepo }, { ...agente, confirmado: true }))
      .entrada;
    expect(t.store.aprobar(a.id, "web")).toMatchObject({ validacion: "validada", validacionVia: "web" });
    expect(t.store.aprobar(b.id, "mcp")).toMatchObject({ validacion: "validada", validacionVia: "mcp" });
    expect(c).toMatchObject({ validacion: "validada", validacionVia: "conversacion" });
    expect(() => t.store.aprobar(a.id, "web")).toThrow(/ya está validada/);
    expect(t.store.pendientes()).toHaveLength(0);
  });

  it("la vigencia futura no oculta la entrada; vencida sale de lo que se lista por defecto", async () => {
    const { entrada } = await t.store.crear({ tipo: "referencia", titulo: "r", contenido: "c", ...enRepo }, persona);
    t.store.caducar(entrada.id, { actor: "persona", fecha: "2026-12-31" });
    expect(t.store.listar({ todosLosAmbitos: true }).map((e) => e.id)).toContain(entrada.id);
    t.fijar(new Date("2026-12-31T08:00:00"));
    expect(t.store.listar({ todosLosAmbitos: true }).map((e) => e.id)).not.toContain(entrada.id);
    expect(t.store.listar({ todosLosAmbitos: true, incluirVencidas: true }).map((e) => e.id)).toContain(entrada.id);
  });
});

describe("cambios del agente sobre lo validado", () => {
  let t: Ctx;
  beforeEach(() => {
    t = storeTemporal();
  });
  afterEach(() => t.cerrar());

  async function validada(titulo = "Convención de nombres") {
    const { entrada } = await t.store.crear({ tipo: "convencion", titulo, contenido: "Usar kebab-case", ...enRepo }, persona);
    return entrada;
  }

  it("editarla la devuelve a pendiente y la revisión validada queda en la historia", async () => {
    const e = await validada();
    t.avanzar(1000);
    const { entrada } = await t.store.editar(e.id, { contenido: "Usar snake_case" }, agente);
    expect(entrada.validacion).toBe("pendiente");
    const revs = t.store.revisiones(e.id);
    expect(revs.map((r) => r.instantanea.validacion)).toEqual(["validada", "pendiente"]);
    expect(revs[0]?.instantanea.contenido).toBe("Usar kebab-case");
  });

  it("con el borrador exacto confirmado, la edición sigue validada", async () => {
    const e = await validada();
    const { entrada } = await t.store.editar(e.id, { contenido: "Usar kebab-case siempre" }, { ...agente, confirmado: true });
    expect(entrada).toMatchObject({ validacion: "validada", validacionVia: "conversacion" });
  });

  it("la persona edita sin cambiar el estado de validación", async () => {
    const e = await validada();
    const { entrada } = await t.store.editar(e.id, { titulo: "Convención de nombres de archivo" }, persona);
    expect(entrada.validacion).toBe("validada");
  });

  it("escenario «reemplazo propuesto por el agente»", async () => {
    const original = await validada();
    const { entrada: nueva } = await t.store.crear(
      { tipo: "convencion", titulo: "Convención de nombres v2", contenido: "Usar snake_case", ...enRepo, reemplazaA: original.id },
      agente,
    );
    const porDefecto = t.store.listar({ contexto: { repo: REPO, proyecto: null } });
    expect(porDefecto.find((e) => e.id === original.id)).toMatchObject({ vida: "activa", validacion: "validada" });
    const bandeja = t.store.pendientes();
    expect(bandeja).toHaveLength(1);
    expect(bandeja[0]).toMatchObject({ id: nueva.id, validacion: "pendiente", reemplazaA: original.id });

    t.store.aprobar(nueva.id, "web");
    const despues = t.store.listar({ contexto: { repo: REPO, proyecto: null } });
    expect(despues.map((e) => e.id)).toEqual([nueva.id]);
    expect(t.store.obtener(original.id)).toMatchObject({ vida: "reemplazada", reemplazadaPor: nueva.id });
    expect(t.store.revisiones(original.id).at(-1)?.accion).toBe(`reemplazada_por:${nueva.id}`);
    expect(t.store.listar({ todosLosAmbitos: true, incluirReemplazadas: true }).map((e) => e.id)).toContain(original.id);
  });

  it("caducar surte efecto de inmediato, queda registrado y la persona lo revierte", async () => {
    const e = await validada();
    const caducada = t.store.caducar(e.id, { actor: "agente" });
    expect(caducada.vigenciaHasta).toBe("2026-11-09");
    expect(caducada.caducidad).toMatchObject({ actor: "agente", vigenciaAnterior: null });
    expect(caducada.validacion).toBe("validada");
    expect(t.store.listar({ todosLosAmbitos: true })).toHaveLength(0);

    const revertida = t.store.revertirCaducidad(e.id);
    expect(revertida).toMatchObject({ vigenciaHasta: null, caducidad: null });
    expect(t.store.listar({ todosLosAmbitos: true }).map((x) => x.id)).toEqual([e.id]);
    expect(t.store.revisiones(e.id).map((r) => r.accion)).toEqual(["crear", "caducar", "revertir_caducidad"]);
  });
});

describe("entradas de proyecto", () => {
  let t: Ctx;
  beforeEach(() => {
    t = storeTemporal();
  });
  afterEach(() => t.cerrar());

  it("se actualizan en sitio con revisiones y nunca pasan por la bandeja", async () => {
    const enProyecto = { ambito: "proyecto" as const, ambitoRef: PROYECTO };
    const { entrada } = await t.store.crear({ tipo: "proyecto", titulo: "Estado del trabajo", contenido: "Primera etapa en curso", ...enProyecto }, agente);
    await t.store.editar(entrada.id, { contenido: "Segunda etapa en curso" }, agente);
    const actual = t.store.obtener(entrada.id);
    expect(actual).toMatchObject({ contenido: "Segunda etapa en curso", validacion: null });
    expect(t.store.revisiones(entrada.id)).toHaveLength(2);
    expect(t.store.pendientes()).toHaveLength(0);
    expect(() => t.store.aprobar(entrada.id, "mcp")).toThrow(/proyecto/);
  });

  it("escenario «trabajo de proyecto cerrado»: vence ese día y la lección sigue", async () => {
    const enProyecto = { ambito: "proyecto" as const, ambitoRef: PROYECTO };
    const { entrada: estado } = await t.store.crear({ tipo: "proyecto", titulo: "Estado", contenido: "abierto", ...enProyecto }, agente);
    const { entrada: leccion } = await t.store.crear({ tipo: "leccion", titulo: "Lección", contenido: "aprendido", ...enProyecto }, persona);

    const cerrada = t.store.caducar(estado.id, { actor: "agente", cerrarTrabajo: true });
    expect(cerrada.vigenciaHasta).toBe("2026-11-09");
    expect(cerrada.caducidad?.trabajoCerrado).toBe(true);
    const visibles = t.store.listar({ contexto: { repo: null, proyecto: PROYECTO } }).map((e) => e.id);
    expect(visibles).toEqual([leccion.id]);
    expect(t.store.revisiones(estado.id)).toHaveLength(2);
    expect(() => t.store.caducar(leccion.id, { actor: "agente", cerrarTrabajo: true })).toThrow(/proyecto/);
  });
});
