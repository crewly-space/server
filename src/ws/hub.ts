import type { Database } from '../db/driver.js';
import type { WebSocket } from 'ws';
import type { WsServerEvent } from '../protocol/index.js';

interface EventRow {
  seq: number;
  topic: string;
  type: string;
  payload: string;
  created_at: string;
}

export class ConnectionHub {
  private sockets = new Map<WebSocket, Set<string>>();
  /** Whose each socket is, so a topic can follow a person onto their open sockets. */
  private owners = new Map<WebSocket, string>();

  constructor(private db: Database) {}

  publish(topic: string, type: string, payload: Record<string, unknown>): WsServerEvent {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare('INSERT INTO event_log (topic, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(topic, type, JSON.stringify(payload), createdAt);
    const event: WsServerEvent = {
      seq: Number(info.lastInsertRowid),
      topic,
      type,
      payload,
      ts: createdAt,
    };
    this.broadcastToTopic(event);
    return event;
  }

  subscribe(socket: WebSocket, topics: string[], userId?: string): void {
    this.sockets.set(socket, new Set(topics));
    if (userId) this.owners.set(socket, userId);
  }

  unsubscribe(socket: WebSocket): void {
    this.sockets.delete(socket);
    this.owners.delete(socket);
  }

  /** Starts sending a topic to every socket someone already has open, e.g. on joining a channel. */
  addUserTopic(userId: string, topic: string): void {
    for (const [socket, owner] of this.owners) if (owner === userId) this.sockets.get(socket)?.add(topic);
  }

  /** Stops sending a topic to someone's open sockets, e.g. on leaving or being removed from a channel. */
  removeUserTopic(userId: string, topic: string): void {
    for (const [socket, owner] of this.owners) if (owner === userId) this.sockets.get(socket)?.delete(topic);
  }

  replaySince(topics: string[], sinceSeq: number): WsServerEvent[] {
    if (topics.length === 0) return [];
    const placeholders = topics.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM event_log WHERE topic IN (${placeholders}) AND seq > ? ORDER BY seq ASC`)
      .all(...topics, sinceSeq) as EventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      topic: r.topic,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.created_at,
    }));
  }

  private broadcastToTopic(event: WsServerEvent): void {
    for (const [socket, topics] of this.sockets) {
      if (topics.has(event.topic) && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    }
  }
}
