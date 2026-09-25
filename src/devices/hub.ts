import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { supportsCapability, type AgentdOperationName, type AgentdResponse } from '../protocol/index.js';

export class DeviceUnavailableError extends Error {}
export class DeviceCapabilityError extends Error {
  constructor(public readonly capability: string) {
    super(`connected device does not advertise ${capability}; update Crewly CLI`);
  }
}
export class DeviceRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

interface PendingRequest {
  deviceId: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DeviceConnection {
  socket: WebSocket;
  capabilities: Set<string>;
}

export class DeviceConnectionHub {
  private readonly sockets = new Map<string, DeviceConnection>();
  private readonly pending = new Map<string, PendingRequest>();

  connect(deviceId: string, socket: WebSocket, capabilities: readonly string[] = []): void {
    const previous = this.sockets.get(deviceId)?.socket;
    if (previous && previous !== socket && previous.readyState === previous.OPEN) {
      this.rejectDevice(deviceId, new DeviceUnavailableError('device connection was replaced'));
      previous.close(4009, 'replaced by a newer connection');
    }
    this.sockets.set(deviceId, { socket, capabilities: new Set(capabilities) });
  }

  /** True when this socket was the device's live one, so the device is now offline. */
  disconnect(deviceId: string, socket: WebSocket): boolean {
    if (this.sockets.get(deviceId)?.socket !== socket) return false;
    this.sockets.delete(deviceId);
    this.rejectDevice(deviceId, new DeviceUnavailableError('device disconnected'));
    return true;
  }

  isConnected(deviceId: string): boolean {
    const socket = this.sockets.get(deviceId)?.socket;
    return Boolean(socket && socket.readyState === socket.OPEN);
  }

  supports(deviceId: string, capability: string): boolean {
    const capabilities = this.sockets.get(deviceId)?.capabilities;
    return supportsCapability(capabilities ? [...capabilities] : undefined, capability);
  }

  request(
    deviceId: string,
    operation: AgentdOperationName,
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
    options: { requiredCapability?: string } = {},
  ): Promise<Record<string, unknown>> {
    const connection = this.sockets.get(deviceId);
    const socket = connection?.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new DeviceUnavailableError('no connected device can handle this request');
    }
    if (options.requiredCapability && !supportsCapability([...connection.capabilities], options.requiredCapability)) {
      throw new DeviceCapabilityError(options.requiredCapability);
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
