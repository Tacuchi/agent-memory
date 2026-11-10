import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Compila `dist/` (servicio y web) una sola vez, antes de que arranquen los workers: las pruebas que lanzan el bin
// nunca lo leen mientras otro worker lo reescribe.
export default function setup(): void {
  const raiz = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync(process.execPath, [`${raiz}node_modules/typescript/bin/tsc`, "-p", `${raiz}tsconfig.build.json`], { stdio: "inherit" });
  // La web también: el servicio la sirve desde dist/web y las pruebas de la web la piden por HTTP.
  execFileSync(process.execPath, [`${raiz}node_modules/vite/bin/vite.js`, "build", "--config", `${raiz}web/vite.config.ts`, "--logLevel", "warn"], {
    stdio: "inherit",
    cwd: raiz,
  });
}
