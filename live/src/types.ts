export interface PublicSession {
  sessionId: string;
  title: string;
  status: string;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface PublicLog {
  syncId: string;
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  deletedAt: string | null;
}

export interface PublicEvent {
  protocolVersion: 1;
  eventId: string;
  sessionId: string;
  seq: number;
  type: string;
  entityType: 'session' | 'log';
  entityId: string;
  occurredAt: string;
  payload: PublicSession | PublicLog;
}

export type LivePhase =
  | 'initializing'
  | 'loadingSnapshot'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'ended'
  | 'fatal';

export type FatalReason =
  | 'invalidLink'
  | 'unavailable'
  | 'unsupported'
  | 'snapshotTooLarge'
  | 'protocolError';

export interface LiveshareState {
  phase: LivePhase;
  fatalReason?: FatalReason;
  session?: PublicSession;
  logs: PublicLog[];
  cursor: number;
  shareExpiresAt?: string;
  lastSyncedAt?: string;
  retryAttempt: number;
}
