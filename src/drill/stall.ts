// stall.ts — a WebSocket constructor whose connections can be cut off the way a dead network
// cuts them: the client stops reading from its TCP socket, so nothing arrives and nothing says
// so. After `stall()`, new connections never open either. Node only (`ws`).
import { WebSocket } from 'ws';
import type { WebSocketConstructor, WebSocketLike } from '../client/feedClient';

/** A connection attempt into the void: it never opens, never closes, never errors. */
class Unreachable implements WebSocketLike {
  send() {}
  close() {}
  addEventListener() {}
}

export interface Stallable {
  WebSocket: WebSocketConstructor;
  /** Stop reading on every open connection; from now on nothing connects. */
  stall(): void;
  /** Destroy every connection, without a closing handshake. */
  terminate(): void;
}

export function stallable(): Stallable {
  let stalled = false;
  const live = new Set<WebSocket>();
  const constructor = function (url: string): WebSocketLike {
    if (stalled) return new Unreachable();
    const ws = new WebSocket(url);
    live.add(ws);
    ws.on('close', () => live.delete(ws));
    return ws as unknown as WebSocketLike;
  } as unknown as WebSocketConstructor;
  return {
    WebSocket: constructor,
    stall() {
      stalled = true;
      for (const ws of live) {
        // The TCP socket under the WebSocket: paused, it is no longer read.
        (ws as unknown as { _socket?: { pause(): void } })._socket?.pause();
        // `ws` hands over whatever the kernel had buffered when the socket is finally torn
        // down. A dead network delivers nothing late, so neither does this.
        ws.removeAllListeners('message');
      }
    },
    terminate() {
      for (const ws of live) ws.terminate();
      live.clear();
    },
  };
}
