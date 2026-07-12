import { Request, RequestHandler } from 'express';
import { AppError } from '../errors/app-error';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  maxKeys?: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

export type MemoryRateLimiter = RequestHandler & { reset: () => void };

export function createMemoryRateLimiter(options: RateLimitOptions): MemoryRateLimiter {
  const counters = new Map<string, Counter>();
  const maxKeys = options.maxKeys ?? 10_000;

  const handler: RequestHandler = (req, res, next) => {
    const now = Date.now();
    const key = options.keyGenerator?.(req) || req.ip || req.socket.remoteAddress || 'unknown';
    let counter = counters.get(key);

    if (!counter || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + options.windowMs };
      counters.set(key, counter);
    }
    counter.count += 1;

    const remaining = Math.max(0, options.max - counter.count);
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(counter.resetAt / 1000)));

    if (counter.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          options.message || 'Too many requests; retry later',
          { retryAfterSeconds: retryAfter },
        ),
      );
      return;
    }

    if (counters.size > maxKeys) {
      for (const [storedKey, stored] of counters) {
        if (stored.resetAt <= now) counters.delete(storedKey);
        if (counters.size <= maxKeys) break;
      }
      while (counters.size > maxKeys) {
        const oldestKey = counters.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        counters.delete(oldestKey);
      }
    }
    next();
  };

  const limiter = handler as MemoryRateLimiter;
  limiter.reset = () => counters.clear();
  return limiter;
}
