import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { transaction } from "../db/driver.js";
import { estaVencida, validarTexto } from "../domain/rules.js";
import { ReglaError, TIPOS, type Entrada } from "../domain/types.js";
import type { MemoryStore, NuevaEntrada } from "../store/store.js";
import { leerPaquete, TOPES_IMPORTACION, type AmbitoElegido, type EntradaPaquete } from "./formato.js";
import { leerZip } from "./zip.js";

// Importar es fusionar, no restaurar. `importar` valida el zip y deja sus entradas en espera sin tocar la memoria; el
// agente resuelve cada una (crear, fusionar con una existente o descartar). Las reglas para zips de terceros viven
// aquí y no en la skill: todo lo creado nace pendiente, con el ámbito que eligió quien importa y la marca de la
// importación; fusionar propone un reemplazo que solo surte efecto al aprobarse; el texto sale de la espera al
// resolverse cada entrada; al cerrar, las relaciones del zip pasan a los ids nuevos.

export type CausaFuera = "proyecto" | "vencida" | "tipo_desconocido" | "preferencia";
export type Accion = "crear" | "fusionar" | "descartar";

export interface ResultadoImportacion {
  importacion: number | null;
  archivo: string;
  ambito: AmbitoElegido;
  en_espera: number;
  fuera: Record<CausaFuera, number>;
}

export interface Resolucion {
  importacion: number;
  entrada: number;
  accion: Accion;
  fusionarCon?: number;
  titulo?: string;
  contenido?: string;
  motivo?: string;
}

export interface OrigenImportacion {
  id: number;
  archivo: string;
  importada_en: string;
}

interface FilaImportacion {
  id: number;
  archivo: string;
  ambito: Entrada["ambito"];
  ambito_ref: string | null;
  importada_en: string;
  estado: "en_espera" | "cerrada" | "rechazada";
}

interface FilaEnEspera {
  entrada_zip: number;
  tipo: string;
  titulo: string;
  contenido: string;
}

export class Importaciones {
  constructor(private readonly store: MemoryStore) {}

  private get db() {
    return this.store.db;
  }

  /** Valida el zip (todo o nada) y deja en espera lo que puede entrar; la memoria no cambia. */
  importar(ruta: string, ambito: AmbitoElegido, conPreferencias: boolean): ResultadoImportacion {
    let tamano: number;
    try {
      const st = statSync(ruta);
      if (!st.isFile()) throw new Error("no es un archivo");
      tamano = st.size;
    } catch (error) {
      throw new ReglaError("zip_ilegible", `no se puede leer ${ruta} (${(error as Error).message}): se espera la ruta de un archivo .zip`);
    }
    if (tamano > TOPES_IMPORTACION.zip) {
      throw new ReglaError("zip_grande", `el zip pesa ${tamano} bytes; el máximo es ${TOPES_IMPORTACION.zip}`);
    }
    const zip = readFileSync(ruta);
    const paquete = leerPaquete(leerZip(zip, TOPES_IMPORTACION));
    const huella = createHash("sha256").update(zip).digest("hex");
    const ahora = this.store.ahora();
    const fuera: Record<CausaFuera, number> = { proyecto: 0, vencida: 0, tipo_desconocido: 0, preferencia: 0 };
    const entran = paquete.entradas.filter((e) => {
      const causa = causaFuera(e, conPreferencias, ahora);
      if (causa) fuera[causa]++;
      return causa === null;
    });
    const archivo = basename(ruta);
    return transaction(this.db, () => {
      const previa = this.db.prepare("SELECT id FROM importaciones WHERE huella = ? AND estado = 'en_espera'").get(huella) as { id: number } | undefined;
      if (previa) {
        throw new ReglaError("importacion_en_espera", `este zip ya está en espera como la importación ${previa.id}: pedile a tu agente que la procese`);
      }
      if (entran.length === 0) return { importacion: null, archivo, ambito, en_espera: 0, fuera };
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO importaciones (archivo, huella, ambito, ambito_ref, con_preferencias, importada_en) VALUES (?, ?, ?, ?, ?, ?)")
        .run(archivo, huella, ambito.ambito, ambito.ref, conPreferencias ? 1 : 0, ahora.toISOString());
      const id = Number(lastInsertRowid);
      const insertar = this.db.prepare("INSERT INTO importacion_entradas (importacion_id, entrada_zip, tipo, titulo, contenido) VALUES (?, ?, ?, ?, ?)");
      for (const e of entran) insertar.run(id, e.id, e.tipo, e.titulo, e.contenido);
      const ids = new Set(entran.map((e) => e.id));
      const relacionar = this.db.prepare("INSERT OR IGNORE INTO importacion_relaciones (importacion_id, origen_zip, destino_zip) VALUES (?, ?, ?)");
      for (const [a, b] of paquete.manifest.relaciones) if (ids.has(a) && ids.has(b) && a !== b) relacionar.run(id, a, b);
      return { importacion: id, archivo, ambito, en_espera: entran.length, fuera };
    });
  }

  /** Importaciones en espera, con cuántas entradas quedan y cuántas se resolvieron. */
  enEspera() {
    const filas = this.db
      .prepare(
        `SELECT i.id, i.archivo, i.ambito, i.ambito_ref, i.importada_en,
                SUM(CASE WHEN e.resolucion IS NULL THEN 1 ELSE 0 END) AS quedan,
                SUM(CASE WHEN e.resolucion IS NULL THEN 0 ELSE 1 END) AS resueltas
         FROM importaciones i JOIN importacion_entradas e ON e.importacion_id = i.id
         WHERE i.estado = 'en_espera' GROUP BY i.id ORDER BY i.id`,
      )
      .all() as (Omit<FilaImportacion, "estado"> & { quedan: number; resueltas: number })[];
    return filas.map((f) => ({ ...f, quedan: Number(f.quedan), resueltas: Number(f.resueltas) }));
  }

  /** Entradas sin resolver de una importación, desde un id del zip, con sus relaciones dentro del zip. */
  entradas(id: number, desde = 0, limite = 20) {
    const imp = this.exigirEnEspera(id);
    const filas = this.db
      .prepare(
        `SELECT entrada_zip, tipo, titulo, contenido FROM importacion_entradas
         WHERE importacion_id = ? AND resolucion IS NULL AND entrada_zip > ? ORDER BY entrada_zip LIMIT ?`,
      )
      .all(id, desde, limite) as unknown as FilaEnEspera[];
    const relaciones = this.db
      .prepare("SELECT origen_zip AS a, destino_zip AS b FROM importacion_relaciones WHERE importacion_id = ?")
      .all(id) as { a: number; b: number }[];
    const quedan = this.quedan(id);
    return {
      importacion: { id: imp.id, archivo: imp.archivo, ambito: imp.ambito, ambito_ref: imp.ambito_ref, importada_en: imp.importada_en, quedan },
      entradas: filas.map((f) => ({
        entrada: f.entrada_zip,
        tipo: f.tipo,
        titulo: f.titulo,
        contenido: f.contenido,
        relacionadas: relaciones.filter((r) => r.a === f.entrada_zip || r.b === f.entrada_zip).map((r) => (r.a === f.entrada_zip ? r.b : r.a)),
      })),
      siguiente: filas.length === limite ? (filas.at(-1) as FilaEnEspera).entrada_zip : null,
    };
  }

  async resolver(r: Resolucion) {
    const imp = this.exigirEnEspera(r.importacion);
    const fila = this.db
      .prepare("SELECT entrada_zip, tipo, titulo, contenido FROM importacion_entradas WHERE importacion_id = ? AND entrada_zip = ?")
      .get(imp.id, r.entrada) as FilaEnEspera | undefined;
    if (!fila) throw new ReglaError("entrada_desconocida", `la importación ${imp.id} no tiene la entrada ${r.entrada}`);
    if (fila.titulo === null) throw new ReglaError("entrada_ya_resuelta", `la entrada ${r.entrada} de la importación ${imp.id} ya está resuelta`);

    if (r.accion === "descartar") {
      if (r.fusionarCon !== undefined || r.titulo !== undefined || r.contenido !== undefined) throw sinCampos("descartar", "motivo");
      const motivo = (r.motivo ?? "").trim();
      if (!motivo) throw new ReglaError("motivo_requerido", "descartar exige un motivo (p. ej. «duplicada de #12»)");
      return transaction(this.db, () => {
        this.marcar(imp.id, r.entrada, "descartar", null, motivo);
        return { accion: r.accion, creada: null, redactados: [], ...this.estadoTras(imp.id) };
      });
    }

    const nueva = r.accion === "crear" ? this.paraCrear(r, fila, imp) : this.paraFusionar(r);
    let estado = { quedan: 0, cerrada: false };
    const { entrada, redactados } = await this.store.crear(nueva, { actor: "agente" }, (id) => {
      this.exigirEnEspera(imp.id);
      this.db.prepare("UPDATE entradas SET importacion_id = ? WHERE id = ?").run(imp.id, id);
      this.marcar(imp.id, r.entrada, r.accion, id, null);
      estado = this.estadoTras(imp.id);
    });
    return { accion: r.accion, creada: entrada, redactados, ...estado };
  }

  /** Rechazo de la persona: sus pendientes quedan rechazadas y lo que siga en espera, descartado. */
  rechazar(id: number, motivo: string | undefined) {
    const limpio = (motivo ?? "").trim();
    if (!limpio) throw new ReglaError("motivo_requerido", "rechazar una importación exige un motivo");
    const imp = this.obtener(id);
    if (imp.estado === "rechazada") throw new ReglaError("importacion_rechazada", `la importación ${id} ya está rechazada`);
    return transaction(this.db, () => {
      const pendientes = this.db
        .prepare("SELECT id FROM entradas WHERE importacion_id = ? AND validacion = 'pendiente' AND vida = 'activa' ORDER BY id")
        .all(id) as { id: number }[];
      for (const p of pendientes) this.store.rechazar(p.id, limpio);
      const descartadas = this.db
        .prepare(
          `UPDATE importacion_entradas SET resolucion = 'descartar', motivo = ?, titulo = NULL, contenido = NULL, resuelta_en = ?
           WHERE importacion_id = ? AND resolucion IS NULL`,
        )
        .run(limpio, this.store.ahora().toISOString(), id).changes;
      this.db.prepare("DELETE FROM importacion_relaciones WHERE importacion_id = ?").run(id);
      this.db.prepare("UPDATE importaciones SET estado = 'rechazada', cerrada_en = ? WHERE id = ?").run(this.store.ahora().toISOString(), id);
      return { importacion: id, rechazadas: pendientes.length, descartadas: Number(descartadas) };
    });
  }

  /** La importación de la que salió cada entrada, para las que vienen de un zip. */
  origenes(): Map<number, OrigenImportacion> {
    const filas = this.db
      .prepare("SELECT e.id AS entrada, i.id, i.archivo, i.importada_en FROM entradas e JOIN importaciones i ON i.id = e.importacion_id")
      .all() as unknown as ({ entrada: number } & OrigenImportacion)[];
    return new Map(filas.map(({ entrada, ...origen }) => [entrada, origen]));
  }

  private paraCrear(r: Resolucion, fila: FilaEnEspera, imp: FilaImportacion): NuevaEntrada {
    if (r.fusionarCon !== undefined || r.titulo !== undefined || r.contenido !== undefined || r.motivo !== undefined) {
      throw new ReglaError("crear_sin_cambios", "crear usa el texto del zip tal cual: para cambiarlo, fusioná con una existente o editá después");
    }
    return { tipo: fila.tipo, titulo: fila.titulo, contenido: fila.contenido, ambito: imp.ambito, ambitoRef: imp.ambito_ref };
  }

  private paraFusionar(r: Resolucion): NuevaEntrada {
    if (r.motivo !== undefined) throw sinCampos("fusionar", "fusionar_con, titulo y contenido");
    if (r.fusionarCon === undefined) {
      throw new ReglaError("fusion_sin_destino", "fusionar necesita fusionar_con: el id de la entrada local que recibe lo nuevo");
    }
    const destino = this.store.obtener(r.fusionarCon);
    if (destino.tipo === "proyecto" || destino.validacion === "rechazada" || destino.vida !== "activa") {
      throw new ReglaError(
        "fusion_no_permitida",
        `no se fusiona con la entrada ${destino.id}: se espera una entrada de conocimiento activa y no rechazada; creá o descartá la del zip`,
      );
    }
    return {
      tipo: destino.tipo,
      titulo: validarTexto("titulo", r.titulo ?? ""),
      contenido: validarTexto("contenido", r.contenido ?? ""),
      ambito: destino.ambito,
      ambitoRef: destino.ambitoRef,
      reemplazaA: destino.id,
    };
  }

  /** Marca la resolución y borra el texto en espera; falla si otra resolución ganó antes. */
  private marcar(importacion: number, entradaZip: number, accion: Accion, entradaId: number | null, motivo: string | null): void {
    const { changes } = this.db
      .prepare(
        `UPDATE importacion_entradas SET resolucion = ?, entrada_id = ?, motivo = ?, titulo = NULL, contenido = NULL, resuelta_en = ?
         WHERE importacion_id = ? AND entrada_zip = ? AND resolucion IS NULL`,
      )
      .run(accion, entradaId, motivo, this.store.ahora().toISOString(), importacion, entradaZip);
    if (Number(changes) !== 1) throw new ReglaError("entrada_ya_resuelta", `la entrada ${entradaZip} de la importación ${importacion} ya está resuelta`);
  }

  /** Cierra la importación si no queda nada en espera: las relaciones del zip pasan a los ids nuevos. */
  private estadoTras(id: number): { quedan: number; cerrada: boolean } {
    const quedan = this.quedan(id);
    if (quedan > 0) return { quedan, cerrada: false };
    const ids = new Map(
      (
        this.db
          .prepare("SELECT entrada_zip AS zip, entrada_id AS id FROM importacion_entradas WHERE importacion_id = ? AND entrada_id IS NOT NULL")
          .all(id) as { zip: number; id: number }[]
      ).map((f) => [f.zip, f.id]),
    );
    const relaciones = this.db.prepare("SELECT origen_zip AS a, destino_zip AS b FROM importacion_relaciones WHERE importacion_id = ?").all(id) as {
      a: number;
      b: number;
    }[];
    for (const { a, b } of relaciones) {
      const origen = ids.get(a);
      const destino = ids.get(b);
      if (origen !== undefined && destino !== undefined && origen !== destino) this.store.relacionar(origen, destino);
    }
    this.db.prepare("DELETE FROM importacion_relaciones WHERE importacion_id = ?").run(id);
    this.db.prepare("UPDATE importaciones SET estado = 'cerrada', cerrada_en = ? WHERE id = ?").run(this.store.ahora().toISOString(), id);
    return { quedan: 0, cerrada: true };
  }

  private quedan(id: number): number {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM importacion_entradas WHERE importacion_id = ? AND resolucion IS NULL").get(id) as { n: number };
    return Number(n);
  }

  private obtener(id: number): FilaImportacion {
    const fila = this.db.prepare("SELECT id, archivo, ambito, ambito_ref, importada_en, estado FROM importaciones WHERE id = ?").get(id) as
      | FilaImportacion
      | undefined;
    if (!fila) throw new ReglaError("importacion_desconocida", `no existe la importación ${id}`);
    return fila;
  }

  private exigirEnEspera(id: number): FilaImportacion {
    const imp = this.obtener(id);
    if (imp.estado !== "en_espera") throw new ReglaError("importacion_no_en_espera", `la importación ${id} está ${imp.estado}: no queda nada que resolver`);
    return imp;
  }
}

function causaFuera(e: EntradaPaquete, conPreferencias: boolean, ahora: Date): CausaFuera | null {
  if (e.tipo === "proyecto") return "proyecto";
  if (!(TIPOS as readonly string[]).includes(e.tipo)) return "tipo_desconocido";
  if (estaVencida(e, ahora)) return "vencida";
  if (e.tipo === "preferencia" && !conPreferencias) return "preferencia";
  return null;
}

function sinCampos(accion: Accion, admitidos: string): ReglaError {
  return new ReglaError("campos_de_mas", `${accion} solo admite ${admitidos}`);
}
