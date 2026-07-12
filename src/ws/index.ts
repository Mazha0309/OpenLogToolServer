import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { AppConfig } from '../config';
import { readEventsAfter } from '../collaboration/events';
import {
  CollaborationRealtimeHub,
  getRealtimeHub,
  RealtimeConnection,
} from '../collaboration/realtime';

interface TicketRow {
  id: string;
  session_id: string;
  user_id: string;
  issued_role: string;
  issued_membership_version: number;
  device_id: string;
  after_seq: number;
  expires_at: string;
  consumed_at: string | null;
  role: string;
  membership_version: number;
  removed_at: string | null;
  status: string;
  deleted_at: string | null;
  event_seq: number;
  min_retained_seq: number;
}

export interface CollaborationWsDependencies {
  db: Database.Database;
  config: AppConfig;
  hub?: CollaborationRealtimeHub;
}

export interface CollaborationWsController {
  wss: WebSocketServer;
  close(): void;
}

interface AttemptCounter {
  count: number;
  resetAt: number;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_CONNECTIONS_PER_SESSION = 100;
const MAX_CONNECTIONS_PER_USER = 8;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_CONNECT_ATTEMPTS_PER_IP_MINUTE = 30;
const MAX_WS_BACKLOG_EVENTS = 1_000;
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024;

function ticketHash(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function forwardedValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
}

function trustsForwardedHeaders(config: AppConfig): boolean {
  return config.trustProxy === true ||
    (typeof config.trustProxy === 'number' && config.trustProxy > 0);
}

function requestIp(req: IncomingMessage, config: AppConfig): string {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustsForwardedHeaders(config)) return remote;
  const forwarded = forwardedValues(req.headers['x-forwarded-for']);
  if (forwarded.length === 0) return remote;
  if (config.trustProxy === true) return forwarded[0];
  const trustedHops = typeof config.trustProxy === 'number' ? config.trustProxy : 0;
  const closestFirst = [remote, ...forwarded.reverse()];
  return closestFirst[Math.min(trustedHops, closestFirst.length - 1)];
}

function forwardedProxyMetadata(
  value: string | string[] | undefined,
  config: AppConfig,
): string | undefined {
  const forwarded = forwardedValues(value);
  if (forwarded.length === 0 || !trustsForwardedHeaders(config)) return undefined;
  return config.trustProxy === true ? forwarded[0] : forwarded[forwarded.length - 1];
}

function isAllowedOrigin(req: IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = forwardedProxyMetadata(req.headers['x-forwarded-host'], config);
    const host = forwardedHost || req.headers.host;
    if (!host) return false;
    const forwardedProtocol = forwardedProxyMetadata(req.headers['x-forwarded-proto'], config);
    const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
    const protocol = forwardedProtocol || (encrypted ? 'https' : 'http');
    return originUrl.origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Socket, status: number, reason: string, retryAfter?: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const statusText: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  };
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${statusText[status] || 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      (retryAfter === undefined ? '' : `Retry-After: ${retryAfter}\r\n`) +
      '\r\n' +
      body,
  );
}

function readTicket(db: Database.Database, hash: string): TicketRow | undefined {
  return db.prepare(`
    SELECT t.*, sm.role, sm.version AS membership_version, sm.removed_at,
           s.status, s.deleted_at, s.event_seq, s.min_retained_seq
    FROM ws_tickets t
    JOIN session_members sm
      ON sm.session_id = t.session_id AND sm.user_id = t.user_id
    JOIN sessions s ON s.id = t.session_id
    WHERE t.token_hash = ?
  `).get(hash) as TicketRow | undefined;
}

function consumeTicket(db: Database.Database, hash: string): TicketRow | undefined {
  return db.transaction(() => {
    const row = readTicket(db, hash);
    const now = new Date().toISOString();
    if (
      !row ||
      row.consumed_at ||
      row.expires_at <= now ||
      row.removed_at ||
      row.issued_role !== row.role ||
      Number(row.issued_membership_version) !== Number(row.membership_version) ||
      row.deleted_at ||
      (row.status === 'initializing' && row.role !== 'owner')
    ) {
      return undefined;
    }
    const consumed = db.prepare(`
      UPDATE ws_tickets SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(now, row.id, now);
    return consumed.changes === 1 ? row : undefined;
  }).immediate();
}

class WebSocketRealtimeConnection implements RealtimeConnection {
  private cursor: number;
  private catchingUp = true;
  private readonly buffered = new Map<number, Parameters<RealtimeConnection['deliver']>[0]>();
  private unsubscribe?: () => void;
  private alive = true;

  constructor(
    private readonly ws: WebSocket,
    readonly sessionId: string,
    readonly userId: string,
    readonly ipAddress: string,
    afterSeq: number,
  ) {
    this.cursor = afterSeq;
  }

  setUnsubscribe(unsubscribe: () => void): void {
    this.unsubscribe = unsubscribe;
  }

  markPong(): void {
    this.alive = true;
  }

  ping(): void {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    try {
      this.ws.ping();
    } catch {
      this.ws.terminate();
    }
  }

  private send(message: unknown): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      this.ws.close(4009, 'Slow consumer must resynchronize');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.ws.terminate();
      return false;
    }
  }

  sendHello(headSeq: number): void {
    this.send({
      type: 'hello',
      sessionId: this.sessionId,
      headSeq,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  }

  sendBacklog(events: ReturnType<typeof readEventsAfter>, headSeq: number): void {
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      if (event.seq !== this.cursor + 1) {
        this.send({ type: 'resyncRequired', minAvailableSeq: event.seq });
        this.ws.close(4009, 'Event sequence gap');
        return;
      }
      if (!this.send({ type: 'event', event })) return;
      this.cursor = event.seq;
    }
    if (this.cursor !== headSeq) {
      this.send({ type: 'resyncRequired', minAvailableSeq: this.cursor + 1 });
      this.ws.close(4009, 'Event sequence gap');
      return;
    }
    this.send({ type: 'ready', cursor: this.cursor });
    this.catchingUp = false;
    const buffered = [...this.buffered.values()].sort((left, right) => left.seq - right.seq);
    this.buffered.clear();
    for (const event of buffered) this.deliver(event);
  }

  resyncRequired(minAvailableSeq: number): void {
    this.send({ type: 'resyncRequired', minAvailableSeq });
    this.ws.close(4009, 'Cursor expired');
  }

  deliver(event: Parameters<RealtimeConnection['deliver']>[0]): void {
    if (this.catchingUp) {
      this.buffered.set(event.seq, event);
      return;
    }
    if (event.seq <= this.cursor) return;
    if (event.seq !== this.cursor + 1) {
      this.send({ type: 'resyncRequired', minAvailableSeq: this.cursor + 1 });
      this.ws.close(4009, 'Event sequence gap');
      return;
    }
    if (this.send({ type: 'event', event })) this.cursor = event.seq;
  }

  revoke(reason: string): void {
    this.send({ type: 'accessRevoked', reason });
    this.ws.close(4003, reason.slice(0, 123));
  }

  membershipChanged(role: string, membershipVersion: number): void {
    this.send({ type: 'membershipChanged', role, membershipVersion });
    this.ws.close(4003, 'Membership changed');
  }

  sessionDeleted(): void {
    this.dispose();
    this.ws.close(1000, 'Session deleted');
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  close(): void {
    this.dispose();
    this.ws.terminate();
  }
}

export function createCollaborationWsServer(
  server: HttpServer,
  dependencies: CollaborationWsDependencies,
): CollaborationWsController {
  const { db, config } = dependencies;
  const hub = dependencies.hub ?? getRealtimeHub(db);
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    // Clients never send business messages on this event-only channel. Keep the
    // parser ceiling tiny so a valid ticket cannot be used to buffer large frames.
    maxPayload: 4_096,
  });
  const attempts = new Map<string, AttemptCounter>();
  const liveConnections = new Set<WebSocketRealtimeConnection>();

  const heartbeat = setInterval(() => {
    for (const connection of [...liveConnections]) connection.ping();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Invalid WebSocket URL');
      return;
    }
    if (url.pathname !== '/ws/collaboration') {
      rejectUpgrade(socket, 404, 'WebSocket route not found');
      return;
    }
    if (!isAllowedOrigin(req, config)) {
      rejectUpgrade(socket, 403, 'WebSocket Origin is not allowed');
      return;
    }

    const ipAddress = requestIp(req, config);
    if (config.rateLimitEnabled) {
      const now = Date.now();
      let counter = attempts.get(ipAddress);
      if (!counter || counter.resetAt <= now) {
        counter = { count: 0, resetAt: now + 60_000 };
        attempts.set(ipAddress, counter);
      }
      counter.count += 1;
      if (counter.count > MAX_CONNECT_ATTEMPTS_PER_IP_MINUTE) {
        const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1_000));
        rejectUpgrade(socket, 429, 'Too many WebSocket connection attempts', retryAfter);
        return;
      }
      if (attempts.size > 10_000) {
        for (const [key, value] of attempts) {
          if (value.resetAt <= now) attempts.delete(key);
          if (attempts.size <= 10_000) break;
        }
        while (attempts.size > 10_000) {
          const oldest = attempts.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          attempts.delete(oldest);
        }
      }
    }

    const ticket = url.searchParams.get('ticket');
    if (!ticket || ticket.length > 256) {
      rejectUpgrade(socket, 401, 'A valid one-time ticket is required');
      return;
    }
    const hash = ticketHash(ticket);
    const preview = readTicket(db, hash);
    const nowIso = new Date().toISOString();
    if (
      !preview ||
      preview.consumed_at ||
      preview.expires_at <= nowIso ||
      preview.removed_at ||
      preview.issued_role !== preview.role ||
      Number(preview.issued_membership_version) !== Number(preview.membership_version) ||
      preview.deleted_at
    ) {
      rejectUpgrade(socket, 401, 'A valid one-time ticket is required');
      return;
    }
    if (preview.event_seq - preview.after_seq > MAX_WS_BACKLOG_EVENTS) {
      rejectUpgrade(socket, 409, 'WebSocket backlog is too large; catch up through REST first');
      return;
    }
    if (hub.connectionCount({ sessionId: preview.session_id }) >= MAX_CONNECTIONS_PER_SESSION) {
      rejectUpgrade(socket, 429, 'Session WebSocket connection limit reached', 30);
      return;
    }
    if (hub.connectionCount({ userId: preview.user_id }) >= MAX_CONNECTIONS_PER_USER) {
      rejectUpgrade(socket, 429, 'User WebSocket connection limit reached', 30);
      return;
    }
    if (hub.connectionCount({ ipAddress }) >= MAX_CONNECTIONS_PER_IP) {
      rejectUpgrade(socket, 429, 'IP WebSocket connection limit reached', 30);
      return;
    }

    const consumed = consumeTicket(db, hash);
    if (!consumed) {
      rejectUpgrade(socket, 401, 'A valid one-time ticket is required');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, consumed, ipAddress);
    });
  };

  server.on('upgrade', upgrade);
  wss.on(
    'connection',
    (ws: WebSocket, _req: IncomingMessage, ticket: TicketRow, ipAddress: string) => {
      const connection = new WebSocketRealtimeConnection(
        ws,
        ticket.session_id,
        ticket.user_id,
        ipAddress,
        ticket.after_seq,
      );
      liveConnections.add(connection);
      connection.setUnsubscribe(hub.add(connection));
      ws.on('pong', () => connection.markPong());
      ws.on('message', () => ws.close(1008, 'WebSocket is an event-only transport'));
      ws.on('error', () => undefined);
      ws.once('close', () => {
        connection.dispose();
        liveConnections.delete(connection);
      });

      const current = db.prepare(`
        SELECT event_seq, min_retained_seq, deleted_at FROM sessions WHERE id = ?
      `).get(ticket.session_id) as {
        event_seq: number;
        min_retained_seq: number;
        deleted_at: string | null;
      } | undefined;
      if (!current) {
        connection.revoke('SESSION_DELETED');
        return;
      }
      connection.sendHello(current.event_seq);
      if (ticket.after_seq < current.min_retained_seq) {
        connection.resyncRequired(current.min_retained_seq);
        return;
      }
      if (current.event_seq - ticket.after_seq > MAX_WS_BACKLOG_EVENTS) {
        connection.resyncRequired(current.min_retained_seq);
        return;
      }
      const events = readEventsAfter(
        db,
        ticket.session_id,
        ticket.after_seq,
        MAX_WS_BACKLOG_EVENTS + 1,
      );
      if (events.length > MAX_WS_BACKLOG_EVENTS) {
        connection.resyncRequired(current.min_retained_seq);
        return;
      }
      connection.sendBacklog(events, current.event_seq);
      if (current.deleted_at) connection.sessionDeleted();
    },
  );

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', upgrade);
      for (const connection of [...liveConnections]) connection.close();
      liveConnections.clear();
      wss.close();
      attempts.clear();
    },
  };
}

/**
 * The legacy unversioned Log routes remain in the source tree for the old admin
 * bundle, but are not mounted. Their former unauthenticated broadcast channel is
 * deliberately a no-op so importing those modules cannot re-enable it.
 */
export function broadcast(_sessionId: string, _message: object): void {
  // Intentionally disabled.
}

export const collaborationWsInternals = {
  isAllowedOrigin,
  requestIp,
  ticketHash,
  MAX_WS_BACKLOG_EVENTS,
};
