import type { Database } from "../db/driver.js";
import { AMBITOS, ReglaError } from "../domain/types.js";
import type { Alcance } from "../store/filters.js";
import { generarIdentidad, type IdentidadGuardada } from "./canal.js";

// Tablas del enlace remoto (migración 3). Solo esta capa las toca.

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
}

export interface Codigo {
  id: number;
  buzon: string;
  huella: string;
  venceEn: string;
  intentos: number;
  usadoEn: string | null;
  creadoEn: string;
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

  rele(): Rele | null {
    const valor = this.ajuste("rele");
    return valor ? (JSON.parse(valor) as Rele) : null;
  }

  fijarRele(rele: Rele): void {
    this.fijarAjuste("rele", JSON.stringify(rele));
  }

  // ── Códigos (dueña) ──────────────────────────────────────────────────────────

  crearCodigo(buzon: string, huella: string): Codigo {
    const ahora = this.reloj();
    const id = Number(
      this.db
        .prepare("INSERT INTO remoto_codigos (buzon, huella, vence_en, creado_en) VALUES (?, ?, ?, ?)")
        .run(buzon, huella, new Date(ahora.getTime() + VIDA_CODIGO_MS).toISOString(), ahora.toISOString()).lastInsertRowid,
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

  crearDispositivo(nombre: string, clavePublica: string, buzon: string): Dispositivo {
    const ahora = this.reloj();
    const existente = this.db.prepare("SELECT id FROM remoto_dispositivos WHERE clave_publica = ?").get(clavePublica) as { id: number } | undefined;
    if (existente) throw new ReglaError("ya_enlazado", "esa instalación ya está enlazada: revocala antes de volver a enlazarla");
    const id = Number(
      this.db
        .prepare("INSERT INTO remoto_dispositivos (nombre, clave_publica, buzon, enlazado_en, vence_en) VALUES (?, ?, ?, ?, ?)")
        .run(nombre, clavePublica, buzon, ahora.toISOString(), new Date(ahora.getTime() + VIDA_CREDENCIAL_MS).toISOString()).lastInsertRowid,
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
    for (const a of alcance.ambitos) {
      if (!AMBITOS.includes(a.ambito)) throw new ReglaError("ambito_invalido", `ámbito desconocido: ${String(a.ambito)}`);
      if ((a.ambito === "global") !== (a.ref === null)) throw new ReglaError("ambito_invalido", "global va sin referencia; proyecto y repo, con la suya");
    }
    this.db
      .prepare("UPDATE remoto_dispositivos SET alcance = ? WHERE id = ?")
      .run(JSON.stringify({ ambitos: alcance.ambitos, no_validadas: alcance.noValidadas }), id);
    return this.dispositivo(id);
  }

  marcarUso(id: number): void {
    this.db.prepare("UPDATE remoto_dispositivos SET usado_en = ? WHERE id = ?").run(this.ahora(), id);
  }

  // ── Enlaces (lectora) ────────────────────────────────────────────────────────

  guardarEnlace(e: Omit<Enlace, "id" | "creadoEn">): Enlace {
    if (this.enlace(e.origen)) throw new ReglaError("origen_repetido", `ya hay un enlace llamado «${e.origen}»`);
    this.db
      .prepare("INSERT INTO remoto_enlaces (origen, buzon, clave_duena, enlace_id, vence_en, creado_en) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.origen, e.buzon, e.claveDuena, e.enlaceId, e.venceEn, this.ahora());
    return this.enlace(e.origen) as Enlace;
  }

  enlace(origen: string): Enlace | null {
    const f = this.db.prepare("SELECT * FROM remoto_enlaces WHERE origen = ?").get(origen) as FilaEnlace | undefined;
    return f ? enlaceDe(f) : null;
  }

  enlaces(): Enlace[] {
    return (this.db.prepare("SELECT * FROM remoto_enlaces ORDER BY id").all() as unknown as FilaEnlace[]).map(enlaceDe);
  }

  // ── Registro (dueña) ─────────────────────────────────────────────────────────

  registrar(r: Omit<RegistroRemoto, "id" | "fecha">): void {
    this.db
      .prepare(
        "INSERT INTO remoto_registro (fecha, dispositivo_id, dispositivo, herramienta, pedido, ids, resultado, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.ahora(), r.dispositivoId, r.dispositivo, r.herramienta, r.pedido, JSON.stringify(r.ids), r.resultado, r.motivo);
  }

  registro(filtro: { dispositivoId?: number; soloRechazos?: boolean; limite?: number } = {}): RegistroRemoto[] {
    const partes: string[] = [];
    const params: (string | number)[] = [];
    if (filtro.dispositivoId !== undefined) {
      partes.push("dispositivo_id = ?");
      params.push(filtro.dispositivoId);
    }
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
  return { id: f.id, buzon: f.buzon, huella: f.huella, venceEn: f.vence_en, intentos: f.intentos, usadoEn: f.usado_en, creadoEn: f.creado_en };
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
  return { id: f.id, origen: f.origen, buzon: f.buzon, claveDuena: f.clave_duena, enlaceId: f.enlace_id, venceEn: f.vence_en, creadoEn: f.creado_en };
}
