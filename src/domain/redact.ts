// Redacción de secretos con formato conocido antes de guardar (AC-26). Devuelve qué tipos se
// redactaron, nunca el valor. La lista es configurable: se puede pasar otra a `redactar`.

export interface PatronSecreto {
  tipo: string;
  patron: RegExp;
  /** Reemplazo; `$1` conserva un prefijo no secreto (p. ej. el nombre de la clave). */
  reemplazo?: string;
}

export const MARCA = "[REDACTADO]";

export const PATRONES_POR_DEFECTO: readonly PatronSecreto[] = [
  {
    tipo: "clave_privada_pem",
    patron: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { tipo: "aws_access_key", patron: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { tipo: "github_token", patron: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { tipo: "clave_sk", patron: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { tipo: "slack_token", patron: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { tipo: "google_api_key", patron: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { tipo: "jwt", patron: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    tipo: "credencial_en_url",
    patron: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
    reemplazo: `$1${MARCA}@`,
  },
  {
    tipo: "asignacion_secreta",
    patron: /\b((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(["']?)(?!\[REDACTADO\])[^\s"',;]+\2/gi,
    reemplazo: `$1${MARCA}`,
  },
];

export interface ResultadoRedaccion {
  texto: string;
  /** Tipos redactados, sin repetir y sin el valor. */
  redactados: string[];
}

export function redactar(texto: string, patrones: readonly PatronSecreto[] = PATRONES_POR_DEFECTO): ResultadoRedaccion {
  const redactados = new Set<string>();
  let salida = texto;
  for (const { tipo, patron, reemplazo } of patrones) {
    const regex = new RegExp(patron.source, patron.flags.includes("g") ? patron.flags : `${patron.flags}g`);
    salida = salida.replace(regex, (...args: unknown[]) => {
      redactados.add(tipo);
      if (!reemplazo) return MARCA;
      const grupos = args.slice(1, -2) as (string | undefined)[];
      return reemplazo.replace(/\$(\d)/g, (_, n: string) => grupos[Number(n) - 1] ?? "");
    });
  }
  return { texto: salida, redactados: [...redactados] };
}
