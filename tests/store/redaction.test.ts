import { afterEach, describe, expect, it } from "vitest";
import { MARCA, redactar } from "../../src/domain/redact.js";
import { REPO, storeTemporal } from "../helpers/temp.js";

// Valores sintéticos con el formato de cada secreto: ninguno es real.
const CASOS: [string, string][] = [
  ["clave_privada_pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"],
  ["aws_access_key", "AKIAABCDEFGHIJKLMNOP"],
  ["github_token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["github_token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
  ["clave_sk", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
  ["clave_sk", "sk-proj-abcdefghijklmnop0123456789"],
  ["slack_token", "xoxb-123456789012-abcdefghijkl"],
  ["google_api_key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaW50ZXRpY28ifQ.c2luLWZpcm1hLXJlYWwtMTIz"],
  ["credencial_en_url", "postgres://usuario:clave-sintetica-123@localhost:5432/db"],
  ["asignacion_secreta", "password=hunter2-sintetico"],
  ["asignacion_secreta", "API_KEY: 'valor-sintetico-xyz'"],
  ["asignacion_secreta", "token = abc123sintetico"],
];

describe("redacción de secretos", () => {
  it.each(CASOS)("redacta %s sin dejar el valor", (tipo, secreto) => {
    const { texto, redactados } = redactar(`antes ${secreto} después`);
    expect(redactados).toContain(tipo);
    expect(texto).toContain(MARCA);
    expect(texto).toMatch(/^antes /);
    const valor = secreto.split(/[=:@]/).at(-1)?.replace(/['"]/g, "").trim() ?? secreto;
    expect(texto).not.toContain(tipo === "credencial_en_url" ? "clave-sintetica-123" : valor.slice(0, 12));
  });

  it("no toca el texto sin secretos", () => {
    const texto = "Usar `npm run build` con el token del archivo 0600; ver sk- en la doc.";
    expect(redactar(texto)).toEqual({ texto, redactados: [] });
  });

  let t: ReturnType<typeof storeTemporal>;
  afterEach(() => t?.cerrar());

  it("el almacén redacta antes de guardar y avisa los tipos, sin el valor, también en revisiones", async () => {
    t = storeTemporal();
    const { entrada, redactados } = await t.store.crear(
      { tipo: "referencia", titulo: "Acceso de prueba", contenido: "usar ghp_abcdefghijklmnopqrstuvwxyz0123456789 y password=secreto-sintetico", ambito: "repo", ambitoRef: REPO },
      { actor: "agente" },
    );
    expect(redactados.sort()).toEqual(["asignacion_secreta", "github_token"]);
    expect(JSON.stringify(redactados)).not.toContain("ghp_");
    expect(entrada.contenido).not.toContain("ghp_abc");
    expect(entrada.contenido).not.toContain("secreto-sintetico");
    const crudo = JSON.stringify(t.store.db.prepare("SELECT * FROM revisiones").all());
    expect(crudo).not.toContain("secreto-sintetico");

    const { redactados: alEditar } = await t.store.editar(entrada.id, { contenido: "clave AKIAABCDEFGHIJKLMNOP" }, { actor: "agente" });
    expect(alEditar).toEqual(["aws_access_key"]);
  });
});
