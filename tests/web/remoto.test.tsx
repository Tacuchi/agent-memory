import "./dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorApi, type Cliente } from "../../web/src/api";
import { Remoto } from "../../web/src/pantallas/Remoto";

afterEach(() => cleanup());

const AHORA = new Date("2026-11-10T12:00:00Z").getTime();
const CLAVE_RELE = "clave-secreta-del-rele";

function comparto(id: number, extra: object = {}) {
  return {
    id,
    estado: "vigente",
    alcance: { ambitos: [] as object[], no_validadas: false },
    usado_en: "2026-11-09T18:30:00.000Z",
    vence_en: "2026-12-01T10:00:00.000Z",
    revocado_en: null as string | null,
    ...extra,
  };
}

function leo(origen: string) {
  return { origen, enlazado_en: "2026-11-02T10:00:00.000Z", usado_en: "2026-11-10T09:00:00.000Z", vence_en: "2026-12-02T10:00:00.000Z" };
}

const SIN_USO = { leyo: 0, lei: 0, rechazos: 0 };

/** Cliente falso con el estado de una PC: registra cada operación con su cuerpo. Las conexiones mandan. */
function clienteFalso(inicio: { interruptor?: boolean; rele?: { url: string } | null; prueba?: string; pendientes?: boolean } = {}) {
  const llamadas: [string, object][] = [];
  const conexiones: any[] = [
    { huella: "h-qtc", nombre: "laptop-qtc", comparto: comparto(1, { alcance: { ambitos: [{ ambito: "global", ref: null }], no_validadas: true } }), leo: leo("laptop-qtc"), hoy: { leyo: 2, lei: 3, rechazos: 1 } },
    { huella: "h-casa", nombre: "desktop-casa", comparto: comparto(2), leo: null, hoy: SIN_USO },
    { huella: "h-taller", nombre: "mini-taller", comparto: null, leo: leo("mini-taller"), hoy: SIN_USO },
    { huella: "h-vieja", nombre: "laptop-vieja", comparto: comparto(3, { estado: "revocado", revocado_en: "2026-11-03T10:00:00.000Z" }), leo: null, hoy: SIN_USO },
  ];
  const estado = {
    interruptor: inicio.interruptor ?? true,
    nombre_pc: "mac-de-prueba",
    panel: "conectado" as "conectado" | "conectando" | "inactivo",
    pendientes: (inicio.pendientes
      ? [
          { id: 11, accion: "renovar", dispositivo: { id: 1, nombre: "casa" }, datos: null, creado_en: "2026-11-10T11:50:00.000Z", estado: "pendiente" },
          {
            id: 12,
            accion: "alcance",
            dispositivo: { id: 1, nombre: "casa" },
            datos: { ambitos: ["global", "proyecto:agent-memory", "repo:github.com/ejemplo/repo"], pendientes: true },
            creado_en: "2026-11-10T11:51:00.000Z",
            estado: "pendiente",
          },
          { id: 13, accion: "codigo", dispositivo: null, datos: null, creado_en: "2026-11-10T11:52:00.000Z", estado: "pendiente" },
        ]
      : []) as any[],
    rele: inicio.rele === undefined ? { url: "wss://rele.ejemplo" } : inicio.rele,
    codigo: null as null | { vence_en: string; intentos_restantes: number },
    desconocidas_hoy: 2,
  };
  let prueba = inicio.prueba ?? "responde";
  const vista = () => ({
    ...structuredClone(estado),
    conexiones: structuredClone(conexiones),
    dispositivos: conexiones.filter((c) => c.comparto).map((c) => ({ ...c.comparto, nombre: c.nombre, enlazado_en: "2026-11-01T10:00:00.000Z" })),
    enlaces: conexiones.filter((c) => c.leo).map((c) => ({ ...c.leo, nombre: c.nombre })),
  });
  const porId = (id: number) => conexiones.find((c) => c.comparto?.id === id).comparto;
  const porOrigen = (origen: string) => conexiones.find((c) => c.leo?.origen === origen);
  const cliente: Cliente = async <T,>(op: string, cuerpo: object = {}): Promise<T> => {
    llamadas.push([op, cuerpo]);
    const c = cuerpo as any;
    switch (op) {
      case "remoto_estado":
        return vista() as T;
      case "remoto_interruptor":
        estado.interruptor = c.encendido;
        return vista() as T;
      case "remoto_ambitos":
        return {
          ambitos: [
            { ambito: "global", ref: null, entradas: 31 },
            { ambito: "proyecto", ref: "agent-memory", entradas: 40 },
            { ambito: "proyecto", ref: "finanzas", entradas: 12 },
            { ambito: "repo", ref: "github.com/ejemplo/repo", entradas: 3 },
          ],
        } as T;
      case "remoto_codigo":
        if (!estado.interruptor) throw new ErrorApi("acceso_apagado", "encendé el acceso remoto");
        return { codigo: "ABCD-EFGH-JKMN-PQRS", vence_en: new Date(AHORA + 600_000).toISOString() } as T;
      case "remoto_alcance":
        porId(c.id).alcance = { ambitos: c.ambitos, no_validadas: c.no_validadas };
        return {} as T;
      case "remoto_revocar":
        porId(c.id).estado = "revocado";
        porId(c.id).revocado_en = new Date(AHORA).toISOString();
        return {} as T;
      case "remoto_renovar":
        return {} as T;
      case "remoto_nombre":
        estado.nombre_pc = c.nombre;
        return vista() as T;
      case "remoto_canjear":
        if (c.codigo === "USADO") throw new ErrorApi("codigo_usado", "ese código ya se usó: pedí uno nuevo en la otra PC");
        conexiones.find((x) => x.huella === "h-casa").leo = leo("desktop-casa");
        return { origen: "desktop-casa", nombre: "desktop-casa", vence_en: "2026-12-10T12:00:00.000Z" } as T;
      case "remoto_enlace_quitar":
        porOrigen(c.origen).leo = null;
        return { ok: true } as T;
      case "remoto_enlace_renombrar":
        porOrigen(c.origen).leo.origen = c.nuevo;
        return { origen: c.nuevo } as T;
      case "remoto_rele":
        if (!/^wss?:\/\//.test(c.url)) throw new ErrorApi("rele_invalido", "la URL del relé debe empezar con ws:// o wss://");
        estado.rele = { url: c.url };
        prueba = "responde";
        return { rele: { url: c.url } } as T;
      case "remoto_rele_probar":
        return { estado: estado.rele ? prueba : "sin_rele" } as T;
      case "remoto_pendiente": {
        const p = estado.pendientes.find((x) => x.id === c.id);
        estado.pendientes = estado.pendientes.filter((x) => x.id !== c.id);
        const resuelto = { ...p, estado: c.aceptar ? "aceptado" : "rechazado" };
        return (c.aceptar && p.accion === "codigo"
          ? { pendiente: resuelto, codigo: { codigo: "PANE-LCOD-IGO0-1234", vence_en: new Date(AHORA + 300_000).toISOString() } }
          : { pendiente: resuelto }) as T;
      }
      case "remoto_actividad":
        return {
          leyo: [
            { fecha: "2026-11-10T11:58:00.000Z", herramienta: "buscar", pedido: '{"consulta":"release npm"}', ids: [179, 83], resultado: "lectura", motivo: null },
            { fecha: "2026-11-09T11:00:00.000Z", herramienta: "leer", pedido: '{"id":40}', ids: [], resultado: "rechazo", motivo: "no_encontrada" },
          ],
          lei: [{ fecha: "2026-11-10T11:50:00.000Z", herramienta: "listar", pedido: null, ids: [355, 352], resultado: "lectura", motivo: null }],
        } as T;
      case "remoto_registro":
        return {
          registro: c.solo_desconocidas
            ? [{ id: 9, fecha: "2026-11-10T11:00:00.000Z", dispositivo_id: null, dispositivo: null, herramienta: "conexion", pedido: null, ids: [], resultado: "rechazo", motivo: "desconocido" }]
            : [],
        } as T;
      default:
        throw new ErrorApi("ruta_desconocida", op);
    }
  };
  return { cliente, llamadas, estado, conexiones };
}

const ops = (llamadas: [string, object][]) => llamadas.map(([op]) => op);
const seccion = () => screen.getByRole("region", { name: /^Conexiones/ });
const tarjeta = (nombre: string) =>
  within(within(seccion()).getByRole("list", { name: "PCs conectadas" })).getByText(nombre, { selector: ".item-nombre" }).closest("li") as HTMLElement;
const comparto_ = (nombre: string) => screen.getByRole("group", { name: `Le compartís tu memoria a ${nombre}` });
const leo_ = (nombre: string) => screen.getByRole("group", { name: `${nombre} te comparte la suya` });

async function montar(f = clienteFalso()) {
  render(<Remoto cliente={f.cliente} ahora={() => AHORA} />);
  await screen.findByRole("region", { name: /^Conexiones/ });
  return f;
}

describe("pantalla «Acceso remoto»", () => {
  it("una tarjeta por PC conectada, con los dos sentidos; las terminadas plegadas al final", async () => {
    await montar();
    const barra = screen.getByRole("group", { name: "Esta PC" });
    expect(barra.compareDocumentPosition(seccion()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(seccion()).getByRole("heading", { level: 3 }).textContent).toBe("Conexiones · 3");
    const lista = within(seccion()).getByRole("list", { name: "PCs conectadas" });
    expect(within(lista).getAllByText(/./, { selector: ".item-nombre" }).map((n) => n.textContent)).toEqual(["laptop-qtc", "desktop-casa", "mini-taller"]);

    const qtc = tarjeta("laptop-qtc");
    expect(within(qtc).getByText("en los dos sentidos")).toBeTruthy();
    expect(comparto_("laptop-qtc").textContent).toMatch(/Le compartís tu memoria.*Global.*\+ no validadas.*leyó 2026-11-09 · vence 2026-12-01/);
    expect(within(leo_("laptop-qtc")).getByText("laptop-qtc").tagName).toBe("CODE");
    expect(leo_("laptop-qtc").textContent).toMatch(/leíste 2026-11-10 · vence 2026-12-02/);

    expect(within(tarjeta("desktop-casa")).getByText("solo le compartís")).toBeTruthy();
    expect(comparto_("desktop-casa").textContent).toContain("sin alcance: todavía no ve nada");
    expect(leo_("desktop-casa").className).toContain("vacio");
    expect(within(tarjeta("mini-taller")).getByText("solo te comparte")).toBeTruthy();
    expect(comparto_("mini-taller").textContent).toContain("No le compartís tu memoria");

    const terminadas = within(seccion()).getByText("Conexiones terminadas", { exact: false }).closest("details")!;
    expect(terminadas.open).toBe(false);
    expect(terminadas.textContent).toMatch(/laptop-vieja · dejaste de compartirle el 2026-11-03/);
    expect(screen.queryByRole("region", { name: "Registro" })).toBeNull();
  });

  it("la actividad de cada conexión arranca plegada con el resumen de hoy y se pide al abrirla", async () => {
    const f = await montar();
    const actividad = tarjeta("laptop-qtc").querySelector("details.actividad") as HTMLDetailsElement;
    expect(actividad.open).toBe(false);
    expect(actividad.querySelector("summary")!.textContent).toBe("Actividadhoy: leyó 2 de las tuyas · leíste 3 de la suya · 1 rechazo");
    expect(tarjeta("desktop-casa").querySelector("details.actividad summary")!.textContent).toBe("Actividadhoy, sin lecturas");
    expect(ops(f.llamadas)).not.toContain("remoto_actividad");

    actividad.open = true;
    fireEvent(actividad, new window.Event("toggle"));
    const leyo = await within(actividad).findByRole("list", { name: "Lo que leyó de tu memoria" });
    expect(f.llamadas).toContainEqual(["remoto_actividad", { huella: "h-qtc", limite: 50 }]);
    expect(within(leyo).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringMatching(/buscar«release npm» → #179, #83$/),
      expect.stringMatching(/rechazoleer #40: no_encontrada$/),
    ]);
    const lei = within(actividad).getByRole("list", { name: "Lo que leíste de la suya" });
    expect(within(lei).getByRole("listitem").textContent).toMatch(/listar#355, #352$/);
  });

  it("«Conectar otra PC» ofrece los dos caminos: compartir con alcance genera el código", async () => {
    const f = await montar();
    fireEvent.click(within(seccion()).getByRole("button", { name: "+ Conectar otra PC" }));
    const compartir = await screen.findByRole("group", { name: "Compartirle tu memoria" });
    expect(screen.getByRole("form", { name: "Leer su memoria" })).toBeTruthy();
    fireEvent.click(await within(compartir).findByRole("checkbox", { name: /Global/ }));
    fireEvent.click(within(compartir).getByRole("checkbox", { name: /agent-memory/ }));
    fireEvent.click(within(compartir).getByRole("button", { name: "Generar código" }));
    expect((await screen.findByLabelText("Código de enlace")).textContent).toBe("ABCD-EFGH-JKMN-PQRS");
    expect(f.llamadas).toContainEqual([
      "remoto_codigo",
      { ambitos: [{ ambito: "global", ref: null }, { ambito: "proyecto", ref: "agent-memory" }], no_validadas: false },
    ]);
    expect(screen.getByText(/Acceso remoto → Conectar otra PC → Leer su memoria/)).toBeTruthy();
  });

  it("leer su memoria pega el código sin pedir nombre y la conexión suma ese sentido", async () => {
    const f = await montar();
    fireEvent.click(within(leo_("desktop-casa")).getByRole("button", { name: "Pegar el código de desktop-casa" }));
    const form = await screen.findByRole("form", { name: "Leer su memoria" });
    fireEvent.change(within(form).getByLabelText("Código de la otra PC"), { target: { value: "USADO" } });
    fireEvent.submit(form);
    expect((await within(form).findByRole("alert")).textContent).toContain("ese código ya se usó");
    fireEvent.change(within(form).getByLabelText("Código de la otra PC"), { target: { value: "WXYZ-1234" } });
    fireEvent.submit(form);
    expect((await within(form).findByRole("status")).textContent).toBe("Ahora leés «desktop-casa» como «desktop-casa».");
    expect(f.llamadas).toContainEqual(["remoto_canjear", { codigo: "WXYZ-1234" }]);
    await waitFor(() => expect(within(tarjeta("desktop-casa")).getByText("en los dos sentidos")).toBeTruthy());
  });

  it("dejar de compartir y dejar de leer piden confirmación antes de llamar al servicio", async () => {
    const f = await montar();
    fireEvent.click(within(comparto_("laptop-qtc")).getByRole("button", { name: "Dejar de compartirle a laptop-qtc" }));
    expect(ops(f.llamadas)).not.toContain("remoto_revocar");
    const confirmar = within(comparto_("laptop-qtc")).getByRole("group", { name: "Dejar de compartir" });
    expect(confirmar.textContent).toContain("laptop-qtc deja de leer tu memoria en el acto");
    fireEvent.click(within(confirmar).getByRole("button", { name: "Dejar de compartir" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_revocar", { id: 1 }]));
    await waitFor(() => expect(comparto_("laptop-qtc").textContent).toContain("No le compartís tu memoria"));

    fireEvent.click(within(leo_("mini-taller")).getByRole("button", { name: "Dejar de leer mini-taller" }));
    expect(ops(f.llamadas)).not.toContain("remoto_enlace_quitar");
    fireEvent.click(within(within(leo_("mini-taller")).getByRole("group", { name: "Dejar de leer" })).getByRole("button", { name: "Dejar de leer" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_enlace_quitar", { origen: "mini-taller" }]));
    // Sin ningún sentido activo, mini-taller pasa a «Conexiones terminadas».
    await waitFor(() => expect(within(within(seccion()).getByRole("list", { name: "PCs conectadas" })).queryByText("mini-taller")).toBeNull());
  });

  it("renombra el identificador que usan los agentes y valida su forma", async () => {
    const f = await montar();
    fireEvent.click(within(leo_("laptop-qtc")).getByRole("button", { name: "Renombrar laptop-qtc" }));
    const campo = within(leo_("laptop-qtc")).getByLabelText("Identificador para los agentes") as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "Con Espacios" } });
    expect((within(leo_("laptop-qtc")).getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(campo, { target: { value: "trabajo" } });
    fireEvent.submit(campo.closest("form")!);
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_enlace_renombrar", { origen: "laptop-qtc", nuevo: "trabajo" }]));
  });

  it("una PC sin alcance lleva al editor de casillas, que manda remoto_alcance", async () => {
    const f = await montar();
    fireEvent.click(within(comparto_("desktop-casa")).getByRole("button", { name: "Qué ve desktop-casa" }));
    const editor = await screen.findByRole("group", { name: "Editar qué ve desktop-casa" });
    fireEvent.click(await within(editor).findByRole("checkbox", { name: /finanzas/ }));
    fireEvent.click(within(editor).getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(f.llamadas).toContainEqual(["remoto_alcance", { id: 2, ambitos: [{ ambito: "proyecto", ref: "finanzas" }], no_validadas: false }]),
    );
  });

  it("con compartir apagado avisa y atenúa lo que compartís; leer sigue operativo", async () => {
    const f = await montar();
    fireEvent.click(screen.getByRole("switch", { name: "Compartir" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_interruptor", { encendido: false }]));
    expect((await within(seccion()).findByRole("note")).textContent).toContain("Compartir está apagado: ninguna PC puede leer tu memoria");
    expect(comparto_("laptop-qtc").className).toContain("apagado");
    expect((within(leo_("laptop-qtc")).getByRole("button", { name: "Dejar de leer laptop-qtc" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("los intentos de PCs desconocidas van en una línea aparte, con su detalle a pedido", async () => {
    const f = await montar();
    expect(within(seccion()).getByText(/Intentos de PCs desconocidas:/).textContent).toMatch(/2 hoy/);
    fireEvent.click(within(seccion()).getByRole("button", { name: "Ver" }));
    const lista = await within(seccion()).findByRole("list", { name: "Intentos de PCs desconocidas" });
    expect(within(lista).getByRole("listitem").textContent).toContain("desconocido");
    expect(f.llamadas).toContainEqual(["remoto_registro", { solo_desconocidas: true }]);
  });

  it("aceptar un pedido de código del panel abre «Conectar otra PC» con el código", async () => {
    const f = await montar(clienteFalso({ pendientes: true }));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: código de enlace nuevo" }));
    expect((await screen.findByLabelText("Código de enlace")).textContent).toBe("PANE-LCOD-IGO0-1234");
    expect(screen.getByRole("timer").textContent).toBe("Vence en 5:00");
    expect(f.llamadas).toContainEqual(["remoto_pendiente", { id: 13, aceptar: true }]);
  });

  it("sin relé ofrece URL y clave, manda remoto_rele y nunca vuelve a mostrar la clave (AC-09)", async () => {
    const f = await montar(clienteFalso({ rele: null }));
    const form = screen.getByRole("form", { name: "Configurar el relé" });
    const clave = within(form).getByLabelText("Clave") as HTMLInputElement;
    expect(clave.type).toBe("password");
    fireEvent.change(within(form).getByLabelText("URL del relé"), { target: { value: "https://mal" } });
    fireEvent.change(clave, { target: { value: CLAVE_RELE } });
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toBe("la URL del relé debe empezar con ws:// o wss://");
    expect(clave.value).toBe("");

    fireEvent.change(within(form).getByLabelText("URL del relé"), { target: { value: "wss://rele.nuevo" } });
    fireEvent.change(clave, { target: { value: CLAVE_RELE } });
    fireEvent.submit(form);
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_rele", { url: "wss://rele.nuevo", clave: CLAVE_RELE }]));
    expect(await screen.findByText("responde")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Configurar el relé" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CLAVE_RELE);
  });

  it("con la clave rechazada lo dice, ofrece corregirla y permite probar de nuevo (AC-10)", async () => {
    const f = await montar(clienteFalso({ prueba: "clave_rechazada" }));
    const barra = screen.getByRole("group", { name: "Esta PC" });
    expect(await within(barra).findByText("rechaza la clave")).toBeTruthy();
    expect(within(barra).getByRole("form", { name: "Configurar el relé" })).toBeTruthy();
    fireEvent.click(within(barra).getByRole("button", { name: "Probar de nuevo" }));
    await waitFor(() => expect(ops(f.llamadas).filter((o) => o === "remoto_rele_probar")).toHaveLength(2));
  });

  it("renombra esta PC en sitio y avisa cómo figura en el panel", async () => {
    const f = await montar();
    const barra = screen.getByRole("group", { name: "Esta PC" });
    fireEvent.click(within(barra).getByRole("button", { name: /Cambiar el nombre de esta PC/ }));
    const campo = within(barra).getByRole("textbox", { name: "Nombre de esta PC" });
    fireEvent.change(campo, { target: { value: "  Mac personal " } });
    fireEvent.submit(campo.closest("form")!);
    expect((await within(barra).findByRole("status")).textContent).toBe("Nombre guardado: el panel del relé muestra «Mac personal»");
    expect(f.llamadas).toContainEqual(["remoto_nombre", { nombre: "Mac personal" }]);
    expect(within(barra).getByText("Mac personal")).toBeTruthy();
  });

  it("sin pedidos del panel no dibuja la sección", async () => {
    await montar();
    expect(screen.queryByRole("region", { name: /Pedidos del panel/ })).toBeNull();
  });

  it("lista los pedidos del panel en castellano llano", async () => {
    await montar(clienteFalso({ pendientes: true }));
    const lista = screen.getByRole("list", { name: "Pedidos del panel" });
    const items = within(lista).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/^renovar casa 30 días/);
    expect(items[1]).toMatch(/^Cambiar el alcance de casa a globalagent-memoryrepo:github\.com\/ejemplo\/repo\+ no validadas/);
    expect(items[2]).toMatch(/^código de enlace nuevo/);
  });

  it("muestra el error del servicio sin inventar un estado", async () => {
    const cliente: Cliente = async () => {
      throw new ErrorApi("solo_persona", "«remoto_estado» lo hace la persona desde la web");
    };
    render(<Remoto cliente={cliente} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/lo hace la persona/);
  });

  it("con un servicio de una versión anterior (sin nombre_pc) avisa y no le pide operaciones nuevas", async () => {
    const llamadas: string[] = [];
    const viejo: Cliente = async <T,>(op: string): Promise<T> => {
      llamadas.push(op);
      if (op === "remoto_estado") return { interruptor: true, rele: { url: "wss://rele.ejemplo" }, codigo: null, dispositivos: [], enlaces: [{ origen: "casa", vence_en: "2026-12-01T00:00:00Z" }] } as T;
      throw new ErrorApi("desconocida", "operación desconocida");
    };
    render(<Remoto cliente={viejo} />);
    expect((await screen.findByRole("alert")).textContent).toContain("versión anterior");
    expect(llamadas).not.toContain("remoto_rele_probar");
  });
});
