import "./dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { apiHttp, type ApiPanel } from "../../web/panel/api";
import { App } from "../../web/panel/App";
import { estadoDeMuestra, HUELLA_LAPTOP, HUELLA_MAC } from "../../web/panel/fixture";
import type { Accion, Estado } from "../../web/panel/tipos";

afterEach(() => cleanup());

const AHORA = new Date("2026-11-10T12:00:00Z").getTime();
const ahora = () => AHORA;
// Sin refresco ni reloj automáticos en las pruebas: cada carga la provoca la prueba.
const QUIETO = { ahora, intervaloMs: 3_600_000, ticMs: 3_600_000 };

/** fetch falso del relé: responde el estado y registra cada POST con su cuerpo. */
function releFalso(estado: Estado = estadoDeMuestra(AHORA)) {
  const posts: { url: string; cuerpo: unknown; metodo: string }[] = [];
  let caido = false;
  const f = async (url: string, init?: RequestInit) => {
    if (caido) throw new TypeError("fetch failed");
    if (url === "/dashboard/api/estado") return Response.json(estado);
    if (url === "/dashboard/api/accion") {
      const cuerpo = JSON.parse(String(init?.body)) as Accion;
      posts.push({ url, metodo: init?.method ?? "GET", cuerpo });
      const pendiente = ["renovar", "alcance", "codigo"].includes(cuerpo.accion);
      return Response.json({ ok: true, estado: pendiente ? "pendiente" : "hecho" });
    }
    return new Response("{}", { status: 404 });
  };
  return { api: apiHttp("/dashboard/api", f), posts, caer: () => (caido = true) };
}

async function abrir(api: ApiPanel) {
  render(<App api={api} {...QUIETO} />);
  return screen.findByRole("navigation", { name: "PCs e IPs del relé" });
}

describe("panel del relé", () => {
  it("lista las PCs, las IPs desconocidas y las bloqueadas, con el resumen", async () => {
    const lista = await abrir(releFalso().api);
    expect(within(lista).getByRole("button", { name: /Mac personal.*en línea · comparte con 1 · lee de 1/ })).toBeTruthy();
    expect(within(lista).getByRole("button", { name: /Laptop trabajo/ })).toBeTruthy();
    expect(within(lista).getByRole("button", { name: /192\.0\.2\.55.*31 intentos con clave equivocada/ })).toBeTruthy();
    expect(within(lista).getByRole("button", { name: /192\.0\.2\.88.*bloqueada hasta/ })).toBeTruthy();
    expect(screen.getByText("2 PCs en línea · 3 conexiones · 1 aviso")).toBeTruthy();
    // La primera PC queda elegida al abrir.
    expect(screen.getByRole("heading", { level: 1, name: "Mac personal" })).toBeTruthy();
  });

  it("al elegir una PC muestra sus enlaces y los pedidos pendientes en la dueña", async () => {
    const lista = await abrir(releFalso().api);
    fireEvent.click(within(lista).getByRole("button", { name: /Laptop trabajo/ }));
    screen.getByRole("heading", { level: 1, name: "Laptop trabajo" });
    const quien = screen.getByRole("region", { name: "Quién lee la memoria de esta PC" });
    const fila = within(quien).getByText("Mac personal").closest("tr")!;
    expect(within(fila).getByText("agent-memory")).toBeTruthy();
    expect(within(fila).getByText("+ no validadas")).toBeTruthy();
    expect(within(fila).getByText("Renovación: pendiente de confirmar en Laptop trabajo")).toBeTruthy();
    const que = screen.getByRole("region", { name: "Qué memorias lee esta PC" });
    expect(within(que).getByText("personal")).toBeTruthy();
    expect(within(que).getByRole("button", { name: "Quitar enlace" })).toBeTruthy();
  });

  it("Bloquear 1 h pide confirmación en línea y manda el cuerpo exacto", async () => {
    const rele = releFalso();
    await abrir(rele.api);
    fireEvent.click(screen.getByRole("button", { name: "Bloquear esta PC" }));
    expect(rele.posts).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: "24 h" }));
    fireEvent.click(screen.getByRole("radio", { name: "1 h" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloqueo" }));
    await screen.findByText("Mac personal quedó bloqueada (por 1 h).");
    expect(rele.posts).toEqual([{ url: "/dashboard/api/accion", metodo: "POST", cuerpo: { accion: "bloquear", pc: HUELLA_MAC, duracion: "1h" } }]);
  });

  it("Revocar no manda nada hasta confirmar, y Cancelar lo descarta", async () => {
    const rele = releFalso();
    await abrir(rele.api);
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(rele.posts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, revocar" }));
    await waitFor(() => expect(rele.posts.map((p) => p.cuerpo)).toEqual([{ accion: "revocar", pc: HUELLA_MAC, objetivo: HUELLA_LAPTOP }]));
  });

  it("una PC sin informe se marca «sin informe» y no muestra pestañas", async () => {
    const lista = await abrir(releFalso().api);
    fireEvent.click(within(lista).getByRole("button", { name: /PC vieja.*sin informe/ }));
    const ficha = screen.getByRole("region", { name: "PC vieja" });
    expect(within(ficha).getByText("sin informe")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Bloquear esta PC" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Nuevo código de enlace" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("nunca muestra el valor de un código, aunque el estado trajera uno", async () => {
    const estado = estadoDeMuestra(AHORA);
    const laptop = estado.pcs[1]!;
    (laptop.codigo as Record<string, unknown>) = { vence: laptop.codigo!.vence, codigo: "ABCD-EFGH-JKMN", valor: "QRST-VWXY" };
    const lista = await abrir(releFalso(estado).api);
    fireEvent.click(within(lista).getByRole("button", { name: /Laptop trabajo/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Códigos/ }));
    expect(screen.getByText(/Hay un código vigente: vence en/)).toBeTruthy();
    expect(screen.getByText("7:42")).toBeTruthy();
    for (const secreto of ["ABCD", "QRST"]) expect(document.body.textContent).not.toContain(secreto);
  });

  it("si el refresco falla, conserva los datos y muestra el error", async () => {
    const rele = releFalso();
    await abrir(rele.api);
    rele.caer();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo actualizar: No se pudo contactar al relé.");
    expect(screen.getByRole("heading", { level: 1, name: "Mac personal" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "PCs e IPs del relé" })).toBeTruthy();
  });

  /** API cuyo POST responde lo dado; el estado sale del fixture. */
  function apiQueResponde(respuesta: () => Response): ApiPanel {
    const http = apiHttp("/x", async () => respuesta());
    return { estado: async () => estadoDeMuestra(AHORA), accion: (c) => http.accion(c) };
  }

  async function cortarTodo() {
    fireEvent.click(screen.getByRole("button", { name: "Cortar todo" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, cortar todo" }));
  }

  it.each([
    ["400", 400],
    ["403", 403],
    ["200 con ok:false", 200],
  ])("muestra el error que devuelve el relé (%s)", async (_caso, status) => {
    await abrir(apiQueResponde(() => Response.json({ ok: false, error: "la PC no está conectada" }, { status })));
    await cortarTodo();
    expect((await screen.findByRole("alert")).textContent).toBe("la PC no está conectada");
  });

  it("un 401 sin cuerpo se lee como sesión de Access vencida", async () => {
    await abrir(apiQueResponde(() => new Response(null, { status: 401 })));
    await cortarTodo();
    expect((await screen.findByRole("alert")).textContent).toBe("La sesión de Access venció: hay que recargar la página.");
  });

  it("si la acción sale bien muestra el mensaje del relé; un pendiente se lee como pendiente en la dueña", async () => {
    await abrir(apiQueResponde(() => Response.json({ ok: true, estado: "hecho", mensaje: "3 conexiones cortadas" })));
    await cortarTodo();
    expect((await screen.findByRole("status")).textContent).toBe("3 conexiones cortadas");
    cleanup();
    await abrir(apiQueResponde(() => Response.json({ ok: true, estado: "pendiente", mensaje: "la dueña lo verá al volver" })));
    fireEvent.click(screen.getByRole("button", { name: "Renovar 30 días" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Renovación de Laptop trabajo pedida: queda pendiente de confirmar en Mac personal. la dueña lo verá al volver",
    );
  });

  it("Cambiar alcance manda los ámbitos como texto con su prefijo", async () => {
    const rele = releFalso();
    await abrir(rele.api);
    const fila = within(screen.getByRole("region", { name: "Quién lee la memoria de esta PC" })).getByText("Laptop trabajo").closest("tr")!;
    // El chip de proyecto se muestra sin el prefijo «proyecto:»; el de repo, tal cual.
    expect(within(fila).getByText("agent-memory")).toBeTruthy();
    expect(within(fila).getByText("repo:workline")).toBeTruthy();
    expect(within(fila).queryByText("proyecto:agent-memory")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cambiar alcance" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Proyectos/ }), { target: { value: "agent-memory\nproyecto:workline" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Global" }));
    fireEvent.click(screen.getByRole("button", { name: "Pedir cambio de alcance" }));
    await waitFor(() =>
      expect(rele.posts.map((p) => p.cuerpo)).toEqual([
        {
          accion: "alcance",
          pc: HUELLA_MAC,
          objetivo: HUELLA_LAPTOP,
          alcance: { ambitos: ["proyecto:agent-memory", "proyecto:workline", "repo:workline"], pendientes: false },
        },
      ]),
    );
  });

  it("los pedidos que amplían (renovar, código) se mandan sin confirmar y avisan que quedan pendientes", async () => {
    const rele = releFalso();
    await abrir(rele.api);
    fireEvent.click(screen.getByRole("button", { name: "Renovar 30 días" }));
    await screen.findByText(/Renovación de Laptop trabajo pedida: queda pendiente de confirmar en Mac personal/);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo código de enlace" }));
    await waitFor(() => expect(rele.posts).toHaveLength(2));
    const cuerpos: Accion[] = rele.posts.map((p) => p.cuerpo as Accion);
    expect(cuerpos).toEqual([
      { accion: "renovar", pc: HUELLA_MAC, objetivo: HUELLA_LAPTOP },
      { accion: "codigo", pc: HUELLA_MAC },
    ]);
  });

  it("sin PCs explica cuándo aparecen; sin desconocidas ni bloqueos lo dice", async () => {
    const vacio: Estado = { rele: { version: "0.3.0", encendido_desde: new Date(AHORA).toISOString(), conexiones: 0, tope: 64 }, pcs: [], desconocidas: [], bloqueos: [] };
    await abrir(releFalso(vacio).api);
    expect(screen.getByText(/aparece aquí cuando se conecta al relé con agent-memory 0\.3\.0/)).toBeTruthy();
    expect(screen.getByText(/Ninguna IP falló la clave/)).toBeTruthy();
    expect(screen.getByText("No hay PCs ni IPs bloqueadas.")).toBeTruthy();
  });

  it("j y k recorren la lista, pero no mientras se escribe en un campo", async () => {
    await abrir(releFalso().api);
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    await screen.findByRole("heading", { level: 1, name: "Laptop trabajo" });
    expect((document.activeElement as HTMLElement).textContent).toContain("Laptop trabajo");
    fireEvent.click(screen.getByRole("button", { name: "Cambiar alcance" }));
    const campo = screen.getByRole("textbox", { name: /Proyectos/ });
    fireEvent.keyDown(campo, { key: "j" });
    expect(screen.getByRole("heading", { level: 1, name: "Laptop trabajo" })).toBeTruthy();
    act(() => void fireEvent.keyDown(document.body, { key: "k" }));
    await screen.findByRole("heading", { level: 1, name: "Mac personal" });
  });

  it("el uso de 7 días se lee como gráfico accesible y como números", async () => {
    await abrir(releFalso().api);
    fireEvent.click(screen.getByRole("tab", { name: "Uso" }));
    expect(screen.getByRole("img", { name: "Lecturas recibidas por día: 4, 9, 7, 12, 15, 5, 12" })).toBeTruthy();
    expect(screen.getByText("64")).toBeTruthy();
  });
});
