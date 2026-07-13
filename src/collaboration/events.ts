import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

export type CollaborationEventType =
  | 'session.activated'
  | 'session.updated'
  | 'session.closed'
  | 'session.reopened'
  | 'session.deleted'
  | 'log.created'
  | 'log.updated'
  | 'log.deleted'
  | 'log.restored';

export interface CollaborationEvent {
  protocolVersion: 1;
  eventId: string;
  sessionId: string;
  seq: number;
  type: CollaborationEventType;
  entityType: 'session' | 'log';
  entityId: string;
  entityVersion: number;
  mutationId: string | null;
  actor: {
    userId: string;
    deviceId: string | null;
    displayName: string;
  };
  occurredAt: string;
  payload: unknown;
}

interface StoredEventRow {
  payload_json: string;
}

export function eventFromStoredRow(row: StoredEventRow): CollaborationEvent {
  return JSON.parse(row.payload_json) as CollaborationEvent;
}

export function appendSessionEvent(
  db: Database.Database,
  input: {
    sessionId: string;
    type: CollaborationEventType;
    entityType: 'session' | 'log';
    entityId: string;
    entityVersion: number;
    mutationId?: string;
    actorUserId: string;
    actorDeviceId?: string;
    payload: unknown;
    occurredAt?: string;
  },
): CollaborationEvent {
  if (!db.inTransaction) {
    throw new Error('Session events must be appended inside the entity transaction');
  }

  const sequenceUpdate = db.prepare(`
    UPDATE sessions
    SET event_seq = event_seq + 1
    WHERE id = ?
  `).run(input.sessionId);
  if (sequenceUpdate.changes !== 1) {
    throw new Error(`Cannot allocate an event sequence for Session ${input.sessionId}`);
  }
  const sequence = db.prepare('SELECT event_seq FROM sessions WHERE id = ?').get(
    input.sessionId,
  ) as { event_seq: number };
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(
    input.actorUserId,
  ) as { username: string } | undefined;
  if (!actor) throw new Error(`Cannot resolve event actor ${input.actorUserId}`);

  const event: CollaborationEvent = {
    protocolVersion: 1,
    eventId: randomUUID(),
    sessionId: input.sessionId,
    seq: Number(sequence.event_seq),
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    entityVersion: input.entityVersion,
    mutationId: input.mutationId ?? null,
    actor: {
      userId: input.actorUserId,
      deviceId: input.actorDeviceId ?? null,
      displayName: actor.username,
    },
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    payload: input.payload,
  };

  db.prepare(`
    INSERT INTO session_events (
      id, session_id, seq, type, entity_type, entity_id, entity_version,
      mutation_id, actor_user_id, actor_device_id, payload_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventId,
    event.sessionId,
    event.seq,
    event.type,
    event.entityType,
    event.entityId,
    event.entityVersion,
    event.mutationId,
    event.actor.userId,
    event.actor.deviceId,
    JSON.stringify(event),
    event.occurredAt,
  );
  return event;
}

export function readEventsAfter(
  db: Database.Database,
  sessionId: string,
  afterSeq: number,
  limit?: number,
): CollaborationEvent[] {
  const rows = (limit === undefined
    ? db.prepare(`
        SELECT payload_json FROM session_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq
      `).all(sessionId, afterSeq)
    : db.prepare(`
        SELECT payload_json FROM session_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?
      `).all(sessionId, afterSeq, limit)) as StoredEventRow[];
  return rows.map(eventFromStoredRow);
}
