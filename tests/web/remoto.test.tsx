import "./dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorApi, type Cliente } from "../../web/src/api";
import { Remoto } from "../../web/src/pantallas/Remoto";

afterEach(() => cleanup());

const AHORA = new Date("2026-11-10T12:00:00Z").getTime();

/** Cliente falso con el estado de una dueña: registra cada operación con su cuerpo. */
function clienteFalso() {
  const llamadas: [string, object][] = [];
  const estado = {
    interruptor: false,
    rele: { url: "wss://rele.ejemplo" },
    codigo: null as null | { vence_en: string; intentos_restantes: number },
    dispositivos: [] as any[],
    enlaces: [],
  };
  const registro = [
    { id: 2, fecha: "2026-11-10T11:59:00.000Z", dispositivo_id: 1, dispositivo: "casa", herramienta: "aprobar", pedido: null, ids: [], resultado: "rechazo", motivo: "operacion_no_permitida" },
    { id: 1, fecha: "2026-11-10T11:58:00.000Z", dispositivo_id: 1, dispositivo: "casa", herramienta: "buscar", pedido: '{"consulta":"deploy"}', ids: [7, 9], resultado: "lectura", motivo: null },
  ];
  const cliente: Cliente = async <T,>(op: string, cuerpo: object = {}): Promise<T> => {
    llamadas.push([op, cuerpo]);
    const c = cuerpo as any;
    switch (op) {
      case "remoto_estado":
        return structuredClone(estado) as T;
      case "remoto_interruptor":
        estado.interruptor = c.encendido;
        if (c.encendido && !estado.dispositivos.length) {
          estado.dispositivos.push({
            id: 1,
            nombre: "casa",
            enlazado_en: "2026-11-01T10:00:00.000Z",
            usado_en: "2026-11-09T18:30:00.000Z",
            vence_en: "2026-12-01T10:00:00.000Z",
            revocado_en: null,
            estado: "vigente",
            alcance: { ambitos: [], no_validadas: false },
          });
        }
        return structuredClone(estado) as T;
      case "remoto_codigo":
        if (!estado.interruptor) throw new ErrorApi("acceso_apagado", "encendé el acceso remoto");
        estado.codigo = { vence_en: new Date(AHORA + 600_000).toISOString(), intentos_restantes: 5 };
        return { codigo: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23", vence_en: new Date(AHORA + 600_000).toISOString() } as T;
      case "remoto_alcance":
        estado.dispositivos[0].alcance = { ambitos: c.ambitos, no_validadas: c.no_validadas };
        return { dispositivo: estado.dispositivos[0] } as T;
      case "remoto_revocar":
        estado.dispositivos[0].estado = "revocado";
        estado.dispositivos[0].revocado_en = new Date(AHORA).toISOString();
        return { dispositivo: estado.dispositivos[0] } as T;
      case "remoto_renovar":
        return { dispositivo: estado.dispositivos[0] } as T;
      case "remoto_registro":
        return { registro: registro.filter((r) => (!c.solo_rechazos || r.resultado === "rechazo") && (c.dispositivo_id === undefined || r.dispositivo_id === c.dispositivo_id)) } as T;
      default:
        throw new ErrorApi("ruta_desconocida", op);
    }
  };
  return { cliente, llamadas, estado };
}

const ops = (llamadas: [string, object][]) => llamadas.map(([op]) => op);

describe("pantalla «Acceso remoto»", () => {
  it("recorre el acceso de punta a punta: encender, código, dispositivo, alcance, revocar, registro y apagar", async () => {
    const f = clienteFalso();
    render(<Remoto cliente={f.cliente} ahora={() => AHORA} />);
    const interruptor = await screen.findByRole("checkbox", { name: /Acceso remoto apagado/ });
    expect((screen.getByRole("button", { name: "Generar código" }) as HTMLButtonElement).disabled).toBe(true);

    // Encender el acceso (AC-14 al revés: viene apagado).
    fireEvent.click(interruptor);
    await screen.findByRole("checkbox", { name: /Acceso remoto encendido/ });
    expect(f.llamadas).toContainEqual(["remoto_interruptor", { encendido: true }]);

    // Generar el código y ver el vencimiento.
    fireEvent.click(screen.getByRole("button", { name: "Generar código" }));
    expect((await screen.findByLabelText("Código de enlace")).textContent).toBe("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23");
    expect(screen.getByRole("timer").textContent).toBe("Vence en 10:00");

    // El dispositivo con sus cinco datos (AC-03).
    const tabla = await screen.findByRole("table", { name: "Dispositivos enlazados" });
    const fila = within(tabla).getAllByRole("row")[1] as HTMLElement;
    expect(within(fila).getAllByRole("cell").slice(0, 6).map((c) => c.textContent)).toEqual(["casa", "2026-11-01", "2026-11-09", "2026-12-01", "nada", "vigente"]);

    // Cambiar el alcance (AC-07).
    fireEvent.click(screen.getByRole("button", { name: "Editar alcance de casa" }));
    const editor = screen.getByRole("group", { name: "Alcance de casa" });
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Global" }));
    fireEvent.change(within(editor).getByLabelText(/Repos/), { target: { value: "github.com/ejemplo/repo\n" } });
    fireEvent.click(within(editor).getByRole("checkbox", { name: /no validadas/ }));
    fireEvent.click(within(editor).getByRole("button", { name: "Guardar alcance" }));
    await waitFor(() =>
      expect(f.llamadas).toContainEqual([
        "remoto_alcance",
        { id: 1, ambitos: [{ ambito: "global", ref: null }, { ambito: "repo", ref: "github.com/ejemplo/repo" }], no_validadas: true },
      ]),
    );
    await waitFor(() => expect(within(tabla).getByText("global, repo github.com/ejemplo/repo (+ no validadas)")).toBeTruthy());

    // Renovar y revocar.
    fireEvent.click(screen.getByRole("button", { name: "Renovar casa" }));
    await waitFor(() => expect(ops(f.llamadas)).toContain("remoto_renovar"));
    fireEvent.click(screen.getByRole("button", { name: "Revocar casa" }));
    await waitFor(() => expect(within(tabla).getByText("revocado")).toBeTruthy());
    expect(f.llamadas).toContainEqual(["remoto_revocar", { id: 1 }]);
    expect((screen.getByRole("button", { name: "Revocar casa" }) as HTMLButtonElement).disabled).toBe(true);

    // Lecturas y rechazos en el registro (AC-05), con filtro de rechazos.
    const registro = await screen.findByRole("table", { name: "Registro remoto" });
    expect(within(registro).getByText('{"consulta":"deploy"}')).toBeTruthy();
    expect(within(registro).getByText("7, 9")).toBeTruthy();
    expect(within(registro).getByText("rechazo: operacion_no_permitida")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "solo rechazos" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Registro remoto" })).queryByText("7, 9")).toBeNull());
    expect(f.llamadas).toContainEqual(["remoto_registro", { solo_rechazos: true }]);

    // Apagar el acceso (AC-14).
    fireEvent.click(screen.getByRole("checkbox", { name: /Acceso remoto encendido/ }));
    await screen.findByRole("checkbox", { name: /Acceso remoto apagado/ });
    expect(f.llamadas).toContainEqual(["remoto_interruptor", { encendido: false }]);
    expect(screen.queryByLabelText("Código de enlace")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/apagado/);
  });

  it("muestra el error del servicio sin inventar un estado", async () => {
    const cliente: Cliente = async () => {
      throw new ErrorApi("solo_persona", "«remoto_estado» lo hace la persona desde la web");
    };
    render(<Remoto cliente={cliente} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/lo hace la persona/);
  });
});
