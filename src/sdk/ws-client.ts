import type { WsServerEvent } from '../protocol/index.js';

export type WsEventHandler = (event: WsServerEvent) => void;

export interface WebSocketConnection {
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketConnection;

interface ActiveWebSocket extends WebSocketConnection {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export class WsClient {
  private socket: ActiveWebSocket | undefined;
  private handlers: WsEventHandler[] = [];
  private openHandlers: (() => void)[] = [];
  private lastSeq: number | undefined;
  private resumeSeq: number | undefined;
  private lastToken: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly WebSocketImpl: WebSocketConstructor
  ) {}

  connect(input: { token: string; sinceSeq?: number }): void {
    this.close();
    this.stopped = false;
    this.lastToken = input.token;
    this.lastSeq = undefined;
    this.resumeSeq = input.sinceSeq;
    this.openSocket(input);
  }

  private openSocket(input: { token: string; sinceSeq?: number }): void {
    const wsUrl = this.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const params = new URLSearchParams({ token: input.token });
    if (input.sinceSeq !== undefined) params.set('sinceSeq', String(input.sinceSeq));

    const socket = new this.WebSocketImpl(`${wsUrl}/api/v1/ws?${params.toString()}`) as ActiveWebSocket;
    // Browsers surface connection failures as events, while implementations such as
    // `ws` also emit an error that becomes an uncaught exception without a handler.
    // The close event below owns reconnection, so consuming the paired error is enough.
    socket.onerror = () => {};
    socket.onopen = () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      for (const handler of this.openHandlers) handler();
    };
    socket.onmessage = (event) => {
      const parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) as WsServerEvent;
      if (this.resumeSeq !== undefined && parsed.seq <= this.resumeSeq) return;
      this.lastSeq = this.lastSeq === undefined ? parsed.seq : Math.max(this.lastSeq, parsed.seq);
      this.resumeSeq = this.resumeSeq === undefined ? parsed.seq : Math.max(this.resumeSeq, parsed.seq);
      for (const handler of this.handlers) handler(parsed);
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped && this.lastToken) this.openSocket({ token: this.lastToken, sinceSeq: this.resumeSeq });
      }, 1000);
    };
    this.socket = socket;
  }

  onEvent(handler: WsEventHandler): void {
    this.handlers.push(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  getLastSeq(): number | undefined {
    return this.lastSeq;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    this.socket = undefined;
    socket.close();
  }

  reconnect(): void {
    if (!this.lastToken) throw new Error('cannot reconnect before connect() has been called at least once');
    this.close();
    this.stopped = false;
    this.openSocket({ token: this.lastToken, sinceSeq: this.resumeSeq });
  }
}
