import Database from 'better-sqlite3';
import { CollaborationEvent } from './events';

export interface RealtimeConnection {
  readonly sessionId: string;
  readonly userId: string;
  readonly ipAddress: string;
  deliver(event: CollaborationEvent): void;
  revoke(reason: string): void;
  membershipChanged(role: string, membershipVersion: number): void;
  sessionDeleted(): void;
  close(): void;
}

export class CollaborationRealtimeHub {
  private readonly connections = new Set<RealtimeConnection>();

  add(connection: RealtimeConnection): () => void {
    this.connections.add(connection);
    return () => this.connections.delete(connection);
  }

  publish(event: CollaborationEvent): void {
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

  connectionCount(filter: { sessionId?: string; userId?: string; ipAddress?: string }): number {
    let count = 0;
    for (const connection of this.connections) {
      if (filter.sessionId !== undefined && connection.sessionId !== filter.sessionId) continue;
      if (filter.userId !== undefined && connection.userId !== filter.userId) continue;
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
    hub = new CollaborationRealtimeHub();
    hubs.set(db, hub);
  }
  return hub;
}
