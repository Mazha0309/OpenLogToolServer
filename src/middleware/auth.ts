import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { AppConfig, config } from '../config';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

type LegacyAuthConfig = Pick<AppConfig, 'jwtSecret' | 'jwtIssuer'>;

function isLegacyPayload(payload: string | JwtPayload): payload is JwtPayload & {
  type: 'legacy';
  userId: string;
  role: string;
} {
  return (
    typeof payload !== 'string' &&
    payload.type === 'legacy' &&
    typeof payload.userId === 'string' &&
    typeof payload.role === 'string'
  );
}

export function createLegacyAuthMiddleware(runtimeConfig: LegacyAuthConfig): RequestHandler {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }
    try {
      const payload = jwt.verify(header.slice(7), runtimeConfig.jwtSecret, {
        algorithms: ['HS256'],
        issuer: runtimeConfig.jwtIssuer,
        audience: 'openlogtool-legacy',
      });
      if (!isLegacyPayload(payload)) throw new Error('Wrong token type');
      req.userId = payload.userId;
      req.userRole = payload.role;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

export const authMiddleware = createLegacyAuthMiddleware(config);
