import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { AgentdOperationName, AgentdResponse } from '../protocol/index.js';

export class DeviceUnavailableError extends Error {}
export class DeviceRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

interface PendingRequest {
  deviceId: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeviceConnectionHub {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  connect(deviceId: string, socket: WebSocket): void {
    const previous = this.sockets.get(deviceId);
    if (previous && previous !== socket && previous.readyState === previous.OPEN) {
      this.rejectDevice(deviceId, new DeviceUnavailableError('device connection was replaced'));
      previous.close(4009, 'replaced by a newer connection');
    }
    this.sockets.set(deviceId, socket);
  }

  /** True when this socket was the device's live one, so the device is now offline. */
  disconnect(deviceId: string, socket: WebSocket): boolean {
    if (this.sockets.get(deviceId) !== socket) return false;
    this.sockets.delete(deviceId);
    this.rejectDevice(deviceId, new DeviceUnavailableError('device disconnected'));
    return true;
  }

  isConnected(deviceId: string): boolean {
    const socket = this.sockets.get(deviceId);
    return Boolean(socket && socket.readyState === socket.OPEN);
  }

  request(
    deviceId: string,
    operation: AgentdOperationName,
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<Record<string, unknown>> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new DeviceUnavailableError('no connected device can handle this request');
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DeviceUnavailableError(`device request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { deviceId, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ requestId, operation, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error as Error);
      }
    });
  }

  handleResponse(deviceId: string, response: AgentdResponse): boolean {
    const request = this.pending.get(response.requestId);
    if (!request || request.deviceId !== deviceId) return false;
    clearTimeout(request.timer);
    this.pending.delete(response.requestId);
    if (response.ok) request.resolve(response.result ?? {});
    else request.reject(new DeviceRequestError(response.error?.code ?? 'device_error', response.error?.message ?? 'device request failed'));
    return true;
  }

  private rejectDevice(deviceId: string, error: Error): void {
    for (const [requestId, request] of this.pending) {
      if (request.deviceId !== deviceId) continue;
      clearTimeout(request.timer);
      this.pending.delete(requestId);
      request.reject(error);
    }
  }
}
