import Database from 'better-sqlite3';
import { Router } from 'express';
import { requireCurrentAdmin } from './admin-v1';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { normalizePublicArchiveAlias } from '../public-archives/model';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface AdminPublicArchiveListsV1Dependencies { db?: Database.Database; config?: AppConfig; }

export function createAdminPublicArchiveListsV1Router(dependencies: AdminPublicArchiveListsV1Dependencies = {}): Router {
  const router = Router(); const database = () => dependencies.db ?? getDb();
  router.use(createAccessTokenMiddleware(dependencies.config ?? config, database));
  router.use((req: V1AuthRequest, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); requireCurrentAdmin(database(), req); next(); } catch (error) { next(error); } });
  router.put('/public-archive-lists/:listId/alias', (req: V1AuthRequest, res, next) => { try {
    const body = requireJsonObject(req.body); rejectUnknownKeys(body, ['alias']); const alias = normalizePublicArchiveAlias(requireString(body, 'alias', { max: 63 }));
    const list = database().prepare('SELECT id, title FROM public_archive_lists WHERE id = ? AND deleted_at IS NULL').get(req.params.listId) as { id: string; title: string } | undefined;
    if (!list) throw new AppError(404, 'NOT_FOUND', 'Archive list was not found');
    const existing = database().prepare('SELECT list_id FROM public_archive_aliases WHERE alias = ?').get(alias) as { list_id: string } | undefined;
    if (existing && existing.list_id !== list.id) throw new AppError(409, 'ARCHIVE_ALIAS_TAKEN', 'Archive alias is already taken');
    const timestamp = new Date().toISOString(); database().prepare('INSERT INTO public_archive_aliases (alias, list_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(list_id) DO UPDATE SET alias = excluded.alias, created_by = excluded.created_by, updated_at = excluded.updated_at').run(alias, list.id, req.auth!.userId, timestamp, timestamp);
    res.json({ data: { ...list, alias } });
  } catch (error) { next(error); } });
  router.delete('/public-archive-lists/:listId/alias', (req, res, next) => { try { rejectUnknownKeys(requireJsonObject(req.body), []); database().prepare('DELETE FROM public_archive_aliases WHERE list_id = ?').run(req.params.listId); res.status(204).end(); } catch (error) { next(error); } });
  return router;
}
