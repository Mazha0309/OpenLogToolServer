import Database from 'better-sqlite3';
import { NextFunction, RequestHandler, Response } from 'express';
import { getDb } from '../db/database';
import { AuthRequest } from './auth';

interface CurrentUserRow {
  role: string;
  disabled_at: string | null;
  deleted_at: string | null;
  must_change_password: number;
}

function requireCurrentAdmin(
  db: Database.Database,
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const currentUser = req.userId
    ? db.prepare(`
        SELECT role, disabled_at, deleted_at, must_change_password
        FROM users WHERE id = ?
      `).get(req.userId) as
        | CurrentUserRow
        | undefined
    : undefined;
  if (
    req.userRole !== 'admin' ||
    currentUser?.role !== 'admin' ||
    currentUser.disabled_at ||
    currentUser.deleted_at ||
    Number(currentUser.must_change_password) === 1
  ) {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  next();
}

export function createAdminMiddleware(db: Database.Database): RequestHandler {
  return (req: AuthRequest, res, next) => requireCurrentAdmin(db, req, res, next);
}

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  requireCurrentAdmin(getDb(), req, res, next);
}
