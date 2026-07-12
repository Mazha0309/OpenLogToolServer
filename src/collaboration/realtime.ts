import Database from 'better-sqlite3';
import { CollaborationEvent } from './events';
import { getRuntimeMetrics } from '../operations/metrics';

export interface CollaborationControlMessage {
  readonly type:
    | 'liveDraft.updated'
    | 'liveDraft.lockChanged'
    | 'liveDraft.cleared'
    | 'liveDraft.committed';
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly [key: string]: unknown;
}

export interface RealtimeConnection {
  readonly audience?: 'member' | 'public';
  readonly sessionId: string;
  readonly userId?: string;
  readonly publicShareId?: string;
  readonly ipAddress: string;
  deliver(event: CollaborationEvent): void;
  deliverControl(message: CollaborationControlMessage): void;
  revoke(reason: string): void;
  membershipChanged(role: string, membershipVersion: number): void;
  sessionDeleted(): void;
  close(): void;
}

export class CollaborationRealtimeHub {
  private readonly connections = new Set<RealtimeConnection>();

  constructor(private readonly db: Database.Database) {}

  add(connection: RealtimeConnection): () => void {
    this.connections.add(connection);
    return () => this.connections.delete(connection);
  }

  publish(event: CollaborationEvent): void {
    getRuntimeMetrics(this.db).recordEventCommitted(event.type);
    for (const connection of [...this.connections]) {
      if (connection.sessionId !== event.sessionId) continue;
      try {
        connection.deliver(event);
      } catch {
        this.connections.delete(connection);
        try {
          connection.close();
        } catch {
          // A broken transport must never escape into the committed mutation path.
        }
      }
    }
  }

  publishControl(message: CollaborationControlMessage): void {
    for (const connection of [...this.connections]) {
      if (connection.audience !== 'member' || connection.sessionId !== message.sessionId) continue;
      try {
        connection.deliverControl(message);
      } catch {
        this.connections.delete(connection);
        try {
          connection.close();
        } catch {
          // A broken member control transport is isolated from the API response.
        }
      }
    }
  }

  revoke(sessionId: string, userId: string, reason = 'MEMBERSHIP_REVOKED'): void {
    for (const connection of [...this.connections]) {
      if (connection.sessionId === sessionId && connection.userId === userId) {
        try {
          connection.revoke(reason);
        } catch {
          this.connections.delete(connection);
          try {
            connection.close();
          } catch {
            // Ignore transport cleanup errors.
          }
        }
      }
    }
  }

  roleChanged(
    sessionId: string,
    userId: string,
    role: string,
    membershipVersion: number,
  ): void {
    for (const connection of [...this.connections]) {
      if (connection.sessionId === sessionId && connection.userId === userId) {
        try {
          connection.membershipChanged(role, membershipVersion);
        } catch {
          this.connections.delete(connection);
          try {
            connection.close();
          } catch {
            // Ignore transport cleanup errors.
          }
        }
      }
    }
  }

  sessionDeleted(sessionId: string): void {
    for (const connection of [...this.connections]) {
      if (connection.sessionId !== sessionId) continue;
      this.connections.delete(connection);
      try {
        connection.sessionDeleted();
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors after the final event was committed.
        }
      }
    }
  }

  revokePublicShare(publicShareId: string): void {
    for (const connection of [...this.connections]) {
      if (connection.publicShareId !== publicShareId) continue;
      this.connections.delete(connection);
      try {
        connection.revoke('PUBLIC_SHARE_REVOKED');
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors after capability revocation committed.
        }
      }
    }
  }

  connectionCount(filter: {
    audience?: 'member' | 'public';
    sessionId?: string;
    userId?: string;
    publicShareId?: string;
    ipAddress?: string;
  }): number {
    let count = 0;
    for (const connection of this.connections) {
      if (filter.audience !== undefined && connection.audience !== filter.audience) continue;
      if (filter.sessionId !== undefined && connection.sessionId !== filter.sessionId) continue;
      if (filter.userId !== undefined && connection.userId !== filter.userId) continue;
      if (
        filter.publicShareId !== undefined &&
        connection.publicShareId !== filter.publicShareId
      ) continue;
      if (filter.ipAddress !== undefined && connection.ipAddress !== filter.ipAddress) continue;
      count += 1;
    }
    return count;
  }

  closeAll(): void {
    for (const connection of [...this.connections]) {
      try {
        connection.close();
      } catch {
        // Best-effort shutdown of independently failing transports.
      }
    }
    this.connections.clear();
  }
}

const hubs = new WeakMap<Database.Database, CollaborationRealtimeHub>();

export function getRealtimeHub(db: Database.Database): CollaborationRealtimeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = new CollaborationRealtimeHub(db);
    hubs.set(db, hub);
  }
  return hub;
}
