import { useCallback, useEffect, useState } from "react";
import { mensajeError, type Cliente } from "../api";
import { Aviso } from "./comunes";
import { EstaPc } from "./remoto/EstaPc";
import { Lee } from "./remoto/Lee";
import { Leen } from "./remoto/Leen";
import { Pedidos } from "./remoto/Pedidos";
import { RegistroRemoto } from "./remoto/Registro";
import type { CodigoNuevo, Estado } from "./remoto/tipos";

// «Acceso remoto»: barra «Esta PC» y, debajo, dos columnas por dirección (D03 de la spec 006): quién lee esta
// memoria y qué memorias lee esta PC. Todo pasa por las operaciones remoto_* del servicio, que solo responden a la
// sesión de la web.

export function Remoto({ cliente, ahora = () => Date.now() }: { cliente: Cliente; ahora?: () => number }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codigo, setCodigo] = useState<CodigoNuevo | null>(null);

  const recargar = useCallback(async () => {
    try {
      setEstado(await cliente<Estado>("remoto_estado"));
      setError(null);
    } catch (e) {
      setError(mensajeError(e));
    }
  }, [cliente]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return (
    <section className="hoja remoto" aria-labelledby="titulo-remoto">
      <div className="remoto-cabecera">
        <h2 id="titulo-remoto">Acceso remoto</h2>
        <p className="meta">Otras PCs tuyas leen (nunca escriben) lo que elijas, a través de un relé que solo ve datos cifrados.</p>
      </div>
      <Aviso texto={error} />
      {!estado && !error && <p className="meta">Cargando…</p>}
      {estado && (
        <>
          {estado.nombre_pc === undefined && (
            <p role="alert" className="aviso error">
              El servicio que responde es de una versión anterior a esta web: reinicialo con «agent-memory stop» y «agent-memory start» (si
              «stop» no puede, te muestra cómo cerrarlo).
            </p>
          )}
          <div className="consola-remota">
            <EstaPc estado={estado} cliente={cliente} recargar={recargar} alApagar={() => setCodigo(null)} />
            <div className="dos-columnas">
              <Leen estado={estado} cliente={cliente} recargar={recargar} codigo={codigo} setCodigo={setCodigo} ahora={ahora} />
              <Lee estado={estado} cliente={cliente} recargar={recargar} />
            </div>
          </div>
          <Pedidos pedidos={estado.pendientes ?? []} cliente={cliente} recargar={recargar} alCodigo={setCodigo} />
          <RegistroRemoto cliente={cliente} dispositivos={estado.dispositivos} version={estado} ahora={ahora} />
        </>
      )}
    </section>
  );
}
