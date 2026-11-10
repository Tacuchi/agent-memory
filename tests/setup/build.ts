import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Compila `dist/` una sola vez, antes de que arranquen los workers: las pruebas que lanzan el bin
// nunca lo leen mientras otro worker lo reescribe.
export default function setup(): void {
  const raiz = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync(process.execPath, [`${raiz}node_modules/typescript/bin/tsc`, "-p", `${raiz}tsconfig.build.json`], { stdio: "inherit" });
}
