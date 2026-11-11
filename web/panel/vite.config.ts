import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// El panel del relé se compila a estáticos en dist/panel y el relé los sirve en /dashboard detrás
// de Cloudflare Access: sin CDN, sin fuentes externas y sin analítica.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../../dist/panel", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
