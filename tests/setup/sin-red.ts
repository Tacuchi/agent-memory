// Las pruebas corren sin red: cualquier fetch fuera de loopback falla en el acto.
const fetchOriginal = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
  if (!LOOPBACK.has(url.hostname)) throw new Error(`red bloqueada en las pruebas: ${url.hostname}`);
  return fetchOriginal(entrada, init);
}) as typeof fetch;
