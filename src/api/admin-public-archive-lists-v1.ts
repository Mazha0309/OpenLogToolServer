import Database from 'better-sqlite3';
import { Router } from 'express';
import { requireCurrentAdmin } from './admin-v1';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { normalizePublicArchiveAlias } from '../public-archives/model';
import { assignArchiveListAlias } from '../public-archives/service';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface AdminPublicArchiveListsV1Dependencies { db?: Database.Database; config?: AppConfig; }

export function createAdminPublicArchiveListsV1Router(dependencies: AdminPublicArchiveListsV1Dependencies = {}): Router {
  const router = Router(); const database = () => dependencies.db ?? getDb();
  router.use(createAccessTokenMiddleware(dependencies.config ?? config, database));
  router.use((req: V1AuthRequest, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); requireCurrentAdmin(database(), req); next(); } catch (error) { next(error); } });
  router.use((req, _res, next) => { try { rejectUnknownKeys(req.query as Record<string, unknown>, []); next(); } catch (error) { next(error); } });
  router.put('/public-archive-lists/:listId/alias', (req: V1AuthRequest, res, next) => { try {
    const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['alias']); const alias = normalizePublicArchiveAlias(requireString(body, 'alias', { max: 63 }));
    res.json({ data: assignArchiveListAlias(database(), req.params.listId, { userId: req.auth!.userId, role: 'admin' }, alias) });
  } catch (error) { next(error); } });
  router.delete('/public-archive-lists/:listId/alias', (req, res, next) => { try { rejectUnknownKeys(requireJsonObject(req.body), []); database().prepare('DELETE FROM public_archive_aliases WHERE list_id = ?').run(req.params.listId); res.status(204).end(); } catch (error) { next(error); } });
  return router;
}
