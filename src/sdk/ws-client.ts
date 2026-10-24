import type { WsServerEvent } from '../protocol/index.js';

export type WsEventHandler = (event: WsServerEvent) => void;

export interface WebSocketConnection {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketConnection;

interface ActiveWebSocket extends WebSocketConnection {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}

export type WsConnectionState = 'connecting' | 'connected' | 'disconnected' | 'unauthorized' | 'forbidden';

export class WsClient {
  private socket: ActiveWebSocket | undefined;
  private handlers: WsEventHandler[] = [];
  private openHandlers: (() => void)[] = [];
  private lastSeq: number | undefined;
  private resumeSeq: number | undefined;
  private lastToken: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private retryDelay = 1000;
  private stateHandlers: ((state: WsConnectionState) => void)[] = [];

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
    this.retryDelay = 1000;
    this.openSocket(input);
  }

  private openSocket(input: { token: string; sinceSeq?: number }): void {
    this.emitState('connecting');
    const wsUrl = this.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const socket = new this.WebSocketImpl(`${wsUrl}/api/v1/ws`) as ActiveWebSocket;
    // Browsers surface connection failures as events, while implementations such as
    // `ws` also emit an error that becomes an uncaught exception without a handler.
    // The close event below owns reconnection, so consuming the paired error is enough.
    socket.onerror = () => {};
    socket.onopen = () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      socket.send(JSON.stringify({ type: 'authenticate', token: input.token, ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}) }));
    };
    socket.onmessage = (event) => {
      let decoded: WsServerEvent | { type: 'authenticated' };
      try { decoded = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (!decoded || typeof decoded !== 'object') return;
      if (decoded.type === 'authenticated' && !('seq' in decoded)) {
        this.retryDelay = 1000;
        this.emitState('connected');
        for (const handler of this.openHandlers) handler();
        return;
      }
      const parsed = decoded as WsServerEvent;
      if (!Number.isSafeInteger(parsed.seq) || parsed.seq < 0) return;
      if (this.resumeSeq !== undefined && parsed.seq <= this.resumeSeq) return;
      this.lastSeq = this.lastSeq === undefined ? parsed.seq : Math.max(this.lastSeq, parsed.seq);
      this.resumeSeq = this.resumeSeq === undefined ? parsed.seq : Math.max(this.resumeSeq, parsed.seq);
      for (const handler of this.handlers) handler(parsed);
    };
    socket.onclose = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      if (event?.code === 4001 || event?.code === 4003) {
        this.stopped = true;
        this.emitState(event.code === 4001 ? 'unauthorized' : 'forbidden');
        return;
      }
      this.emitState('disconnected');
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped && this.lastToken) this.openSocket({ token: this.lastToken, sinceSeq: this.resumeSeq });
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    };
    this.socket = socket;
  }

  onState(handler: (state: WsConnectionState) => void): void {
    this.stateHandlers.push(handler);
  }

  private emitState(state: WsConnectionState): void {
    for (const handler of this.stateHandlers) handler(state);
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
