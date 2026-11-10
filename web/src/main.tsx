import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { clienteHttp } from "./api";
import "./estilos.css";

const raiz = document.getElementById("raiz");
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <App cliente={clienteHttp} />
    </StrictMode>,
  );
}
