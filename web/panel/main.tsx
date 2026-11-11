import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiHttp, type ApiPanel } from "./api";
import { App } from "./App";
import "./estilos.css";

async function api(): Promise<ApiPanel> {
  // En desarrollo, ?muestra usa el estado de muestra en vez del relé; el build no lo incluye.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("muestra")) {
    return (await import("./fixture")).apiDeMuestra();
  }
  return apiHttp();
}

const raiz = document.getElementById("raiz");
if (raiz) {
  void api().then((a) =>
    createRoot(raiz).render(
      <StrictMode>
        <App api={a} />
      </StrictMode>,
    ),
  );
}
