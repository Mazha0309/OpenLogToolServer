import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
