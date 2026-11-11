// Tipos mínimos de `ws` (8.x) para lo que usa el enlace remoto: la única dependencia nueva del plan 005 es `ws`,
// sin `@types/ws`. Solo se declara lo que el código llama.
declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { IncomingMessage, ClientRequestArgs } from "node:http";
  import type { Duplex } from "node:stream";

  type Datos = Buffer | ArrayBuffer | Buffer[];

  interface OpcionesCliente {
    headers?: Record<string, string>;
    maxPayload?: number;
    handshakeTimeout?: number;
    perMessageDeflate?: boolean;
    createConnection?: ClientRequestArgs["createConnection"];
  }

  class WebSocket extends EventEmitter {
    static readonly OPEN: 1;
    readonly readyState: 0 | 1 | 2 | 3;
    readonly bufferedAmount: number;
    constructor(url: string, opciones?: OpcionesCliente);
    send(datos: Buffer | string, cb?: (error?: Error) => void): void;
    close(codigo?: number, motivo?: string): void;
    terminate(): void;
    on(evento: "open", fn: () => void): this;
    on(evento: "message", fn: (datos: Datos, binario: boolean) => void): this;
    on(evento: "close", fn: (codigo: number, motivo: Buffer) => void): this;
    on(evento: "error", fn: (error: Error) => void): this;
    on(evento: "unexpected-response", fn: (req: unknown, res: IncomingMessage) => void): this;
    once(evento: "open", fn: () => void): this;
    once(evento: "close", fn: (codigo: number, motivo: Buffer) => void): this;
    once(evento: "error", fn: (error: Error) => void): this;
  }

  interface OpcionesServidor {
    noServer: true;
    maxPayload?: number;
    perMessageDeflate?: boolean;
  }

  class WebSocketServer extends EventEmitter {
    constructor(opciones: OpcionesServidor);
    readonly clients: Set<WebSocket>;
    handleUpgrade(req: IncomingMessage, socket: Duplex, cabeza: Buffer, cb: (ws: WebSocket) => void): void;
    close(cb?: () => void): void;
  }

  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
