import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

export interface GovernanceAuditInput {
  action: string;
  actorUserId: string;
  requestId: string;
  mutationId: string;
  targetType?: string;
  targetId?: string;
  sessionId?: string;
  reason?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  details?: Record<string, unknown>;
  occurredAt?: string;
}

export function appendGovernanceAudit(
  db: Database.Database,
  input: GovernanceAuditInput,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO admin_governance_audit_events (
      id, action, actor_user_id, target_type, target_id, session_id,
      request_id, mutation_id, reason, before_json, after_json,
      details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.action,
    input.actorUserId,
    input.targetType ?? null,
    input.targetId ?? null,
    input.sessionId ?? null,
    input.requestId,
    input.mutationId,
    input.reason ?? null,
    input.before === undefined || input.before === null
      ? null
      : JSON.stringify(input.before),
    input.after === undefined || input.after === null
      ? null
      : JSON.stringify(input.after),
    JSON.stringify(input.details ?? {}),
    input.occurredAt ?? new Date().toISOString(),
  );
  return id;
}

export function parseStoredObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored governance audit value is invalid');
  }
  return parsed as Record<string, unknown>;
}
