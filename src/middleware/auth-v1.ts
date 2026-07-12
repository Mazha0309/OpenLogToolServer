import { Request, RequestHandler } from 'express';
import jwt, { JwtPayload, TokenExpiredError } from 'jsonwebtoken';
import { AppConfig, config } from '../config';
import { AppError } from '../errors/app-error';

export interface AccessIdentity {
  userId: string;
  role: string;
  tokenId: string;
}

export interface V1AuthRequest extends Request {
  auth?: AccessIdentity;
}

function identityFromPayload(payload: string | JwtPayload): AccessIdentity {
  if (
    typeof payload === 'string' ||
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token is invalid');
  }
  return { userId: payload.sub, role: payload.role, tokenId: payload.jti };
}

export function createAccessTokenMiddleware(runtimeConfig: AppConfig): RequestHandler {
  return (req: V1AuthRequest, _res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      next(new AppError(401, 'AUTH_REQUIRED', 'A Bearer access token is required'));
      return;
    }
    try {
      const payload = jwt.verify(header.slice(7), runtimeConfig.jwtSecret, {
        algorithms: ['HS256'],
        issuer: runtimeConfig.jwtIssuer,
        audience: 'openlogtool-v1',
      });
      req.auth = identityFromPayload(payload);
      next();
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else if (error instanceof TokenExpiredError) {
        next(new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired'));
      } else {
        next(new AppError(401, 'TOKEN_INVALID', 'Access token is invalid'));
      }
    }
  };
}

export const requireAccessToken = createAccessTokenMiddleware(config);
