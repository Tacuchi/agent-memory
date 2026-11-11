import "./dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorApi, type Cliente } from "../../web/src/api";
import { Remoto } from "../../web/src/pantallas/Remoto";

afterEach(() => cleanup());

const AHORA = new Date("2026-11-10T12:00:00Z").getTime();
const CLAVE_RELE = "clave-secreta-del-rele";

function dispositivo(id: number, nombre: string, extra: object = {}) {
  return {
    id,
    nombre,
    enlazado_en: "2026-11-01T10:00:00.000Z",
    usado_en: "2026-11-09T18:30:00.000Z",
    vence_en: "2026-12-01T10:00:00.000Z",
    revocado_en: null,
    estado: "vigente",
    alcance: { ambitos: [] as object[], no_validadas: false },
    ...extra,
  };
}

/** Cliente falso con el estado de una PC: registra cada operación con su cuerpo. */
function clienteFalso(inicio: { interruptor?: boolean; rele?: { url: string } | null; prueba?: string; pendientes?: boolean } = {}) {
  const llamadas: [string, object][] = [];
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
    dispositivos: [
      dispositivo(1, "casa", { alcance: { ambitos: [{ ambito: "global", ref: null }], no_validadas: false } }),
      dispositivo(2, "Laptop trabajo"),
      dispositivo(3, "vieja", { estado: "revocado", revocado_en: "2026-11-05T10:00:00.000Z" }),
    ] as any[],
    enlaces: [
      { origen: "mac-personal", nombre: "Mac personal", enlazado_en: "2026-11-02T10:00:00.000Z", vence_en: "2026-12-02T10:00:00.000Z", usado_en: "2026-11-10T09:00:00.000Z" },
    ] as any[],
  };
  let prueba = inicio.prueba ?? "responde";
  const registro = [
    { id: 3, fecha: "2026-11-09T11:00:00.000Z", dispositivo_id: 1, dispositivo: "casa", herramienta: "buscar", pedido: null, ids: [1], resultado: "lectura", motivo: null },
    { id: 2, fecha: "2026-11-10T11:59:00.000Z", dispositivo_id: 1, dispositivo: "casa", herramienta: "aprobar", pedido: null, ids: [], resultado: "rechazo", motivo: "operacion_no_permitida" },
    { id: 1, fecha: "2026-11-10T11:58:00.000Z", dispositivo_id: 1, dispositivo: "casa", herramienta: "buscar", pedido: '{"consulta":"deploy"}', ids: [7, 9], resultado: "lectura", motivo: null },
  ];
  const porId = (id: number) => estado.dispositivos.find((d) => d.id === id);
  const cliente: Cliente = async <T,>(op: string, cuerpo: object = {}): Promise<T> => {
    llamadas.push([op, cuerpo]);
    const c = cuerpo as any;
    switch (op) {
      case "remoto_estado":
        return structuredClone(estado) as T;
      case "remoto_interruptor":
        estado.interruptor = c.encendido;
        return structuredClone(estado) as T;
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
        return { dispositivo: porId(c.id) } as T;
      case "remoto_revocar":
        porId(c.id).estado = "revocado";
        porId(c.id).revocado_en = new Date(AHORA).toISOString();
        return { dispositivo: porId(c.id) } as T;
      case "remoto_renovar":
        return { dispositivo: porId(c.id) } as T;
      case "remoto_nombre":
        estado.nombre_pc = c.nombre;
        return structuredClone(estado) as T;
      case "remoto_canjear":
        if (c.codigo === "USADO") throw new ErrorApi("codigo_usado", "ese código ya se usó: pedí uno nuevo en la otra PC");
        estado.enlaces.push({ origen: "laptop-trabajo", nombre: "Laptop trabajo", enlazado_en: new Date(AHORA).toISOString(), vence_en: "2026-12-10T12:00:00.000Z", usado_en: null });
        return { origen: "laptop-trabajo", nombre: "Laptop trabajo", vence_en: "2026-12-10T12:00:00.000Z" } as T;
      case "remoto_enlace_quitar":
        estado.enlaces = estado.enlaces.filter((e) => e.origen !== c.origen);
        return { ok: true } as T;
      case "remoto_enlace_renombrar":
        estado.enlaces.find((e) => e.origen === c.origen).origen = c.nuevo;
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
      case "remoto_registro":
        return { registro: registro.filter((r) => (!c.solo_rechazos || r.resultado === "rechazo") && (c.dispositivo_id === undefined || r.dispositivo_id === c.dispositivo_id)) } as T;
      default:
        throw new ErrorApi("ruta_desconocida", op);
    }
  };
  return { cliente, llamadas, estado };
}

const ops = (llamadas: [string, object][]) => llamadas.map(([op]) => op);
const leen = () => screen.getByRole("region", { name: "Leen esta memoria" });
const lee = () => screen.getByRole("region", { name: "Esta PC lee" });
const item = (lista: HTMLElement, texto: string) => within(lista).getByText(texto).closest("li") as HTMLElement;

async function montar(f = clienteFalso()) {
  render(<Remoto cliente={f.cliente} ahora={() => AHORA} />);
  await screen.findByRole("region", { name: "Leen esta memoria" });
  return f;
}

describe("pantalla «Acceso remoto»", () => {
  it("dibuja la barra «Esta PC» y las dos columnas, en ese orden, con PCs y enlaces (AC-01)", async () => {
    await montar();
    const barra = screen.getByRole("group", { name: "Esta PC" });
    const columnas = [leen(), lee()];
    expect(barra.compareDocumentPosition(columnas[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(columnas[0]!.compareDocumentPosition(columnas[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(barra).getByText("mac-de-prueba")).toBeTruthy();
    expect(await within(barra).findByText("responde")).toBeTruthy();
    expect(within(barra).getByText("conectado")).toBeTruthy();

    const lectoras = within(leen()).getByRole("list", { name: "PCs que leen esta memoria" });
    expect(within(lectoras).getAllByRole("listitem").map((li) => li.querySelector(".item-nombre")!.textContent)).toEqual(["casa", "Laptop trabajo"]);
    const enlace = item(within(lee()).getByRole("list", { name: "Memorias que lee esta PC" }), "Mac personal");
    expect(within(enlace).getByText("mac-personal").tagName).toBe("CODE");
    expect(enlace.textContent).toMatch(/última lectura 2026-11-10 · vence 2026-12-02/);
  });

  it("invitar con alcance manda remoto_codigo con los ámbitos marcados y muestra el código grande (AC-02)", async () => {
    const f = await montar();
    fireEvent.click(within(leen()).getByRole("button", { name: "Invitar una PC" }));
    const invitar = within(leen()).getByRole("group", { name: "Invitar una PC" });
    fireEvent.click(await within(invitar).findByRole("checkbox", { name: /Global/ }));
    fireEvent.click(within(invitar).getByRole("checkbox", { name: /agent-memory/ }));
    expect(within(invitar).getByLabelText("40 entradas")).toBeTruthy();
    fireEvent.click(within(invitar).getByRole("button", { name: "Generar código" }));

    expect((await screen.findByLabelText("Código de enlace")).textContent).toBe("ABCD-EFGH-JKMN-PQRS");
    expect(f.llamadas).toContainEqual(["remoto_codigo", { ambitos: [{ ambito: "global", ref: null }, { ambito: "proyecto", ref: "agent-memory" }], no_validadas: false }]);
    expect(screen.getByRole("timer").textContent).toBe("Vence en 10:00");
    const codigo = screen.getByRole("group", { name: "Código para enlazar" });
    expect(codigo.textContent).toContain("En la otra PC: Acceso remoto → Pegar un código");
    expect(within(codigo).getByText("agent-memory remote link ABCD-EFGH-JKMN-PQRS")).toBeTruthy();
    expect(within(codigo).getByRole("button", { name: "Copiar" })).toBeTruthy();
  });

  it("pegar un código manda remoto_canjear sin pedir nombre y muestra con qué nombre e identificador quedó (AC-04)", async () => {
    const f = await montar();
    fireEvent.click(within(lee()).getByRole("button", { name: "Pegar un código" }));
    const form = within(lee()).getByRole("form", { name: "Pegar un código" });
    expect(within(form).getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(within(form).getByRole("textbox", { name: "Código de la otra PC" }), { target: { value: " WXYZ-1234 " } });
    fireEvent.click(within(form).getByRole("button", { name: "Enlazar" }));
    expect((await within(lee()).findByRole("status")).textContent).toBe("Ahora leés «Laptop trabajo» como «laptop-trabajo».");
    expect(f.llamadas).toContainEqual(["remoto_canjear", { codigo: "WXYZ-1234" }]);
    expect(within(lee()).queryByRole("form", { name: "Pegar un código" })).toBeNull();
    expect(item(within(lee()).getByRole("list"), "Laptop trabajo").textContent).toContain("laptop-trabajo");
  });

  it("el error del canje aparece junto al formulario y lo deja abierto", async () => {
    await montar();
    fireEvent.click(within(lee()).getByRole("button", { name: "Pegar un código" }));
    fireEvent.change(within(lee()).getByRole("textbox", { name: "Código de la otra PC" }), { target: { value: "USADO" } });
    fireEvent.click(within(lee()).getByRole("button", { name: "Enlazar" }));
    expect((await within(lee()).findByRole("alert")).textContent).toBe("ese código ya se usó: pedí uno nuevo en la otra PC");
    expect(within(lee()).getByRole("form", { name: "Pegar un código" })).toBeTruthy();
  });

  it("quitar un enlace pide confirmación antes de llamar al servicio (AC-07)", async () => {
    const f = await montar();
    fireEvent.click(within(lee()).getByRole("button", { name: "Quitar mac-personal" }));
    expect(ops(f.llamadas)).not.toContain("remoto_enlace_quitar");
    const confirmar = within(lee()).getByRole("group", { name: "Quitar mac-personal" });
    fireEvent.click(within(confirmar).getByRole("button", { name: "Cancelar" }));
    expect(within(lee()).queryByRole("group", { name: "Quitar mac-personal" })).toBeNull();

    fireEvent.click(within(lee()).getByRole("button", { name: "Quitar mac-personal" }));
    fireEvent.click(within(within(lee()).getByRole("group", { name: "Quitar mac-personal" })).getByRole("button", { name: "Quitar mac-personal" }));
    await within(lee()).findByText("Esta PC no lee ninguna otra memoria.");
    expect(f.llamadas).toContainEqual(["remoto_enlace_quitar", { origen: "mac-personal" }]);
  });

  it("renombra el identificador de un enlace y valida su forma (AC-07)", async () => {
    const f = await montar();
    fireEvent.click(within(lee()).getByRole("button", { name: "Renombrar mac-personal" }));
    const campo = within(lee()).getByRole("textbox", { name: "Identificador para los agentes" });
    fireEvent.change(campo, { target: { value: "Mac Casa" } });
    expect((within(lee()).getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(campo, { target: { value: "mac-casa" } });
    fireEvent.click(within(lee()).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_enlace_renombrar", { origen: "mac-personal", nuevo: "mac-casa" }]));
    expect(await within(lee()).findByText("mac-casa")).toBeTruthy();
  });

  it("revocar pide confirmación; las revocadas quedan agrupadas y plegadas al final (AC-08)", async () => {
    const f = await montar();
    const revocadas = within(leen()).getByText("Revocadas").closest("details") as HTMLDetailsElement;
    expect(revocadas.open).toBe(false);
    expect(within(revocadas).getByText("vieja")).toBeTruthy();

    fireEvent.click(within(leen()).getByRole("button", { name: "Revocar casa" }));
    expect(ops(f.llamadas)).not.toContain("remoto_revocar");
    fireEvent.click(within(within(leen()).getByRole("group", { name: "Revocar casa" })).getByRole("button", { name: "Revocar casa" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_revocar", { id: 1 }]));
    await waitFor(() => expect(within(revocadas).getByText("casa")).toBeTruthy());
    expect(within(within(leen()).getByRole("list", { name: "PCs que leen esta memoria" })).queryByText("casa")).toBeNull();
  });

  it("una PC sin alcance lo dice y lleva al editor de casillas, que manda remoto_alcance", async () => {
    const f = await montar();
    const laptop = item(within(leen()).getByRole("list", { name: "PCs que leen esta memoria" }), "Laptop trabajo");
    expect(within(laptop).getByText("sin alcance: no ve nada")).toBeTruthy();
    fireEvent.click(within(laptop).getByRole("button", { name: "Elegir el alcance de Laptop trabajo" }));
    const editor = within(laptop).getByRole("group", { name: "Editar alcance de Laptop trabajo" });
    fireEvent.click(await within(editor).findByRole("checkbox", { name: /finanzas/ }));
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Incluir no validadas" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Guardar alcance" }));
    await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_alcance", { id: 2, ambitos: [{ ambito: "proyecto", ref: "finanzas" }], no_validadas: true }]));
    await waitFor(() => expect(within(laptop).queryByText("sin alcance: no ve nada")).toBeNull());
    expect(within(laptop).getByText("finanzas")).toBeTruthy();
  });

  it("el editor de alcance arranca con lo que la PC ya ve marcado", async () => {
    await montar();
    const casa = item(within(leen()).getByRole("list", { name: "PCs que leen esta memoria" }), "casa");
    fireEvent.click(within(casa).getByRole("button", { name: "Alcance de casa" }));
    expect(((await within(casa).findByRole("checkbox", { name: /Global/ })) as HTMLInputElement).checked).toBe(true);
    expect((within(casa).getByRole("checkbox", { name: /agent-memory/ }) as HTMLInputElement).checked).toBe(false);
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

  it("con el acceso apagado atenúa «Leen esta memoria» y avisa; «Esta PC lee» sigue operativa (AC-11)", async () => {
    const f = await montar();
    expect(leen().className).not.toContain("apagada");
    fireEvent.click(screen.getByRole("switch", { name: "Acceso" }));
    await waitFor(() => expect(leen().className).toContain("apagada"));
    expect(f.llamadas).toContainEqual(["remoto_interruptor", { encendido: false }]);
    expect(within(leen()).getByRole("note").textContent).toContain("Acceso apagado: nadie puede leer");
    expect((within(leen()).getByRole("button", { name: "Invitar una PC" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(lee()).getByRole("button", { name: "Pegar un código" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Acceso" }).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("apagado")).toBeTruthy();
  });

  it("el registro arranca plegado con el resumen de hoy y se despliega con sus filtros (AC-15)", async () => {
    const f = await montar();
    const registro = screen.getByRole("region", { name: "Registro" });
    const plegable = registro.querySelector("details")!;
    expect(plegable.open).toBe(false);
    await waitFor(() => expect(registro.querySelector(".resumen-hoy")!.textContent).toBe("hoy: 1 lectura · 1 rechazo"));

    fireEvent.click(within(registro).getByText("Registro"));
    expect(plegable.open).toBe(true);
    const tabla = within(registro).getByRole("table", { name: "Registro remoto" });
    expect(within(tabla).getByText('{"consulta":"deploy"}')).toBeTruthy();
    expect(within(tabla).getByText("rechazo: operacion_no_permitida")).toBeTruthy();
    fireEvent.click(within(registro).getByRole("checkbox", { name: "solo rechazos" }));
    await waitFor(() => expect(within(within(registro).getByRole("table")).queryByText("7, 9")).toBeNull());
    expect(f.llamadas).toContainEqual(["remoto_registro", { solo_rechazos: true }]);
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

  it("aceptar un pedido de código lo muestra en «Leen esta memoria»; rechazar los demás vacía la sección", async () => {
    const f = await montar(clienteFalso({ pendientes: true }));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: código de enlace nuevo" }));
    expect((await within(leen()).findByLabelText("Código de enlace")).textContent).toBe("PANE-LCOD-IGO0-1234");
    expect(screen.getByRole("timer").textContent).toBe("Vence en 5:00");
    expect(f.llamadas).toContainEqual(["remoto_pendiente", { id: 13, aceptar: true }]);

    for (const id of [11, 12]) {
      fireEvent.click(screen.getAllByRole("button", { name: /^Rechazar:/ })[0]!);
      await waitFor(() => expect(f.llamadas).toContainEqual(["remoto_pendiente", { id, aceptar: false }]));
    }
    await waitFor(() => expect(screen.queryByRole("list", { name: "Pedidos del panel" })).toBeNull());
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
      if (op === "remoto_registro") return { registro: [] } as T;
      throw new ErrorApi("desconocida", "operación desconocida");
    };
    render(<Remoto cliente={viejo} />);
    expect((await screen.findByRole("alert")).textContent).toContain("versión anterior");
    // Sin nombre de la otra PC, el título es su identificador y se explica por qué.
    const titulo = lee().querySelector(".item-nombre")!;
    expect(titulo.tagName).toBe("CODE");
    expect(titulo.textContent).toBe("casa");
    expect(within(lee()).getByText("PC de una versión anterior: no comunica su nombre")).toBeTruthy();
    expect(within(lee()).queryByText(/los agentes la consultan como/)).toBeNull();
    expect(llamadas).not.toContain("remoto_rele_probar");
  });
});
