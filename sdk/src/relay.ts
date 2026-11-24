import { parse, stringify } from "./json";
import type { ArenaEvent, ArenaSnapshot, Deployment } from "./types";

/** Relay wire protocol (server → client). */
export type RelayMessage =
  | { t: "hello"; deployment: Deployment; snapshot: ArenaSnapshot | null; history: ArenaEvent[]; mode: RelayMode; serverTime: number }
  | { t: "event"; e: ArenaEvent }
  | { t: "snapshot"; s: ArenaSnapshot }
  | { t: "mode"; mode: RelayMode }
  | { t: "pong"; at: number };

export interface RelayMode {
  replay: boolean;
  speed: number;
  /** wall-clock ms when the replay window started, for the REPLAY badge */
  since?: number;
  reason?: string;
}

/** Client → server. */
export type RelayRequest = { t: "ping"; at: number } | { t: "history"; fromBlock?: string };

export interface RelayHandlers {
  onHello?(m: Extract<RelayMessage, { t: "hello" }>): void;
  onEvent?(e: ArenaEvent): void;
  onSnapshot?(s: ArenaSnapshot): void;
  onMode?(m: RelayMode): void;
  onStatus?(s: "connecting" | "open" | "closed"): void;
}

/**
 * Connect to the Red Queen relay (one shared heartbeat for every screen in the room).
 * Reconnects with backoff; works in browsers and Node >= 22 (global WebSocket).
 */
export function connectRelay(url: string, h: RelayHandlers) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    h.onStatus?.("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      h.onStatus?.("open");
    };
    ws.onmessage = (msg) => {
      const m = parse<RelayMessage>(typeof msg.data === "string" ? msg.data : String(msg.data));
      if (m.t === "hello") h.onHello?.(m);
      else if (m.t === "event") h.onEvent?.(m.e);
      else if (m.t === "snapshot") h.onSnapshot?.(m.s);
      else if (m.t === "mode") h.onMode?.(m.mode);
    };
    ws.onclose = () => {
      h.onStatus?.("closed");
      if (closed) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(r: RelayRequest) {
      if (ws?.readyState === 1) ws.send(stringify(r));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
