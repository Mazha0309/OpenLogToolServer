import Database from 'better-sqlite3';
import { NextFunction, RequestHandler, Response } from 'express';
import { getDb } from '../db/database';
import { AuthRequest } from './auth';

interface CurrentUserRow {
  role: string;
}

function requireCurrentAdmin(
  db: Database.Database,
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const currentUser = req.userId
    ? db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as
        | CurrentUserRow
        | undefined
    : undefined;
  if (req.userRole !== 'admin' || currentUser?.role !== 'admin') {
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
