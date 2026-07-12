import { randomUUID } from 'crypto';
import { Request, RequestHandler } from 'express';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const candidate = req.header('x-request-id')?.trim();
  const requestId = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

export function getRequestId(req: Request): string {
  return String(req.res?.locals.requestId || 'unknown');
}
