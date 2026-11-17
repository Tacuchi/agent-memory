/**
 * Límite de intentos fallidos por IP, del modo directo y del relé: tras `fallos` fallos dentro de `ventanaMs`, esa IP
 * queda limitada `bloqueoMs`. Vive solo en memoria y solo anota las IPs que fallan.
 */
export const FALLOS_POR_IP = 10;
export const VENTANA_FALLOS_MS = 10 * 60_000;
export const BLOQUEO_POR_FALLOS_MS = 15 * 60_000;
/** Tope de IPs anotadas: un barrido con muchas IPs no hace crecer la memoria sin fin. */
const TOPE_IPS = 10_000;

export interface OpcionesLimite {
  fallos?: number;
  ventanaMs?: number;
  bloqueoMs?: number;
  reloj?: () => number;
}

export class LimiteIntentos {
  private readonly fallosPorIp = new Map<string, number[]>();
  private readonly limitadas = new Map<string, number>();
  private readonly fallos: number;
  private readonly ventanaMs: number;
  private readonly bloqueoMs: number;
  private readonly reloj: () => number;

  constructor(opciones: OpcionesLimite = {}) {
    this.fallos = opciones.fallos ?? FALLOS_POR_IP;
    this.ventanaMs = opciones.ventanaMs ?? VENTANA_FALLOS_MS;
    this.bloqueoMs = opciones.bloqueoMs ?? BLOQUEO_POR_FALLOS_MS;
    this.reloj = opciones.reloj ?? Date.now;
  }

  /** ¿Está limitada esta IP ahora? Una IP desconocida (null) nunca lo está. */
  limitada(ip: string | null): boolean {
    if (!ip) return false;
    const hasta = this.limitadas.get(ip);
    if (hasta === undefined) return false;
    if (hasta > this.reloj()) return true;
    this.limitadas.delete(ip);
    return false;
  }

  /** Anota un fallo de esta IP; al llegar al tope, la limita y olvida sus fallos. */
  fallo(ip: string | null): void {
    if (!ip) return;
    const ahora = this.reloj();
    const recientes = (this.fallosPorIp.get(ip) ?? []).filter((t) => t > ahora - this.ventanaMs);
    recientes.push(ahora);
    this.fallosPorIp.delete(ip);
    if (recientes.length >= this.fallos) {
      this.limitadas.delete(ip);
      this.limitadas.set(ip, ahora + this.bloqueoMs);
      recortar(this.limitadas);
      return;
    }
    this.fallosPorIp.set(ip, recientes);
    recortar(this.fallosPorIp);
  }
}

/** Saca las entradas más viejas (orden de inserción) que pasen del tope. */
function recortar(mapa: Map<string, unknown>): void {
  for (const clave of mapa.keys()) {
    if (mapa.size <= TOPE_IPS) return;
    mapa.delete(clave);
  }
}
