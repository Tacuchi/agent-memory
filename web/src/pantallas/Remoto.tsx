import { useCallback, useEffect, useState } from "react";
import { mensajeError, type Cliente } from "../api";
import { Aviso } from "./comunes";
import { Conexiones } from "./remoto/Conexiones";
import { EstaPc } from "./remoto/EstaPc";
import { Pedidos } from "./remoto/Pedidos";
import type { CodigoNuevo, Estado } from "./remoto/tipos";

// «Acceso remoto»: barra «Esta PC» (la única local) y, debajo, una tarjeta por cada otra PC conectada, con los dos
// sentidos y su actividad (0.4.1). Todo pasa por las operaciones remoto_* del servicio, que solo responden a la sesión
// de la web.

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
        <p className="meta">
          Esta PC es la única local. Las demás son conexiones: en cada una ves qué le compartís y qué te comparte. Solo lectura y
          cifrado de punta a punta: directo por Tailscale o la red local, o por un relé que solo ve datos cifrados.
        </p>
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
            <Conexiones estado={estado} cliente={cliente} recargar={recargar} codigo={codigo} setCodigo={setCodigo} ahora={ahora} />
          </div>
          <Pedidos pedidos={estado.pendientes ?? []} cliente={cliente} recargar={recargar} alCodigo={setCodigo} />
        </>
      )}
    </section>
  );
}
