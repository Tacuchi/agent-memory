import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Dispositivo } from "../../src/remoto/datos.js";
import type { Rele } from "../../src/remoto/rele.js";
import { leerToken } from "../../src/service/token.js";
import { PROYECTO, REPO } from "../helpers/temp.js";
import { CLAVE_RELE, enlazar, instalacion, releLocal, type Instalacion } from "./instalaciones.js";

const MARCA = "cadena-marcada-alcance-91b";
const abiertos: { cerrar(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const a of abiertos.splice(0).reverse()) await a.cerrar();
});

interface Mundo {
  rele: Rele;
  duena: Instalacion;
  lectora: Instalacion;
  id: number;
}

async function mundo(): Promise<Mundo> {
  const rele = await releLocal();
  const duena = await instalacion();
  const lectora = await instalacion();
  abiertos.push(rele, duena, lectora);
  const id = await enlazar(duena, lectora, rele);
  return { rele, duena, lectora, id };
}

type Estado = "validada" | "pendiente" | "rechazada" | "vencida" | "reemplazada";

/** Crea una entrada en la dueña en el estado pedido y devuelve su id. */
async function entrada(d: Instalacion, titulo: string, opciones: { estado?: Estado; ambito?: "global" | "repo" | "proyecto"; ref?: string | null; tipo?: string } = {}) {
  const st = d.app.store;
  const estado = opciones.estado ?? "validada";
  const nueva = {
    tipo: opciones.tipo ?? "leccion",
    titulo,
    contenido: `${titulo} ${MARCA}`,
    ambito: opciones.ambito ?? "global",
    ambitoRef: opciones.ambito && opciones.ambito !== "global" ? (opciones.ref ?? REPO) : null,
  };
  const { entrada: e } = await st.crear(nueva, { actor: "agente", confirmado: estado !== "pendiente" && estado !== "rechazada" });
  if (estado === "rechazada") st.rechazar(e.id, "no sirve");
  if (estado === "vencida") st.caducar(e.id, { actor: "persona" });
  if (estado === "reemplazada") await st.crear({ ...nueva, titulo: `${titulo} (nueva)`, reemplazaA: e.id }, { actor: "agente", confirmado: true });
  return e.id;
}

async function alcance(m: Mundo, ambitos: { ambito: string; ref: string | null }[], noValidadas = false) {
  const r = await m.duena.persona("remoto_alcance", { id: m.id, ambitos, no_validadas: noValidadas });
  expect(r.status).toBe(200);
}

const titulos = (xs: { titulo: string }[]) => xs.map((x) => x.titulo).sort();

describe("la dueña responde solo lecturas dentro del alcance", () => {
  it("un enlace nuevo no ve nada (AC-06)", async () => {
    const m = await mundo();
    await entrada(m.duena, "Validada global");
    expect((await m.lectora.agente("listar", { origen: "trabajo" })).datos.entradas).toEqual([]);
    const busqueda = await m.lectora.agente("buscar", { consulta: "validada" });
    expect(busqueda.datos.enlaces).toEqual([{ origen: "trabajo", estado: "ok", motivo: null }]);
    expect(busqueda.datos.resultados).toEqual([]);
  });

  it("el alcance por ámbito y la marca de no validadas rigen desde la petición siguiente (AC-07)", async () => {
    const m = await mundo();
    await entrada(m.duena, "Global validada");
    await entrada(m.duena, "Global pendiente", { estado: "pendiente" });
    await entrada(m.duena, "Repo validada", { ambito: "repo", ref: REPO });
    await entrada(m.duena, "Otro repo validada", { ambito: "repo", ref: "github.com/ejemplo/otro" });
    await entrada(m.duena, "Estado del proyecto", { ambito: "proyecto", ref: PROYECTO, tipo: "proyecto" });
    const listar = async () => titulos((await m.lectora.agente("listar", { origen: "trabajo" })).datos.entradas);

    await alcance(m, [{ ambito: "global", ref: null }]);
    expect(await listar()).toEqual(["Global validada"]);
    await alcance(m, [
      { ambito: "global", ref: null },
      { ambito: "repo", ref: REPO },
      { ambito: "proyecto", ref: PROYECTO },
    ]);
    expect(await listar()).toEqual(["Global validada", "Repo validada"]);
    await alcance(m, [{ ambito: "global", ref: null }, { ambito: "repo", ref: REPO }, { ambito: "proyecto", ref: PROYECTO }], true);
    expect(await listar()).toEqual(["Estado del proyecto", "Global pendiente", "Global validada", "Repo validada"]);
    await alcance(m, []);
    expect(await listar()).toEqual([]);
  });

  it("lo rechazado, lo vencido y lo reemplazado nunca salen, pida lo que pida la lectora (AC-08)", async () => {
    const m = await mundo();
    const visible = await entrada(m.duena, "Visible");
    const rechazada = await entrada(m.duena, "Rechazada", { estado: "rechazada" });
    const vencida = await entrada(m.duena, "Vencida");
    m.duena.app.store.caducar(vencida, { actor: "persona" });
    const reemplazada = await entrada(m.duena, "Reemplazada", { estado: "reemplazada" });
    await alcance(m, [{ ambito: "global", ref: null }], true);
    const filtros = { validacion: ["rechazada", "validada", "pendiente"], incluir_vencidas: true, incluir_reemplazadas: true, todos_los_ambitos: true };
    const lista = titulos((await m.lectora.agente("listar", { origen: "trabajo", filtros })).datos.entradas);
    expect(lista).toEqual(["Reemplazada (nueva)", "Visible"]);
    const busqueda = await m.lectora.agente("buscar", { consulta: MARCA, filtros, limite: 50 });
    expect(titulos(busqueda.datos.resultados)).toEqual(["Reemplazada (nueva)", "Visible"]);
    for (const id of [rechazada, vencida, reemplazada]) {
      const r = await m.lectora.agente("leer", { id, origen: "trabajo" });
      expect(r.datos.error.codigo, String(id)).toBe("no_encontrada");
      expect((await m.lectora.agente("revisiones", { id, origen: "trabajo" })).datos.error.codigo).toBe("no_encontrada");
    }
    expect((await m.lectora.agente("leer", { id: visible, origen: "trabajo" })).status).toBe(200);
  });

  it("fuera del alcance responde igual que lo inexistente y las relaciones se recortan", async () => {
    const m = await mundo();
    const st = m.duena.app.store;
    const dentro = await entrada(m.duena, "Dentro");
    const fuera = await entrada(m.duena, "Fuera", { ambito: "repo", ref: "github.com/ejemplo/otro" });
    const companera = await entrada(m.duena, "Compañera");
    st.relacionar(dentro, fuera);
    st.relacionar(dentro, companera);
    await alcance(m, [{ ambito: "global", ref: null }]);
    const r = await m.lectora.agente("leer", { id: dentro, origen: "trabajo" });
    expect(r.datos.relaciones.map((x: { id: number }) => x.id)).toEqual([companera]);
    const noVisible = await m.lectora.agente("leer", { id: fuera, origen: "trabajo" });
    const inexistente = await m.lectora.agente("leer", { id: 9999, origen: "trabajo" });
    expect(noVisible.datos).toEqual(inexistente.datos);
    expect(noVisible.status).toBe(inexistente.status);
  });

  it("una lectora modificada que pide escribir recibe operacion_no_permitida y queda en el registro (AC-12)", async () => {
    const m = await mundo();
    const id = await entrada(m.duena, "Validada");
    await alcance(m, [{ ambito: "global", ref: null }]);
    const remoto = m.duena.app.remoto;
    const dispositivo = remoto.datos.dispositivo(m.id) as Dispositivo;
    for (const op of ["crear", "aprobar", "caducar"]) {
      const r = (await remoto.atenderPedido(dispositivo, { op, datos: { id, tipo: "leccion", titulo: "x", contenido: "y" } })) as { ok: boolean; error: { codigo: string } };
      expect(r).toEqual({ ok: false, error: { codigo: "operacion_no_permitida" } });
    }
    // Un pedido mal formado también.
    expect(await remoto.atenderPedido(dispositivo, { op: "leer", datos: { id: "uno" } })).toEqual({ ok: false, error: { codigo: "operacion_no_permitida" } });
    expect(m.duena.app.store.obtener(id).caducidad).toBeNull();
    const { datos } = await m.duena.persona("remoto_registro", { solo_rechazos: true, dispositivo_id: m.id });
    expect(datos.registro.map((x: { herramienta: string; motivo: string }) => `${x.herramienta}:${x.motivo}`)).toEqual(
      expect.arrayContaining(["crear:operacion_no_permitida", "aprobar:operacion_no_permitida", "caducar:operacion_no_permitida", "leer:operacion_no_permitida"]),
    );
  });

  it("el registro muestra herramienta, pedido e ids de cada lectura, y las lecturas remotas no tocan el uso (AC-05)", async () => {
    const m = await mundo();
    const id = await entrada(m.duena, "Para el registro");
    await alcance(m, [{ ambito: "global", ref: null }]);
    await m.lectora.agente("buscar", { consulta: "registro" });
    await m.lectora.agente("leer", { id, origen: "trabajo" });
    await m.lectora.agente("revisiones", { id, origen: "trabajo" });
    const { datos } = await m.duena.persona("remoto_registro", { dispositivo_id: m.id });
    const lecturas = datos.registro.filter((x: { resultado: string }) => x.resultado === "lectura");
    expect(lecturas.slice(0, 3).map((x: { herramienta: string; pedido: string; ids: number[]; dispositivo: string }) => [x.herramienta, JSON.parse(x.pedido), x.ids, x.dispositivo])).toEqual([
      ["revisiones", { id }, [id], "casa"],
      ["leer", { id }, [id], "casa"],
      ["buscar", { consulta: "registro" }, [id], "casa"],
    ]);
    const e = m.duena.app.store.obtener(id);
    expect(e.usos).toBe(0);
    expect(e.usadaEn).toBeNull();
    expect((await m.duena.persona("remoto_estado")).datos.dispositivos[0].usado_en).not.toBeNull();
  });

  it("la credencial del enlace no entra al servicio local y el token local no viaja por el relé (AC-15)", async () => {
    const rele = await releLocal();
    const espia = await espiaTcp(rele.port);
    const duena = await instalacion();
    const lectora = await instalacion();
    abiertos.push(rele, { cerrar: () => cerrarServidor(espia.servidor) }, duena, lectora);
    const urlEspia = `ws://127.0.0.1:${(espia.servidor.address() as AddressInfo).port}`;
    for (const i of [duena, lectora]) expect((await i.agente("enlace_rele", { url: urlEspia, clave: CLAVE_RELE })).status).toBe(200);
    await duena.persona("remoto_interruptor", { encendido: true });
    const { datos: codigo } = await duena.persona("remoto_codigo");
    expect((await lectora.agente("enlace_canjear", { codigo: codigo.codigo, origen: "trabajo", dispositivo: "casa" })).status).toBe(200);
    const id = (await duena.persona("remoto_estado")).datos.dispositivos[0].id as number;
    await duena.persona("remoto_alcance", { id, ambitos: [{ ambito: "global", ref: null }], no_validadas: false });
    await entrada(duena, "Secreta");
    const busqueda = await lectora.agente("buscar", { consulta: MARCA });
    expect(busqueda.datos.resultados.length).toBeGreaterThan(0);

    const todo = Buffer.concat(espia.bytes);
    for (const token of [leerToken(duena.config.tokenPath), leerToken(lectora.config.tokenPath)]) expect(todo.includes(Buffer.from(token))).toBe(false);
    expect(todo.includes(Buffer.from(MARCA))).toBe(false);

    // Lo que la lectora tiene del enlace (buzón, clave de la dueña, su propia clave pública) no sirve como token local.
    const enlace = lectora.app.remoto.datos.enlace("trabajo");
    const credenciales = [enlace?.buzon, enlace?.claveDuena, lectora.app.remoto.datos.identidad().publica, String(enlace?.enlaceId)];
    for (const credencial of credenciales) {
      for (const i of [duena, lectora]) {
        const r = await fetch(`${i.app.url}/api/listar`, { method: "POST", headers: { authorization: `Bearer ${credencial}`, "content-type": "application/json" }, body: "{}" });
        expect(r.status).toBe(401);
      }
    }
    expect(duena.app.server.address()).toMatchObject({ address: "127.0.0.1" });
  });
});

/** Proxy TCP que guarda todo lo que pasa entre las instalaciones y el relé (WebSocket sin TLS: se ve el contenido). */
async function espiaTcp(puertoRele: number): Promise<{ servidor: Server; bytes: Buffer[] }> {
  const bytes: Buffer[] = [];
  const servidor = createServer((cliente) => {
    const destino = connect(puertoRele, "127.0.0.1");
    cliente.on("data", (d: Buffer) => {
      bytes.push(Buffer.from(d));
      destino.write(d);
    });
    destino.on("data", (d: Buffer) => {
      bytes.push(Buffer.from(d));
      cliente.write(d);
    });
    const cortar = () => {
      cliente.destroy();
      destino.destroy();
    };
    cliente.on("close", cortar);
    destino.on("close", cortar);
    cliente.on("error", cortar);
    destino.on("error", cortar);
  });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  return { servidor, bytes };
}

function cerrarServidor(s: Server): Promise<void> {
  return new Promise((ok) => s.close(() => ok()));
}
