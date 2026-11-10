import { JSDOM } from "jsdom";

// DOM de jsdom sobre el entorno node de vitest: así la web se prueba contra la API real, que usa
// node:sqlite (el entorno «jsdom» de vitest la trataría como código de navegador). Se importa
// primero, antes que @testing-library/react.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/", pretendToBeVisual: true });
const global = globalThis as Record<string, unknown>;
const ventana = dom.window as unknown as Record<string, unknown>;
global.window = dom.window;
global.document = dom.window.document;
for (const clave of Object.getOwnPropertyNames(ventana)) {
  if (clave in global) continue;
  Object.defineProperty(global, clave, { configurable: true, get: () => ventana[clave] });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
