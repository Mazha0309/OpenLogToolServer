import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { Request } from 'express';
import { AppError } from '../errors/app-error';

interface StoredMutationRow {
  user_id: string;
  request_hash: string;
  status_code: number;
  response_json: string;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function requireIdempotencyKey(req: Request): string {
  const value = req.header('idempotency-key')?.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must be a non-empty safe identifier',
    );
  }
  return value;
}

export function computeRequestHash(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${JSON.stringify(canonicalize(body))}`)
    .digest('hex');
}

export function readStoredResponse(
  db: Database.Database,
  mutationId: string,
  userId: string,
  requestHash: string,
): StoredResponse | undefined {
  const row = db.prepare(`
    SELECT user_id, request_hash, status_code, response_json
    FROM processed_mutations
    WHERE mutation_id = ?
  `).get(mutationId) as StoredMutationRow | undefined;
  if (!row) return undefined;
  if (row.user_id !== userId || row.request_hash !== requestHash) {
    throw new AppError(
      409,
      'MUTATION_ID_REUSED',
      'The idempotency key was already used for a different request',
    );
  }
  return { status: row.status_code, body: JSON.parse(row.response_json) };
}

export function storeResponse(
  db: Database.Database,
  input: {
    mutationId: string;
    sessionId?: string;
    userId: string;
    deviceId?: string;
    requestHash: string;
    status: number;
    body: unknown;
  },
): void {
  db.prepare(`
    INSERT INTO processed_mutations (
      mutation_id, session_id, user_id, device_id, request_hash,
      status_code, response_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.mutationId,
    input.sessionId ?? null,
    input.userId,
    input.deviceId ?? null,
    input.requestHash,
    input.status,
    JSON.stringify(input.body),
    new Date().toISOString(),
  );
}
