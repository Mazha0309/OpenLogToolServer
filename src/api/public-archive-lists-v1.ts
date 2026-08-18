import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { ArchiveActor } from '../public-archives/access';
import {
  addArchiveMember, addArchiveSource, createArchiveList, createArchiveSnapshot, getArchiveList,
  listArchiveLists, listAvailableArchiveSessions, publishArchiveList, refreshArchiveSnapshot,
  removeArchiveMember, removeArchiveSession, removeArchiveSource, reorderArchiveSessions,
  softDeleteArchiveList, unpublishArchiveList, updateArchiveListTitle,
} from '../public-archives/service';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface PublicArchiveListsV1Dependencies { db?: Database.Database; config?: AppConfig; }

function actor(req: V1AuthRequest): ArchiveActor {
  if (!req.auth || (req.auth.role !== 'admin' && req.auth.role !== 'user')) {
    throw new AppError(401, 'AUTH_REQUIRED', 'A Bearer access token is required');
  }
  return { userId: req.auth.userId, role: req.auth.role };
}

function query(req: V1AuthRequest): { page: number; pageSize: number; source?: 'personal' | 'collaboration' } {
  rejectUnknownKeys(req.query as Record<string, unknown>, ['page', 'pageSize', 'source']);
  const integer = (field: 'page' | 'pageSize', fallback: number, maximum: number) => {
    const value = req.query[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
      throw new AppError(422, 'VALIDATION_FAILED', `${field} is outside the allowed range`, { field });
    }
    return Number(value);
  };
  const source = req.query.source;
  if (source !== undefined && source !== 'personal' && source !== 'collaboration') {
    throw new AppError(422, 'VALIDATION_FAILED', 'source must be personal or collaboration', { field: 'source' });
  }
  return { page: integer('page', 1, 10_000), pageSize: integer('pageSize', 25, 100), ...(source === undefined ? {} : { source }) };
}

function noBody(req: V1AuthRequest): void { rejectUnknownKeys(requireJsonObject(req.body), []); }

export function createPublicArchiveListsV1Router(dependencies: PublicArchiveListsV1Dependencies = {}): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  router.use(createAccessTokenMiddleware(dependencies.config ?? config, database));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use((req, _res, next) => {
    try {
      const allowed = req.method === 'GET' && req.path === '/'
        ? ['page', 'pageSize']
        : req.method === 'GET' && req.path.endsWith('/available-sessions')
          ? ['page', 'pageSize', 'source']
          : [];
      rejectUnknownKeys(req.query as Record<string, unknown>, allowed);
      next();
    } catch (error) { next(error); }
  });

  router.get('/', (req: V1AuthRequest, res, next) => { try { const { page, pageSize } = query(req); const items = listArchiveLists(database(), actor(req)); const total = items.length; res.json({ data: { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }); } catch (error) { next(error); } });
  router.post('/', (req: V1AuthRequest, res, next) => { try { const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['title']); res.status(201).json({ data: createArchiveList(database(), actor(req), requireString(body, 'title', { max: 256 })) }); } catch (error) { next(error); } });
  router.get('/:listId', (req: V1AuthRequest, res, next) => { try { const list = getArchiveList(database(), req.params.listId, actor(req)); if (!list) throw new AppError(404, 'NOT_FOUND', 'Archive list was not found'); res.json({ data: list }); } catch (error) { next(error); } });
  router.patch('/:listId', (req: V1AuthRequest, res, next) => { try { const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['title']); res.json({ data: updateArchiveListTitle(database(), req.params.listId, actor(req), requireString(body, 'title', { max: 256 })) }); } catch (error) { next(error); } });
  router.delete('/:listId', (req: V1AuthRequest, res, next) => { try { noBody(req); softDeleteArchiveList(database(), req.params.listId, actor(req)); res.status(204).end(); } catch (error) { next(error); } });
  router.post('/:listId/publish', (req: V1AuthRequest, res, next) => { try { noBody(req); publishArchiveList(database(), req.params.listId, actor(req)); res.json({ data: getArchiveList(database(), req.params.listId, actor(req)) }); } catch (error) { next(error); } });
  router.post('/:listId/unpublish', (req: V1AuthRequest, res, next) => { try { noBody(req); unpublishArchiveList(database(), req.params.listId, actor(req)); res.json({ data: getArchiveList(database(), req.params.listId, actor(req)) }); } catch (error) { next(error); } });

  for (const [kind, add, remove] of [['sources', addArchiveSource, removeArchiveSource], ['members', addArchiveMember, removeArchiveMember]] as const) {
    router.get(`/:listId/${kind}`, (req: V1AuthRequest, res, next) => { try { rejectUnknownKeys(req.query as Record<string, unknown>, []); const list = getArchiveList(database(), req.params.listId, actor(req)); if (!list) throw new AppError(404, 'NOT_FOUND', 'Archive list was not found'); const rows = database().prepare(`SELECT user_id FROM public_archive_list_${kind} WHERE list_id = ? ORDER BY user_id`).all(req.params.listId).map((row) => ({ userId: (row as { user_id: string }).user_id })); res.json({ data: rows }); } catch (error) { next(error); } });
    router.put(`/:listId/${kind}/:userId`, (req: V1AuthRequest, res, next) => { try { noBody(req); add(database(), req.params.listId, actor(req), req.params.userId); res.status(204).end(); } catch (error) { next(error); } });
    router.delete(`/:listId/${kind}/:userId`, (req: V1AuthRequest, res, next) => { try { noBody(req); remove(database(), req.params.listId, actor(req), req.params.userId); res.status(204).end(); } catch (error) { next(error); } });
  }

  router.get('/:listId/available-sessions', (req: V1AuthRequest, res, next) => { try { res.json({ data: listAvailableArchiveSessions(database(), req.params.listId, actor(req), { ...query(req), includeDeleted: false }) }); } catch (error) { next(error); } });
  const createSnapshot = (req: V1AuthRequest, res: Parameters<typeof router.post>[1] extends (req: never, res: infer R) => unknown ? R : never, next: (error?: unknown) => void) => { try { const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['sourceUserId', 'sourceKind', 'sourceSessionId']); const sourceKind = requireString(body, 'sourceKind'); if (sourceKind !== 'personal' && sourceKind !== 'collaboration') throw new AppError(422, 'VALIDATION_FAILED', 'sourceKind must be personal or collaboration'); res.status(201).json({ data: createArchiveSnapshot(database(), req.params.listId, actor(req), { sourceUserId: requireString(body, 'sourceUserId', { max: 128 }), sourceKind, sourceSessionId: requireString(body, 'sourceSessionId', { max: 128 }) }) }); } catch (error) { next(error); } };
  router.post('/:listId/sessions', createSnapshot);
  const refresh = (req: V1AuthRequest, res: any, next: (error?: unknown) => void) => { try { noBody(req); res.json({ data: refreshArchiveSnapshot(database(), req.params.listId, req.params.archiveSessionId, actor(req)) }); } catch (error) { next(error); } };
  router.put('/:listId/sessions/:archiveSessionId/refresh', refresh);
  const order = (req: V1AuthRequest, res: any, next: (error?: unknown) => void) => { try { const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['archiveSessionIds']); if (!Array.isArray(body.archiveSessionIds) || body.archiveSessionIds.some((id) => typeof id !== 'string')) throw new AppError(422, 'VALIDATION_FAILED', 'archiveSessionIds must be an array of strings'); reorderArchiveSessions(database(), req.params.listId, actor(req), body.archiveSessionIds); res.status(204).end(); } catch (error) { next(error); } };
  router.patch('/:listId/sessions/order', order);
  const removeSnapshot = (req: V1AuthRequest, res: any, next: (error?: unknown) => void) => { try { noBody(req); removeArchiveSession(database(), req.params.listId, req.params.archiveSessionId, actor(req)); res.status(204).end(); } catch (error) { next(error); } };
  router.delete('/:listId/sessions/:archiveSessionId', removeSnapshot);
  return router;
}
