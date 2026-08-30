import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { appendGovernanceAudit } from '../admin/governance-audit';
import {
  findSession,
  normalizeStableId,
  requireMembership,
  SessionRow,
  MembershipRow,
} from '../collaboration/access';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import {
  buildCorrectionPreview,
  ExcelCorrectionPreview,
  extractWorkbookRecords,
  parseWorkbookInput,
} from '../excel-corrections/service';
import {
  HttpJsonCompletionClient,
  JsonCompletionClient,
  llmPublicConfiguration,
  requireLlmConfigured,
} from '../llm/json-client';
import { llmCredentialStatus, resolveLlmApiKey } from '../llm/credential-store';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';
import {
  LogRow,
  mutateLog,
  MutationOperation,
  readLog,
} from './collaboration-sync-v1';

export interface ExcelCorrectionsV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
  createClient?: (config: AppConfig) => JsonCompletionClient;
}

interface PreviewRow {
  id: string;
  session_id: string;
  created_by: string;
  provider: Exclude<AppConfig['llmProvider'], 'disabled'>;
  model: string;
  preview_json: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
}

interface StoredPreview extends ExcelCorrectionPreview {
  formatVersion: 1;
}

const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_SESSION_LOGS = 1_000;

function noLimit(): RequestHandler {
  return (_req, _res, next) => next();
}

function correctionAccess(
  db: Database.Database,
  sessionId: string,
  userId: string,
  accountRole: string,
): { session: SessionRow; membership: MembershipRow; administrative: boolean } {
  if (accountRole === 'admin') {
    const session = requireAdministratorSession(db, sessionId);
    if (session.status !== 'active' && session.status !== 'closed') {
      throw new AppError(
        409,
        'SESSION_NOT_CORRECTABLE',
        'Only active or closed Sessions can be corrected by an administrator',
      );
    }
    const now = new Date().toISOString();
    return {
      session,
      membership: {
        id: `admin:${userId}`,
        session_id: session.id,
        user_id: userId,
        role: 'owner',
        version: 1,
        created_at: now,
        updated_at: now,
        removed_at: null,
      },
      administrative: true,
    };
  }
  const access = requireMembership(db, sessionId, userId, ['owner', 'editor']);
  if (access.session.status === 'active') return { ...access, administrative: false };
  if (access.session.status === 'closed' && access.membership.role === 'owner') {
    return { ...access, administrative: true };
  }
  if (access.session.status === 'closed') {
    throw new AppError(
      403,
      'EXCEL_CORRECTION_OWNER_REQUIRED',
      'Only the Session owner can correct a closed Session',
    );
  }
  throw new AppError(
    409,
    'SESSION_NOT_CORRECTABLE',
    'Only active Sessions, or closed Sessions owned by the current user, can be corrected',
  );
}

function requireAdministratorSession(
  db: Database.Database,
  sessionId: string,
): SessionRow {
  const session = findSession(db, sessionId);
  if (!session) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  if (session.deleted_at) {
    throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
      deletedAt: session.deleted_at,
      finalSeq: session.event_seq,
    });
  }
  return session;
}

function deviceId(req: V1AuthRequest): string {
  const raw = req.header('x-device-id');
  return raw ? normalizeStableId(raw, 'X-Device-Id') : 'web-excel-correction';
}

function readPreview(value: string): StoredPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AppError(500, 'EXCEL_CORRECTION_PREVIEW_INVALID', 'Stored correction preview is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(500, 'EXCEL_CORRECTION_PREVIEW_INVALID', 'Stored correction preview is invalid');
  }
  const preview = parsed as Partial<StoredPreview>;
  if (preview.formatVersion !== 1 || !Array.isArray(preview.proposals) || !preview.summary) {
    throw new AppError(500, 'EXCEL_CORRECTION_PREVIEW_INVALID', 'Stored correction preview is invalid');
  }
  return preview as StoredPreview;
}

function parseProposalIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.proposalIds) || body.proposalIds.length < 1 || body.proposalIds.length > 1_000) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'proposalIds must contain between 1 and 1000 proposal IDs',
    );
  }
  const ids = body.proposalIds.map((value, index) =>
    normalizeStableId(value, `proposalIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new AppError(422, 'VALIDATION_FAILED', 'proposalIds must not contain duplicates');
  }
  return ids;
}

function cleanupPreviews(db: Database.Database, now: string): void {
  const appliedCutoff = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  db.prepare(`
    DELETE FROM llm_excel_correction_previews
    WHERE expires_at < ? OR (applied_at IS NOT NULL AND applied_at < ?)
  `).run(now, appliedCutoff);
}

export function createExcelCorrectionsV1Router(
  dependencies: ExcelCorrectionsV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const createClient = dependencies.createClient ?? ((value: AppConfig) =>
    new HttpJsonCompletionClient(value));
  const previewLimiter = createMemoryRateLimiter({
    windowMs: 5 * 60_000,
    max: 4,
    keyGenerator: (req) =>
      `${(req as V1AuthRequest).auth?.userId ?? 'unknown'}:${req.params.sessionId ?? ''}`,
    message: 'Too many Excel correction previews; retry later',
  });
  const applyLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) =>
      `${(req as V1AuthRequest).auth?.userId ?? 'unknown'}:${req.params.sessionId ?? ''}`,
    message: 'Too many Excel correction apply requests; retry later',
  });

  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/:sessionId/excel-corrections/capabilities', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const access = req.auth!.role === 'admin'
        ? {
            session: requireAdministratorSession(database(), sessionId),
            membership: { role: 'owner' as const },
          }
        : requireMembership(database(), sessionId, req.auth!.userId);
      const credential = llmCredentialStatus(database(), runtimeConfig);
      const llm = llmPublicConfiguration(
        runtimeConfig,
        credential.configured ? 'configured' : '',
      );
      res.json({
        configured: llm.configured,
        provider: llm.provider,
        model: llm.model,
        maxWorkbookRows: 1_000,
        previewExpiresInSeconds: PREVIEW_TTL_MS / 1_000,
        canPreview: access.membership.role !== 'viewer' && (
          access.session.status === 'active' ||
          (access.session.status === 'closed' && (
            access.membership.role === 'owner' || req.auth!.role === 'admin'
          ))
        ),
        closedSessionRequiresOwner: req.auth!.role !== 'admin',
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/:sessionId/excel-corrections/preview',
    runtimeConfig.rateLimitEnabled ? previewLimiter : noLimit(),
    async (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const db = database();
        correctionAccess(db, sessionId, req.auth!.userId, req.auth!.role);
        const apiKey = resolveLlmApiKey(db, runtimeConfig);
        requireLlmConfigured(runtimeConfig, apiKey);
        const workbook = parseWorkbookInput(req.body);
        const logs = db.prepare(`
          SELECT * FROM logs
          WHERE session_id = ? AND deleted_at IS NULL
          ORDER BY time ASC, id ASC
        `).all(sessionId) as LogRow[];
        if (logs.length === 0) {
          throw new AppError(409, 'SESSION_HAS_NO_LOGS', 'The Session has no existing Logs to correct');
        }
        if (logs.length > MAX_SESSION_LOGS) {
          throw new AppError(
            413,
            'SESSION_TOO_LARGE_FOR_LLM_CORRECTION',
            `The Session exceeds the ${MAX_SESSION_LOGS}-Log correction limit`,
          );
        }
        const requestConfig: AppConfig = { ...runtimeConfig, llmApiKey: apiKey };
        const extracted = await extractWorkbookRecords(workbook, createClient(requestConfig));
        const preview = buildCorrectionPreview(workbook, extracted, logs);
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.parse(now) + PREVIEW_TTL_MS).toISOString();
        const previewId = preview.proposals.length > 0 ? randomUUID() : null;
        if (previewId) {
          const provider = runtimeConfig.llmProvider;
          if (provider === 'disabled') {
            throw new AppError(503, 'LLM_NOT_CONFIGURED', 'The server LLM is disabled');
          }
          db.transaction(() => {
            cleanupPreviews(db, now);
            db.prepare(`
              INSERT INTO llm_excel_correction_previews (
                id, session_id, created_by, provider, model, preview_json,
                created_at, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              previewId,
              sessionId,
              req.auth!.userId,
              provider,
              runtimeConfig.llmModel,
              JSON.stringify({ formatVersion: 1, ...preview } satisfies StoredPreview),
              now,
              expiresAt,
            );
          }).immediate();
        }
        res.status(201).json({
          previewId,
          expiresAt: previewId ? expiresAt : null,
          llm: { provider: runtimeConfig.llmProvider, model: runtimeConfig.llmModel },
          ...preview,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:sessionId/excel-corrections/apply',
    runtimeConfig.rateLimitEnabled ? applyLimiter : noLimit(),
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['previewId', 'proposalIds']);
        const previewId = normalizeStableId(body.previewId, 'previewId');
        const proposalIds = parseProposalIds(body);
        const idempotencyKey = requireIdempotencyKey(req);
        const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
        const db = database();
        const now = new Date().toISOString();
        const events: NonNullable<ReturnType<typeof mutateLog>['event']>[] = [];

        const result = db.transaction(() => {
          const replay = readStoredResponse(db, idempotencyKey, req.auth!.userId, requestHash);
          if (replay) return { status: replay.status, body: replay.body, replay: true };
          const access = correctionAccess(db, sessionId, req.auth!.userId, req.auth!.role);
          const row = db.prepare(`
            SELECT * FROM llm_excel_correction_previews
            WHERE id = ? AND session_id = ? AND created_by = ?
          `).get(previewId, sessionId, req.auth!.userId) as PreviewRow | undefined;
          if (!row) throw new AppError(404, 'EXCEL_CORRECTION_PREVIEW_NOT_FOUND', 'Correction preview not found');
          if (row.applied_at) {
            throw new AppError(409, 'EXCEL_CORRECTION_PREVIEW_APPLIED', 'Correction preview was already applied', {
              appliedAt: row.applied_at,
            });
          }
          if (row.expires_at <= now) {
            throw new AppError(410, 'EXCEL_CORRECTION_PREVIEW_EXPIRED', 'Correction preview has expired');
          }
          const preview = readPreview(row.preview_json);
          const byId = new Map(preview.proposals.map((proposal) => [proposal.proposalId, proposal]));
          const selected = proposalIds.map((proposalId) => {
            const proposal = byId.get(proposalId);
            if (!proposal) {
              throw new AppError(
                422,
                'EXCEL_CORRECTION_PROPOSAL_INVALID',
                'A selected proposal does not belong to this preview',
                { proposalId },
              );
            }
            return proposal;
          });

          for (const proposal of selected) {
            const current = readLog(db, sessionId, proposal.syncId);
            if (!current || current.deleted_at || current.version !== proposal.target.version) {
              throw new AppError(
                409,
                'EXCEL_CORRECTION_VERSION_CONFLICT',
                'A target Log changed after the preview was generated; create a new preview',
                {
                  syncId: proposal.syncId,
                  expectedVersion: proposal.target.version,
                  currentVersion: current?.version ?? null,
                },
              );
            }
          }

          const applied: Array<{ proposalId: string; syncId: string; version: number }> = [];
          for (const proposal of selected) {
            const operation: MutationOperation = {
              raw: {
                mutationId: proposal.proposalId,
                entityType: 'log',
                entityId: proposal.syncId,
                operation: 'update',
                baseVersion: proposal.target.version,
                patch: proposal.patch,
              },
              mutationId: proposal.proposalId,
              entityType: 'log',
              entityId: proposal.syncId,
              operation: 'update',
              baseVersion: proposal.target.version,
            };
            const outcome = mutateLog(
              db,
              access.session,
              access.membership,
              operation,
              req.auth!.userId,
              deviceId(req),
              { administrative: access.administrative },
            );
            if (outcome.result.status !== 'accepted' || !outcome.event) {
              throw new AppError(
                409,
                'EXCEL_CORRECTION_APPLY_CONFLICT',
                'A correction could not be applied atomically; create a new preview',
                { proposalId: proposal.proposalId, result: outcome.result },
              );
            }
            events.push(outcome.event);
            applied.push({
              proposalId: proposal.proposalId,
              syncId: proposal.syncId,
              version: outcome.event.entityVersion,
            });
          }
          db.prepare(`
            UPDATE llm_excel_correction_previews SET applied_at = ?
            WHERE id = ? AND applied_at IS NULL
          `).run(now, previewId);
          if (req.auth!.role === 'admin') {
            appendGovernanceAudit(db, {
              action: 'session.excel_corrections.apply',
              actorUserId: req.auth!.userId,
              requestId: getRequestId(req),
              mutationId: idempotencyKey,
              targetType: 'session',
              targetId: sessionId,
              sessionId,
              details: {
                previewId,
                appliedCount: applied.length,
                proposalIds,
                logs: applied.map((item) => ({
                  syncId: item.syncId,
                  version: item.version,
                })),
              },
            });
          }
          const response = { previewId, appliedAt: now, appliedCount: applied.length, applied };
          storeResponse(db, {
            mutationId: idempotencyKey,
            sessionId,
            userId: req.auth!.userId,
            deviceId: deviceId(req),
            requestHash,
            status: 200,
            body: response,
          });
          return { status: 200, body: response, replay: false };
        }).immediate();

        if (!result.replay) {
          const hub = getRealtimeHub(db);
          for (const event of events) hub.publish(event);
        } else {
          res.setHeader('Idempotent-Replay', 'true');
        }
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const excelCorrectionsV1Router = createExcelCorrectionsV1Router();
