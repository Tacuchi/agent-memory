import { createHash } from "node:crypto";

/**
 * Huella de un borrador (AC-16): sha256 del contenido canónico ya redactado. El servicio la
 * recalcula al confirmar, así que un cambio en cualquier campo exige confirmar de nuevo. No
 * guarda estado: lo que ata la confirmación al texto es la huella misma.
 */
export function huella(campos: Record<string, string | number | null>): string {
  const canonico = Object.keys(campos)
    .sort()
    .map((k) => [k, campos[k] ?? null]);
  return createHash("sha256").update(JSON.stringify(canonico)).digest("hex");
}
