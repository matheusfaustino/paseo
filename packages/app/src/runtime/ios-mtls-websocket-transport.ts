import { Buffer } from "buffer";
import type { DaemonClientConfig, DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import type { EventSubscription } from "expo-modules-core";
import {
  addMtlsSocketCloseListener,
  addMtlsSocketErrorListener,
  addMtlsSocketMessageListener,
  addMtlsSocketOpenListener,
  closeMtlsSocket,
  connectMtlsSocket,
  isMtlsWebSocketAvailable,
  sendMtlsSocketBinary,
  sendMtlsSocketString,
} from "@/native/ios-mtls-websocket";

let nextSocketId = 1;

interface HandlerSet {
  open: () => void;
  close: (event?: unknown) => void;
  error: (event?: unknown) => void;
  message: (data: unknown, isBinary: boolean) => void;
}

function createHandlerSet(): HandlerSet {
  return {
    open: () => {},
    close: () => {},
    error: () => {},
    message: () => {},
  };
}

function toArrayBuffer(base64: string): ArrayBuffer {
  const bytes = Buffer.from(base64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toBase64(data: Uint8Array | ArrayBuffer): string {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("base64");
  }
  return Buffer.from(data).toString("base64");
}

function bindSocketSubscriptions(
  socketId: string,
  handlers: HandlerSet,
  cleanup: () => void,
): EventSubscription[] {
  return [
    addMtlsSocketOpenListener((event) => {
      if (event.socketId !== socketId) {
        return;
      }
      handlers.open();
    }),
    addMtlsSocketMessageListener((event) => {
      if (event.socketId !== socketId) {
        return;
      }
      if (event.type === "binary") {
        handlers.message(toArrayBuffer(event.base64 ?? ""), true);
        return;
      }
      handlers.message(event.text ?? "", false);
    }),
    addMtlsSocketErrorListener((event) => {
      if (event.socketId !== socketId) {
        return;
      }
      handlers.error(new Error(event.message));
    }),
    addMtlsSocketCloseListener((event) => {
      if (event.socketId !== socketId) {
        return;
      }
      handlers.close(event);
      cleanup();
    }),
  ];
}

export function createIosMtlsTransportFactory(
  identityId: string,
): DaemonClientConfig["transportFactory"] | null {
  if (!isMtlsWebSocketAvailable()) {
    return null;
  }

  return ({ url, headers, protocols }) => {
    const socketId = `mtls-${nextSocketId++}`;
    const handlers = createHandlerSet();
    let subscriptions: EventSubscription[] = [];
    let cleanedUp = false;
    let connectRequested = false;

    function cleanup(): void {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      for (const subscription of subscriptions) {
        subscription.remove();
      }
      subscriptions = [];
    }

    subscriptions = bindSocketSubscriptions(socketId, handlers, cleanup);

    queueMicrotask(() => {
      if (cleanedUp) {
        return;
      }
      connectRequested = true;
      void connectMtlsSocket({ socketId, url, headers, protocols, identityId }).catch((error) => {
        if (cleanedUp) {
          return;
        }
        handlers.error(error);
        handlers.close({ code: 0, reason: error instanceof Error ? error.message : String(error) });
        cleanup();
      });
    });

    const transport: DaemonTransport = {
      send(data) {
        if (typeof data === "string") {
          void sendMtlsSocketString(socketId, data);
          return;
        }
        void sendMtlsSocketBinary(socketId, toBase64(data));
      },
      close(code, reason) {
        if (!connectRequested && !cleanedUp) {
          cleanup();
        }
        void closeMtlsSocket(socketId, code, reason).catch(() => {
          cleanup();
        });
      },
      onOpen(handler) {
        handlers.open = handler;
        return () => {
          if (handlers.open === handler) {
            handlers.open = () => {};
          }
        };
      },
      onClose(handler) {
        handlers.close = handler;
        return () => {
          if (handlers.close === handler) {
            handlers.close = () => {};
          }
        };
      },
      onError(handler) {
        handlers.error = handler;
        return () => {
          if (handlers.error === handler) {
            handlers.error = () => {};
          }
        };
      },
      onMessage(handler) {
        handlers.message = handler;
        return () => {
          if (handlers.message === handler) {
            handlers.message = () => {};
          }
        };
      },
    };

    return transport;
  };
}
