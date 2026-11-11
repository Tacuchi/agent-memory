import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Database } from "../db/driver.js";
import { AMBITOS, ReglaError } from "../domain/types.js";
import type { Alcance } from "../store/filters.js";
import { generarIdentidad, type IdentidadGuardada } from "./canal.js";

// Tablas del enlace remoto (migraciones 3 y 4). Solo esta capa las toca.

export const VIDA_CODIGO_MS = 10 * 60_000;
export const INTENTOS_CODIGO = 5;
export const VIDA_CREDENCIAL_MS = 30 * 24 * 3600_000;
/** Tras vencer o usarse, la dueña sigue escuchando el buzón del código este tiempo, para rechazar y registrar. */
export const ESCUCHA_CODIGO_MS = 24 * 3600_000;

export interface Dispositivo {
  id: number;
  nombre: string;
  clavePublica: string;
  buzon: string;
  enlazadoEn: string;
  usadoEn: string | null;
  venceEn: string;
  revocadoEn: string | null;
  alcance: Alcance;
}

export interface Enlace {
  id: number;
  origen: string;
  buzon: string;
  claveDuena: string;
  enlaceId: number;
  venceEn: string;
  creadoEn: string;
  usadoEn: string | null;
  /** Nombre configurado de la PC dueña; null si es de una versión que no lo comunica. */
  nombre: string | null;
}

/** Uso de un día, sin contenido: lecturas recibidas (dueña), hechas (lectora), bytes por el relé y rechazos. */
export interface UsoDia {
  dia: string;
  recibidas: number;
  hechas: number;
  bytes: number;
  rechazos: number;
}

/** Una consulta que esta PC hizo a otra (lectora), sin el contenido devuelto. */
export interface Consulta {
  id: number;
  fecha: string;
  huella: string;
  origen: string;
  herramienta: string;
  pedido: string | null;
  ids: number[];
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

interface FilaConsulta {
  id: number;
  fecha: string;
  huella: string;
  origen: string;
  herramienta: string;
  pedido: string | null;
  ids: string | null;
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

export type AccionPendiente = "renovar" | "alcance" | "codigo";

/** Pedido del panel del relé que amplía el acceso: espera la decisión de la persona en la web local (D01). */
export interface Pendiente {
  id: number;
  accion: AccionPendiente;
  /** Huella de la lectora afectada (renovar, alcance); null para un código. */
  objetivo: string | null;
  datos: unknown;
  creadoEn: string;
  estado: "pendiente" | "aceptado" | "rechazado";
  resueltoEn: string | null;
}

/** Huella pública de una instalación: SHA-256 de su clave estática, 22 caracteres base64url. */
export function huellaDe(clavePublica: string): string {
  return createHash("sha256").update(clavePublica).digest("base64url").slice(0, 22);
}

export const LARGO_NOMBRE_PC = 60;

export interface Codigo {
  id: number;
  buzon: string;
  huella: string;
  venceEn: string;
  intentos: number;
  usadoEn: string | null;
  creadoEn: string;
  /** Alcance con que nace el dispositivo que canjee el código; null = sin alcance. */
  alcance: Alcance | null;
}

export interface Rele {
  url: string;
  clave: string;
}

export interface RegistroRemoto {
  id: number;
  fecha: string;
  dispositivoId: number | null;
  dispositivo: string | null;
  herramienta: string;
  pedido: string | null;
  ids: number[];
  resultado: "lectura" | "rechazo";
  motivo: string | null;
}

export class DatosRemotos {
  constructor(
    private readonly db: Database,
    private readonly reloj: () => Date,
  ) {}

  private ahora(): string {
    return this.reloj().toISOString();
  }

  private ajuste(clave: string): string | null {
    return (this.db.prepare("SELECT valor FROM remoto_ajustes WHERE clave = ?").get(clave) as { valor: string } | undefined)?.valor ?? null;
  }

  private fijarAjuste(clave: string, valor: string): void {
    this.db.prepare("INSERT INTO remoto_ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(clave, valor);
  }

  /** Clave estática de esta instalación; nace la primera vez que se pide. */
  identidad(): IdentidadGuardada {
    const guardada = this.ajuste("identidad");
    if (guardada) return JSON.parse(guardada) as IdentidadGuardada;
    const nueva = generarIdentidad();
    this.fijarAjuste("identidad", JSON.stringify(nueva));
    return nueva;
  }

  interruptor(): boolean {
    return this.ajuste("interruptor") === "1";
  }

  fijarInterruptor(encendido: boolean): void {
    this.fijarAjuste("interruptor", encendido ? "1" : "0");
  }

  /** Nombre de esta PC en el panel del relé: el del equipo, salvo que la persona lo cambie. */
  nombrePc(): string {
    return this.ajuste("nombre_pc") ?? (hostname().slice(0, LARGO_NOMBRE_PC) || "pc");
  }

  fijarNombrePc(nombre: string): string {
    const limpio = nombre.trim().replace(/\s+/g, " ");
    if (!limpio || limpio.length > LARGO_NOMBRE_PC) throw new ReglaError("nombre_invalido", `el nombre de la PC va de 1 a ${LARGO_NOMBRE_PC} caracteres`);
    this.fijarAjuste("nombre_pc", limpio);
    return limpio;
  }

  rele(): Rele | null {
    const valor = this.ajuste("rele");
    return valor ? (JSON.parse(valor) as Rele) : null;
  }

  fijarRele(rele: Rele): void {
    this.fijarAjuste("rele", JSON.stringify(rele));
  }

  // ── Códigos (dueña) ──────────────────────────────────────────────────────────

  crearCodigo(buzon: string, huella: string, alcance: Alcance | null = null): Codigo {
    if (alcance) validarAlcance(alcance);
    const ahora = this.reloj();
    const id = Number(
      this.db
        .prepare("INSERT INTO remoto_codigos (buzon, huella, vence_en, creado_en, alcance) VALUES (?, ?, ?, ?, ?)")
        .run(
          buzon,
          huella,
          new Date(ahora.getTime() + VIDA_CODIGO_MS).toISOString(),
          ahora.toISOString(),
          alcance ? JSON.stringify({ ambitos: alcance.ambitos, no_validadas: alcance.noValidadas }) : null,
        ).lastInsertRowid,
    );
    return this.codigo(id) as Codigo;
  }

  codigo(id: number): Codigo | null {
    const f = this.db.prepare("SELECT * FROM remoto_codigos WHERE id = ?").get(id) as FilaCodigo | undefined;
    return f ? codigoDe(f) : null;
  }

  codigoPorBuzon(buzon: string): Codigo | null {
    const f = this.db.prepare("SELECT * FROM remoto_codigos WHERE buzon = ?").get(buzon) as FilaCodigo | undefined;
    return f ? codigoDe(f) : null;
  }

  /** Códigos cuyo buzón la dueña escucha: los creados en las últimas 24 h. */
  codigosEscuchados(): Codigo[] {
    const desde = new Date(this.reloj().getTime() - ESCUCHA_CODIGO_MS).toISOString();
    return (this.db.prepare("SELECT * FROM remoto_codigos WHERE creado_en >= ? ORDER BY id").all(desde) as unknown as FilaCodigo[]).map(codigoDe);
  }

  /** El código vivo más nuevo (para la web), o null. */
  codigoVigente(): Codigo | null {
    const f = this.db
      .prepare("SELECT * FROM remoto_codigos WHERE usado_en IS NULL AND vence_en > ? AND intentos < ? ORDER BY id DESC LIMIT 1")
      .get(this.ahora(), INTENTOS_CODIGO) as FilaCodigo | undefined;
    return f ? codigoDe(f) : null;
  }

  sumarIntento(id: number): void {
    this.db.prepare("UPDATE remoto_codigos SET intentos = intentos + 1 WHERE id = ?").run(id);
  }

  /** Marca el código usado; false si otro canje llegó antes. */
  usarCodigo(id: number): boolean {
    return this.db.prepare("UPDATE remoto_codigos SET usado_en = ? WHERE id = ? AND usado_en IS NULL").run(this.ahora(), id).changes === 1;
  }

  // ── Dispositivos (dueña) ─────────────────────────────────────────────────────

  crearDispositivo(nombre: string, clavePublica: string, buzon: string, alcance: Alcance | null = null): Dispositivo {
    const ahora = this.reloj();
    const alcanceTexto = JSON.stringify({ ambitos: alcance?.ambitos ?? [], no_validadas: alcance?.noValidadas ?? false });
    const existente = this.db.prepare("SELECT id, revocado_en FROM remoto_dispositivos WHERE clave_publica = ?").get(clavePublica) as
      | { id: number; revocado_en: string | null }
      | undefined;
    if (existente && !existente.revocado_en) throw new ReglaError("ya_enlazado", "esa instalación ya está enlazada: revocala antes de volver a enlazarla");
    if (existente) {
      // Una PC revocada que vuelve a enlazarse reusa su fila: credencial y buzón nuevos y el alcance del código nuevo
      // (vacío si no trae), como un enlace nuevo; el registro anterior queda asociado al mismo id.
      this.db
        .prepare(
          `UPDATE remoto_dispositivos SET nombre = ?, buzon = ?, enlazado_en = ?, vence_en = ?, revocado_en = NULL, usado_en = NULL,
             alcance = ? WHERE id = ?`,
        )
        .run(nombre, buzon, ahora.toISOString(), new Date(ahora.getTime() + VIDA_CREDENCIAL_MS).toISOString(), alcanceTexto, existente.id);
      return this.dispositivo(existente.id);
    }
    const id = Number(
      this.db
        .prepare("INSERT INTO remoto_dispositivos (nombre, clave_publica, buzon, enlazado_en, vence_en, alcance) VALUES (?, ?, ?, ?, ?, ?)")
        .run(nombre, clavePublica, buzon, ahora.toISOString(), new Date(ahora.getTime() + VIDA_CREDENCIAL_MS).toISOString(), alcanceTexto).lastInsertRowid,
    );
    return this.dispositivo(id);
  }

  dispositivo(id: number): Dispositivo {
    const f = this.db.prepare("SELECT * FROM remoto_dispositivos WHERE id = ?").get(id) as FilaDispositivo | undefined;
    if (!f) throw new ReglaError("no_encontrado", `no existe el dispositivo ${id}`);
    return dispositivoDe(f);
  }

  dispositivoPorBuzon(buzon: string): Dispositivo | null {
    const f = this.db.prepare("SELECT * FROM remoto_dispositivos WHERE buzon = ?").get(buzon) as FilaDispositivo | undefined;
    return f ? dispositivoDe(f) : null;
  }

  dispositivos(): Dispositivo[] {
    return (this.db.prepare("SELECT * FROM remoto_dispositivos ORDER BY id").all() as unknown as FilaDispositivo[]).map(dispositivoDe);
  }

  /** Por qué un dispositivo no puede leer ahora, o null si puede. */
  estadoDispositivo(d: Dispositivo): "revocado" | "credencial_vencida" | null {
    if (d.revocadoEn) return "revocado";
    if (d.venceEn <= this.ahora()) return "credencial_vencida";
    return null;
  }

  revocar(id: number): Dispositivo {
    this.dispositivo(id);
    this.db.prepare("UPDATE remoto_dispositivos SET revocado_en = COALESCE(revocado_en, ?) WHERE id = ?").run(this.ahora(), id);
    return this.dispositivo(id);
  }

  /** Extiende 30 días desde hoy. Un revocado no se renueva: se enlaza de nuevo. */
  renovar(id: number): Dispositivo {
    if (this.dispositivo(id).revocadoEn) throw new ReglaError("revocado", "un dispositivo revocado no se renueva: generá un código y enlazalo de nuevo");
    this.db.prepare("UPDATE remoto_dispositivos SET vence_en = ? WHERE id = ?").run(new Date(this.reloj().getTime() + VIDA_CREDENCIAL_MS).toISOString(), id);
    return this.dispositivo(id);
  }

  fijarAlcance(id: number, alcance: Alcance): Dispositivo {
    this.dispositivo(id);
    validarAlcance(alcance);
    this.db
      .prepare("UPDATE remoto_dispositivos SET alcance = ? WHERE id = ?")
      .run(JSON.stringify({ ambitos: alcance.ambitos, no_validadas: alcance.noValidadas }), id);
    return this.dispositivo(id);
  }

  /** El nombre que la lectora comunica en sus pedidos; solo escribe si cambió. */
  fijarNombreDispositivo(id: number, nombre: string): void {
    this.db.prepare("UPDATE remoto_dispositivos SET nombre = ? WHERE id = ? AND nombre <> ?").run(nombre, id, nombre);
  }

  marcarUso(id: number): void {
    this.db.prepare("UPDATE remoto_dispositivos SET usado_en = ? WHERE id = ?").run(this.ahora(), id);
  }

  // ── Enlaces (lectora) ────────────────────────────────────────────────────────

  guardarEnlace(e: Omit<Enlace, "id" | "creadoEn" | "usadoEn">): Enlace {
    if (this.enlace(e.origen)) throw new ReglaError("origen_repetido", `ya hay un enlace llamado «${e.origen}»`);
    this.db
      .prepare("INSERT INTO remoto_enlaces (origen, buzon, clave_duena, enlace_id, vence_en, creado_en, nombre) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.origen, e.buzon, e.claveDuena, e.enlaceId, e.venceEn, this.ahora(), e.nombre);
    return this.enlace(e.origen) as Enlace;
  }

  enlace(origen: string): Enlace | null {
    const f = this.db.prepare("SELECT * FROM remoto_enlaces WHERE origen = ?").get(origen) as FilaEnlace | undefined;
    return f ? enlaceDe(f) : null;
  }

  enlaces(): Enlace[] {
    return (this.db.prepare("SELECT * FROM remoto_enlaces ORDER BY id").all() as unknown as FilaEnlace[]).map(enlaceDe);
  }

  marcarUsoEnlace(origen: string): void {
    this.db.prepare("UPDATE remoto_enlaces SET usado_en = ? WHERE origen = ?").run(this.ahora(), origen);
  }

  /** Identificador libre derivado del nombre de la dueña (D01): «Laptop trabajo» → laptop-trabajo, -2 si existe. */
  origenLibre(nombre: string | null): string {
    const base = slugOrigen(nombre);
    if (!base) {
      for (let n = 1; ; n++) if (!this.enlace(`pc-${n}`)) return `pc-${n}`;
    }
    if (!this.enlace(base)) return base;
    for (let n = 2; ; n++) if (!this.enlace(`${base}-${n}`)) return `${base}-${n}`;
  }

  renombrarEnlace(origen: string, nuevo: string): Enlace {
    if (!this.enlace(origen)) throw new ReglaError("origen_desconocido", `no hay un enlace llamado «${origen}»`);
    if (origen === nuevo) return this.enlace(origen) as Enlace;
    if (this.enlace(nuevo)) throw new ReglaError("origen_repetido", `ya hay un enlace llamado «${nuevo}»`);
    this.db.prepare("UPDATE remoto_enlaces SET origen = ? WHERE origen = ?").run(nuevo, origen);
    return this.enlace(nuevo) as Enlace;
  }

  /** El nombre que la dueña comunica en sus respuestas; solo escribe si cambió. */
  fijarNombreEnlace(origen: string, nombre: string): void {
    this.db.prepare("UPDATE remoto_enlaces SET nombre = ? WHERE origen = ? AND nombre IS NOT ?").run(nombre, origen, nombre);
  }

  /** Quita un enlace de la lectora (pedido del panel o de la persona): deja de leer ese origen. */
  quitarEnlace(origen: string): boolean {
    return this.db.prepare("DELETE FROM remoto_enlaces WHERE origen = ?").run(origen).changes === 1;
  }

  // ── Consultas hechas por esta PC (lectora) ───────────────────────────────────

  registrarConsulta(c: Omit<Consulta, "id" | "fecha">): void {
    this.db
      .prepare("INSERT INTO remoto_consultas (fecha, huella, origen, herramienta, pedido, ids, resultado, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.ahora(), c.huella, c.origen, c.herramienta, c.pedido, JSON.stringify(c.ids), c.resultado, c.motivo);
  }

  consultas(huella: string, limite = 50): Consulta[] {
    const filas = this.db.prepare("SELECT * FROM remoto_consultas WHERE huella = ? ORDER BY id DESC LIMIT ?").all(huella, limite) as unknown as FilaConsulta[];
    return filas.map((f) => ({
      id: f.id,
      fecha: f.fecha,
      huella: f.huella,
      origen: f.origen,
      herramienta: f.herramienta,
      pedido: f.pedido,
      ids: f.ids ? (JSON.parse(f.ids) as number[]) : [],
      resultado: f.resultado,
      motivo: f.motivo,
    }));
  }

  /** Conteos de hoy (día UTC, como el resto de las fechas) para el resumen de cada conexión. */
  actividadHoy(): { leyo: Map<number, number>; rechazosDuena: Map<number, number>; lei: Map<string, number>; rechazosLectora: Map<string, number>; desconocidas: number } {
    const desde = `${this.ahora().slice(0, 10)}T00:00:00.000Z`;
    const leyo = new Map<number, number>();
    const rechazosDuena = new Map<number, number>();
    let desconocidas = 0;
    // Lo leído cuenta solo las cuatro lecturas; los rechazos, de cualquier herramienta (conexión, enlazar…).
    const filas = this.db
      .prepare(
        `SELECT dispositivo_id AS id, resultado, COUNT(*) AS n FROM remoto_registro
         WHERE fecha >= ? AND (resultado = 'rechazo' OR herramienta IN ('buscar','leer','listar','revisiones'))
         GROUP BY dispositivo_id, resultado`,
      )
      .all(desde) as { id: number | null; resultado: string; n: number }[];
    for (const f of filas) {
      if (f.id === null) {
        if (f.resultado === "rechazo") desconocidas += Number(f.n);
        continue;
      }
      (f.resultado === "rechazo" ? rechazosDuena : leyo).set(f.id, Number(f.n));
    }
    const lei = new Map<string, number>();
    const rechazosLectora = new Map<string, number>();
    const consultas = this.db
      .prepare("SELECT huella, resultado, COUNT(*) AS n FROM remoto_consultas WHERE fecha >= ? GROUP BY huella, resultado")
      .all(desde) as { huella: string; resultado: string; n: number }[];
    for (const f of consultas) (f.resultado === "rechazo" ? rechazosLectora : lei).set(f.huella, Number(f.n));
    return { leyo, rechazosDuena, lei, rechazosLectora, desconocidas };
  }

  // ── Uso por día (dueña y lectora) ────────────────────────────────────────────

  sumarUso(cambio: Partial<Omit<UsoDia, "dia">>): void {
    const dia = this.ahora().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO remoto_uso (dia, recibidas, hechas, bytes, rechazos) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dia) DO UPDATE SET recibidas = recibidas + excluded.recibidas, hechas = hechas + excluded.hechas,
           bytes = bytes + excluded.bytes, rechazos = rechazos + excluded.rechazos`,
      )
      .run(dia, cambio.recibidas ?? 0, cambio.hechas ?? 0, cambio.bytes ?? 0, cambio.rechazos ?? 0);
  }

  /** Los últimos `dias` días, del más viejo a hoy, con ceros donde no hubo uso. */
  uso(dias = 7): UsoDia[] {
    const hoy = this.reloj();
    const lista: UsoDia[] = [];
    for (let i = dias - 1; i >= 0; i--) {
      const dia = new Date(hoy.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      const f = this.db.prepare("SELECT * FROM remoto_uso WHERE dia = ?").get(dia) as UsoDia | undefined;
      lista.push({ dia, recibidas: f?.recibidas ?? 0, hechas: f?.hechas ?? 0, bytes: f?.bytes ?? 0, rechazos: f?.rechazos ?? 0 });
    }
    return lista;
  }

  // ── Pedidos del panel (dueña) ────────────────────────────────────────────────

  crearPendiente(accion: AccionPendiente, objetivo: string | null, datos: unknown = null): Pendiente {
    const id = Number(
      this.db
        .prepare("INSERT INTO remoto_pendientes (accion, objetivo, datos, creado_en) VALUES (?, ?, ?, ?)")
        .run(accion, objetivo, datos === null ? null : JSON.stringify(datos), this.ahora()).lastInsertRowid,
    );
    return this.pendiente(id);
  }

  pendiente(id: number): Pendiente {
    const f = this.db.prepare("SELECT * FROM remoto_pendientes WHERE id = ?").get(id) as FilaPendiente | undefined;
    if (!f) throw new ReglaError("no_encontrado", `no existe el pedido ${id}`);
    return pendienteDe(f);
  }

  pendientes(): Pendiente[] {
    return (this.db.prepare("SELECT * FROM remoto_pendientes WHERE estado = 'pendiente' ORDER BY id").all() as unknown as FilaPendiente[]).map(pendienteDe);
  }

  resolverPendiente(id: number, estado: "aceptado" | "rechazado"): Pendiente {
    if (this.pendiente(id).estado !== "pendiente") throw new ReglaError("ya_resuelto", "ese pedido ya se resolvió");
    this.db.prepare("UPDATE remoto_pendientes SET estado = ?, resuelto_en = ? WHERE id = ?").run(estado, this.ahora(), id);
    return this.pendiente(id);
  }

  // ── Registro (dueña) ─────────────────────────────────────────────────────────

  registrar(r: Omit<RegistroRemoto, "id" | "fecha">): void {
    this.db
      .prepare(
        "INSERT INTO remoto_registro (fecha, dispositivo_id, dispositivo, herramienta, pedido, ids, resultado, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.ahora(), r.dispositivoId, r.dispositivo, r.herramienta, r.pedido, JSON.stringify(r.ids), r.resultado, r.motivo);
  }

  registro(filtro: { dispositivoId?: number; dispositivoIds?: number[]; soloRechazos?: boolean; soloDesconocidas?: boolean; limite?: number } = {}): RegistroRemoto[] {
    const partes: string[] = [];
    const params: (string | number)[] = [];
    if (filtro.dispositivoId !== undefined) {
      partes.push("dispositivo_id = ?");
      params.push(filtro.dispositivoId);
    }
    if (filtro.dispositivoIds !== undefined) {
      if (!filtro.dispositivoIds.length) return [];
      partes.push(`dispositivo_id IN (${filtro.dispositivoIds.map(() => "?").join(",")})`);
      params.push(...filtro.dispositivoIds);
    }
    if (filtro.soloDesconocidas) partes.push("dispositivo_id IS NULL");
    if (filtro.soloRechazos) partes.push("resultado = 'rechazo'");
    const filas = this.db
      .prepare(`SELECT * FROM remoto_registro ${partes.length ? `WHERE ${partes.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...params, filtro.limite ?? 200) as unknown as FilaRegistro[];
    return filas.map((f) => ({
      id: f.id,
      fecha: f.fecha,
      dispositivoId: f.dispositivo_id,
      dispositivo: f.dispositivo,
      herramienta: f.herramienta,
      pedido: f.pedido,
      ids: f.ids ? (JSON.parse(f.ids) as number[]) : [],
      resultado: f.resultado as RegistroRemoto["resultado"],
      motivo: f.motivo,
    }));
  }
}

interface FilaCodigo {
  id: number;
  buzon: string;
  huella: string;
  vence_en: string;
  intentos: number;
  usado_en: string | null;
  creado_en: string;
  alcance: string | null;
}

interface FilaDispositivo {
  id: number;
  nombre: string;
  clave_publica: string;
  buzon: string;
  enlazado_en: string;
  usado_en: string | null;
  vence_en: string;
  revocado_en: string | null;
  alcance: string;
}

interface FilaEnlace {
  id: number;
  origen: string;
  buzon: string;
  clave_duena: string;
  enlace_id: number;
  vence_en: string;
  creado_en: string;
  usado_en: string | null;
  nombre: string | null;
}

interface FilaPendiente {
  id: number;
  accion: AccionPendiente;
  objetivo: string | null;
  datos: string | null;
  creado_en: string;
  estado: Pendiente["estado"];
  resuelto_en: string | null;
}

function pendienteDe(f: FilaPendiente): Pendiente {
  return {
    id: f.id,
    accion: f.accion,
    objetivo: f.objetivo,
    datos: f.datos === null ? null : (JSON.parse(f.datos) as unknown),
    creadoEn: f.creado_en,
    estado: f.estado,
    resueltoEn: f.resuelto_en,
  };
}

interface FilaRegistro {
  id: number;
  fecha: string;
  dispositivo_id: number | null;
  dispositivo: string | null;
  herramienta: string;
  pedido: string | null;
  ids: string | null;
  resultado: string;
  motivo: string | null;
}

function codigoDe(f: FilaCodigo): Codigo {
  const alcance = f.alcance ? (JSON.parse(f.alcance) as { ambitos: Alcance["ambitos"]; no_validadas: boolean }) : null;
  return {
    id: f.id,
    buzon: f.buzon,
    huella: f.huella,
    venceEn: f.vence_en,
    intentos: f.intentos,
    usadoEn: f.usado_en,
    creadoEn: f.creado_en,
    alcance: alcance ? { ambitos: alcance.ambitos, noValidadas: Boolean(alcance.no_validadas) } : null,
  };
}

function validarAlcance(alcance: Alcance): void {
  for (const a of alcance.ambitos) {
    if (!AMBITOS.includes(a.ambito)) throw new ReglaError("ambito_invalido", `ámbito desconocido: ${String(a.ambito)}`);
    if ((a.ambito === "global") !== (a.ref === null)) throw new ReglaError("ambito_invalido", "global va sin referencia; proyecto y repo, con la suya");
  }
}

/** Largo máximo de la base del identificador: deja lugar a un sufijo «-NN» dentro de los 40 de NOMBRE_ORIGEN. */
const LARGO_BASE_ORIGEN = 36;

/** «Laptop  Trabajo (Windows)» → «laptop-trabajo-windows»; "" si no queda nada utilizable. */
export function slugOrigen(nombre: string | null): string {
  if (!nombre) return "";
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LARGO_BASE_ORIGEN)
    .replace(/-+$/g, "");
}

function dispositivoDe(f: FilaDispositivo): Dispositivo {
  const alcance = JSON.parse(f.alcance) as { ambitos: Alcance["ambitos"]; no_validadas: boolean };
  return {
    id: f.id,
    nombre: f.nombre,
    clavePublica: f.clave_publica,
    buzon: f.buzon,
    enlazadoEn: f.enlazado_en,
    usadoEn: f.usado_en,
    venceEn: f.vence_en,
    revocadoEn: f.revocado_en,
    alcance: { ambitos: alcance.ambitos, noValidadas: Boolean(alcance.no_validadas) },
  };
}

function enlaceDe(f: FilaEnlace): Enlace {
  return {
    id: f.id,
    origen: f.origen,
    buzon: f.buzon,
    claveDuena: f.clave_duena,
    enlaceId: f.enlace_id,
    venceEn: f.vence_en,
    creadoEn: f.creado_en,
    usadoEn: f.usado_en ?? null,
    nombre: f.nombre ?? null,
  };
}
