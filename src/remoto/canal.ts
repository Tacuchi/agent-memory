/**
 * Canal cifrado de extremo a extremo entre dos instalaciones, sobre un transporte que no es de confianza (el relé).
 * Solo usa primitivas de `node:crypto`.
 *
 * Protocolo `agent-memory/enlace`, versión {@link PROTOCOLO}:
 *
 * - Cada instalación tiene una clave estática X25519. La dueña conoce la de cada lectora y la lectora la de la dueña:
 *   se fijan al emparejar. El emparejamiento usa el mismo handshake, pero sin claves fijadas y con un secreto
 *   compartido (el del código, ≥100 bits).
 * - Handshake (el iniciador es la lectora; R es la dueña):
 *   1. I → R  `M1 = {p, v, modo, e: Ie, s: Is}` (JSON; claves públicas en base64url).
 *   2. R valida la versión (si no coincide, responde `{p, v, error: "version_incompatible"}` y corta) y la estática
 *      de I (en modo `enlace`, tiene que ser una lectora registrada). R → I `M2 = {p, v, e: Re, s: Rs}`.
 *   3. Las dos partes calculan `th = SHA-256(M1 ‖ M2)` sobre los bytes tal cual viajaron, y
 *      `ikm = DH(Ie,Re) ‖ DH(Is,Re) ‖ DH(Ie,Rs) ‖ secreto` (el secreto es vacío en modo `enlace`).
 *      `HKDF-SHA256(ikm, sal = th, info = "agent-memory/enlace v<v>")` da 96 bytes: clave I→R, clave R→I y clave de
 *      prueba.
 *   4. R → I `{prueba: HMAC-SHA256(kp, "duena" ‖ th)}`. I la verifica (y, en modo `enlace`, que `Rs` sea la clave
 *      fijada de la dueña) y recién entonces manda I → R `{prueba: HMAC-SHA256(kp, "lectora" ‖ th)}`.
 *   Un relé que cambia una clave efímera no puede calcular los DH; uno que cambia la estática choca con la clave
 *   fijada o, al emparejar, con el secreto. Las pruebas comparan en tiempo constante.
 * - Mensajes: `contador (8 bytes, big-endian) ‖ ChaCha20-Poly1305(clave del sentido, nonce = 0⁴ ‖ contador,
 *   aad = contador ‖ sentido)`. Cada sentido cuenta desde 0 y el receptor exige exactamente el siguiente: un mensaje
 *   alterado, repetido o fuera de orden corta la sesión con `manipulado`. El contenido es JSON.
 * - El contador no detecta que el relé corte la cola de un flujo: por eso cada pedido lleva exactamente una
 *   respuesta en un solo mensaje, y una respuesta que no llega es un error (`tiempo` o `cerrado`), nunca un vacío.
 * - Los errores en claro del handshake (`version_incompatible`, `rechazado`) no están autenticados: el relé puede
 *   forjarlos, pero solo para negar el servicio, lo que ya puede hacer cortando. Nunca se imprime su texto.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

export const PROTOCOLO = 1;
const NOMBRE = "agent-memory/enlace";
const ESPERA_HANDSHAKE_MS = 10_000;
const SENTIDO_IR = 0x01;
const SENTIDO_RI = 0x02;
/** Tope de mensajes recibidos sin leer: un relé hostil no agota la memoria de la otra punta. */
const TOPE_COLA = 64;
const CLAVE_PUBLICA = /^[A-Za-z0-9_-]{43}$/;

export type CodigoCanal =
  | "version_incompatible"
  | "manipulado"
  | "clave_distinta"
  | "prueba_invalida"
  | "rechazado"
  | "formato"
  | "tiempo"
  | "cerrado";

export class ErrorCanal extends Error {
  constructor(
    readonly codigo: CodigoCanal,
    detalle?: string,
  ) {
    super(detalle ? `${codigo}: ${detalle}` : codigo);
    this.name = "ErrorCanal";
  }
}

/** Lo que el canal necesita del transporte: mensajes binarios enteros, en orden, y un aviso de cierre. */
export interface Transporte {
  enviar(datos: Buffer): void;
  alRecibir(fn: (datos: Buffer) => void): void;
  alCerrar(fn: () => void): void;
  cerrar(): void;
}

/** Clave estática X25519 de una instalación. `publica` son los 32 bytes crudos en base64url. */
export interface Identidad {
  publica: string;
  privada: KeyObject;
}

/** Forma guardable de una identidad: la privada en JWK. */
export interface IdentidadGuardada {
  publica: string;
  privada: string;
}

export function generarIdentidad(): IdentidadGuardada {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publica: String(jwk.x), privada: JSON.stringify(jwk) };
}

export function cargarIdentidad(guardada: IdentidadGuardada): Identidad {
  const privada = createPrivateKey({ key: JSON.parse(guardada.privada) as Record<string, string>, format: "jwk" });
  const publica = String(createPublicKey(privada).export({ format: "jwk" }).x);
  if (publica !== guardada.publica) throw new Error("la identidad guardada no coincide con su clave pública");
  return { publica, privada };
}

/** Una sesión establecida: mensajes JSON cifrados en los dos sentidos. */
export interface Sesion {
  /** Clave estática del otro extremo (base64url). */
  readonly otro: string;
  enviar(mensaje: unknown): void;
  recibir(esperaMs?: number): Promise<unknown>;
  cerrar(): void;
}

interface OpcionesIniciador {
  yo: Identidad;
  /** Clave fijada de la dueña. Falta solo al emparejar, y entonces el secreto es obligatorio. */
  otro?: string;
  secreto?: Buffer;
  esperaMs?: number;
  /** Solo para probar el rechazo de versión. */
  version?: number;
}

interface OpcionesRespondedor {
  yo: Identidad;
  /** En modo `enlace`, dice si la estática de la lectora es una registrada y vigente. */
  aceptar?: (estatica: string) => boolean;
  /** Presente: se espera un emparejamiento con ese secreto y se acepta cualquier estática. */
  secreto?: Buffer;
  esperaMs?: number;
}

export async function abrirComoIniciador(t: Transporte, op: OpcionesIniciador): Promise<Sesion> {
  const emparejar = op.otro === undefined;
  if (emparejar && !op.secreto) throw new Error("emparejar exige el secreto del código");
  const cola = new Cola(t);
  try {
    const e = generateKeyPairSync("x25519");
    const m1 = codificar({ p: NOMBRE, v: op.version ?? PROTOCOLO, modo: emparejar ? "emparejar" : "enlace", e: publicaDe(e.publicKey), s: op.yo.publica });
    t.enviar(m1);
    const m2 = await cola.siguiente(op.esperaMs ?? ESPERA_HANDSHAKE_MS);
    const r = decodificar(m2);
    if (r.error === "version_incompatible") throw new ErrorCanal("version_incompatible", versionAjena(r.v));
    if (r.error !== undefined) throw new ErrorCanal("rechazado", "la dueña no aceptó la conexión");
    if (r.p !== NOMBRE || r.v !== PROTOCOLO) throw new ErrorCanal("version_incompatible", versionAjena(r.v));
    const re = clavePublica(r.e);
    const rs = clavePublica(r.s);
    if (!emparejar && r.s !== op.otro) throw new ErrorCanal("clave_distinta", "la dueña no presentó la clave fijada");
    const th = transcripcion(m1, m2);
    const ikm = Buffer.concat([dh(e.privateKey, re), dh(op.yo.privada, re), dh(e.privateKey, rs), op.secreto ?? Buffer.alloc(0)]);
    const claves = derivar(ikm, th);
    const prueba = decodificar(await cola.siguiente(op.esperaMs ?? ESPERA_HANDSHAKE_MS));
    verificarPrueba(prueba.prueba, claves.prueba, "duena", th);
    t.enviar(codificar({ prueba: hmac(claves.prueba, "lectora", th).toString("base64url") }));
    return new SesionCanal(t, cola, r.s as string, { clave: claves.ir, sentido: SENTIDO_IR }, { clave: claves.ri, sentido: SENTIDO_RI });
  } catch (error) {
    t.cerrar();
    throw error;
  }
}

export async function abrirComoRespondedor(t: Transporte, op: OpcionesRespondedor): Promise<Sesion> {
  const emparejar = op.secreto !== undefined;
  const cola = new Cola(t);
  try {
    const m1 = await cola.siguiente(op.esperaMs ?? ESPERA_HANDSHAKE_MS);
    const i = decodificar(m1);
    if (i.p !== NOMBRE || i.v !== PROTOCOLO) {
      t.enviar(codificar({ p: NOMBRE, v: PROTOCOLO, error: "version_incompatible" }));
      throw new ErrorCanal("version_incompatible", versionAjena(i.v));
    }
    if (i.modo !== (emparejar ? "emparejar" : "enlace")) {
      t.enviar(codificar({ p: NOMBRE, v: PROTOCOLO, error: "modo_incorrecto" }));
      throw new ErrorCanal("rechazado", "modo de handshake inesperado");
    }
    const ie = clavePublica(i.e);
    const is = clavePublica(i.s);
    if (!emparejar && !(op.aceptar?.(i.s as string) ?? false)) {
      t.enviar(codificar({ p: NOMBRE, v: PROTOCOLO, error: "rechazado" }));
      throw new ErrorCanal("rechazado", "lectora no registrada o sin acceso vigente");
    }
    const e = generateKeyPairSync("x25519");
    const m2 = codificar({ p: NOMBRE, v: PROTOCOLO, e: publicaDe(e.publicKey), s: op.yo.publica });
    t.enviar(m2);
    const th = transcripcion(m1, m2);
    const ikm = Buffer.concat([dh(e.privateKey, ie), dh(e.privateKey, is), dh(op.yo.privada, ie), op.secreto ?? Buffer.alloc(0)]);
    const claves = derivar(ikm, th);
    t.enviar(codificar({ prueba: hmac(claves.prueba, "duena", th).toString("base64url") }));
    const prueba = decodificar(await cola.siguiente(op.esperaMs ?? ESPERA_HANDSHAKE_MS));
    verificarPrueba(prueba.prueba, claves.prueba, "lectora", th);
    return new SesionCanal(t, cola, i.s as string, { clave: claves.ri, sentido: SENTIDO_RI }, { clave: claves.ir, sentido: SENTIDO_IR });
  } catch (error) {
    t.cerrar();
    throw error;
  }
}

class SesionCanal implements Sesion {
  private enviados = 0n;
  private esperados = 0n;

  constructor(
    private readonly t: Transporte,
    private readonly cola: Cola,
    readonly otro: string,
    private readonly envio: { clave: Buffer; sentido: number },
    private readonly recibo: { clave: Buffer; sentido: number },
  ) {}

  enviar(mensaje: unknown): void {
    if (this.cola.cerrada) throw new ErrorCanal("cerrado");
    const marco = sellar(this.envio, this.enviados, Buffer.from(JSON.stringify(mensaje), "utf8"));
    this.enviados++;
    this.t.enviar(marco);
  }

  async recibir(esperaMs = 30_000): Promise<unknown> {
    const marco = await this.cola.siguiente(esperaMs);
    try {
      const claro = abrir(this.recibo, this.esperados, marco);
      this.esperados++;
      return JSON.parse(claro.toString("utf8")) as unknown;
    } catch (error) {
      this.cola.fallar(error instanceof ErrorCanal ? error : new ErrorCanal("manipulado"));
      this.t.cerrar();
      throw error instanceof ErrorCanal ? error : new ErrorCanal("manipulado");
    }
  }

  cerrar(): void {
    this.cola.fallar(new ErrorCanal("cerrado"));
    this.t.cerrar();
  }
}

/** Cola de mensajes entrantes del transporte, leída en orden por el handshake y después por la sesión. */
class Cola {
  private readonly pendientes: Buffer[] = [];
  private espera: { ok: (b: Buffer) => void; mal: (e: Error) => void } | null = null;
  private error: ErrorCanal | null = null;

  constructor(t: Transporte) {
    t.alRecibir((datos) => {
      if (this.error) return;
      if (this.espera) {
        const { ok } = this.espera;
        this.espera = null;
        ok(datos);
      } else if (this.pendientes.length < TOPE_COLA) this.pendientes.push(datos);
      else {
        this.fallar(new ErrorCanal("formato", "demasiados mensajes sin leer"));
        t.cerrar();
      }
    });
    t.alCerrar(() => this.fallar(new ErrorCanal("cerrado")));
  }

  get cerrada(): boolean {
    return this.error !== null;
  }

  fallar(error: ErrorCanal): void {
    if (this.error) return;
    this.error = error;
    if (this.espera) {
      const { mal } = this.espera;
      this.espera = null;
      mal(error);
    }
  }

  siguiente(esperaMs: number): Promise<Buffer> {
    const listo = this.pendientes.shift();
    if (listo) return Promise.resolve(listo);
    if (this.error) return Promise.reject(this.error);
    return new Promise((ok, mal) => {
      const reloj = setTimeout(() => {
        this.espera = null;
        mal(new ErrorCanal("tiempo"));
      }, esperaMs);
      this.espera = {
        ok: (b) => {
          clearTimeout(reloj);
          ok(b);
        },
        mal: (e) => {
          clearTimeout(reloj);
          mal(e);
        },
      };
    });
  }
}

function sellar(k: { clave: Buffer; sentido: number }, contador: bigint, claro: Buffer): Buffer {
  const cabeza = Buffer.alloc(8);
  cabeza.writeBigUInt64BE(contador);
  const cifrador = createCipheriv("chacha20-poly1305", k.clave, nonce(cabeza), { authTagLength: 16 });
  cifrador.setAAD(aad(cabeza, k.sentido), { plaintextLength: claro.length });
  return Buffer.concat([cabeza, cifrador.update(claro), cifrador.final(), cifrador.getAuthTag()]);
}

function abrir(k: { clave: Buffer; sentido: number }, esperado: bigint, marco: Buffer): Buffer {
  if (marco.length < 8 + 16) throw new ErrorCanal("manipulado", "mensaje truncado");
  const cabeza = marco.subarray(0, 8);
  if (cabeza.readBigUInt64BE() !== esperado) throw new ErrorCanal("manipulado", "mensaje repetido o fuera de orden");
  const descifrador = createDecipheriv("chacha20-poly1305", k.clave, nonce(cabeza), { authTagLength: 16 });
  descifrador.setAAD(aad(cabeza, k.sentido), { plaintextLength: marco.length - 24 });
  descifrador.setAuthTag(marco.subarray(marco.length - 16));
  try {
    return Buffer.concat([descifrador.update(marco.subarray(8, marco.length - 16)), descifrador.final()]);
  } catch {
    throw new ErrorCanal("manipulado", "mensaje alterado");
  }
}

function aad(cabeza: Buffer, sentido: number): Buffer {
  return Buffer.concat([cabeza, Buffer.from([sentido])]);
}

function nonce(cabeza: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), cabeza]);
}

function derivar(ikm: Buffer, th: Buffer): { ir: Buffer; ri: Buffer; prueba: Buffer } {
  const salida = Buffer.from(hkdfSync("sha256", ikm, th, `${NOMBRE} v${PROTOCOLO}`, 96));
  return { ir: salida.subarray(0, 32), ri: salida.subarray(32, 64), prueba: salida.subarray(64, 96) };
}

function hmac(clave: Buffer, rol: "duena" | "lectora", th: Buffer): Buffer {
  return createHmac("sha256", clave).update(rol).update(th).digest();
}

function verificarPrueba(valor: unknown, clave: Buffer, rol: "duena" | "lectora", th: Buffer): void {
  const esperada = hmac(clave, rol, th);
  const recibida = typeof valor === "string" ? Buffer.from(valor, "base64url") : Buffer.alloc(0);
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
    throw new ErrorCanal("prueba_invalida", "la otra punta no probó las claves ni el secreto");
  }
}

function transcripcion(m1: Buffer, m2: Buffer): Buffer {
  const largo = Buffer.alloc(8);
  largo.writeUInt32BE(m1.length, 0);
  largo.writeUInt32BE(m2.length, 4);
  return createHash("sha256").update(largo).update(m1).update(m2).digest();
}

function dh(privada: KeyObject, publica: KeyObject): Buffer {
  const secreto = diffieHellman({ privateKey: privada, publicKey: publica });
  // Una clave pública de orden bajo da un secreto de ceros: se rechaza.
  if (secreto.every((b) => b === 0)) throw new ErrorCanal("formato", "clave pública inválida");
  return secreto;
}

/** Texto acotado de una versión ajena: viene sin autenticar y nunca se imprime tal cual. */
function versionAjena(v: unknown): string {
  return typeof v === "number" && Number.isInteger(v) ? `la otra punta habla la versión ${v}` : "la otra punta habla otra versión";
}

function publicaDe(clave: KeyObject): string {
  return String(clave.export({ format: "jwk" }).x);
}

function clavePublica(valor: unknown): KeyObject {
  if (typeof valor !== "string" || !CLAVE_PUBLICA.test(valor)) throw new ErrorCanal("formato", "clave pública mal formada");
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: valor }, format: "jwk" });
  } catch {
    throw new ErrorCanal("formato", "clave pública mal formada");
  }
}

function codificar(objeto: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(objeto), "utf8");
}

function decodificar(datos: Buffer): Record<string, unknown> {
  try {
    const valor = JSON.parse(datos.toString("utf8")) as unknown;
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) return valor as Record<string, unknown>;
  } catch {
    // cae al error de abajo
  }
  throw new ErrorCanal("formato", "mensaje de handshake ilegible");
}
