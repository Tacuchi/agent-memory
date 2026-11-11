// Fechas, tiempos y tamaños en español, sobrios y cortos.

const FECHA = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const HORA = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const DIA = new Intl.DateTimeFormat("es", { weekday: "short", timeZone: "UTC" });

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** «hace 4 s», «hace 5 min», «hace 2 h», «hace 3 d». */
export function hace(iso: string | null | undefined, ahora: number): string {
  const t = ms(iso);
  if (t === null) return "nunca";
  const s = Math.max(0, Math.round((ahora - t) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

/** «en 7 min», «en 3 h», «en 30 días»; «vencido» si ya pasó. */
export function falta(iso: string | null | undefined, ahora: number): string {
  const t = ms(iso);
  if (t === null) return "sin vencimiento";
  const s = Math.round((t - ahora) / 1000);
  if (s <= 0) return "vencido";
  if (s < 3600) return `en ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86_400) return `en ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86_400);
  return `en ${d} ${d === 1 ? "día" : "días"}`;
}

/** Cuenta regresiva «7:42». */
export function cuenta(iso: string, ahora: number): string {
  const t = ms(iso) ?? ahora;
  const s = Math.max(0, Math.floor((t - ahora) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fecha(iso: string | null | undefined): string {
  const t = ms(iso);
  return t === null ? "—" : FECHA.format(t).replace(".", "");
}

export function hora(iso: string | null | undefined): string {
  const t = ms(iso);
  return t === null ? "—" : HORA.format(t);
}

/** Día de la semana corto de una fecha AAAA-MM-DD. */
export function diaSemana(dia: string): string {
  const t = ms(`${dia}T12:00:00Z`);
  return t === null ? dia : DIA.format(t).replace(".", "");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const unidades = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < unidades.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("es", { maximumFractionDigits: 1 })} ${unidades[i]}`;
}

export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}
