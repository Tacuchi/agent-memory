import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type OpcionesStore } from "../../src/store/store.js";

export function dirTemporal(prefijo = "agent-memory-test-"): { dir: string; limpiar: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefijo));
  return { dir, limpiar: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Almacén sobre un archivo SQLite temporal, con reloj controlable. */
export function storeTemporal(opciones: OpcionesStore = {}) {
  const { dir, limpiar } = dirTemporal();
  let ahora = new Date("2026-11-09T12:00:00");
  const store = MemoryStore.abrir(join(dir, "memoria.db"), { reloj: () => ahora, ...opciones });
  return {
    store,
    dir,
    avanzar(ms: number) {
      ahora = new Date(ahora.getTime() + ms);
    },
    fijar(fecha: Date) {
      ahora = fecha;
    },
    cerrar() {
      store.close();
      limpiar();
    },
  };
}

export const REPO = "github.com/ejemplo/repo-sintetico";
export const PROYECTO = "proyecto:sintetico";
