import Database from 'better-sqlite3';
import { Router } from 'express';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import {
  PublicArchiveLogRow,
  PublicArchiveSessionRow,
  publicArchiveListDto,
  publicArchiveLogDto,
  publicArchiveSessionDto,
} from '../public-archives/model';
import { rejectUnknownKeys } from '../utils/validation';

export interface PublicArchivesV1Dependencies { db?: Database.Database; }
const unavailable = () => new AppError(404, 'NOT_FOUND', 'Resource not found');

export function createPublicArchivesV1Router(dependencies: PublicArchivesV1Dependencies = {}): Router {
  const router = Router(); const database = () => dependencies.db ?? getDb();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use((req, _res, next) => { try { rejectUnknownKeys(req.query as Record<string, unknown>, []); next(); } catch (error) { next(error); } });
  const listBy = (column: 'id' | 'alias', value: string) => {
    const sql = column === 'id'
      ? 'SELECT l.id, l.title FROM public_archive_lists l WHERE l.id = ? AND l.is_published = 1 AND l.deleted_at IS NULL'
      : 'SELECT l.id, l.title FROM public_archive_aliases a JOIN public_archive_lists l ON l.id = a.list_id WHERE a.alias = ? AND l.is_published = 1 AND l.deleted_at IS NULL';
    return database().prepare(sql).get(value) as { id: string; title: string } | undefined;
  };
  const list = (column: 'id' | 'alias') => (req: any, res: any, next: any) => { try { const archive = listBy(column, req.params[column === 'id' ? 'listId' : 'alias'].toLowerCase()); if (!archive) throw unavailable(); const sessions = database().prepare('SELECT s.id, s.title, s.closed_at, s.display_order, COUNT(l.archive_session_id) AS log_count FROM public_archive_list_sessions s LEFT JOIN public_archive_list_logs l ON l.archive_session_id = s.id WHERE s.list_id = ? GROUP BY s.id ORDER BY s.display_order, s.closed_at DESC').all(archive.id) as PublicArchiveSessionRow[]; res.json({ data: { ...publicArchiveListDto(archive), sessions: sessions.map(publicArchiveSessionDto) } }); } catch (error) { next(error); } };
  const detail = (column: 'id' | 'alias') => (req: any, res: any, next: any) => { try { const archive = listBy(column, req.params[column === 'id' ? 'listId' : 'alias'].toLowerCase()); if (!archive) throw unavailable(); const session = database().prepare('SELECT s.id, s.title, s.closed_at, s.display_order, COUNT(l.archive_session_id) AS log_count FROM public_archive_list_sessions s LEFT JOIN public_archive_list_logs l ON l.archive_session_id = s.id WHERE s.list_id = ? AND s.id = ? GROUP BY s.id').get(archive.id, req.params.archiveSessionId) as PublicArchiveSessionRow | undefined; if (!session) throw unavailable(); const logs = database().prepare('SELECT ordinal, time, controller, callsign, rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(session.id) as PublicArchiveLogRow[]; res.json({ data: { session: publicArchiveSessionDto(session), logs: logs.map(publicArchiveLogDto) } }); } catch (error) { next(error); } };
  router.get('/archive-lists/:listId', list('id')); router.get('/archive-lists/:listId/sessions/:archiveSessionId', detail('id'));
  router.get('/archive-aliases/:alias', list('alias')); router.get('/archive-aliases/:alias/sessions/:archiveSessionId', detail('alias'));
  return router;
}
