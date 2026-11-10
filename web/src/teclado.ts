import { useEffect, useRef } from "react";

/** Mientras se escribe en un campo, las letras son texto, no atajos. */
function esEditable(objetivo: EventTarget | null): boolean {
  if (!(objetivo instanceof HTMLElement)) return false;
  return objetivo.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(objetivo.tagName);
}

/**
 * Atajos: tecla → acción. Se ignoran con modificadores y dentro de campos, salvo Escape, que saca
 * el foco del campo para volver a navegar con el teclado. Una acción que devuelve `false` no tomó
 * la tecla y la deja pasar. Con `primero`, el atajo escucha antes que los de cada pantalla (así
 * «g p» de la carcasa gana sobre la «p» de una pantalla).
 */
export function useAtajos(mapa: Record<string, () => boolean | void>, opciones: { activo?: boolean; primero?: boolean } = {}) {
  const { activo = true, primero = false } = opciones;
  const actual = useRef(mapa);
  actual.current = mapa;
  useEffect(() => {
    if (!activo) return;
    function alPulsar(evento: KeyboardEvent) {
      if (evento.metaKey || evento.ctrlKey || evento.altKey || evento.defaultPrevented) return;
      if (esEditable(evento.target)) {
        if (evento.key === "Escape") (evento.target as HTMLElement).blur();
        return;
      }
      // Enter sobre un botón o enlace es su propio clic, no el atajo de la pantalla.
      if (evento.key === "Enter" && evento.target instanceof HTMLElement && evento.target.closest("button, a, summary")) return;
      const accion = actual.current[evento.key];
      if (!accion || accion() === false) return;
      evento.preventDefault();
    }
    window.addEventListener("keydown", alPulsar, primero);
    return () => window.removeEventListener("keydown", alPulsar, primero);
  }, [activo, primero]);
}

/** Índice del siguiente elemento al moverse con j/k, sin salirse de la lista. */
export function mover(indice: number, delta: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(total - 1, Math.max(0, indice + delta));
}
